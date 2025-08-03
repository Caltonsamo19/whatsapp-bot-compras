const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
require('dotenv').config();

// Configuração da OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

class WhatsAppBot {
    constructor() {
        this.client = new Client({
            authStrategy: new LocalAuth()
        });

        this.dataFile = path.join(__dirname, process.env.DATA_FILE || 'grupos_data.json');
        this.pendingFile = path.join(__dirname, process.env.PENDING_FILE || 'pending.json');
        this.gruposData = this.loadData();
        this.pendingTransactions = this.loadPendingData();
        this.pendingCleanup = null;
        this.pendingNumberCleanup = null; // Para limpeza de números estrangeiros
        
        // Sistema anti-spam
        this.spamDetection = new Map(); // Armazena dados de spam por grupo
        this.SPAM_THRESHOLD = 5; // Máximo de mensagens idênticas
        this.SPAM_WINDOW = 60000; // 1 minuto em millisegundos
        this.MIN_MESSAGE_LENGTH = 10; // Mensagens muito curtas não são consideradas spam

        this.setupEventListeners();
    }

    loadData() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const data = fs.readFileSync(this.dataFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            this.log('Erro ao carregar dados:', error.message);
        }
        return {};
    }

    loadPendingData() {
        try {
            if (fs.existsSync(this.pendingFile)) {
                const data = fs.readFileSync(this.pendingFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            this.log('Erro ao carregar dados pendentes:', error.message);
        }
        return {};
    }

    saveData() {
        try {
            fs.writeFileSync(this.dataFile, JSON.stringify(this.gruposData, null, 2));
        } catch (error) {
            this.log('Erro ao salvar dados:', error.message);
        }
    }

    savePendingData() {
        try {
            fs.writeFileSync(this.pendingFile, JSON.stringify(this.pendingTransactions, null, 2));
        } catch (error) {
            this.log('Erro ao salvar dados pendentes:', error.message);
        }
    }

    // Obtém ou cria dados de um grupo específico
    getGrupoData(groupId) {
        if (!this.gruposData[groupId]) {
            this.gruposData[groupId] = {
                compradores: {},
                info: {
                    nome: '',
                    criadoEm: new Date().toISOString(),
                    totalCompras: 0,
                    totalMegas: 0
                }
            };
        }
        return this.gruposData[groupId];
    }

    // Obtém compradores de um grupo específico
    getCompradores(groupId) {
        return this.getGrupoData(groupId).compradores;
    }

    // Extrai ID do grupo da mensagem
    getGroupId(message) {
        // Se for mensagem de grupo, retorna o ID do grupo
        if (message.from.includes('@g.us')) {
            return message.from;
        }
        // Se for mensagem privada, usa 'private' como ID
        return 'private';
    }

    log(message, ...args) {
        const timestamp = new Date().toLocaleString('pt-BR');
        console.log(`[${timestamp}] ${message}`, ...args);
    }

    setupEventListeners() {
        this.client.on('qr', (qr) => {
            try {
                console.log('\n=================================');
                console.log('QR Code gerado! Escaneie com WhatsApp:');
                console.log('=================================');
                qrcode.generate(qr, { small: true });
                console.log('=================================');
                console.log('Aguardando conexão...');
            } catch (error) {
                console.log('Erro ao gerar QR Code:', error.message);
            }
        });

        this.client.on('authenticated', () => {
            this.log('✅ Cliente autenticado com sucesso!');
        });

        this.client.on('ready', () => {
            this.log('🚀 Bot conectado e pronto para uso!');
            this.testBot();
        });

        this.client.on('message', async (message) => {
            try {
                await this.handleMessage(message);
            } catch (error) {
                this.log('Erro ao processar mensagem:', error.message);
            }
        });

        this.client.on('group_join', async (notification) => {
            try {
                await this.handleGroupJoin(notification);
            } catch (error) {
                this.log('Erro ao processar entrada no grupo:', error.message);
            }
        });

        this.client.on('disconnected', (reason) => {
            this.log('🔌 Cliente desconectado:', reason);
        });
    }

    // Verifica se um número é válido (começa com 258)
    isValidMozambiqueNumber(phoneNumber) {
        // Remove caracteres especiais e espaços
        const cleanNumber = phoneNumber.replace(/[^\d]/g, '');
        
        // Verifica se começa com 258 e tem pelo menos 12 dígitos (258 + 9 dígitos)
        return cleanNumber.startsWith('258') && cleanNumber.length >= 12;
    }

    // Remove números estrangeiros automaticamente quando entram no grupo
    async handleGroupJoin(notification) {
        try {
            if (notification.type !== 'add') return;

            const groupId = notification.chatId;
            const addedParticipants = notification.recipientIds || [];

            for (const participantId of addedParticipants) {
                const phoneNumber = participantId.replace('@c.us', '');
                
                if (!this.isValidMozambiqueNumber(phoneNumber)) {
                    await this.removeForeignNumber(groupId, participantId, phoneNumber, 'entrada automática');
                }
            }
        } catch (error) {
            this.log('Erro ao verificar novos membros:', error.message);
        }
    }

    // Remove um número estrangeiro do grupo
    async removeForeignNumber(groupId, participantId, phoneNumber, motivo) {
        try {
            // Verifica se o bot é admin
            const chat = await this.client.getChatById(groupId);
            const botInfo = await this.client.info;
            const botParticipant = chat.participants.find(p => p.id.user === botInfo.wid.user);
            
            if (!botParticipant || !botParticipant.isAdmin) {
                this.log(`❌ Bot não é admin no grupo ${groupId} - não pode remover ${phoneNumber}`);
                return false;
            }

            // Obtém informações do usuário
            let userName = phoneNumber;
            try {
                const contact = await this.client.getContactById(participantId);
                userName = contact.pushname || contact.name || phoneNumber;
            } catch (error) {
                // Se não conseguir obter o contato, usa o número
            }

            // Remove o participante
            await this.client.removeParticipant(groupId, participantId);

            // Notificação de remoção
            const removalNotification = `🚫 *NÚMERO ESTRANGEIRO REMOVIDO* 🚫\n\n` +
                `👤 **Usuário:** ${userName}\n` +
                `📱 **Número:** +${phoneNumber}\n` +
                `🌍 **Motivo:** Número não moçambicano\n` +
                `⚡ **Ação:** ${motivo}\n\n` +
                `🇲🇿 *Este grupo aceita apenas números de Moçambique (+258)*`;

            await this.client.sendMessage(groupId, removalNotification);

            this.log(`🚫 Removido número estrangeiro: ${userName} (+${phoneNumber}) do grupo ${groupId} - Motivo: ${motivo}`);
            return true;

        } catch (error) {
            this.log(`Erro ao remover número estrangeiro ${phoneNumber}:`, error.message);
            return false;
        }
    }

    // Sistema de detecção de spam
    async detectSpam(message, groupId) {
        try {
            // Só funciona em grupos
            if (groupId === 'private') return false;

            // Verifica se o remetente é admin
            const chat = await this.client.getChatById(groupId);
            const senderNumber = message.author || message.from.replace('@c.us', '');
            const senderParticipant = chat.participants.find(p => p.id.user === senderNumber.replace('@c.us', ''));
            
            // Administradores não são verificados por spam
            if (senderParticipant && senderParticipant.isAdmin) {
                return false;
            }

            // Ignora mensagens muito curtas, comandos e mensagens do sistema
            const messageText = message.body.trim();
            if (messageText.length < this.MIN_MESSAGE_LENGTH || 
                messageText.startsWith('.') || 
                message.type !== 'chat') {
                return false;
            }

            // Normaliza a mensagem para comparação (remove espaços extras, converte para minúsculas)
            const normalizedMessage = messageText.toLowerCase().replace(/\s+/g, ' ').trim();
            
            // Inicializa dados do grupo se não existir
            if (!this.spamDetection.has(groupId)) {
                this.spamDetection.set(groupId, new Map());
            }
            
            const groupSpamData = this.spamDetection.get(groupId);
            
            // Inicializa dados do usuário se não existir
            if (!groupSpamData.has(senderNumber)) {
                groupSpamData.set(senderNumber, {
                    messages: [],
                    lastCleanup: Date.now()
                });
            }
            
            const userData = groupSpamData.get(senderNumber);
            const now = Date.now();
            
            // Remove mensagens antigas (fora da janela de tempo)
            userData.messages = userData.messages.filter(msg => 
                now - msg.timestamp < this.SPAM_WINDOW
            );
            
            // Adiciona a nova mensagem
            userData.messages.push({
                content: normalizedMessage,
                timestamp: now
            });
            
            // Conta mensagens idênticas
            const identicalMessages = userData.messages.filter(msg => 
                msg.content === normalizedMessage
            );
            
            // Se atingiu o limite de spam
            if (identicalMessages.length >= this.SPAM_THRESHOLD) {
                this.log(`🚨 SPAM DETECTADO no grupo ${groupId} por ${senderNumber}: ${identicalMessages.length} mensagens idênticas`);
                await this.handleSpamDetected(message, groupId, senderNumber, identicalMessages.length);
                return true;
            }
            
            return false;
            
        } catch (error) {
            this.log('Erro na detecção de spam:', error.message);
            return false;
        }
    }

    async handleSpamDetected(message, groupId, spammerNumber, messageCount) {
        try {
            const chat = await this.client.getChatById(groupId);
            
            // Obter informações do spammer
            const contact = await this.client.getContactById(`${spammerNumber}@c.us`);
            const spammerName = contact.pushname || contact.name || spammerNumber;
            
            // Notificação sobre detecção de spam
            const spamNotification = `🚨 *SPAM DETECTADO* 🚨\n\n` +
                `👤 **Usuário:** ${spammerName}\n` +
                `📱 **Número:** +${spammerNumber}\n` +
                `📊 **Mensagens repetidas:** ${messageCount}\n` +
                `⏰ **Horário:** ${new Date().toLocaleString('pt-BR')}\n\n` +
                `🔒 **GRUPO SERÁ FECHADO POR SEGURANÇA**\n\n` +
                `*Motivo:* Suspeita de spam/flood de mensagens`;

            await this.client.sendMessage(groupId, spamNotification);
            
            // Aguarda 2 segundos para a mensagem ser enviada
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Fecha o grupo (apenas mensagens de admins)
            await chat.setMessagesAdminsOnly(true);
            
            // Notificação de grupo fechado
            const closedNotification = `🔐 *GRUPO FECHADO AUTOMATICAMENTE* 🔐\n\n` +
                `O grupo foi temporariamente fechado devido à detecção de spam.\n\n` +
                `👨‍💼 **Administradores:** O grupo está agora restrito apenas para admins.\n` +
                `Para reabrir, use as configurações do grupo.\n\n` +
                `⚠️ **Recomendação:** Revisar e remover o usuário suspeito antes de reabrir.`;

            await this.client.sendMessage(groupId, closedNotification);
            
            // Log detalhado
            this.log(`🔒 Grupo ${groupId} fechado automaticamente devido a spam de ${spammerName} (+${spammerNumber})`);
            
            // Limpa os dados de spam para este grupo
            this.spamDetection.delete(groupId);
            
        } catch (error) {
            this.log('Erro ao lidar com spam detectado:', error.message);
        }
    }

    // Limpa dados de spam antigos (executado periodicamente)
    cleanupSpamData() {
        const now = Date.now();
        
        this.spamDetection.forEach((groupData, groupId) => {
            groupData.forEach((userData, userNumber) => {
                // Remove mensagens antigas
                userData.messages = userData.messages.filter(msg => 
                    now - msg.timestamp < this.SPAM_WINDOW
                );
                
                // Remove usuários sem mensagens recentes
                if (userData.messages.length === 0 && 
                    now - userData.lastCleanup > this.SPAM_WINDOW * 2) {
                    groupData.delete(userNumber);
                }
            });
            
            // Remove grupos vazios
            if (groupData.size === 0) {
                this.spamDetection.delete(groupId);
            }
        });
    }

    extractMpesaReference(text) {
        const patterns = [
            /Confirmado\s+([A-Z0-9]{8,15})/i,
            /^([A-Z0-9]{8,15})\s*\./,
            /Referência:\s*([A-Z0-9]{8,15})/i,
            /\b([A-Z]{2,3}\d{2}[A-Z0-9]{6,10})\b/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                let referencia = match[1].toUpperCase();
                referencia = referencia.replace(/\.$/, '');
                return referencia;
            }
        }
        return null;
    }

    extractEmolaReference(text) {
        const patterns = [
            /(PP\d+\.\d+\.[A-Z0-9]+)/i,
            /Referência:\s*(PP\d+\.\d+\.[A-Z0-9]+)/i,
            /ID da transacao[:\s]+(PP\d+\.\d+\.[A-Z0-9]+)/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                let referencia = match[1].toUpperCase();
                referencia = referencia.replace(/\.\s*$/, '');
                return referencia;
            }
        }
        return null;
    }

    extractReference(text) {
        return this.extractMpesaReference(text) || this.extractEmolaReference(text);
    }

    async extractReferenceFromImage(media) {
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [{
                    role: "user",
                    content: [{
                        type: "text",
                        text: "Extrai apenas a referência da transação desta imagem. M-Pesa: código após 'Confirmado'. eMola: código após 'ID da transacao:'. Responde apenas com a referência ou 'NAO_ENCONTRADA'."
                    }, {
                        type: "image_url",
                        image_url: { url: `data:${media.mimetype};base64,${media.data}` }
                    }]
                }],
                max_tokens: 50
            });

            const result = response.choices[0].message.content.trim();
            if (result !== "NAO_ENCONTRADA") {
                // CORREÇÃO: Normaliza a referência extraída da imagem
                return result.toUpperCase().replace(/\.$/, '');
            }
            return null;
        } catch (error) {
            this.log('Erro ao processar imagem:', error.message);
            return null;
        }
    }

    extractMegas(text) {
        const patterns = [
            /Megas:\s*(\d+)\s*MB/i,
            /(\d+)\s*MB/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                return parseInt(match[1]);
            }
        }
        return null;
    }

    calculateRanking(phoneNumber, groupId) {
        const compradores = this.getCompradores(groupId);
        const sorted = Object.entries(compradores)
            .sort((a, b) => b[1].quantidadeTotal - a[1].quantidadeTotal)
            .map(([phone, data], index) => ({ phone, ...data, position: index + 1 }));

        const comprador = sorted.find(c => c.phone === phoneNumber);
        return comprador ? comprador.position : 0;
    }

    formatMegas(megabytes) {
        if (megabytes >= 1024) {
            const gigabytes = (megabytes / 1024).toFixed(1);
            return `${gigabytes} GB`;
        } else {
            return `${megabytes.toLocaleString()} MB`;
        }
    }

    getTopComprador(groupId) {
        const compradores = this.getCompradores(groupId);
        const sorted = Object.entries(compradores)
            .sort((a, b) => b[1].quantidadeTotal - a[1].quantidadeTotal);
        
        if (sorted.length > 0) {
            const [phone, data] = sorted[0];
            return {
                nome: data.nome,
                total: data.quantidadeTotal,
                phone: phone
            };
        }
        return null;
    }

    // Calcula estatísticas de compras do cliente
    getCompraStats(phoneNumber, groupId) {
        const compradores = this.getCompradores(groupId);
        const comprador = compradores[phoneNumber];
        if (!comprador) return null;

        const hoje = new Date().toISOString().split('T')[0];
        const comprasHoje = comprador.historicoCompras?.[hoje]?.length || 0;
        
        // Calcula dias desde última compra
        let diasSemComprar = 0;
        if (comprador.ultimaCompra) {
            const ultimaCompra = new Date(comprador.ultimaCompra);
            const agora = new Date();
            const diffTime = agora - ultimaCompra;
            diasSemComprar = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        }

        return {
            comprasHoje: comprasHoje,
            diasSemComprar: diasSemComprar
        };
    }

    // Atualiza o contador de compras do dia
    updateDailyPurchaseCount(phoneNumber, groupId) {
        const compradores = this.getCompradores(groupId);
        const hoje = new Date().toISOString().split('T')[0];
        
        if (!compradores[phoneNumber].historicoCompras) {
            compradores[phoneNumber].historicoCompras = {};
        }
        
        if (!compradores[phoneNumber].historicoCompras[hoje]) {
            compradores[phoneNumber].historicoCompras[hoje] = [];
        }
        
        compradores[phoneNumber].historicoCompras[hoje].push({
            timestamp: new Date().toISOString(),
            megas: compradores[phoneNumber].quantidadeAtual
        });
        
        return compradores[phoneNumber].historicoCompras[hoje].length;
    }

    // Calcula dias desde a última compra
    getDaysSinceLastPurchase(phoneNumber, groupId) {
        const compradores = this.getCompradores(groupId);
        const comprador = compradores[phoneNumber];
        if (!comprador || !comprador.ultimaCompra) return 0;

        const ultimaCompra = new Date(comprador.ultimaCompra);
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0); // Define para início do dia atual
        ultimaCompra.setHours(0, 0, 0, 0); // Define para início do dia da última compra
        
        const diffTime = hoje - ultimaCompra;
        return Math.floor(diffTime / (1000 * 60 * 60 * 24));
    }

    // Gera números ordinais em português
    getOrdinalNumber(number) {
        if (number === 1) return '1ª';
        if (number === 2) return '2ª';
        if (number === 3) return '3ª';
        return `${number}ª`;
    }

    generatePersonalizedMessage(phoneNumber, megasAdicionados, totalMegas, posicao, nome, groupId) {
        const cleanNumber = phoneNumber.replace('+', '');
        const megasFormatted = this.formatMegas(megasAdicionados);
        const totalFormatted = this.formatMegas(totalMegas);
        
        // Verifica se o cliente não comprava há dias
        const diasSemComprar = this.getDaysSinceLastPurchase(phoneNumber, groupId);
        
        let baseMessage;
        if (diasSemComprar >= 2) {
            // Cliente que não comprava há dias
            baseMessage = `🎉 Obrigado, @${cleanNumber}, Há ${diasSemComprar} dias que você não comprava, bom tê-lo de volta! Foram adicionados ${megasFormatted}, totalizando ${totalFormatted} comprados.`;
        } else {
            // Cliente com compras regulares
            const comprasHoje = this.updateDailyPurchaseCount(phoneNumber, groupId);
            const numeroOrdinal = this.getOrdinalNumber(comprasHoje);
            baseMessage = `🎉 Obrigado, @${cleanNumber}, Você está fazendo a sua ${numeroOrdinal} compra do dia! Foram adicionados ${megasFormatted}, totalizando ${totalFormatted} comprados.`;
        }
        
        let motivationalMessage = '';
        let leaderInfo = '';
        
        if (posicao === 1) {
            motivationalMessage = ` Você está em 1º lugar no ranking. Continue comprando para se manter no topo e garantir seus bônus de líder!`;
        } else if (posicao === 2) {
            motivationalMessage = ` Você está em 2º lugar no ranking. Está quase lá! Continue comprando para alcançar o topo.`;
            const topComprador = this.getTopComprador(groupId);
            leaderInfo = topComprador ? ` O líder já acumulou ${this.formatMegas(topComprador.total)}! 🏆` : '';
        } else {
            motivationalMessage = ` Você está em ${posicao}º lugar no ranking. Continue comprando para subir e desbloquear bônus especiais.`;
            const topComprador = this.getTopComprador(groupId);
            leaderInfo = topComprador ? ` O líder já acumulou ${this.formatMegas(topComprador.total)}! 🏆` : '';
        }
        
        return `${baseMessage}${motivationalMessage}${leaderInfo}`;
    }

    async processReceipt(message) {
        try {
            let referencia = null;
            const fromRaw = message.from;
            const groupId = this.getGroupId(message);
            
            let sender;
            if (message.author) {
                sender = message.author.replace('@c.us', '').replace('@g.us', '');
            } else {
                sender = fromRaw.replace('@c.us', '').replace('@g.us', '');
            }
            
            if (sender.includes('-')) {
                sender = sender.split('-')[0];
            }
            
            if (sender.startsWith('258258')) {
                sender = sender.substring(3);
            }
            
            if (sender.length > 9) {
                sender = sender.substring(sender.length - 9);
            }
            
            const contact = await message.getContact();
            const nome = contact.pushname || contact.name || sender;

            if (message.hasMedia) {
                const media = await message.downloadMedia();
                if (media.mimetype.startsWith('image/')) {
                    referencia = await this.extractReferenceFromImage(media);
                }
            } else {
                referencia = this.extractReference(message.body);
            }

            if (referencia) {
                // CORREÇÃO: Normaliza a referência para maiúsculas
                const referenciaKey = referencia.toUpperCase();
                
                this.pendingTransactions[referenciaKey] = {
                    sender: sender,
                    nome: nome,
                    timestamp: Date.now(),
                    messageId: message.id.id,
                    groupId: groupId,
                    originalReference: referencia // Mantém a referência original para logs
                };
                this.savePendingData();
                this.log(`✅ Referência capturada: ${referencia} (normalizada: ${referenciaKey}) de ${nome} (${sender}) no grupo ${groupId}`);
            }
        } catch (error) {
            this.log('Erro ao processar comprovativo:', error.message);
        }
    }

    async processConfirmation(message) {
        try {
            const text = message.body;
            
            let referencia = this.extractReference(text);
            
            if (!referencia) {
                const ppMatches = text.match(/PP\d+[\.\w]*\d+[\.\w]*\d+/gi);
                if (ppMatches) {
                    referencia = ppMatches.sort((a, b) => b.length - a.length)[0].toUpperCase();
                }
            }
            
            if (!referencia) {
                this.log('❌ Referência não encontrada na confirmação');
                return;
            }

            // CORREÇÃO: Normaliza a referência para maiúsculas para comparação
            const referenciaKey = referencia.toUpperCase();

            const megas = this.extractMegas(text);
            if (!megas) {
                this.log('❌ Quantidade de megas não encontrada na confirmação');
                return;
            }

            // CORREÇÃO: Busca pela referência normalizada
            const pendingTransaction = this.pendingTransactions[referenciaKey];
            if (!pendingTransaction) {
                // CORREÇÃO: Tenta buscar por referências similares (case-insensitive)
                const similarKey = Object.keys(this.pendingTransactions).find(key => 
                    key.toUpperCase() === referenciaKey
                );
                
                if (similarKey) {
                    // Encontrou uma referência similar, usa ela
                    const similarTransaction = this.pendingTransactions[similarKey];
                    this.log(`🔄 Referência similar encontrada: ${similarKey} para confirmação ${referencia}`);
                    
                    // Remove a transação antiga e processa
                    delete this.pendingTransactions[similarKey];
                    await this.processPurchase(similarTransaction, megas, message, referencia);
                    return;
                }
                
                this.log(`❌ Transação pendente não encontrada para referência: ${referencia} (normalizada: ${referenciaKey})`);
                this.log(`📋 Referências pendentes: ${Object.keys(this.pendingTransactions).join(', ')}`);
                return;
            }

            // Remove a transação processada
            delete this.pendingTransactions[referenciaKey];
            
            // Processa a compra
            await this.processPurchase(pendingTransaction, megas, message, referencia);

        } catch (error) {
            this.log('Erro ao processar confirmação:', error.message);
        }
    }

    // NOVO MÉTODO: Processa a compra após validação
    async processPurchase(pendingTransaction, megas, message, referenciaConfirmacao) {
        try {
            const { sender, nome, groupId } = pendingTransaction;
            const phoneNumber = `+258${sender}`;
            const compradores = this.getCompradores(groupId);

            if (!compradores[phoneNumber]) {
                compradores[phoneNumber] = {
                    nome: nome,
                    quantidadeAtual: 0,
                    quantidadeTotal: 0,
                    ultimaCompra: null
                };
            }

            compradores[phoneNumber].nome = nome;
            compradores[phoneNumber].quantidadeAtual = megas;
            compradores[phoneNumber].quantidadeTotal += megas;
            compradores[phoneNumber].ultimaCompra = new Date().toISOString();

            // Atualiza estatísticas do grupo
            const grupoData = this.getGrupoData(groupId);
            grupoData.info.totalCompras += 1;
            grupoData.info.totalMegas += megas;

            this.saveData();
            this.savePendingData();

            const posicao = this.calculateRanking(phoneNumber, groupId);
            const mensagem = this.generatePersonalizedMessage(phoneNumber, megas, compradores[phoneNumber].quantidadeTotal, posicao, nome, groupId);

            const mentionedJidList = [`${phoneNumber.replace('+', '')}@c.us`];
            
            await this.client.sendMessage(message.from, mensagem, {
                mentions: mentionedJidList
            });

            this.log(`✅ Compra processada: ${nome} (${phoneNumber}) - ${megas}MB - Posição #${posicao} - Grupo: ${groupId} - Ref: ${referenciaConfirmacao}`);

        } catch (error) {
            this.log('Erro ao processar compra:', error.message);
        }
    }

    async handleMessage(message) {
        try {
            if (message.fromMe) return;

            const contact = await message.getContact();
            const senderName = contact.pushname || contact.name || '';
            
            if (senderName.includes('AutoBot')) {
                this.log(`🤖 Ignorando mensagem do AutoBot: ${senderName}`);
                return;
            }

            const groupId = this.getGroupId(message);

            // Verifica spam ANTES de processar qualquer outro conteúdo
            const isSpam = await this.detectSpam(message, groupId);
            if (isSpam) {
                // Se spam foi detectado, para o processamento aqui
                return;
            }

            // Verifica se é um comando
            if (message.body.startsWith('.')) {
                await this.handleCommand(message);
                return;
            }

            if (message.body.includes('Transação Concluída Com Sucesso')) {
                await this.processConfirmation(message);
                return;
            }

            const hasReference = this.extractReference(message.body);
            const hasImage = message.hasMedia;
            
            if (hasReference || hasImage) {
                await this.processReceipt(message);
            }

        } catch (error) {
            this.log('Erro ao processar mensagem:', error.message);
        }
    }

    async handleCommand(message) {
        try {
            const command = message.body.toLowerCase().trim();
            const groupId = this.getGroupId(message);

            switch (command) {
                case '.ranking':
                    await this.sendRanking(message, groupId);
                    break;
                
                case '.inativos':
                    await this.sendInativos(message, groupId);
                    break;
                
                case '.semregistro':
                    await this.sendSemRegistro(message, groupId);
                    break;
                
                case '.limpeza':
                    await this.executarLimpeza(message, groupId);
                    break;
                
                case '.confirmar':
                    await this.confirmarLimpeza(message, groupId);
                    break;
                
                case '.limpar.numeros':
                    await this.executarLimpezaNumeros(message, groupId);
                    break;
                
                case '.confirmar.numeros':
                    await this.confirmarLimpezaNumeros(message, groupId);
                    break;
                
                default:
                    // Comando não reconhecido - não faz nada
                    break;
            }
        } catch (error) {
            this.log('Erro ao processar comando:', error.message);
        }
    }

    async sendRanking(message, groupId) {
        try {
            const compradores = this.getCompradores(groupId);
            const sorted = Object.entries(compradores)
                .sort((a, b) => b[1].quantidadeTotal - a[1].quantidadeTotal)
                .slice(0, 20); // Limita aos top 20

            if (sorted.length === 0) {
                await message.reply('📊 *RANKING*\n\nAinda não há compradores registados neste grupo.');
                return;
            }

            let rankingText = '🏆 *RANKING DE COMPRADORES* 🏆\n\n';
            
            sorted.forEach(([phone, data], index) => {
                const posicao = index + 1;
                const emoji = posicao === 1 ? '🥇' : posicao === 2 ? '🥈' : posicao === 3 ? '🥉' : '📍';
                const nome = data.nome || phone.replace('+258', '');
                const total = this.formatMegas(data.quantidadeTotal);
                
                rankingText += `${emoji} *${posicao}º* - ${nome}\n`;
                rankingText += `   📊 ${total}\n\n`;
            });

            const grupoData = this.getGrupoData(groupId);
            rankingText += `📈 *Total do grupo:* ${this.formatMegas(grupoData.info.totalMegas)}\n`;
            rankingText += `🛒 *Total de compras:* ${grupoData.info.totalCompras}`;

            await message.reply(rankingText);
            this.log(`📊 Ranking enviado para o grupo ${groupId}`);

        } catch (error) {
            this.log('Erro ao enviar ranking:', error.message);
        }
    }

    async sendInativos(message, groupId) {
        try {
            const compradores = this.getCompradores(groupId);
            const hoje = new Date();
            const inativos = [];

            Object.entries(compradores).forEach(([phone, data]) => {
                if (data.ultimaCompra) {
                    const ultimaCompra = new Date(data.ultimaCompra);
                    const diffTime = hoje - ultimaCompra;
                    const diasSemComprar = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    
                    if (diasSemComprar > 15) {
                        inativos.push({
                            phone,
                            nome: data.nome || phone.replace('+258', ''),
                            diasSemComprar,
                            totalComprado: data.quantidadeTotal
                        });
                    }
                }
            });

            if (inativos.length === 0) {
                await message.reply('😴 *COMPRADORES INATIVOS*\n\nNão há compradores inativos (15+ dias sem comprar).');
                return;
            }

            // Ordena por dias sem comprar (maior primeiro)
            inativos.sort((a, b) => b.diasSemComprar - a.diasSemComprar);

            let inativosText = '😴 *COMPRADORES INATIVOS* 😴\n';
            inativosText += `*(Mais de 15 dias sem comprar)*\n\n`;

            inativos.slice(0, 15).forEach((comprador, index) => {
                const total = this.formatMegas(comprador.totalComprado);
                inativosText += `📱 ${comprador.nome}\n`;
                inativosText += `   ⏰ ${comprador.diasSemComprar} dias sem comprar\n`;
                inativosText += `   📊 Total: ${total}\n\n`;
            });

            if (inativos.length > 15) {
                inativosText += `... e mais ${inativos.length - 15} compradores inativos.`;
            }

            await message.reply(inativosText);
            this.log(`😴 Lista de inativos enviada para o grupo ${groupId}`);

        } catch (error) {
            this.log('Erro ao enviar lista de inativos:', error.message);
        }
    }

    async sendSemRegistro(message, groupId) {
        try {
            // Se for mensagem privada, não há membros para verificar
            if (groupId === 'private') {
                await message.reply('📝 Este comando só funciona em grupos.');
                return;
            }

            // Obtém todos os membros do grupo
            const chat = await this.client.getChatById(groupId);
            const participants = chat.participants;
            
            const compradores = this.getCompradores(groupId);
            const semCompras = [];

            // Verifica cada membro do grupo
            participants.forEach(participant => {
                const phoneNumber = `+${participant.id.user}`;
                
                // Se não está na base de dados OU tem 0 compras
                if (!compradores[phoneNumber] || compradores[phoneNumber].quantidadeTotal === 0) {
                    // Tenta obter o nome do participante
                    const nome = participant.pushname || 
                                compradores[phoneNumber]?.nome || 
                                participant.id.user;
                    
                    semCompras.push({
                        phone: phoneNumber,
                        nome: nome,
                        temRegisto: !!compradores[phoneNumber]
                    });
                }
            });

            if (semCompras.length === 0) {
                await message.reply('📝 *SEM REGISTO DE COMPRAS*\n\nTodos os membros do grupo já fizeram pelo menos uma compra! 🎉');
                return;
            }

            let semRegistroText = '📝 *MEMBROS SEM COMPRAS* 📝\n';
            semRegistroText += `*(Membros do grupo que nunca compraram)*\n\n`;

            semCompras.slice(0, 20).forEach((membro, index) => {
                const status = membro.temRegisto ? '📋 Registado' : '❌ Sem registo';
                semRegistroText += `📱 ${membro.nome}\n`;
                semRegistroText += `   ${status} • 0 MB comprados\n\n`;
            });

            if (semCompras.length > 20) {
                semRegistroText += `... e mais ${semCompras.length - 20} membros sem compras.`;
            }

            semRegistroText += `\n💡 *Total sem compras:* ${semCompras.length}/${participants.length} membros`;

            await message.reply(semRegistroText);
            this.log(`📝 Lista de membros sem registo enviada para o grupo ${groupId} - ${semCompras.length}/${participants.length} membros`);

        } catch (error) {
            this.log('Erro ao enviar lista sem registo:', error.message);
            await message.reply('❌ Erro ao obter lista de membros do grupo. Certifique-se de que o bot é administrador.');
        }
    }

    async executarLimpeza(message, groupId) {
        try {
            // Verificações de segurança
            if (groupId === 'private') {
                await message.reply('🚫 Este comando só funciona em grupos.');
                return;
            }

            // Verifica se quem executou o comando é admin do grupo
            const chat = await this.client.getChatById(groupId);
            const senderNumber = message.author || message.from.replace('@c.us', '');
            
            const senderParticipant = chat.participants.find(p => p.id.user === senderNumber.replace('@c.us', ''));
            
            if (!senderParticipant || !senderParticipant.isAdmin) {
                await message.reply('🚫 *ACESSO NEGADO*\n\nApenas administradores podem executar limpeza do grupo.');
                return;
            }

            // Verifica se o bot é admin
            const botInfo = await this.client.info;
            const botParticipant = chat.participants.find(p => p.id.user === botInfo.wid.user);
            
            if (!botParticipant || !botParticipant.isAdmin) {
                await message.reply('🚫 *BOT SEM PERMISSÃO*\n\nO bot precisa ser administrador para remover membros.');
                return;
            }

            // Obtém membros sem compras
            const participants = chat.participants;
            const compradores = this.getCompradores(groupId);
            const semCompras = [];

            participants.forEach(participant => {
                const phoneNumber = `+${participant.id.user}`;
                
                // Não remove admins nem o bot
                if (participant.isAdmin || participant.id.user === botInfo.wid.user) {
                    return;
                }
                
                // Se não está na base de dados OU tem 0 compras
                if (!compradores[phoneNumber] || compradores[phoneNumber].quantidadeTotal === 0) {
                    semCompras.push({
                        id: participant.id._serialized,
                        phone: phoneNumber,
                        nome: participant.pushname || compradores[phoneNumber]?.nome || participant.id.user
                    });
                }
            });

            if (semCompras.length === 0) {
                await message.reply('✅ *LIMPEZA DESNECESSÁRIA*\n\nTodos os membros (não-admin) já têm compras registadas!');
                return;
            }

            // Confirmação antes da limpeza
            const confirmMsg = `🧹 *CONFIRMAÇÃO DE LIMPEZA* 🧹\n\n` +
                `⚠️ Será removido ${semCompras.length} membro(s) sem compras:\n\n` +
                semCompras.slice(0, 10).map(m => `• ${m.nome}`).join('\n') +
                (semCompras.length > 10 ? `\n... e mais ${semCompras.length - 10}` : '') +
                `\n\n📋 *PROTEGIDOS:* Administradores não serão removidos\n\n` +
                `Para confirmar, responda com: *.confirmar*\n` +
                `Para cancelar, ignore esta mensagem.`;

            await message.reply(confirmMsg);

            // Armazena dados da limpeza pendente
            const currentTimestamp = Date.now();
            this.pendingCleanup = {
                groupId: groupId,
                membersToRemove: semCompras,
                requestedBy: senderNumber,
                timestamp: currentTimestamp
            };

            // Auto-expira em 2 minutos
            setTimeout(() => {
                if (this.pendingCleanup && this.pendingCleanup.timestamp === currentTimestamp) {
                    this.pendingCleanup = null;
                    this.log(`⏰ Limpeza expirada para grupo ${groupId}`);
                }
            }, 120000);

        } catch (error) {
            this.log('Erro ao preparar limpeza:', error.message);
            await message.reply('❌ Erro ao preparar limpeza do grupo.');
        }
    }

    async confirmarLimpeza(message, groupId) {
        try {
            const senderNumber = message.author || message.from.replace('@c.us', '');

            // Verifica se há limpeza pendente
            if (!this.pendingCleanup || this.pendingCleanup.groupId !== groupId) {
                await message.reply('❌ Não há limpeza pendente para confirmar.');
                return;
            }

            // Verifica se quem confirma é quem solicitou
            if (this.pendingCleanup.requestedBy !== senderNumber) {
                await message.reply('🚫 Apenas quem solicitou a limpeza pode confirmar.');
                return;
            }

            const membersToRemove = this.pendingCleanup.membersToRemove;
            this.pendingCleanup = null;

            await message.reply(`🧹 *INICIANDO LIMPEZA...*\n\nRemoção de ${membersToRemove.length} membro(s) em andamento...`);

            let removidos = 0;
            let erros = 0;

            // Remove membros um por um com delay
            for (const member of membersToRemove) {
                try {
                    await this.client.removeParticipant(groupId, member.id);
                    removidos++;
                    this.log(`✅ Removido: ${member.nome} (${member.phone})`);
                    
                    // Delay de 1 segundo entre remoções para evitar spam
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                } catch (error) {
                    erros++;
                    this.log(`❌ Erro ao remover ${member.nome}: ${error.message}`);
                }
            }

            // Relatório final
            const relatorio = `✅ *LIMPEZA CONCLUÍDA* ✅\n\n` +
                `🗑️ **Removidos:** ${removidos} membro(s)\n` +
                `❌ **Erros:** ${erros}\n` +
                `📊 **Total processado:** ${membersToRemove.length}\n\n` +
                `🎯 Grupo agora contém apenas membros com compras registadas!`;

            await message.reply(relatorio);
            this.log(`🧹 Limpeza concluída no grupo ${groupId}: ${removidos}/${membersToRemove.length} removidos`);

        } catch (error) {
            this.log('Erro ao executar limpeza:', error.message);
            await message.reply('❌ Erro durante a execução da limpeza.');
        }
    }

    // Comando para remover todos os números estrangeiros existentes no grupo
    async executarLimpezaNumeros(message, groupId) {
        try {
            // Verificações de segurança
            if (groupId === 'private') {
                await message.reply('🚫 Este comando só funciona em grupos.');
                return;
            }

            // Verifica se quem executou o comando é admin do grupo
            const chat = await this.client.getChatById(groupId);
            const senderNumber = message.author || message.from.replace('@c.us', '');
            
            const senderParticipant = chat.participants.find(p => p.id.user === senderNumber.replace('@c.us', ''));
            
            if (!senderParticipant || !senderParticipant.isAdmin) {
                await message.reply('🚫 *ACESSO NEGADO*\n\nApenas administradores podem executar limpeza de números.');
                return;
            }

            // Verifica se o bot é admin
            const botInfo = await this.client.info;
            const botParticipant = chat.participants.find(p => p.id.user === botInfo.wid.user);
            
            if (!botParticipant || !botParticipant.isAdmin) {
                await message.reply('🚫 *BOT SEM PERMISSÃO*\n\nO bot precisa ser administrador para remover membros.');
                return;
            }

            // Obtém números estrangeiros
            const participants = chat.participants;
            const numerosEstrangeiros = [];

            participants.forEach(participant => {
                const phoneNumber = participant.id.user;
                
                // Não remove admins nem o bot
                if (participant.isAdmin || phoneNumber === botInfo.wid.user) {
                    return;
                }
                
                // Se não é número moçambicano
                if (!this.isValidMozambiqueNumber(phoneNumber)) {
                    numerosEstrangeiros.push({
                        id: participant.id._serialized,
                        phone: phoneNumber,
                        nome: participant.pushname || phoneNumber
                    });
                }
            });

            if (numerosEstrangeiros.length === 0) {
                await message.reply('✅ *LIMPEZA DESNECESSÁRIA*\n\nTodos os membros (não-admin) são números moçambicanos válidos! 🇲🇿');
                return;
            }

            // Confirmação antes da limpeza
            const confirmMsg = `🇲🇿 *CONFIRMAÇÃO DE LIMPEZA NÚMEROS* 🇲🇿\n\n` +
                `⚠️ Será removido ${numerosEstrangeiros.length} número(s) estrangeiro(s):\n\n` +
                numerosEstrangeiros.slice(0, 10).map(m => `• ${m.nome} (+${m.phone})`).join('\n') +
                (numerosEstrangeiros.length > 10 ? `\n... e mais ${numerosEstrangeiros.length - 10}` : '') +
                `\n\n📋 *PROTEGIDOS:* Administradores não serão removidos\n` +
                `🇲🇿 *CRITÉRIO:* Apenas números +258 são aceites\n\n` +
                `Para confirmar, responda com: *.confirmar.numeros*\n` +
                `Para cancelar, ignore esta mensagem.`;

            await message.reply(confirmMsg);

            // Armazena dados da limpeza pendente
            const currentTimestamp = Date.now();
            this.pendingNumberCleanup = {
                groupId: groupId,
                numbersToRemove: numerosEstrangeiros,
                requestedBy: senderNumber,
                timestamp: currentTimestamp
            };

            // Auto-expira em 2 minutos
            setTimeout(() => {
                if (this.pendingNumberCleanup && this.pendingNumberCleanup.timestamp === currentTimestamp) {
                    this.pendingNumberCleanup = null;
                    this.log(`⏰ Limpeza de números expirada para grupo ${groupId}`);
                }
            }, 120000);

        } catch (error) {
            this.log('Erro ao preparar limpeza de números:', error.message);
            await message.reply('❌ Erro ao preparar limpeza de números.');
        }
    }

    async confirmarLimpezaNumeros(message, groupId) {
        try {
            const senderNumber = message.author || message.from.replace('@c.us', '');

            // Verifica se há limpeza pendente
            if (!this.pendingNumberCleanup || this.pendingNumberCleanup.groupId !== groupId) {
                await message.reply('❌ Não há limpeza de números pendente para confirmar.');
                return;
            }

            // Verifica se quem confirma é quem solicitou
            if (this.pendingNumberCleanup.requestedBy !== senderNumber) {
                await message.reply('🚫 Apenas quem solicitou a limpeza pode confirmar.');
                return;
            }

            const numbersToRemove = this.pendingNumberCleanup.numbersToRemove;
            this.pendingNumberCleanup = null;

            await message.reply(`🇲🇿 *INICIANDO LIMPEZA DE NÚMEROS...*\n\nRemoção de ${numbersToRemove.length} número(s) estrangeiro(s) em andamento...`);

            let removidos = 0;
            let erros = 0;

            // Remove números um por um com delay
            for (const member of numbersToRemove) {
                try {
                    await this.client.removeParticipant(groupId, member.id);
                    removidos++;
                    this.log(`✅ Removido número estrangeiro: ${member.nome} (+${member.phone})`);
                    
                    // Delay de 1.5 segundos entre remoções
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    
                } catch (error) {
                    erros++;
                    this.log(`❌ Erro ao remover ${member.nome}: ${error.message}`);
                }
            }

            // Relatório final
            const relatorio = `✅ *LIMPEZA DE NÚMEROS CONCLUÍDA* ✅\n\n` +
                `🗑️ **Removidos:** ${removidos} número(s) estrangeiro(s)\n` +
                `❌ **Erros:** ${erros}\n` +
                `📊 **Total processado:** ${numbersToRemove.length}\n\n` +
                `🇲🇿 Grupo agora contém apenas números moçambicanos válidos!`;

            await message.reply(relatorio);
            this.log(`🇲🇿 Limpeza de números concluída no grupo ${groupId}: ${removidos}/${numbersToRemove.length} removidos`);

        } catch (error) {
            this.log('Erro ao executar limpeza de números:', error.message);
            await message.reply('❌ Erro durante a execução da limpeza de números.');
        }
    }

    async start() {
        try {
            await this.client.initialize();
            this.log('✅ Bot iniciado com sucesso!');
            
            // Inicia limpeza periódica de dados de spam (a cada 5 minutos)
            setInterval(() => {
                this.cleanupSpamData();
            }, 300000);
            
        } catch (error) {
            this.log('❌ Erro ao iniciar bot:', error.message);
        }
    }

    async stop() {
        try {
            await this.client.destroy();
            this.log('Bot parado com sucesso! 🛑');
        } catch (error) {
            this.log('Erro ao parar bot:', error.message);
        }
    }

    async testBot() {
        try {
            const info = await this.client.info;
            this.log(`📱 Conectado como: ${info.pushname} (${info.wid.user})`);
            this.log('✅ Bot funcionando corretamente!');
            
            const totalGrupos = Object.keys(this.gruposData).length;
            let totalCompradores = 0;
            
            Object.values(this.gruposData).forEach(grupo => {
                totalCompradores += Object.keys(grupo.compradores).length;
            });
            
            this.log(`📊 Grupos ativos: ${totalGrupos}`);
            this.log(`👥 Compradores registados: ${totalCompradores}`);
            this.log('📋 Comandos disponíveis: .ranking, .inativos, .semregistro, .limpeza, .limpar.numeros');
            this.log('🛡️ Sistema anti-spam ativo: 5 mensagens idênticas em 1 minuto');
            this.log('🇲🇿 Proteção automática: Remove números não moçambicanos (+258)');
            
        } catch (error) {
            this.log('❌ Erro no teste do bot:', error.message);
        }
    }
}

const bot = new WhatsAppBot();

process.on('SIGINT', async () => {
    console.log('\n🛑 Encerrando bot...');
    await bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Encerrando bot...');
    await bot.stop();
    process.exit(0);
});

bot.start().catch(console.error);

module.exports = WhatsAppBot;
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
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor'
                ]
            }
        });

        this.dataFile = path.join(__dirname, process.env.DATA_FILE || 'grupos_data.json');
        this.pendingFile = path.join(__dirname, process.env.PENDING_FILE || 'pending.json');
        this.gruposData = this.loadData();
        this.pendingTransactions = this.loadPendingData();
        this.pendingCleanup = null;
        this.pendingNumberCleanup = null;
        
        // Sistema anti-spam
        this.spamDetection = new Map();
        this.SPAM_THRESHOLD = 5;
        this.SPAM_WINDOW = 60000;
        this.MIN_MESSAGE_LENGTH = 10;

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

    getCompradores(groupId) {
        return this.getGrupoData(groupId).compradores;
    }

    getGroupId(message) {
        if (message.from.includes('@g.us')) {
            return message.from;
        }
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

    isValidMozambiqueNumber(phoneNumber) {
        const cleanNumber = phoneNumber.replace(/[^\d]/g, '');
        return cleanNumber.startsWith('258') && cleanNumber.length >= 12;
    }

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

    async removeForeignNumber(groupId, participantId, phoneNumber, motivo) {
        try {
            const chat = await this.client.getChatById(groupId);
            const botInfo = await this.client.info;
            const botParticipant = chat.participants.find(p => p.id.user === botInfo.wid.user);
            
            if (!botParticipant || !botParticipant.isAdmin) {
                this.log(`❌ Bot não é admin no grupo ${groupId} - não pode remover ${phoneNumber}`);
                return false;
            }

            let userName = phoneNumber;
            try {
                const contact = await this.client.getContactById(participantId);
                userName = contact.pushname || contact.name || phoneNumber;
            } catch (error) {
                // Se não conseguir obter o contato, usa o número
            }

            await this.client.removeParticipant(groupId, participantId);

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

    async detectSpam(message, groupId) {
        try {
            if (groupId === 'private') return false;

            const chat = await this.client.getChatById(groupId);
            const senderNumber = message.author || message.from.replace('@c.us', '');
            const senderParticipant = chat.participants.find(p => p.id.user === senderNumber.replace('@c.us', ''));
            
            if (senderParticipant && senderParticipant.isAdmin) {
                return false;
            }

            const messageText = message.body.trim();
            if (messageText.length < this.MIN_MESSAGE_LENGTH || 
                messageText.startsWith('.') || 
                message.type !== 'chat') {
                return false;
            }

            const normalizedMessage = messageText.toLowerCase().replace(/\s+/g, ' ').trim();
            
            if (!this.spamDetection.has(groupId)) {
                this.spamDetection.set(groupId, new Map());
            }
            
            const groupSpamData = this.spamDetection.get(groupId);
            
            if (!groupSpamData.has(senderNumber)) {
                groupSpamData.set(senderNumber, {
                    messages: [],
                    lastCleanup: Date.now()
                });
            }
            
            const userData = groupSpamData.get(senderNumber);
            const now = Date.now();
            
            userData.messages = userData.messages.filter(msg => 
                now - msg.timestamp < this.SPAM_WINDOW
            );
            
            userData.messages.push({
                content: normalizedMessage,
                timestamp: now
            });
            
            const identicalMessages = userData.messages.filter(msg => 
                msg.content === normalizedMessage
            );
            
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
            
            const contact = await this.client.getContactById(`${spammerNumber}@c.us`);
            const spammerName = contact.pushname || contact.name || spammerNumber;
            
            const spamNotification = `🚨 *SPAM DETECTADO* 🚨\n\n` +
                `👤 **Usuário:** ${spammerName}\n` +
                `📱 **Número:** +${spammerNumber}\n` +
                `📊 **Mensagens repetidas:** ${messageCount}\n` +
                `⏰ **Horário:** ${new Date().toLocaleString('pt-BR')}\n\n` +
                `🔒 **GRUPO SERÁ FECHADO POR SEGURANÇA**\n\n` +
                `*Motivo:* Suspeita de spam/flood de mensagens`;

            await this.client.sendMessage(groupId, spamNotification);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            await chat.setMessagesAdminsOnly(true);
            
            const closedNotification = `🔐 *GRUPO FECHADO AUTOMATICAMENTE* 🔐\n\n` +
                `O grupo foi temporariamente fechado devido à detecção de spam.\n\n` +
                `👨‍💼 **Administradores:** O grupo está agora restrito apenas para admins.\n` +
                `Para reabrir, use as configurações do grupo.\n\n` +
                `⚠️ **Recomendação:** Revisar e remover o usuário suspeito antes de reabrir.`;

            await this.client.sendMessage(groupId, closedNotification);
            
            this.log(`🔒 Grupo ${groupId} fechado automaticamente devido a spam de ${spammerName} (+${spammerNumber})`);
            
            this.spamDetection.delete(groupId);
            
        } catch (error) {
            this.log('Erro ao lidar com spam detectado:', error.message);
        }
    }

    cleanupSpamData() {
        const now = Date.now();
        
        this.spamDetection.forEach((groupData, groupId) => {
            groupData.forEach((userData, userNumber) => {
                userData.messages = userData.messages.filter(msg => 
                    now - msg.timestamp < this.SPAM_WINDOW
                );
                
                if (userData.messages.length === 0 && 
                    now - userData.lastCleanup > this.SPAM_WINDOW * 2) {
                    groupData.delete(userNumber);
                }
            });
            
            if (groupData.size === 0) {
                this.spamDetection.delete(groupId);
            }
        });
    }

    // FUNÇÃO CORRIGIDA: Normalização que sempre ignora o último ponto
    normalizeReference(reference) {
        if (!reference) return null;
        
        // Remove apenas espaços extras e caracteres de controle, preserva formato original
        let normalized = reference
            .trim()
            .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove caracteres invisíveis
            .replace(/\s+/g, ' '); // Normaliza espaços múltiplos para um único
        
        // SEMPRE remove o último ponto, independentemente de ser único ou múltiplo
        normalized = normalized.replace(/\.+$/, '');
        
        // Remove pontos apenas no início (não no fim, pois já foi tratado acima)
        normalized = normalized.replace(/^\.+/, '');
        
        return normalized;
    }

    // NOVA FUNÇÃO: Teste da normalização para debug
    testNormalization() {
        const testCases = [
            'ABC123.',
            'ABC123..',
            'ABC123...',
            'ABC.123.',
            'ABC.123..',
            'ABC.123...',
            '.ABC123.',
            '.ABC123..',
            '.ABC123...',
            'ABC123',
            'ABC.123',
            '.ABC123',
            'ABC123.456.',
            'ABC123.456..',
            'ABC123.456...'
        ];
        
        this.log('🧪 TESTE DE NORMALIZAÇÃO:');
        testCases.forEach(test => {
            const result = this.normalizeReference(test);
            this.log(`   "${test}" → "${result}"`);
        });
    }

    // FUNÇÃO MELHORADA: Extração avançada de referência M-Pesa com múltiplos padrões
    extractMpesaReference(text) {
        const patterns = [
            // Padrão principal: "Confirmado" + referência
            /Confirmado\.?\s*([A-Za-z0-9]{8,20})/i,
            
            // Padrão: "Confirmado" com espaços e caracteres especiais
            /Confirmado[^\w]*([A-Za-z0-9]{8,20})/i,
            
            // Padrão: Referência isolada (linha única)
            /^[^\w]*([A-Za-z0-9]{8,20})[^\w]*$/m,
            
            // Padrão: "Referência:" + código
            /Referência[:\s]*([A-Za-z0-9]{8,20})/i,
            /Referencia[:\s]*([A-Za-z0-9]{8,20})/i,
            
            // Padrão: "ID:" + código
            /ID[:\s]*([A-Za-z0-9]{8,20})/i,
            /Id[:\s]*([A-Za-z0-9]{8,20})/i,
            
            // Padrão: "Código:" + referência
            /Código[:\s]*([A-Za-z0-9]{8,20})/i,
            /Codigo[:\s]*([A-Za-z0-9]{8,20})/i,
            
            // Padrão: "Número:" + referência
            /Número[:\s]*([A-Za-z0-9]{8,20})/i,
            /Numero[:\s]*([A-Za-z0-9]{8,20})/i,
            
            // Padrão: "Transação:" + referência
            /Transação[:\s]*([A-Za-z0-9]{8,20})/i,
            /Transacao[:\s]*([A-Za-z0-9]{8,20})/i,
            
            // Padrão: Referência com formato específico (2-3 letras + 2 dígitos + alfanumérico)
            /\b([A-Za-z]{2,4}\d{2,3}[A-Za-z0-9]{4,12})\b/i,
            
            // Padrão: Referência com pontos internos
            /\b([A-Za-z0-9]{3,6}\.[A-Za-z0-9]{3,6}\.[A-Za-z0-9]{2,8})\b/i,
            
            // Padrão: Referência com hífens
            /\b([A-Za-z0-9]{3,8}-[A-Za-z0-9]{3,8}-[A-Za-z0-9]{2,8})\b/i,
            
            // Padrão: Referência com underscores
            /\b([A-Za-z0-9]{3,8}_[A-Za-z0-9]{3,8}_[A-Za-z0-9]{2,8})\b/i,
            
            // Padrão: Referência entre parênteses
            /\(([A-Za-z0-9]{8,20})\)/i,
            
            // Padrão: Referência entre colchetes
            /\[([A-Za-z0-9]{8,20})\]/i,
            
            // Padrão: Referência entre chaves
            /\{([A-Za-z0-9]{8,20})\}/i,
            
            // Padrão: Referência após "="
            /=([A-Za-z0-9]{8,20})/i,
            
            // Padrão: Referência após ">"
            />([A-Za-z0-9]{8,20})/i,
            
            // Padrão: Referência após "|"
            /\|([A-Za-z0-9]{8,20})/i,
            
            // Padrão: Referência isolada com contexto
            /(?:^|\s)([A-Za-z0-9]{8,20})(?:\s|$)/m
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const referencia = this.normalizeReference(match[1]);
                if (referencia && this.isValidMpesaReference(referencia)) {
                    return referencia;
                }
            }
        }
        return null;
    }

    // FUNÇÃO MELHORADA: Extração avançada de referência eMola com múltiplos padrões
    extractEmolaReference(text) {
        const patterns = [
            // Padrão principal: PP + números + alfanumérico
            /(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            
            // Padrão: "Referência:" + PP
            /Referência[:\s]*(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            /Referencia[:\s]*(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            
            // Padrão: "ID da transação:" + PP
            /ID\s+da\s+transacao[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            /ID\s+da\s+transação[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            /Id\s+da\s+transacao[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            /Id\s+da\s+transação[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            
            // Padrão: "Transação:" + PP
            /transacao[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            /transação[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            
            // Padrão: "Código:" + PP
            /Código[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            /Codigo[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            
            // Padrão: "Número:" + PP
            /Número[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            /Numero[:\s]+(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i,
            
            // Padrão: PP isolado
            /\b(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)\b/i,
            
            // Padrão: PP com formato específico (PP + números + separadores)
            /(PP\d{1,3}[\.\-\_]?\d{1,3}[\.\-\_]?[A-Za-z0-9]{2,8})/i,
            
            // Padrão: PP entre parênteses
            /\(([^)]*PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*[^)]*)\)/i,
            
            // Padrão: PP entre colchetes
            /\[([^\]]*PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*[^\]]*)\]/i,
            
            // Padrão: PP após "="
            /=([^=]*PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*[^=]*)/i,
            
            // Padrão: PP após ">"
            />([^>]*PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*[^>]*)/i,
            
            // NOVO: Padrão específico para confirmações do sistema
            /🔖\s*Referência[:\s]*([A-Za-z0-9\.\-\_]+)/i,
            
            // NOVO: Padrão para referências após "Referência:"
            /Referência[:\s]*([A-Za-z0-9\.\-\_]+)/i,
            
            // NOVO: Padrão para referências após "🔖 Referência:"
            /🔖\s*Referência[:\s]*([A-Za-z0-9\.\-\_]+)/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                let referencia = match[1];
                
                // Se o padrão capturou texto extra, extrai apenas a parte PP
                if (referencia.length > 20) {
                    const ppMatch = referencia.match(/(PP\d+[\.\-\_]?\d*[\.\-\_]?[A-Za-z0-9]*)/i);
                    if (ppMatch) {
                        referencia = ppMatch[1];
                    }
                }
                
                const referenciaNormalizada = this.normalizeReference(referencia);
                if (referenciaNormalizada && this.isValidEmolaReference(referenciaNormalizada)) {
                    return referenciaNormalizada;
                }
            }
        }
        return null;
    }

    // NOVA FUNÇÃO: Validação de referência M-Pesa
    isValidMpesaReference(reference) {
        if (!reference || reference.length < 8 || reference.length > 20) return false;
        
        // Deve conter pelo menos 2 letras e 2 números
        const hasLetters = /[A-Za-z]/.test(reference);
        const hasNumbers = /\d/.test(reference);
        
        if (!hasLetters || !hasNumbers) return false;
        
        // Verifica se não contém caracteres inválidos
        const validChars = /^[A-Za-z0-9\.\-\_]+$/.test(reference);
        
        return validChars;
    }

    // NOVA FUNÇÃO: Validação de referência eMola
    isValidEmolaReference(reference) {
        if (!reference || !reference.startsWith('PP')) return false;
        
        // Deve ter pelo menos 4 caracteres (PP + pelo menos 2 caracteres)
        if (reference.length < 4) return false;
        
        // Verifica se contém pelo menos um número após PP
        const hasNumbers = /\d/.test(reference.substring(2));
        
        return hasNumbers;
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
                        text: `Extrai apenas a referência da transação desta imagem. 

Para M-Pesa: Procura por códigos após palavras como "Confirmado", "Referência", "ID", "Código", "Número", "Transação". Formato típico: 2-4 letras + 2-3 números + 4-12 alfanumérico.

Para eMola: Procura por códigos que começam com "PP" seguidos de números e possivelmente separadores como pontos, hífens ou underscores.

Responde apenas com a referência encontrada ou 'NAO_ENCONTRADA' se não encontrar nenhuma.`
                    }, {
                        type: "image_url",
                        image_url: { url: `data:${media.mimetype};base64,${media.data}` }
                    }]
                }],
                max_tokens: 100
            });

            const result = response.choices[0].message.content.trim();
            if (result !== "NAO_ENCONTRADA" && result.length > 0) {
                // MELHORIA: Usa o novo sistema de normalização
                const referenciaNormalizada = this.normalizeReference(result);
                
                // VALIDAÇÃO: Verifica se a referência extraída é válida
                if (this.isValidReference(referenciaNormalizada)) {
                    this.log(`🖼️ Referência extraída de imagem: ${result} → ${referenciaNormalizada}`);
                    return referenciaNormalizada;
                } else {
                    this.log(`⚠️ Referência extraída inválida: ${result} → ${referenciaNormalizada}`);
                    return null;
                }
            }
            return null;
        } catch (error) {
            this.log('Erro ao processar imagem:', error.message);
            return null;
        }
    }

    extractMegas(text) {
        const patterns = [
            /Megas[:\s]*(\d+)\s*MB/i,
            /(\d+)\s*MB/i,
            /(\d+)\s*mb/i,
            /quantidade[:\s]*(\d+)/i,
            /valor[:\s]*(\d+)\s*MB/i,
            
            // NOVO: Padrão específico para confirmações do sistema
            /📊\s*Megas[:\s]*(\d+)\s*MB/i,
            /📊\s*Megas[:\s]*(\d+)/i,
            
            // NOVO: Padrão para megas após "📊 Megas:"
            /📊\s*Megas[:\s]*(\d+)/i,
            
            // NOVO: Padrão para megas isolados
            /(\d+)\s*MB/i,
            /(\d+)\s*mb/i
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                const megas = parseInt(match[1]);
                if (megas > 0 && megas <= 50000) {
                    return megas;
                }
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

    getCompraStats(phoneNumber, groupId) {
        const compradores = this.getCompradores(groupId);
        const comprador = compradores[phoneNumber];
        if (!comprador) return null;

        const hoje = new Date().toISOString().split('T')[0];
        const comprasHoje = comprador.historicoCompras?.[hoje]?.length || 0;
        
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

    getDaysSinceLastPurchase(phoneNumber, groupId) {
        const compradores = this.getCompradores(groupId);
        const comprador = compradores[phoneNumber];
        if (!comprador || !comprador.ultimaCompra) return 0;

        const ultimaCompra = new Date(comprador.ultimaCompra);
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        ultimaCompra.setHours(0, 0, 0, 0);
        
        const diffTime = hoje - ultimaCompra;
        return Math.floor(diffTime / (1000 * 60 * 60 * 24));
    }

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
        
        const diasSemComprar = this.getDaysSinceLastPurchase(phoneNumber, groupId);
        
        let baseMessage;
        if (diasSemComprar >= 2) {
            baseMessage = `🎉 Obrigado, @${cleanNumber}, Há ${diasSemComprar} dias que você não comprava, bom tê-lo de volta! Foram adicionados ${megasFormatted}, totalizando ${totalFormatted} comprados.`;
        } else {
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
                // MELHORIA: Usa o novo sistema de normalização inteligente
                const referenciaKey = this.normalizeReference(referencia);
                
                // VALIDAÇÃO: Verifica se a referência é válida antes de salvar
                if (this.isValidReference(referenciaKey)) {
                    this.pendingTransactions[referenciaKey] = {
                        sender: sender,
                        nome: nome,
                        timestamp: Date.now(),
                        messageId: message.id.id,
                        groupId: groupId,
                        originalReference: referencia,
                        referenceType: this.getReferenceType(referenciaKey)
                    };
                    this.savePendingData();
                    this.log(`✅ Referência capturada: ${referencia} (normalizada: ${referenciaKey}) de ${nome} (${sender}) no grupo ${groupId}`);
                    this.log(`📋 Tipo de referência: ${this.getReferenceType(referenciaKey)}`);
                    
                    // DEBUG: Lista todas as referências pendentes
                    this.log(`📋 Referências pendentes: ${Object.keys(this.pendingTransactions).join(', ')}`);
                } else {
                    this.log(`⚠️ Referência inválida ignorada: ${referencia} (${referenciaKey})`);
                }
            }
        } catch (error) {
            this.log('Erro ao processar comprovativo:', error.message);
        }
    }

    // NOVA FUNÇÃO: Validação geral de referências
    isValidReference(reference) {
        if (!reference) return false;
        
        // Verifica se é uma referência eMola válida
        if (this.isValidEmolaReference(reference)) {
            return true;
        }
        
        // Verifica se é uma referência M-Pesa válida
        if (this.isValidMpesaReference(reference)) {
            return true;
        }
        
        return false;
    }

    // NOVA FUNÇÃO: Identifica o tipo de referência
    getReferenceType(reference) {
        if (reference.toUpperCase().startsWith('PP')) {
            return 'eMola';
        } else if (this.isValidMpesaReference(reference)) {
            return 'M-Pesa';
        } else {
            return 'Desconhecido';
        }
    }

    async processConfirmation(message) {
        try {
            const text = message.body;
            
            let referencia = this.extractReference(text);
            
            // TENTATIVA ADICIONAL: Busca padrões PP específicos para eMola
            if (!referencia) {
                const ppMatches = text.match(/PP\d+[\.\-\_]*\d*[\.\-\_]*[A-Za-z0-9]*/gi);
                if (ppMatches) {
                    referencia = ppMatches.sort((a, b) => b.length - a.length)[0];
                }
            }
            
            if (!referencia) {
                this.log('❌ Referência não encontrada na confirmação:', text.substring(0, 100));
                return;
            }

            // MELHORIA: Normaliza a referência preservando formato original
            const referenciaKey = this.normalizeReference(referencia);
            this.log(`🔍 Procurando referência: ${referencia} (normalizada: ${referenciaKey})`);

            const megas = this.extractMegas(text);
            if (!megas) {
                this.log('❌ Quantidade de megas não encontrada na confirmação:', text.substring(0, 100));
                return;
            }

            // MELHORIA: Sistema de matching inteligente e flexível
            let pendingTransaction = this.findBestMatch(referenciaKey, referencia);
            
            if (!pendingTransaction) {
                this.log(`❌ Transação pendente não encontrada para referência: ${referencia} (normalizada: ${referenciaKey})`);
                this.log(`📋 Referências pendentes disponíveis: ${Object.keys(this.pendingTransactions).join(', ')}`);
                return;
            }

            // Processa a compra
            await this.processPurchase(pendingTransaction, megas, message, referencia);

        } catch (error) {
            this.log('Erro ao processar confirmação:', error.message);
        }
    }

    // NOVA FUNÇÃO: Sistema de matching inteligente para referências
    findBestMatch(referenciaKey, referenciaOriginal) {
        // 1. Busca exata pela referência normalizada
        if (this.pendingTransactions[referenciaKey]) {
            const transaction = this.pendingTransactions[referenciaKey];
            delete this.pendingTransactions[referenciaKey];
            this.log(`✅ Match exato encontrado: ${referenciaKey}`);
            return transaction;
        }

        // 2. Busca por similaridade (ignorando diferenças mínimas)
        const bestMatch = this.findSimilarMatch(referenciaKey, referenciaOriginal);
        if (bestMatch) {
            return bestMatch;
        }

        // 3. Busca por padrões específicos (M-Pesa vs eMola)
        return this.findPatternMatch(referenciaKey, referenciaOriginal);
    }

    // NOVA FUNÇÃO: Busca por similaridade inteligente
    findSimilarMatch(referenciaKey, referenciaOriginal) {
        const candidates = [];
        
        Object.keys(this.pendingTransactions).forEach(key => {
            const similarity = this.calculateSimilarity(referenciaKey, key);
            if (similarity >= 0.8) { // 80% de similaridade
                candidates.push({
                    key: key,
                    similarity: similarity,
                    transaction: this.pendingTransactions[key]
                });
            }
        });

        if (candidates.length === 0) return null;

        // Ordena por similaridade e seleciona o melhor
        candidates.sort((a, b) => b.similarity - a.similarity);
        const bestMatch = candidates[0];

        // Remove a transação encontrada
        delete this.pendingTransactions[bestMatch.key];
        
        this.log(`🔄 Match por similaridade (${Math.round(bestMatch.similarity * 100)}%): ${bestMatch.key} para ${referenciaKey}`);
        return bestMatch.transaction;
    }

    // NOVA FUNÇÃO: Cálculo de similaridade entre referências
    calculateSimilarity(ref1, ref2) {
        if (ref1 === ref2) return 1.0;
        
        const len1 = ref1.length;
        const len2 = ref2.length;
        const maxLen = Math.max(len1, len2);
        
        if (maxLen === 0) return 1.0;
        
        // Calcula distância de Levenshtein
        const distance = this.levenshteinDistance(ref1, ref2);
        const similarity = 1 - (distance / maxLen);
        
        // Bônus para referências que começam igual
        if (ref1.charAt(0) === ref2.charAt(0)) {
            const commonPrefix = this.getCommonPrefix(ref1, ref2);
            const prefixBonus = commonPrefix / maxLen * 0.2;
            return Math.min(1.0, similarity + prefixBonus);
        }
        
        return similarity;
    }

    // NOVA FUNÇÃO: Distância de Levenshtein para cálculo de similaridade
    levenshteinDistance(str1, str2) {
        const matrix = [];
        
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[str2.length][str1.length];
    }

    // NOVA FUNÇÃO: Obtém prefixo comum entre duas strings
    getCommonPrefix(str1, str2) {
        let commonLength = 0;
        const minLength = Math.min(str1.length, str2.length);
        
        for (let i = 0; i < minLength; i++) {
            if (str1.charAt(i) === str2.charAt(i)) {
                commonLength++;
            } else {
                break;
            }
        }
        
        return commonLength;
    }

    // NOVA FUNÇÃO: Busca por padrões específicos
    findPatternMatch(referenciaKey, referenciaOriginal) {
        // Verifica se é uma referência eMola (PP)
        if (referenciaKey.toUpperCase().startsWith('PP')) {
            return this.findEmolaPatternMatch(referenciaKey);
        }
        
        // Verifica se é uma referência M-Pesa
        return this.findMpesaPatternMatch(referenciaKey);
    }

    // NOVA FUNÇÃO: Busca por padrões eMola
    findEmolaPatternMatch(referenciaKey) {
        const ppPattern = /^PP\d+/i;
        
        for (const key of Object.keys(this.pendingTransactions)) {
            if (ppPattern.test(key)) {
                // Verifica se os números principais são similares
                const keyNumbers = key.match(/\d+/g) || [];
                const refNumbers = referenciaKey.match(/\d+/g) || [];
                
                if (this.arraysAreSimilar(keyNumbers, refNumbers)) {
                    const transaction = this.pendingTransactions[key];
                    delete this.pendingTransactions[key];
                    this.log(`🔄 Match por padrão eMola: ${key} para ${referenciaKey}`);
                    return transaction;
                }
            }
        }
        
        return null;
    }

    // NOVA FUNÇÃO: Busca por padrões M-Pesa
    findMpesaPatternMatch(referenciaKey) {
        // Para M-Pesa, busca por referências com estrutura similar
        for (const key of Object.keys(this.pendingTransactions)) {
            if (!key.toUpperCase().startsWith('PP')) {
                // Verifica se têm estrutura similar (letras + números)
                const keyStructure = this.getReferenceStructure(key);
                const refStructure = this.getReferenceStructure(referenciaKey);
                
                if (keyStructure === refStructure) {
                    const transaction = this.pendingTransactions[key];
                    delete this.pendingTransactions[key];
                    this.log(`🔄 Match por padrão M-Pesa: ${key} para ${referenciaKey}`);
                    return transaction;
                }
            }
        }
        
        return null;
    }

    // NOVA FUNÇÃO: Obtém estrutura de uma referência (L=letra, N=número)
    getReferenceStructure(reference) {
        return reference
            .split('')
            .map(char => /[A-Za-z]/.test(char) ? 'L' : /\d/.test(char) ? 'N' : 'S')
            .join('');
    }

    // NOVA FUNÇÃO: Verifica se arrays de números são similares
    arraysAreSimilar(arr1, arr2) {
        if (arr1.length !== arr2.length) return false;
        
        for (let i = 0; i < arr1.length; i++) {
            if (Math.abs(parseInt(arr1[i]) - parseInt(arr2[i])) > 1) {
                return false;
            }
        }
        
        return true;
    }

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
            
            // CORREÇÃO: Melhora detecção de AutoBot
            if (senderName.toLowerCase().includes('autobot') || 
                senderName.toLowerCase().includes('bot') ||
                message.body.includes('AutoBot')) {
                this.log(`🤖 Ignorando mensagem do AutoBot: ${senderName}`);
                return;
            }

            const groupId = this.getGroupId(message);

            // Verifica spam ANTES de processar qualquer outro conteúdo
            const isSpam = await this.detectSpam(message, groupId);
            if (isSpam) {
                return;
            }

            // Verifica se é um comando
            if (message.body.startsWith('.')) {
                await this.handleCommand(message);
                return;
            }

            // CORREÇÃO: Melhora detecção de confirmação
            if (message.body.includes('Transação Concluída Com Sucesso') ||
                message.body.includes('Transacao Concluida Com Sucesso') ||
                message.body.includes('transação concluída') ||
                message.body.includes('transacao concluida')) {
                this.log(`💰 Processando confirmação de transação: ${message.body.substring(0, 50)}...`);
                await this.processConfirmation(message);
                return;
            }

            const hasReference = this.extractReference(message.body);
            const hasImage = message.hasMedia;
            
            if (hasReference || hasImage) {
                this.log(`📋 Processando possível comprovativo: hasRef=${!!hasReference}, hasImage=${hasImage}`);
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

                case '.debug':
                    await this.sendDebugInfo(message, groupId);
                    break;
                
                default:
                    // Comando não reconhecido - não faz nada
                    break;
            }
        } catch (error) {
            this.log('Erro ao processar comando:', error.message);
        }
    }

    // FUNÇÃO MELHORADA: Comando de debug com informações detalhadas do sistema de referências
    async sendDebugInfo(message, groupId) {
        try {
            const pendingCount = Object.keys(this.pendingTransactions).length;
            const compradores = this.getCompradores(groupId);
            const compradoresCount = Object.keys(compradores).length;
            
            let debugText = `🔧 *DEBUG DO BOT* 🔧\n\n`;
            debugText += `📊 **Estatísticas:**\n`;
            debugText += `   • Transações pendentes: ${pendingCount}\n`;
            debugText += `   • Compradores registados: ${compradoresCount}\n\n`;
            
            if (pendingCount > 0) {
                debugText += `📋 **Referências pendentes:**\n`;
                
                // Agrupa por tipo de referência
                const byType = {};
                Object.keys(this.pendingTransactions).forEach(ref => {
                    const transaction = this.pendingTransactions[ref];
                    const type = transaction.referenceType || 'Desconhecido';
                    if (!byType[type]) byType[type] = [];
                    byType[type].push({ ref, transaction });
                });
                
                Object.entries(byType).forEach(([type, refs]) => {
                    debugText += `   📌 **${type}:**\n`;
                    refs.slice(0, 3).forEach(({ ref, transaction }) => {
                        const timeAgo = Math.floor((Date.now() - transaction.timestamp) / 1000 / 60);
                        debugText += `      • ${ref} (${transaction.nome}, ${timeAgo}min)\n`;
                    });
                    if (refs.length > 3) {
                        debugText += `      ... e mais ${refs.length - 3}\n`;
                    }
                });
                
                if (pendingCount > 10) {
                    debugText += `\n📊 **Total:** ${pendingCount} transações pendentes\n`;
                }
            }
            
            debugText += `\n🔍 **Sistema de Referências:**\n`;
            debugText += `   • Padrões M-Pesa: 25+ formatos suportados\n`;
            debugText += `   • Padrões eMola: 15+ formatos suportados\n`;
            debugText += `   • Normalização: SEMPRE ignora último ponto\n`;
            debugText += `   • Matching inteligente: Similaridade + padrões\n`;
            debugText += `   • Validação automática: Formato + estrutura\n`;
            
            debugText += `\n⏰ **Hora do sistema:** ${new Date().toLocaleString('pt-BR')}`;
            
            await message.reply(debugText);
            this.log(`🔧 Debug detalhado enviado para o grupo ${groupId}`);

        } catch (error) {
            this.log('Erro ao enviar debug:', error.message);
        }
    }

    async sendRanking(message, groupId) {
        try {
            const compradores = this.getCompradores(groupId);
            const sorted = Object.entries(compradores)
                .sort((a, b) => b[1].quantidadeTotal - a[1].quantidadeTotal)
                .slice(0, 20);

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

            inativos.sort((a, b) => b.diasSemComprar - a.diasSemComprar);

            let inativosText = '😴 *COMPRADORES INATIVOS* 😴\n';
            inativosText += `*(Mais de 15 dias sem comprar)*\n\n`;

            const mentions = [];

            inativos.slice(0, 15).forEach((comprador, index) => {
                const total = this.formatMegas(comprador.totalComprado);
                
                inativosText += `📱 @${comprador.phone.replace('+', '')}\n`;
                inativosText += `   ⏰ ${comprador.diasSemComprar} dias sem comprar\n`;
                inativosText += `   📊 Total: ${total}\n\n`;
                
                mentions.push(`${comprador.phone.replace('+', '')}@c.us`);
            });

            if (inativos.length > 15) {
                inativosText += `... e mais ${inativos.length - 15} compradores inativos.`;
            }

            await this.client.sendMessage(groupId, inativosText, {
                mentions: mentions
            });

            this.log(`😴 Lista de inativos enviada para o grupo ${groupId}`);

        } catch (error) {
            this.log('Erro ao enviar lista de inativos:', error.message);
        }
    }

    async sendSemRegistro(message, groupId) {
        try {
            if (groupId === 'private') {
                await message.reply('📝 Este comando só funciona em grupos.');
                return;
            }

            const chat = await this.client.getChatById(groupId);
            const participants = chat.participants;
            
            const compradores = this.getCompradores(groupId);
            const semCompras = [];

            participants.forEach(participant => {
                const phoneNumber = `+${participant.id.user}`;
                
                if (!compradores[phoneNumber] || compradores[phoneNumber].quantidadeTotal === 0) {
                    const nome = participant.pushname || 
                                compradores[phoneNumber]?.nome || 
                                participant.id.user;
                    
                    semCompras.push({
                        phone: phoneNumber,
                        nome: nome,
                        temRegisto: !!compradores[phoneNumber],
                        participantId: participant.id._serialized
                    });
                }
            });

            if (semCompras.length === 0) {
                await message.reply('📝 *SEM REGISTO DE COMPRAS*\n\nTodos os membros do grupo já fizeram pelo menos uma compra! 🎉');
                return;
            }

            let semRegistroText = '📝 *MEMBROS SEM COMPRAS* 📝\n';
            semRegistroText += `*(Membros do grupo que nunca compraram)*\n\n`;

            const mentions = [];

            semCompras.slice(0, 20).forEach((membro, index) => {
                const status = membro.temRegisto ? '📋 Registado' : '❌ Sem registo';
                
                semRegistroText += `📱 @${membro.phone.replace('+', '')}\n`;
                semRegistroText += `   ${status} • 0 MB comprados\n\n`;
                
                mentions.push(`${membro.phone.replace('+', '')}@c.us`);
            });

            if (semCompras.length > 20) {
                semRegistroText += `... e mais ${semCompras.length - 20} membros sem compras.`;
            }

            semRegistroText += `\n💡 *Total sem compras:* ${semCompras.length}/${participants.length} membros`;

            await this.client.sendMessage(groupId, semRegistroText, {
                mentions: mentions
            });

            this.log(`📝 Lista de membros sem registo enviada para o grupo ${groupId} - ${semCompras.length}/${participants.length} membros`);

        } catch (error) {
            this.log('Erro ao enviar lista sem registo:', error.message);
            await message.reply('❌ Erro ao obter lista de membros do grupo. Certifique-se de que o bot é administrador.');
        }
    }

    async executarLimpeza(message, groupId) {
        try {
            if (groupId === 'private') {
                await message.reply('🚫 Este comando só funciona em grupos.');
                return;
            }

            const chat = await this.client.getChatById(groupId);
            const senderNumber = message.author || message.from.replace('@c.us', '');
            
            const senderParticipant = chat.participants.find(p => p.id.user === senderNumber.replace('@c.us', ''));
            
            if (!senderParticipant || !senderParticipant.isAdmin) {
                await message.reply('🚫 *ACESSO NEGADO*\n\nApenas administradores podem executar limpeza do grupo.');
                return;
            }

            const botInfo = await this.client.info;
            const botParticipant = chat.participants.find(p => p.id.user === botInfo.wid.user);
            
            if (!botParticipant || !botParticipant.isAdmin) {
                await message.reply('🚫 *BOT SEM PERMISSÃO*\n\nO bot precisa ser administrador para remover membros.');
                return;
            }

            const participants = chat.participants;
            const compradores = this.getCompradores(groupId);
            const semCompras = [];

            participants.forEach(participant => {
                const phoneNumber = `+${participant.id.user}`;
                
                if (participant.isAdmin || participant.id.user === botInfo.wid.user) {
                    return;
                }
                
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

            const confirmMsg = `🧹 *CONFIRMAÇÃO DE LIMPEZA* 🧹\n\n` +
                `⚠️ Será removido ${semCompras.length} membro(s) sem compras:\n\n` +
                semCompras.slice(0, 10).map(m => `• ${m.nome}`).join('\n') +
                (semCompras.length > 10 ? `\n... e mais ${semCompras.length - 10}` : '') +
                `\n\n📋 *PROTEGIDOS:* Administradores não serão removidos\n\n` +
                `Para confirmar, responda com: *.confirmar*\n` +
                `Para cancelar, ignore esta mensagem.`;

            await message.reply(confirmMsg);

            const currentTimestamp = Date.now();
            this.pendingCleanup = {
                groupId: groupId,
                membersToRemove: semCompras,
                requestedBy: senderNumber,
                timestamp: currentTimestamp
            };

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

            if (!this.pendingCleanup || this.pendingCleanup.groupId !== groupId) {
                await message.reply('❌ Não há limpeza pendente para confirmar.');
                return;
            }

            if (this.pendingCleanup.requestedBy !== senderNumber) {
                await message.reply('🚫 Apenas quem solicitou a limpeza pode confirmar.');
                return;
            }

            const membersToRemove = this.pendingCleanup.membersToRemove;
            this.pendingCleanup = null;

            await message.reply(`🧹 *INICIANDO LIMPEZA...*\n\nRemoção de ${membersToRemove.length} membro(s) em andamento...`);

            let removidos = 0;
            let erros = 0;

            for (const member of membersToRemove) {
                try {
                    await this.client.removeParticipant(groupId, member.id);
                    removidos++;
                    this.log(`✅ Removido: ${member.nome} (${member.phone})`);
                    
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                } catch (error) {
                    erros++;
                    this.log(`❌ Erro ao remover ${member.nome}: ${error.message}`);
                }
            }

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

    async executarLimpezaNumeros(message, groupId) {
        try {
            if (groupId === 'private') {
                await message.reply('🚫 Este comando só funciona em grupos.');
                return;
            }

            const chat = await this.client.getChatById(groupId);
            const senderNumber = message.author || message.from.replace('@c.us', '');
            
            const senderParticipant = chat.participants.find(p => p.id.user === senderNumber.replace('@c.us', ''));
            
            if (!senderParticipant || !senderParticipant.isAdmin) {
                await message.reply('🚫 *ACESSO NEGADO*\n\nApenas administradores podem executar limpeza de números.');
                return;
            }

            const botInfo = await this.client.info;
            const botParticipant = chat.participants.find(p => p.id.user === botInfo.wid.user);
            
            if (!botParticipant || !botParticipant.isAdmin) {
                await message.reply('🚫 *BOT SEM PERMISSÃO*\n\nO bot precisa ser administrador para remover membros.');
                return;
            }

            const participants = chat.participants;
            const numerosEstrangeiros = [];

            participants.forEach(participant => {
                const phoneNumber = participant.id.user;
                
                if (participant.isAdmin || phoneNumber === botInfo.wid.user) {
                    return;
                }
                
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

            const confirmMsg = `🇲🇿 *CONFIRMAÇÃO DE LIMPEZA NÚMEROS* 🇲🇿\n\n` +
                `⚠️ Será removido ${numerosEstrangeiros.length} número(s) estrangeiro(s):\n\n` +
                numerosEstrangeiros.slice(0, 10).map(m => `• ${m.nome} (+${m.phone})`).join('\n') +
                (numerosEstrangeiros.length > 10 ? `\n... e mais ${numerosEstrangeiros.length - 10}` : '') +
                `\n\n📋 *PROTEGIDOS:* Administradores não serão removidos\n` +
                `🇲🇿 *CRITÉRIO:* Apenas números +258 são aceites\n\n` +
                `Para confirmar, responda com: *.confirmar.numeros*\n` +
                `Para cancelar, ignore esta mensagem.`;

            await message.reply(confirmMsg);

            const currentTimestamp = Date.now();
            this.pendingNumberCleanup = {
                groupId: groupId,
                numbersToRemove: numerosEstrangeiros,
                requestedBy: senderNumber,
                timestamp: currentTimestamp
            };

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

            if (!this.pendingNumberCleanup || this.pendingNumberCleanup.groupId !== groupId) {
                await message.reply('❌ Não há limpeza de números pendente para confirmar.');
                return;
            }

            if (this.pendingNumberCleanup.requestedBy !== senderNumber) {
                await message.reply('🚫 Apenas quem solicitou a limpeza pode confirmar.');
                return;
            }

            const numbersToRemove = this.pendingNumberCleanup.numbersToRemove;
            this.pendingNumberCleanup = null;

            await message.reply(`🇲🇿 *INICIANDO LIMPEZA DE NÚMEROS...*\n\nRemoção de ${numbersToRemove.length} número(s) estrangeiro(s) em andamento...`);

            let removidos = 0;
            let erros = 0;

            for (const member of numbersToRemove) {
                try {
                    await this.client.removeParticipant(groupId, member.id);
                    removidos++;
                    this.log(`✅ Removido número estrangeiro: ${member.nome} (+${member.phone})`);
                    
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    
                } catch (error) {
                    erros++;
                    this.log(`❌ Erro ao remover ${member.nome}: ${error.message}`);
                }
            }

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
            
            setInterval(() => {
                this.cleanupSpamData();
            }, 300000);
            
            // NOVO: Limpeza periódica de transações pendentes antigas (a cada 10 minutos)
            setInterval(() => {
                this.cleanupOldPendingTransactions();
            }, 600000);
            
        } catch (error) {
            this.log('❌ Erro ao iniciar bot:', error.message);
        }
    }

    // NOVO: Limpeza de transações pendentes antigas (mais de 30 minutos)
    cleanupOldPendingTransactions() {
        const now = Date.now();
        const maxAge = 30 * 60 * 1000; // 30 minutos
        let cleaned = 0;

        Object.keys(this.pendingTransactions).forEach(key => {
            const transaction = this.pendingTransactions[key];
            if (now - transaction.timestamp > maxAge) {
                delete this.pendingTransactions[key];
                cleaned++;
            }
        });

        if (cleaned > 0) {
            this.savePendingData();
            this.log(`🧹 Limpeza automática: ${cleaned} transações pendentes antigas removidas`);
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
            this.log('📋 Comandos disponíveis: .ranking, .inativos, .semregistro, .limpeza, .limpar.numeros, .debug');
            this.log('🛡️ Sistema anti-spam ativo: 5 mensagens idênticas em 1 minuto');
            this.log('🇲🇿 Proteção automática: Remove números não moçambicanos (+258)');
            this.log('🧹 Limpeza automática: Transações pendentes antigas são removidas a cada 10 minutos');
            
            // NOVAS FUNCIONALIDADES DO SISTEMA DE REFERÊNCIAS
            this.log('🔍 SISTEMA DE REFERÊNCIAS AVANÇADO:');
            this.log('   • 25+ padrões M-Pesa suportados (Confirmado, Referência, ID, Código, etc.)');
            this.log('   • 15+ padrões eMola suportados (PP + números + separadores)');
            this.log('   • Normalização CORRIGIDA: SEMPRE ignora o último ponto');
            this.log('   • Validação automática: Formato + estrutura + tipo');
            this.log('   • Matching inteligente: Exato + similaridade + padrões');
            this.log('   • Algoritmo de Levenshtein para cálculo de similaridade');
            this.log('   • Análise de estrutura (L=letra, N=número, S=símbolo)');
            this.log('   • Suporte a separadores: pontos, hífens, underscores');
            this.log('   • Integração OpenAI melhorada para análise de imagens');
            
            // TESTE DE NORMALIZAÇÃO
            this.log('\n🧪 TESTE DE NORMALIZAÇÃO:');
            this.testNormalization();
            
            // TESTE DE EXEMPLOS REAIS
            this.log('\n🧪 TESTE DE EXEMPLOS REAIS:');
            this.testRealExamples();
            
        } catch (error) {
            this.log('❌ Erro no teste do bot:', error.message);
        }
    }

    // NOVA FUNÇÃO: Teste de matching com exemplos reais
    testRealExamples() {
        this.log('\n🧪 TESTE DE EXEMPLOS REAIS:');
        
        // Simula transações pendentes (comprovativos)
        const pendingTransactions = {
            'PP250820.1925.P55378': {
                sender: '841417347',
                nome: 'NATACHA ALICE TIMANA',
                timestamp: Date.now() - 300000, // 5 minutos atrás
                messageId: 'msg1',
                groupId: 'test-group',
                originalReference: 'PP250820.1925.P55378',
                referenceType: 'eMola'
            },
            'CHK7H3PXRNJ': {
                sender: '856070113',
                nome: 'NATACHA',
                timestamp: Date.now() - 600000, // 10 minutos atrás
                messageId: 'msg2',
                groupId: 'test-group',
                originalReference: 'CHK7H3PXRNJ',
                referenceType: 'M-Pesa'
            },
            'PP250820.1350.k93393': {
                sender: '841417347',
                nome: 'NATACHA ALICE TIMANA',
                timestamp: Date.now() - 900000, // 15 minutos atrás
                messageId: 'msg3',
                groupId: 'test-group',
                originalReference: 'PP250820.1350.k93393',
                referenceType: 'eMola'
            },
            'PP250820.1337.h52287': {
                sender: '855429098',
                nome: 'NATACHA ALICE TIMANA',
                timestamp: Date.now() - 1200000, // 20 minutos atrás
                messageId: 'msg4',
                groupId: 'test-group',
                originalReference: 'PP250820.1337.h52287',
                referenceType: 'eMola'
            }
        };
        
        // Simula confirmações
        const confirmations = [
            {
                text: '✅ Transação Concluída Com Sucesso\n\n📱 Número: 855429098\n📊 Megas: 1024 MB\n🔖 Referência: PP250820.1337.h52287\n⏰ Data/Hora: 20-08-25 às 13.40\n\nTransferencia Processada Automaticamente Pelo Sistema',
                expectedRef: 'PP250820.1337.h52287',
                expectedMegas: 1024
            },
            {
                text: '✅ Transação Concluída Com Sucesso\n\n📱 Número: 846518049\n📊 Megas: 1024 MB\n🔖 Referência: PP250820.1713.Q66348\n⏰ Data/Hora: 20-08-25 às 17.14\n\nTransferencia Processada Automaticamente Pelo Sistema',
                expectedRef: 'PP250820.1713.Q66348',
                expectedMegas: 1024
            },
            {
                text: '✅ Transação Concluída Com Sucesso\n\n📱 Número: 846518019\n📊 Megas: 1024 MB\n🔖 Referência: PP250820.1707.R22988\n⏰ Data/Hora: 20-08-25 às 17.10\n\nTransferencia Processada Automaticamente Pelo Sistema',
                expectedRef: 'PP250820.1707.R22988',
                expectedMegas: 1024
            }
        ];
        
        // Testa extração de referências
        this.log('\n📋 TESTE DE EXTRAÇÃO DE REFERÊNCIAS:');
        confirmations.forEach((conf, index) => {
            const extractedRef = this.extractReference(conf.text);
            const extractedMegas = this.extractMegas(conf.text);
            const normalizedRef = this.normalizeReference(extractedRef);
            
            this.log(`\n   Confirmação ${index + 1}:`);
            this.log(`   Texto: ${conf.text.substring(0, 100)}...`);
            this.log(`   Referência extraída: ${extractedRef}`);
            this.log(`   Referência normalizada: ${normalizedRef}`);
            this.log(`   Megas extraídas: ${extractedMegas}`);
            this.log(`   Esperado: ${conf.expectedRef} / ${conf.expectedMegas}MB`);
            this.log(`   ✅ Extração: ${extractedRef === conf.expectedRef ? 'CORRETA' : 'INCORRETA'}`);
            this.log(`   ✅ Megas: ${extractedMegas === conf.expectedMegas ? 'CORRETAS' : 'INCORRETAS'}`);
        });
        
        // Testa matching
        this.log('\n🔍 TESTE DE MATCHING:');
        this.pendingTransactions = { ...pendingTransactions };
        
        confirmations.forEach((conf, index) => {
            const extractedRef = this.extractReference(conf.text);
            if (extractedRef) {
                const normalizedRef = this.normalizeReference(extractedRef);
                const match = this.findBestMatch(normalizedRef, extractedRef);
                
                this.log(`\n   Confirmação ${index + 1} (${extractedRef}):`);
                if (match) {
                    this.log(`   ✅ MATCH ENCONTRADO: ${match.nome} (${match.sender})`);
                    this.log(`   📱 Número: ${match.sender}`);
                    this.log(`   👤 Nome: ${match.nome}`);
                    this.log(`   📋 Tipo: ${match.referenceType}`);

                    // Simula mensagem personalizada
                    const megas = this.extractMegas(conf.text);
                    if (megas) {
                        const phoneNumber = `+258${match.sender}`;
                        const posicao = 1; // Simula posição
                        const mensagem = this.generatePersonalizedMessage(phoneNumber, megas, megas, posicao, match.nome, 'test-group');
                        this.log(`   💬 Mensagem simulada: ${mensagem.substring(0, 100)}...`);
                    }
                } else {
                    this.log(`   ❌ NENHUM MATCH ENCONTRADO`);
                    this.log(`   📋 Referências pendentes: ${Object.keys(this.pendingTransactions).join(', ')}`);
                }
            }
        });
        
        // Restaura estado original
        this.pendingTransactions = {};
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

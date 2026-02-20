import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { RawRecordSchema, type RawRecord } from '../typesRaw';
import { ApiMessage } from '../api/types/apiTypes';
import { DecryptedMessage, Metadata, MetadataSchema, AgentState, AgentStateSchema } from '../domains/state/storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';

type EncryptedApiMessage = ApiMessage & { content: { t: 'encrypted'; c: string } };

function isEncryptedApiMessage(message: ApiMessage): message is EncryptedApiMessage {
    const content: any = (message as any)?.content;
    return Boolean(content && content.t === 'encrypted' && typeof content.c === 'string');
}

export class SessionEncryption {
    private sessionId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;

    constructor(
        sessionId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache
    ) {
        this.sessionId = sessionId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    /**
     * Batch-first API for decrypting messages
     */
    async decryptMessages(messages: ApiMessage[]): Promise<(DecryptedMessage | null)[]> {
        const computeCiphertextFingerprint = (ciphertextB64: string): string => {
            // Avoid storing full ciphertext in-memory; keep a cheap fingerprint so we can
            // detect streaming updates that reuse message ids.
            const value = String(ciphertextB64 ?? '');
            const len = value.length;
            const start = value.slice(0, 24);
            const end = value.slice(Math.max(0, len - 24));
            return `enc:${len}:${start}:${end}`;
        };

        const computePlainValueFingerprint = (value: unknown): string => {
            try {
                const json = JSON.stringify(value);
                const len = json.length;
                const start = json.slice(0, 48);
                const end = json.slice(Math.max(0, len - 48));
                return `plain:${len}:${start}:${end}`;
            } catch {
                return "plain:unserializable";
            }
        };

        const computeMessageFingerprint = (message: ApiMessage): string => {
            const content: any = (message as any)?.content;
            if (content && content.t === 'encrypted' && typeof content.c === 'string') {
                return computeCiphertextFingerprint(content.c);
            }
            if (content && content.t === 'plain') {
                return computePlainValueFingerprint(content.v);
            }
            return 'plain:unknown';
        };

        // Check cache for all messages first
        const results: (DecryptedMessage | null)[] = new Array(messages.length);
        const toDecrypt: { index: number; message: EncryptedApiMessage; fingerprint: string }[] = [];

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message) {
                results[i] = null;
                continue;
            }

            // Check cache first
            const fingerprint = computeMessageFingerprint(message);
            const cached = this.cache.getCachedMessage(message.id, fingerprint);
            if (cached) {
                // Encrypted messages that previously failed to decrypt (content: null) must be
                // re-tried, because the session key/encryptor may become available later.
                if (cached.content !== null || message.content.t !== 'encrypted') {
                    results[i] = cached;
                    continue;
                }
            } else if (isEncryptedApiMessage(message)) {
                toDecrypt.push({ index: i, message, fingerprint });
            } else if (message.content.t === 'plain') {
                const parsed = RawRecordSchema.safeParse((message.content as any).v);
                const result: DecryptedMessage = {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    content: parsed.success ? parsed.data : null,
                    createdAt: message.createdAt,
                };
                results[i] = result;
                this.cache.setCachedMessage(message.id, result, fingerprint);
            } else {
                // Invalid content
                results[i] = {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    content: null,
                    createdAt: message.createdAt,
                };
                this.cache.setCachedMessage(message.id, results[i]!, fingerprint);
            }
        }

        // Batch decrypt uncached messages
        if (toDecrypt.length > 0) {
            const encrypted = toDecrypt.map(item =>
                decodeBase64(item.message.content.c, 'base64')
            );
            
            const decrypted = await this.encryptor.decrypt(encrypted);

            for (let i = 0; i < toDecrypt.length; i++) {
                const decryptedData = decrypted[i];
                const { message, index } = toDecrypt[i];

                if (decryptedData) {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        content: decryptedData,
                        createdAt: message.createdAt,
                    };
                    this.cache.setCachedMessage(message.id, result, toDecrypt[i].fingerprint);
                    results[index] = result;
                } else {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        content: null,
                        createdAt: message.createdAt,
                    };
                    // Do not cache failed decrypts for encrypted messages.
                    // Otherwise a transient failure (wrong key, delayed key init, etc) can
                    // permanently poison the message cache and make sessions look empty.
                    results[index] = result;
                }
            }
        }

        return results;
    }

    /**
     * Single message convenience method
     */
    async decryptMessage(message: ApiMessage | null | undefined): Promise<DecryptedMessage | null> {
        if (!message) {
            return null;
        }
        const results = await this.decryptMessages([message]);
        return results[0];
    }

    /**
     * Encrypt a raw record
     */
    async encryptRawRecord(record: RawRecord): Promise<string> {
        const encrypted = await this.encryptor.encrypt([record]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Encrypt raw data using session-specific encryption
     */
    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.encryptor.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt raw data using session-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Encrypt metadata using session-specific encryption
     */
    async encryptMetadata(metadata: Metadata): Promise<string> {
        const encrypted = await this.encryptor.encrypt([metadata]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt metadata using session-specific encryption
     */
    async decryptMetadata(version: number, encrypted: string): Promise<Metadata | null> {
        // Check cache first
        const cached = this.cache.getCachedMetadata(this.sessionId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        const encryptedData = decodeBase64(encrypted, 'base64');
        const decrypted = await this.encryptor.decrypt([encryptedData]);
        if (!decrypted[0]) {
            return null;
        }
        const parsed = MetadataSchema.safeParse(decrypted[0]);
        if (!parsed.success) {
            return null;
        }

        // Cache the result
        this.cache.setCachedMetadata(this.sessionId, version, parsed.data);
        return parsed.data;
    }

    /**
     * Encrypt agent state using session-specific encryption
     */
    async encryptAgentState(state: AgentState): Promise<string> {
        const encrypted = await this.encryptor.encrypt([state]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt agent state using session-specific encryption
     */
    async decryptAgentState(version: number, encrypted: string | null | undefined): Promise<AgentState> {
        if (!encrypted) {
            return {};
        }

        // Check cache first
        const cached = this.cache.getCachedAgentState(this.sessionId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        const encryptedData = decodeBase64(encrypted, 'base64');
        const decrypted = await this.encryptor.decrypt([encryptedData]);
        if (!decrypted[0]) {
            return {};
        }
        const parsed = AgentStateSchema.safeParse(decrypted[0]);
        if (!parsed.success) {
            return {};
        }

        // Cache the result
        this.cache.setCachedAgentState(this.sessionId, version, parsed.data);
        return parsed.data;
    }
}

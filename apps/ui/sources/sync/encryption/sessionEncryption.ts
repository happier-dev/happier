import { encodeBase64 } from '@/encryption/base64';
import { RawRecordSchema, type RawRecord } from '../typesRaw';
import { ApiMessage } from '../api/types/apiTypes';
import { DecryptedMessage, Metadata, MetadataSchema, AgentState, AgentStateSchema } from '../domains/state/storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';
import { runWithInFlightDedupe } from '../runtime/orchestration/runWithInFlightDedupe';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { decryptBase64Payloads } from './decryptBase64Payloads';

type EncryptedApiMessage = ApiMessage & { content: { t: 'encrypted'; c: string } };

function isEncryptedApiMessage(message: ApiMessage): message is EncryptedApiMessage {
    const content: any = (message as any)?.content;
    return Boolean(content && content.t === 'encrypted' && typeof content.c === 'string');
}

function computeCiphertextFingerprint(ciphertextB64: string): string {
    const value = String(ciphertextB64 ?? '');
    const len = value.length;
    const start = value.slice(0, 24);
    const end = value.slice(Math.max(0, len - 24));
    return `${len}:${start}:${end}`;
}

export class SessionEncryption {
    private sessionId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;
    private readonly metadataDecryptInFlight = new Map<string, Promise<Metadata | null>>();
    private readonly agentStateDecryptInFlight = new Map<string, Promise<AgentState>>();
    private readonly snapshotStateDecryptInFlight = new Map<string, Promise<{ metadata: Metadata | null; agentState: AgentState }>>();

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
        const computeMessageCiphertextFingerprint = (ciphertextB64: string): string => {
            // Avoid storing full ciphertext in-memory; keep a cheap fingerprint so we can
            // detect streaming updates that reuse message ids.
            return `enc:${computeCiphertextFingerprint(ciphertextB64)}`;
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
                return computeMessageCiphertextFingerprint(content.c);
            }
            if (content && content.t === 'plain') {
                return computePlainValueFingerprint(content.v);
            }
            return 'plain:unknown';
        };

        // Check cache for all messages first
        const results: (DecryptedMessage | null)[] = new Array(messages.length);
        const toDecrypt: { index: number; message: EncryptedApiMessage; fingerprint: string }[] = [];
        let cachedCount = 0;
        let plainCount = 0;
        let invalidCount = 0;

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message) {
                results[i] = null;
                invalidCount++;
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
                    cachedCount++;
                    continue;
                }
                if (isEncryptedApiMessage(message)) {
                    toDecrypt.push({ index: i, message, fingerprint });
                } else {
                    results[i] = cached;
                    cachedCount++;
                }
            } else if (isEncryptedApiMessage(message)) {
                toDecrypt.push({ index: i, message, fingerprint });
            } else if (message.content.t === 'plain') {
                plainCount++;
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
                invalidCount++;
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

        syncPerformanceTelemetry.count('sync.encryption.decryptMessages.scan', {
            messages: messages.length,
            toDecrypt: toDecrypt.length,
            cached: cachedCount,
            plain: plainCount,
            invalid: invalidCount,
        });

        // Batch decrypt uncached messages
        if (toDecrypt.length > 0) {
            const decrypted = await decryptBase64Payloads(
                this.encryptor,
                toDecrypt.map((item) => item.message.content.c),
                {
                    decryptName: 'sync.encryption.decryptMessages.batchDecrypt',
                    decryptFields: { messages: toDecrypt.length },
                    decode: {
                        name: 'sync.encryption.decryptMessages.decodeCiphertext',
                        fields: { messages: toDecrypt.length },
                    },
                },
            );

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
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.session.encryptRawRecord',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([record]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    /**
     * Encrypt raw data using session-specific encryption
     */
    async encryptRaw(data: any): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.session.encryptRaw',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([data]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    /**
     * Decrypt raw data using session-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const decrypted = await decryptBase64Payloads(this.encryptor, [encrypted], {
                decryptName: 'sync.encryption.decryptRaw',
                decryptFields: { items: 1 },
            });
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Encrypt metadata using session-specific encryption
     */
    async encryptMetadata(metadata: Metadata): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.session.encryptMetadata',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([metadata]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
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

        const key = this.buildDedupeKey('metadata', version, encrypted);
        return runWithInFlightDedupe(
            {
                get: () => this.metadataDecryptInFlight.get(key) ?? null,
                set: (value) => {
                    if (value) {
                        this.metadataDecryptInFlight.set(key, value);
                    } else {
                        this.metadataDecryptInFlight.delete(key);
                    }
                },
            },
            () => this.decryptMetadataUncached(version, encrypted),
        );
    }

    private async decryptMetadataUncached(version: number, encrypted: string): Promise<Metadata | null> {
        // Decrypt if not cached
        const decrypted = await decryptBase64Payloads(this.encryptor, [encrypted], {
            decryptName: 'sync.encryption.decryptMetadata',
            decryptFields: { items: 1 },
        });
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
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.session.encryptAgentState',
            { items: 1 },
            async () => {
                const encrypted = await this.encryptor.encrypt([state]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
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

        const key = this.buildDedupeKey('agentState', version, encrypted);
        return runWithInFlightDedupe(
            {
                get: () => this.agentStateDecryptInFlight.get(key) ?? null,
                set: (value) => {
                    if (value) {
                        this.agentStateDecryptInFlight.set(key, value);
                    } else {
                        this.agentStateDecryptInFlight.delete(key);
                    }
                },
            },
            () => this.decryptAgentStateUncached(version, encrypted),
        );
    }

    private async decryptAgentStateUncached(version: number, encrypted: string): Promise<AgentState> {
        // Decrypt if not cached
        const decrypted = await decryptBase64Payloads(this.encryptor, [encrypted], {
            decryptName: 'sync.encryption.decryptAgentState',
            decryptFields: { items: 1 },
        });
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

    private buildDedupeKey(kind: 'metadata' | 'agentState', version: number, encrypted: string): string {
        return `${kind}:${this.sessionId}:${version}:${computeCiphertextFingerprint(encrypted)}`;
    }

    async decryptSessionSnapshotState(
        metadataVersion: number,
        encryptedMetadata: string,
        agentStateVersion: number,
        encryptedAgentState: string | null | undefined,
    ): Promise<{ metadata: Metadata | null; agentState: AgentState }> {
        const key = this.buildSnapshotStateDedupeKey(
            metadataVersion,
            encryptedMetadata,
            agentStateVersion,
            encryptedAgentState,
        );
        return runWithInFlightDedupe(
            {
                get: () => this.snapshotStateDecryptInFlight.get(key) ?? null,
                set: (value) => {
                    if (value) {
                        this.snapshotStateDecryptInFlight.set(key, value);
                    } else {
                        this.snapshotStateDecryptInFlight.delete(key);
                    }
                },
            },
            () => this.decryptSessionSnapshotStateUncached(
                metadataVersion,
                encryptedMetadata,
                agentStateVersion,
                encryptedAgentState,
            ),
        );
    }

    private async decryptSessionSnapshotStateUncached(
        metadataVersion: number,
        encryptedMetadata: string,
        agentStateVersion: number,
        encryptedAgentState: string | null | undefined,
    ): Promise<{ metadata: Metadata | null; agentState: AgentState }> {
        const cachedMetadata = this.cache.getCachedMetadata(this.sessionId, metadataVersion);
        const cachedAgentState = encryptedAgentState
            ? this.cache.getCachedAgentState(this.sessionId, agentStateVersion)
            : {};
        const metadataNeedsDecrypt = !cachedMetadata;
        const agentStateNeedsDecrypt = !cachedAgentState && Boolean(encryptedAgentState);
        const decodeTaskCount = (metadataNeedsDecrypt ? 1 : 0) + (agentStateNeedsDecrypt ? 1 : 0);

        const tasks: Array<{ kind: 'metadata' | 'agentState'; encrypted: string }> = [];
        if (metadataNeedsDecrypt) {
            tasks.push({ kind: 'metadata', encrypted: encryptedMetadata });
        }
        if (agentStateNeedsDecrypt && encryptedAgentState) {
            tasks.push({ kind: 'agentState', encrypted: encryptedAgentState });
        }

        let metadata: Metadata | null = cachedMetadata;
        let agentState: AgentState | null = cachedAgentState;

        if (tasks.length > 0) {
            const decrypted = await decryptBase64Payloads(
                this.encryptor,
                tasks.map((task) => task.encrypted),
                {
                    decryptName: 'sync.encryption.decryptSessionSnapshotState',
                    decryptFields: {
                        items: tasks.length,
                        cached: (cachedMetadata ? 1 : 0) + (cachedAgentState ? 1 : 0),
                        metadata: metadataNeedsDecrypt ? 1 : 0,
                        agentState: agentStateNeedsDecrypt ? 1 : 0,
                    },
                    decode: {
                        name: 'sync.encryption.decryptSessionSnapshotState.decodeCiphertext',
                        fields: {
                            items: decodeTaskCount,
                            metadata: metadataNeedsDecrypt ? 1 : 0,
                            agentState: agentStateNeedsDecrypt ? 1 : 0,
                        },
                    },
                },
            );

            tasks.forEach((task, index) => {
                const value = decrypted[index];
                if (task.kind === 'metadata') {
                    const parsed = MetadataSchema.safeParse(value);
                    metadata = parsed.success ? parsed.data : null;
                    if (parsed.success) {
                        this.cache.setCachedMetadata(this.sessionId, metadataVersion, parsed.data);
                    }
                    return;
                }

                const parsed = AgentStateSchema.safeParse(value);
                agentState = parsed.success ? parsed.data : {};
                if (parsed.success) {
                    this.cache.setCachedAgentState(this.sessionId, agentStateVersion, parsed.data);
                }
            });
        }

        return {
            metadata,
            agentState: agentState ?? {},
        };
    }

    private buildSnapshotStateDedupeKey(
        metadataVersion: number,
        encryptedMetadata: string,
        agentStateVersion: number,
        encryptedAgentState: string | null | undefined,
    ): string {
        const agentStateFingerprint = encryptedAgentState
            ? computeCiphertextFingerprint(encryptedAgentState)
            : 'none';
        return [
            'snapshotState',
            this.sessionId,
            metadataVersion,
            computeCiphertextFingerprint(encryptedMetadata),
            agentStateVersion,
            agentStateFingerprint,
        ].join(':');
    }
}

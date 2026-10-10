import type { SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { parseSessionMessageDeliveryResolutionV1, SessionMessageAcceptedDeliveryFactsV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { deriveSessionMutationEqualityTagV1, SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1, SESSION_INPUT_EQUALITY_HKDF_LABEL_V1 } from '@happier-dev/protocol/sessions/mutations/sessionMutationEqualityV1';
import { projectSessionMetadataForWire } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { encodeBase64 } from '@/encryption/base64';
import type { RawRecord } from "@happier-dev/session-core/raw";

import { DecryptedMessage } from '../domains/state/storageTypes';
import { Metadata, MetadataSchema, AgentState, AgentStateSchema } from '@happier-dev/session-core/state';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor, type DecryptOptions } from './encryptor';
import { runWithInFlightDedupe } from '../runtime/orchestration/runWithInFlightDedupe';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { decryptBase64Payloads } from './decryptBase64Payloads';

type EncryptedApiMessage = SessionMessageV1 & { content: { t: 'encrypted'; c: string } };

function isEncryptedApiMessage(message: SessionMessageV1): message is EncryptedApiMessage {
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
    private readonly metadataPayloadDecryptInFlight = new Map<string, Promise<{ payload: unknown; authenticationFailed: boolean }>>();
    private readonly agentStateDecryptInFlight = new Map<string, Promise<AgentState>>();
    private readonly snapshotStateDecryptInFlight = new Map<string, Promise<{ metadata: Metadata | null; agentState: AgentState; metadataAuthenticationFailed: boolean }>>();

    /**
     * The secret this Session's content is sealed with. It never leaves the
     * device and is used here only as HKDF input keying material, never as a
     * cipher key. A SessionEncryption opened without it (a public share view)
     * cannot assert Session-input equality and says so instead of degrading.
     */
    private readonly equalityKeyMaterial: Uint8Array | null;

    constructor(
        sessionId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache,
        equalityKeyMaterial: Uint8Array | null = null,
        private readonly isCurrent: () => boolean = () => true,
    ) {
        this.sessionId = sessionId;
        this.encryptor = encryptor;
        this.cache = cache;
        this.equalityKeyMaterial = equalityKeyMaterial;
    }

    /**
     * Server-opaque equality for one E2EE Session input, keyed by this Session's
     * own encryption material.
     *
     * A Session input is re-encrypted on every attempt, so its ciphertext cannot
     * identify "the same admitted payload" across a lost response. A tag can,
     * and the server only ever compares two client-asserted tags for equality --
     * it never computes one. Keying is therefore free at the server and load
     * bearing at the client: an unkeyed digest of the plaintext, carried beside
     * the ciphertext, would let the server confirm a guessed plaintext.
     *
     * The Session id is the HKDF salt so tags cannot be correlated across
     * Sessions.
     */
    deriveInputEqualityTagV1(canonicalIntent: string): string {
        return this.deriveMutationEqualityTagV1(SESSION_INPUT_EQUALITY_HKDF_LABEL_V1, canonicalIntent);
    }

    /**
     * Session discussion create/post equality, keyed out of the same Session
     * material under its own purpose label so a discussion tag can never be
     * replayed as a Session-input tag.
     */
    deriveDiscussionMutationEqualityTagV1(canonicalIntent: string): string {
        return this.deriveMutationEqualityTagV1(
            SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
            canonicalIntent,
        );
    }

    private deriveMutationEqualityTagV1(
        purpose: typeof SESSION_INPUT_EQUALITY_HKDF_LABEL_V1 | typeof SESSION_DISCUSSION_MUTATION_EQUALITY_HKDF_LABEL_V1,
        canonicalIntent: string,
    ): string {
        const keyMaterial = this.equalityKeyMaterial;
        if (!keyMaterial || keyMaterial.length === 0) {
            throw new Error(`Session ${this.sessionId} has no input-equality key material`);
        }
        return deriveSessionMutationEqualityTagV1({
            keyMaterial,
            sessionId: this.sessionId,
            purpose,
            canonicalIntent,
        });
    }

    /**
     * Batch-first API for decrypting messages
     */
    async decryptMessages(messages: SessionMessageV1[], options: DecryptOptions = {}): Promise<(DecryptedMessage | null)[]> {
        if (!this.isCurrent()) return messages.map(() => null);

        const computeMessageCiphertextFingerprint = (ciphertextB64: string): string => {
            // Avoid storing full ciphertext in-memory; keep a cheap fingerprint so we can
            // detect streaming updates that reuse message ids.
            return `enc:${computeCiphertextFingerprint(ciphertextB64)}`;
        };

        const computeMessageFingerprint = (message: EncryptedApiMessage): string => {
            const messageRole = typeof message.messageRole === 'string' ? message.messageRole : 'null';
            const resolution = parseSessionMessageDeliveryResolutionV1(message.deliveryResolution);
            const deliveryFingerprint = resolution?.kind === 'provider_accepted' && resolution.content.t === 'encrypted'
                ? computeMessageCiphertextFingerprint(resolution.content.c) : 'none';
            return `${computeMessageCiphertextFingerprint(message.content.c)}:role:${messageRole}:delivery:${deliveryFingerprint}`;
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

            // This owner is instantiated only for E2EE Sessions. Validate the
            // stored envelope before checking the cache or parsing any nested
            // payload so a well-formed plaintext record cannot be disclosed
            // under the wrong persisted Session mode.
            if (!isEncryptedApiMessage(message)) {
                invalidCount++;
                results[i] = {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    messageRole: message.messageRole ?? null,
                    content: null,
                    createdAt: message.createdAt,
                };
                continue;
            }

            // Check cache first
            const fingerprint = computeMessageFingerprint(message);
            const cached = this.cache.getCachedMessage(message.id, fingerprint);
            if (cached) {
                // Encrypted messages that previously failed to decrypt (content: null) must be
                // re-tried, because the session key/encryptor may become available later.
                if (cached.content !== null) {
                    results[i] = cached;
                    cachedCount++;
                    continue;
                }
                toDecrypt.push({ index: i, message, fingerprint });
            } else {
                toDecrypt.push({ index: i, message, fingerprint });
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
                {
                    ...options,
                    onAuthenticationFailure: (index) => options.onAuthenticationFailure?.(toDecrypt[index].index),
                },
            );
            const acceptedContent = toDecrypt.map(({ message }) => {
                const resolution = parseSessionMessageDeliveryResolutionV1(message.deliveryResolution);
                return resolution?.kind === 'provider_accepted' && resolution.content.t === 'encrypted'
                    ? resolution.content.c : null;
            });
            const acceptedIndices = acceptedContent.flatMap((content, index) => content === null ? [] : [index]);
            const acceptedFacts = acceptedIndices.length > 0 ? await decryptBase64Payloads(
                this.encryptor, acceptedIndices.map((index) => acceptedContent[index]!),
                { decryptName: 'sync.encryption.decryptMessages.acceptedDelivery', decryptFields: { messages: acceptedIndices.length } },
            ) : [];
            const acceptedDeliveryByIndex = new Map(acceptedIndices.map((index, position) => {
                const parsed = SessionMessageAcceptedDeliveryFactsV1Schema.safeParse(acceptedFacts[position]);
                return [index, parsed.success ? parsed.data : undefined] as const;
            }));
            if (!this.isCurrent()) return messages.map(() => null);

            for (let i = 0; i < toDecrypt.length; i++) {
                const decryptedData = decrypted[i];
                const { message, index } = toDecrypt[i];

                if (decryptedData !== null && decryptedData !== undefined) {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        messageRole: message.messageRole ?? null,
                        content: decryptedData,
                        createdAt: message.createdAt,
                        ...(acceptedDeliveryByIndex.get(i) ? { acceptedDelivery: acceptedDeliveryByIndex.get(i) } : {}),
                    };
                    // Failed protected detail is retryable even when the message itself opened.
                    if (acceptedContent[i] === null || result.acceptedDelivery !== undefined) {
                        this.cache.setCachedMessage(message.id, result, toDecrypt[i].fingerprint, this.sessionId);
                    }
                    results[index] = result;
                } else {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        messageRole: message.messageRole ?? null,
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
    async decryptMessage(message: SessionMessageV1 | null | undefined): Promise<DecryptedMessage | null> {
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
                const encrypted = await this.encryptor.encrypt([projectSessionMetadataForWire(metadata)]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    /**
     * Decrypt a metadata envelope without applying the legacy Metadata schema.
     *
     * Layout-aware readers must admit this raw value through their canonical
     * layout parser. In particular, layout v1 must not pass through
     * MetadataSchema because its legacy defaults make a strict shared envelope
     * invalid and can resurrect owner-only legacy fields.
     */
    async decryptMetadataPayload(version: number, encrypted: string, options: DecryptOptions = {}): Promise<unknown | null> {
        if (!this.isCurrent()) return null;
        const key = this.buildDedupeKey('metadata-payload', version, encrypted);
        const result = await runWithInFlightDedupe(
            {
                get: () => this.metadataPayloadDecryptInFlight.get(key) ?? null,
                set: (value) => {
                    if (value) {
                        this.metadataPayloadDecryptInFlight.set(key, value);
                    } else {
                        this.metadataPayloadDecryptInFlight.delete(key);
                    }
                },
            },
            async () => {
                let authenticationFailed = false;
                const decrypted = await decryptBase64Payloads(this.encryptor, [encrypted], {
                    decryptName: 'sync.encryption.decryptMetadata',
                    decryptFields: { items: 1 },
                }, { onAuthenticationFailure: () => { authenticationFailed = true; } });
                return { payload: decrypted[0] ?? null, authenticationFailed };
            },
        );
        if (!this.isCurrent()) return null;
        if (result.authenticationFailed) options.onAuthenticationFailure?.(0);
        return result.payload;
    }

    /**
     * Decrypt metadata using session-specific encryption
     */
    async decryptMetadata(version: number, encrypted: string, options: DecryptOptions = {}): Promise<Metadata | null> {
        if (!this.isCurrent()) return null;
        // Check cache first
        const cached = this.cache.getCachedMetadata(this.sessionId, version);
        if (cached) {
            return cached;
        }

        return this.decryptMetadataUncached(version, encrypted, options);
    }

    private async decryptMetadataUncached(version: number, encrypted: string, options: DecryptOptions): Promise<Metadata | null> {
        const decrypted = await this.decryptMetadataPayload(version, encrypted, options);
        if (!this.isCurrent() || !decrypted) {
            return null;
        }
        const parsed = MetadataSchema.safeParse(decrypted);
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
        if (!this.isCurrent() || !encrypted) {
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
        if (!this.isCurrent() || !decrypted[0]) {
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

    private buildDedupeKey(
        kind: 'metadata-payload' | 'metadata' | 'agentState',
        version: number,
        encrypted: string,
    ): string {
        return `${kind}:${this.sessionId}:${version}:${computeCiphertextFingerprint(encrypted)}`;
    }

    async decryptSessionSnapshotState(
        metadataVersion: number,
        encryptedMetadata: string,
        agentStateVersion: number,
        encryptedAgentState: string | null | undefined,
        options: DecryptOptions = {},
    ): Promise<{ metadata: Metadata | null; agentState: AgentState }> {
        if (!this.isCurrent()) return { metadata: null, agentState: {} };
        const key = this.buildSnapshotStateDedupeKey(
            metadataVersion,
            encryptedMetadata,
            agentStateVersion,
            encryptedAgentState,
        );
        const result = await runWithInFlightDedupe(
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
        if (!this.isCurrent()) return { metadata: null, agentState: {} };
        if (result.metadataAuthenticationFailed) options.onAuthenticationFailure?.(0);
        return { metadata: result.metadata, agentState: result.agentState };
    }

    private async decryptSessionSnapshotStateUncached(
        metadataVersion: number,
        encryptedMetadata: string,
        agentStateVersion: number,
        encryptedAgentState: string | null | undefined,
    ): Promise<{ metadata: Metadata | null; agentState: AgentState; metadataAuthenticationFailed: boolean }> {
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
        let metadataAuthenticationFailed = false;

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
                { onAuthenticationFailure: (index) => {
                    if (tasks[index].kind === 'metadata') metadataAuthenticationFailed = true;
                } },
            );
            if (!this.isCurrent()) {
                return { metadata: null, agentState: {}, metadataAuthenticationFailed: false };
            }

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
            metadataAuthenticationFailed,
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

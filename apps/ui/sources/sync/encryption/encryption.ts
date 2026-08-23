import { deriveKey } from "@/encryption/deriveKey";
import {
    AES256Encryption,
    BoxEncryption,
    SecretBoxEncryption,
    Encryptor,
    Decryptor,
    DEFAULT_AES_BATCH_CONCURRENCY_LIMIT,
    normalizeAesBatchConcurrencyLimit,
} from "./encryptor";
import { encodeHex } from "@/encryption/hex";
import { EncryptionCache } from "./encryptionCache";
import { mapCryptoBatchWithYield } from "./cryptoBatchYield";
import { SessionEncryption } from "./sessionEncryption";
import { MachineEncryption } from "./machineEncryption";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium, { type LibsodiumKeyPair } from '@/encryption/libsodium.lib';
import { decryptBox, encryptBox } from "@/encryption/libsodium";
import { randomUUID } from '@/platform/randomUUID';
import { getRandomBytes } from '@/platform/cryptoRandom';
import {
    openAccountScopedBlobCiphertext,
    openEncryptedDataKeyEnvelopeV1,
    sealAccountScopedBlobCiphertext,
    sealEncryptedDataKeyEnvelopeV1,
    type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';
import { syncPerformanceTelemetry } from '../runtime/syncPerformanceTelemetry';
import { createNativeCryptoWorker } from './nativeCryptoWorker/nativeCryptoWorker';
import {
    bytesToCryptoWorkerBase64,
    cryptoWorkerBase64ToBytes,
    estimateCryptoWorkerBatchBridgeBytes,
    estimateCryptoWorkerRawBytesBridgeBytes,
} from './nativeCryptoWorker/nativeCryptoWorkerBridgePayload';
import {
    type NativeCryptoWorkerRoutingInput,
    normalizeNativeCryptoWorkerRouting,
    runNativeCryptoWorkerBatch,
} from './nativeCryptoWorker/nativeCryptoWorkerRouting';
import {
    markNativeCryptoWorkerQueueActive,
    markNativeCryptoWorkerQueueQuiescent,
    runNativeCryptoWorkerQueuedBatch,
} from './nativeCryptoWorker/nativeCryptoWorkerQueue';
import { getDefaultNativeCryptoWorkerRouting } from './nativeCryptoWorker/nativeCryptoWorkerRoutingConfig';
import { recordNativeCryptoWorkerBridgeSerialization } from './nativeCryptoWorker/nativeCryptoWorkerTelemetry';
import { probeNativeCryptoWorkerCapabilities } from './nativeCryptoWorker/probeNativeCryptoWorkerCapabilities';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    type CryptoWorkerScope,
    type NativeCryptoWorker,
    type NativeCryptoWorkerCapability,
} from './nativeCryptoWorker/types';

export type EncryptionScopeInput = Readonly<{
    accountId?: string;
    serverId?: string | null;
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
}>;

export type EncryptionGenerationScope = Readonly<{
    accountId: string;
    serverId: string | null;
    generation: number;
}>;

type ResolvedEncryptionScope = Readonly<{
    accountId: string;
    serverId: string | null;
}>;

const DEFAULT_NATIVE_CRYPTO_WORKER_ACCOUNT_ID = 'local';

function nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}
const NO_SERVER_SCOPE_KEY = '__local__';
const NO_KEY_FINGERPRINT = '__no_key__';

function normalizeScopeAccountId(value: string | undefined, fallback: string): string {
    const trimmed = String(value ?? '').trim();
    return trimmed || fallback;
}

function normalizeScopeServerId(value: string | null | undefined, fallback: string | null): string | null {
    if (value === undefined) return fallback;
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
}

function getScopeKey(scope: ResolvedEncryptionScope): string {
    return `${scope.accountId}\u0000${scope.serverId ?? NO_SERVER_SCOPE_KEY}`;
}

function getDataKeyFingerprint(dataKey: Uint8Array | null): string {
    return dataKey ? encodeBase64(dataKey, 'base64') : NO_KEY_FINGERPRINT;
}

export class Encryption {

    static async create(masterSecret: Uint8Array) {

        // Derive content data key to open session and machine records
        const contentDataKey = await deriveKey(masterSecret, 'Happy EnCoder', ['content']);

        // Derive content data key keypair
        const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);

        // Derive anonymous ID
        const anonID = encodeHex((await deriveKey(masterSecret, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();

        // Create encryption
        return new Encryption(anonID, masterSecret, contentKeyPair);
    }

    static async createFromContentKeyPair(params: { publicKey: Uint8Array; machineKey: Uint8Array }) {
        // Best-effort: we don't have the original secret seed in dataKey mode.
        // Using machineKey as the legacy secret keeps legacy fallback deterministic while
        // ensuring content-key based encryption/decryption works.
        const fallbackKey = params.machineKey;
        const anonID = encodeHex((await deriveKey(fallbackKey, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();
        const contentKeyPair: LibsodiumKeyPair = { publicKey: params.publicKey, privateKey: params.machineKey };
        return new Encryption(anonID, fallbackKey, contentKeyPair, true);
    }

    private readonly fallbackEncryption: Encryptor & Decryptor;
    // Automation templates must be decryptable by the daemon across credential modes.
    // We always seal them with secretbox using the master secret (legacy) or machine key (dataKey).
    private readonly automationTemplateEncryption: Encryptor & Decryptor;
    private readonly contentKeyPair: LibsodiumKeyPair;
    // The secret behind `fallbackEncryption`. Sessions opened without their own
    // data key are sealed with it, so it is also their input-equality material.
    private readonly masterSecret: Uint8Array;
    private readonly accountScopedCryptoMaterial: AccountScopedCryptoMaterial;
    readonly anonID: string;
    readonly contentDataKey: Uint8Array;

    // Session and machine encryption management
    private sessionEncryptions = new Map<string, SessionEncryption>();
    private sessionKeyFingerprints = new Map<string, string>();
    private machineEncryptions = new Map<string, MachineEncryption>();
    private machineKeyFingerprints = new Map<string, string>();
    private cache: EncryptionCache;
    private aesBatchConcurrencyLimit = DEFAULT_AES_BATCH_CONCURRENCY_LIMIT;
    // Per-instance worker object. This is the cross-account fence: the queue registry
    // (`nativeCryptoWorkerQueue`) and the capability cache are both keyed by this object,
    // so two Encryption instances can never share a queue and no batch can ever mix two
    // accounts' items. Key material travels per item, never as worker state.
    private nativeCryptoWorker: NativeCryptoWorker = createNativeCryptoWorker();
    // Routing is resolved at construction, not by a call each new site must remember.
    private nativeCryptoWorkerRouting: NativeCryptoWorkerRoutingInput = getDefaultNativeCryptoWorkerRouting();
    private nativeCryptoWorkerAccountId = DEFAULT_NATIVE_CRYPTO_WORKER_ACCOUNT_ID;
    private nativeCryptoWorkerServerId: string | null = null;
    private nativeCryptoWorkerGenerations = new Map<string, number>();
    private sessionEncryptionScopes = new Map<string, ResolvedEncryptionScope>();

    private constructor(
        anonID: string,
        masterSecret: Uint8Array,
        contentKeyPair: LibsodiumKeyPair,
        useDataKeyFallback = false
    ) {
        this.anonID = anonID;
        this.contentKeyPair = contentKeyPair;
        this.masterSecret = masterSecret;
        this.accountScopedCryptoMaterial = useDataKeyFallback
            ? { type: 'dataKey', machineKey: masterSecret }
            : { type: 'legacy', secret: masterSecret };
        this.fallbackEncryption = useDataKeyFallback
            ? new AES256Encryption(masterSecret, {
                nativeCryptoWorker: this.createNativeJsonDecryptWorkerBinding(),
            })
            : new SecretBoxEncryption(masterSecret, {
                nativeCryptoWorker: this.createNativeJsonDecryptWorkerBinding(),
            });
        this.automationTemplateEncryption = new SecretBoxEncryption(masterSecret);
        this.cache = new EncryptionCache();
        this.contentDataKey = contentKeyPair.publicKey;
    }

    configureAesBatchConcurrencyLimit(limit: number): void {
        this.aesBatchConcurrencyLimit = normalizeAesBatchConcurrencyLimit(limit);
    }

    configureNativeCryptoWorker(params: Readonly<{
        worker?: NativeCryptoWorker;
        routing?: NativeCryptoWorkerRoutingInput;
        scope?: CryptoWorkerScope;
    }>): void {
        if (params.worker) {
            this.nativeCryptoWorker = params.worker;
        }
        if (params.routing) {
            this.nativeCryptoWorkerRouting = params.routing;
        }
        if (params.scope) {
            const previousScope = this.resolveEncryptionScope();
            const scope = this.resolveEncryptionScope(params.scope);
            const previousScopeKey = getScopeKey(previousScope);
            const scopeChanged = previousScope.accountId !== scope.accountId || previousScope.serverId !== scope.serverId;
            if (scopeChanged && this.nativeCryptoWorkerGenerations.has(previousScopeKey)) {
                this.bumpGenerationForScope(previousScope);
            }
            this.nativeCryptoWorkerAccountId = scope.accountId;
            this.nativeCryptoWorkerServerId = scope.serverId;
            const generation = Math.max(0, Math.trunc(Number.isFinite(params.scope.generation) ? params.scope.generation : 0));
            const key = getScopeKey(scope);
            this.nativeCryptoWorkerGenerations.set(key, Math.max(this.nativeCryptoWorkerGenerations.get(key) ?? 0, generation));
        }
    }

    async warmNativeCryptoWorkerForDiagnostics(): Promise<NativeCryptoWorkerCapability | null> {
        return probeNativeCryptoWorkerCapabilities({
            worker: this.nativeCryptoWorker,
            capabilityCacheKey: this.nativeCryptoWorker,
            routing: this.nativeCryptoWorkerRouting,
            telemetry: syncPerformanceTelemetry,
        });
    }

    static markNativeCryptoWorkerQueueQuiescent(options: Readonly<{
        telemetryEnabled: boolean;
    }>): void {
        markNativeCryptoWorkerQueueQuiescent({
            telemetry: syncPerformanceTelemetry,
            telemetryEnabled: options.telemetryEnabled,
        });
    }

    static async markNativeCryptoWorkerQueueActive(options: Readonly<{
        telemetryEnabled: boolean;
        capabilityStalenessMs: number;
        revalidationTimeoutMs?: number;
        revalidateCapabilities?: () => Promise<void>;
    }>): Promise<void> {
        await markNativeCryptoWorkerQueueActive({
            telemetry: syncPerformanceTelemetry,
            telemetryEnabled: options.telemetryEnabled,
            capabilityStalenessMs: options.capabilityStalenessMs,
            revalidationTimeoutMs: options.revalidationTimeoutMs,
            revalidateCapabilities: options.revalidateCapabilities,
        });
    }

    getContentPrivateKey(): Uint8Array {
        return this.contentKeyPair.privateKey;
    }

    openActionOperationSnapshotRaw(ciphertext: string): unknown | null {
        return openAccountScopedBlobCiphertext({
            kind: 'action_operation_snapshot',
            material: this.accountScopedCryptoMaterial,
            ciphertext,
        })?.value ?? null;
    }

    private resolveEncryptionScope(scope: EncryptionScopeInput = {}): ResolvedEncryptionScope {
        return {
            accountId: normalizeScopeAccountId(scope.accountId, this.nativeCryptoWorkerAccountId),
            serverId: normalizeScopeServerId(scope.serverId, this.nativeCryptoWorkerServerId),
        };
    }

    private getGenerationForScope(scope: ResolvedEncryptionScope): number {
        return this.nativeCryptoWorkerGenerations.get(getScopeKey(scope)) ?? 0;
    }

    private bumpGenerationForScope(scope: ResolvedEncryptionScope): void {
        this.nativeCryptoWorkerGenerations.set(getScopeKey(scope), this.getGenerationForScope(scope) + 1);
    }

    getCurrentGeneration(accountId?: string, serverId?: string | null): number {
        return this.getGenerationForScope(this.resolveEncryptionScope({ accountId, serverId }));
    }

    getCurrentNativeCryptoWorkerScope(scope: EncryptionScopeInput = {}): CryptoWorkerScope {
        const resolved = this.resolveEncryptionScope(scope);
        return {
            accountId: resolved.accountId,
            serverId: resolved.serverId,
            generation: this.getGenerationForScope(resolved),
        };
    }

    getCurrentEncryptionGenerationScope(scope: EncryptionScopeInput = {}): EncryptionGenerationScope {
        return this.getCurrentNativeCryptoWorkerScope(scope);
    }

    isCurrentNativeCryptoWorkerScope(scope: CryptoWorkerScope): boolean {
        const current = this.getCurrentNativeCryptoWorkerScope({
            accountId: scope.accountId,
            serverId: scope.serverId,
        });
        return current.accountId === scope.accountId
            && current.serverId === scope.serverId
            && current.generation === scope.generation;
    }

    isCurrentEncryptionGenerationScope(scope: EncryptionGenerationScope): boolean {
        return this.isCurrentNativeCryptoWorkerScope(scope);
    }

    private createNativeJsonDecryptWorkerBinding(scopeInput: EncryptionScopeInput = {}) {
        return {
            getWorker: () => this.nativeCryptoWorker,
            getRouting: () => this.nativeCryptoWorkerRouting,
            getScope: () => this.getCurrentNativeCryptoWorkerScope(scopeInput),
            isScopeCurrent: (scope: CryptoWorkerScope) => this.isCurrentNativeCryptoWorkerScope(scope),
        };
    }

    //
    // Core encryption opening
    //

    async openEncryption(dataEncryptionKey: Uint8Array | null, scopeInput: EncryptionScopeInput = {}): Promise<Encryptor & Decryptor> {
        if (!dataEncryptionKey) {
            return this.fallbackEncryption;
        }
        return new AES256Encryption(dataEncryptionKey, {
            batchConcurrencyLimit: this.aesBatchConcurrencyLimit,
            nativeCryptoWorker: this.createNativeJsonDecryptWorkerBinding(scopeInput),
        });
    }

    //
    // Session operations
    //

    /**
     * Initialize sessions with their encryption keys
     * This should be called once when sessions are loaded
     */
    async initializeSessions(sessions: Map<string, Uint8Array | null>, scopeInput: EncryptionScopeInput = {}): Promise<void> {
        const scope = this.resolveEncryptionScope(scopeInput);
        const shouldContinue = () => (
            scopeInput.signal?.aborted !== true
            && scopeInput.shouldContinue?.() !== false
        );
        for (const [sessionId, dataKey] of sessions) {
            if (!shouldContinue()) return;
            const fingerprint = getDataKeyFingerprint(dataKey);
            const existing = this.sessionEncryptions.get(sessionId);
            const existingFingerprint = this.sessionKeyFingerprints.get(sessionId);
            const previousScope = this.sessionEncryptionScopes.get(sessionId);
            const scopeChanged = previousScope
                ? previousScope.accountId !== scope.accountId || previousScope.serverId !== scope.serverId
                : false;
            // Skip only when both key and owner scope are unchanged; scope changes need a fresh native binding.
            if (existing && existingFingerprint === fingerprint && !scopeChanged) {
                continue;
            }

            if (scopeChanged && previousScope) {
                this.bumpGenerationForScope(previousScope);
            }

            if (existing && existingFingerprint !== fingerprint) {
                this.bumpGenerationForScope(scope);
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey, scope);
            if (!shouldContinue()) return;

            // Create and cache session encryption
            const sessionEnc = new SessionEncryption(
                sessionId,
                encryptor,
                this.cache,
                // Whichever secret actually seals this Session: its own data key,
                // or the account secret behind the fallback encryptor.
                dataKey ?? this.masterSecret,
            );
            this.sessionEncryptions.set(sessionId, sessionEnc);
            this.sessionKeyFingerprints.set(sessionId, fingerprint);
            this.sessionEncryptionScopes.set(sessionId, scope);

            // If the session key changed (often due to decryptEncryptionKey becoming available later),
            // clear cached decrypted session data so future reads use the updated encryptor.
            // Note: message cache is keyed only by messageId; encrypted messages that previously
            // failed to decrypt must not be permanently cached (handled in SessionEncryption).
            if (existing) {
                this.cache.clearSessionCache(sessionId);
            }
        }
    }

    /**
     * Get session encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.sessionEncryptions.get(sessionId) || null;
    }

    /**
     * Remove session encryption from memory when session is deleted
     */
    removeSessionEncryption(sessionId: string): void {
        const existing = this.sessionEncryptions.get(sessionId);
        const scope = this.sessionEncryptionScopes.get(sessionId);
        if (existing && scope) {
            this.bumpGenerationForScope(scope);
        }
        this.sessionEncryptions.delete(sessionId);
        this.sessionKeyFingerprints.delete(sessionId);
        this.sessionEncryptionScopes.delete(sessionId);
        // Also clear any cached data for this session
        this.cache.clearSessionCache(sessionId);
    }

    //
    // Machine operations
    //

    /**
     * Initialize machines with their encryption keys
     * This should be called once when machines are loaded
     */
    async initializeMachines(machines: Map<string, Uint8Array | null>): Promise<void> {
        for (const [machineId, dataKey] of machines) {
            const fingerprint = dataKey ? encodeBase64(dataKey, 'base64') : '__no_key__';
            const existing = this.machineEncryptions.get(machineId);
            const existingFingerprint = this.machineKeyFingerprints.get(machineId);
            // Skip if already initialized with the same key (or both missing).
            if (existing && existingFingerprint === fingerprint) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache machine encryption
            const machineEnc = new MachineEncryption(
                machineId,
                encryptor,
                this.cache
            );
            this.machineEncryptions.set(machineId, machineEnc);
            this.machineKeyFingerprints.set(machineId, fingerprint);
        }
    }

    /**
     * Get machine encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getMachineEncryption(machineId: string): MachineEncryption | null {
        return this.machineEncryptions.get(machineId) || null;
    }

    //
    // Legacy methods for machine metadata (temporary until machines are migrated)
    //

    async encryptRaw(data: any): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.account.encryptRaw',
            { items: 1 },
            async () => {
                const encrypted = await this.fallbackEncryption.encrypt([data]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.account.decryptRaw',
                { items: 1 },
                async () => this.fallbackEncryption.decrypt([encryptedData]),
            );
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    async encryptAutomationTemplateRaw(data: any): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.account.encryptAutomationTemplateRaw',
            { items: 1 },
            async () => {
                const machineKey = this.getContentPrivateKey();
                return sealAccountScopedBlobCiphertext({
                    kind: 'automation_template_payload',
                    material: { type: 'dataKey', machineKey },
                    payload: data,
                    randomBytes: getRandomBytes,
                });
            },
        );
    }

    async decryptAutomationTemplateRaw(encrypted: string): Promise<any | null> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.account.decryptAutomationTemplateRaw',
            { items: 1 },
            async () => {
                const machineKey = this.getContentPrivateKey();
                const opened = openAccountScopedBlobCiphertext({
                    kind: 'automation_template_payload',
                    material: { type: 'dataKey', machineKey },
                    ciphertext: encrypted,
                });
                if (opened) return opened.value ?? null;

                try {
                    const encryptedData = decodeBase64(encrypted, 'base64');
                    const machineDecrypted = await new SecretBoxEncryption(machineKey).decrypt([encryptedData]);
                    if (machineDecrypted[0]) return machineDecrypted[0];

                    const decrypted = await this.automationTemplateEncryption.decrypt([encryptedData]);
                    return decrypted[0] || null;
                } catch {
                    return null;
                }
            },
        );
    }

    //
    // Data Encryption Key decryption
    //

    async decryptEncryptionKey(encrypted: string, scope?: EncryptionScopeInput) {
        const [decrypted] = await this.decryptEncryptionKeys([encrypted], scope);
        return decrypted ?? null;
    }

    async decryptEncryptionKeys(encryptedValues: readonly string[], scopeInput: EncryptionScopeInput = {}): Promise<Array<Uint8Array | null>> {
        // Nothing to open. Short-circuited before routing so an empty call is not
        // recorded as a routing decision it never made.
        if (encryptedValues.length === 0) return [];
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.account.decryptDataKey',
            { items: encryptedValues.length },
            async () => {
                const routing = normalizeNativeCryptoWorkerRouting(this.nativeCryptoWorkerRouting);
                // One asymmetric envelope open per item: on a cold start with a large account this is
                // thousands of curve25519 scalar mults, so the pass releases the JS thread between
                // chunks instead of holding it for the whole batch.
                const referenceRun = async () => mapCryptoBatchWithYield(encryptedValues, (value) => {
                    try {
                        const encryptedKey = decodeBase64(value, 'base64');
                        const opened = openEncryptedDataKeyEnvelopeV1({
                            envelope: encryptedKey,
                            recipientSecretKeyOrSeed: this.contentKeyPair.privateKey,
                        });
                        return opened ? bytesToCryptoWorkerBase64(opened) : null;
                    } catch {
                        return null;
                    }
                });
                // No pre-gate here. `runNativeCryptoWorkerBatch` is the single owner of
                // "does this batch reach the worker", and a copy of half its thresholds
                // at this call site would take the JS path without the owner ever
                // recording which branch chose it.
                const payloadBytes = estimateCryptoWorkerBatchBridgeBytes(encryptedValues).totalBridgeBytes
                    + estimateCryptoWorkerRawBytesBridgeBytes(this.contentKeyPair.privateKey).totalBridgeBytes * encryptedValues.length;
                let capturedScope: CryptoWorkerScope | null = null;
                const result = await runNativeCryptoWorkerBatch<string | null>({
                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
                    routing,
                    itemCount: encryptedValues.length,
                    payloadBytes,
                    capabilityCacheKey: this.nativeCryptoWorker,
                    probe: () => this.nativeCryptoWorker.probe(),
                    nativeRun: async () => {
                        const shouldMeasureSerialization = routing.telemetryEnabled && syncPerformanceTelemetry.isEnabled();
                        const serializeStartedAtMs = shouldMeasureSerialization ? nowMs() : 0;
                        let serializeMs = 0;
                        let bytesOut = 0;
                        const recipientSecretKeyOrSeedBase64 = bytesToCryptoWorkerBase64(this.contentKeyPair.privateKey);
                        const scope = this.getCurrentNativeCryptoWorkerScope(scopeInput);
                        capturedScope = scope;
                        const nativeItems = encryptedValues.map((envelopeBase64) => ({
                            envelopeBase64,
                            recipientSecretKeyOrSeedBase64,
                        }));
                        serializeMs = shouldMeasureSerialization ? Math.max(0, nowMs() - serializeStartedAtMs) : 0;
                        const refreshCancellation = () =>
                            scopeInput.shouldContinue?.() === false || scopeInput.signal?.aborted === true;
                        try {
                            if (refreshCancellation()) {
                                return nativeItems.map(() => null);
                            }
                            const items = await runNativeCryptoWorkerQueuedBatch({
                                owner: this.nativeCryptoWorker,
                                operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
                                scope,
                                maxBatchSize: routing.maxBatchSize,
                                items: nativeItems,
                                telemetry: syncPerformanceTelemetry,
                                telemetryEnabled: routing.telemetryEnabled,
                                signal: scopeInput.signal,
                                dispatch: async (queuedItems, context) => {
                                    if (refreshCancellation() || context.signal?.aborted === true) {
                                        return queuedItems.map(() => null);
                                    }
                                    const nativeResult = await this.nativeCryptoWorker.decryptDataKeyEnvelopeV1({
                                        scope,
                                        items: queuedItems,
                                        signal: context.signal,
                                    });
                                    if (nativeResult.status !== 'ok') {
                                        throw new Error('native data-key envelope decrypt batch did not complete');
                                    }
                                    return nativeResult.items;
                                },
                            });
                            bytesOut = estimateCryptoWorkerBatchBridgeBytes(items.filter((item): item is string => typeof item === 'string')).totalBridgeBytes;
                            return items;
                        } finally {
                            if (routing.telemetryEnabled && syncPerformanceTelemetry.isEnabled()) {
                                recordNativeCryptoWorkerBridgeSerialization(syncPerformanceTelemetry, {
                                    operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
                                    items: nativeItems.length,
                                    bytesIn: payloadBytes,
                                    bytesOut,
                                    serializeMs,
                                });
                            }
                        }
                    },
                    referenceRun,
                    isScopeCurrent: () => capturedScope !== null && this.isCurrentNativeCryptoWorkerScope(capturedScope),
                    signal: scopeInput.signal,
                });
                if (result.status !== 'ok') {
                    return encryptedValues.map(() => null);
                }
                return result.items.map((value) => {
                    if (!value) return null;
                    return cryptoWorkerBase64ToBytes(value);
                });
            },
        );
    }

    async encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array> {
        return syncPerformanceTelemetry.measure(
            'sync.encryption.account.encryptDataKey',
            { items: 1 },
            () => {
                // Use public key for encryption (encrypt TO ourselves)
                return sealEncryptedDataKeyEnvelopeV1({
                    dataKey: key,
                    recipientPublicKey: this.contentKeyPair.publicKey,
                    randomBytes: getRandomBytes,
                });
            },
        );
    }

    generateId(): string {
        return randomUUID();
    }
}

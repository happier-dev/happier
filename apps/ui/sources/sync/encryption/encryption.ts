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
import { mapCryptoBatchWithYield } from "./cryptoBatchYield";
import { EncryptionCache } from "./encryptionCache";
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
    sessionId?: string | null;
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
}>;

export type EncryptionGenerationScope = Readonly<{
    accountId: string;
    serverId: string | null;
    generation: number;
    sessionId?: string | null;
}>;

type ResolvedEncryptionScope = Readonly<{
    accountId: string;
    serverId: string | null;
    sessionId: string | null;
}>;

const DEFAULT_NATIVE_CRYPTO_WORKER_ACCOUNT_ID = 'local';

function nowMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}
const NO_SERVER_SCOPE_KEY = '__local__';
const NO_SESSION_SCOPE_KEY = '__shared__';
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

function normalizeScopeSessionId(value: string | null | undefined, fallback: string | null): string | null {
    if (value === undefined) return fallback;
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
}

function getScopeKey(scope: ResolvedEncryptionScope): string {
    return `${scope.accountId}\u0000${scope.serverId ?? NO_SERVER_SCOPE_KEY}\u0000${scope.sessionId ?? NO_SESSION_SCOPE_KEY}`;
}

function getDataKeyFingerprint(dataKey: Uint8Array | null): string {
    return dataKey ? encodeBase64(dataKey, 'base64') : NO_KEY_FINGERPRINT;
}

export class EncryptionMaterialUnavailableError extends Error {
    readonly code = 'encryption_material_unavailable';
    constructor() {
        super('Encryption key material is unavailable for this account');
        this.name = 'EncryptionMaterialUnavailableError';
    }
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

    static createWithoutKeyMaterial(): Encryption {
        return new Encryption(null, null, null);
    }

    hasEncryptionMaterial(): boolean {
        return this.contentKeyPair !== null;
    }

    private requireContentKeyPair(): LibsodiumKeyPair {
        if (!this.contentKeyPair) throw new EncryptionMaterialUnavailableError();
        return this.contentKeyPair;
    }

    private requireFallbackEncryption(): Encryptor & Decryptor {
        if (!this.fallbackEncryption) throw new EncryptionMaterialUnavailableError();
        return this.fallbackEncryption;
    }

    private readonly fallbackEncryption: (Encryptor & Decryptor) | null;
    // Automation templates must be decryptable by the daemon across credential modes.
    // We always seal them with secretbox using the master secret (legacy) or machine key (dataKey).
    private readonly automationTemplateEncryption: (Encryptor & Decryptor) | null;
    private readonly contentKeyPair: LibsodiumKeyPair | null;
    readonly anonID: string | null;
    get contentDataKey(): Uint8Array {
        return this.requireContentKeyPair().publicKey;
    }

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
    private readonly fallbackSecret: Uint8Array | null;
    private readonly useDataKeyFallback: boolean;

    private constructor(
        anonID: string | null,
        masterSecret: Uint8Array | null,
        contentKeyPair: LibsodiumKeyPair | null,
        useDataKeyFallback = false
    ) {
        this.anonID = anonID;
        this.contentKeyPair = contentKeyPair;
        this.fallbackSecret = masterSecret;
        this.useDataKeyFallback = useDataKeyFallback;
        this.fallbackEncryption = masterSecret ? this.createFallbackEncryption(masterSecret) : null;
        this.automationTemplateEncryption = masterSecret ? new SecretBoxEncryption(masterSecret) : null;
        this.cache = new EncryptionCache();
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
            const scopeChanged = previousScope.accountId !== scope.accountId
                || previousScope.serverId !== scope.serverId
                || previousScope.sessionId !== scope.sessionId;
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
        return this.requireContentKeyPair().privateKey;
    }

    private resolveEncryptionScope(scope: EncryptionScopeInput = {}): ResolvedEncryptionScope {
        return {
            accountId: normalizeScopeAccountId(scope.accountId, this.nativeCryptoWorkerAccountId),
            serverId: normalizeScopeServerId(scope.serverId, this.nativeCryptoWorkerServerId),
            sessionId: normalizeScopeSessionId(scope.sessionId, null),
        };
    }

    private getGenerationForScope(scope: ResolvedEncryptionScope): number {
        return this.nativeCryptoWorkerGenerations.get(getScopeKey(scope)) ?? 0;
    }

    private bumpGenerationForScope(scope: ResolvedEncryptionScope): void {
        this.nativeCryptoWorkerGenerations.set(getScopeKey(scope), this.getGenerationForScope(scope) + 1);
    }

    getCurrentGeneration(accountId?: string, serverId?: string | null, sessionId?: string | null): number {
        return this.getGenerationForScope(this.resolveEncryptionScope({ accountId, serverId, sessionId }));
    }

    getCurrentNativeCryptoWorkerScope(scope: EncryptionScopeInput = {}): CryptoWorkerScope {
        const resolved = this.resolveEncryptionScope(scope);
        return {
            accountId: resolved.accountId,
            serverId: resolved.serverId,
            generation: this.getGenerationForScope(resolved),
            ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
        };
    }

    getCurrentEncryptionGenerationScope(scope: EncryptionScopeInput = {}): EncryptionGenerationScope {
        return this.getCurrentNativeCryptoWorkerScope(scope);
    }

    isCurrentNativeCryptoWorkerScope(scope: CryptoWorkerScope): boolean {
        const current = this.getCurrentNativeCryptoWorkerScope({
            accountId: scope.accountId,
            serverId: scope.serverId,
            sessionId: scope.sessionId,
        });
        return current.accountId === scope.accountId
            && current.serverId === scope.serverId
            && current.generation === scope.generation
            && (current.sessionId ?? null) === (scope.sessionId ?? null);
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

    private createFallbackEncryption(masterSecret: Uint8Array, scopeInput: EncryptionScopeInput = {}): Encryptor & Decryptor {
        if (this.useDataKeyFallback) {
            return new AES256Encryption(masterSecret, {
                nativeCryptoWorker: this.createNativeJsonDecryptWorkerBinding(scopeInput),
            });
        }
        return new SecretBoxEncryption(masterSecret, {
            nativeCryptoWorker: this.createNativeJsonDecryptWorkerBinding(scopeInput),
        });
    }

    //
    // Core encryption opening
    //

    async openEncryption(dataEncryptionKey: Uint8Array | null, scopeInput: EncryptionScopeInput = {}): Promise<Encryptor & Decryptor> {
        if (!dataEncryptionKey) {
            if (!this.fallbackSecret) throw new EncryptionMaterialUnavailableError();
            return scopeInput.sessionId ? this.createFallbackEncryption(this.fallbackSecret, scopeInput) : this.requireFallbackEncryption();
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
        for (const [sessionId, dataKey] of sessions) {
            const sessionScope = {
                ...scope,
                sessionId,
            } satisfies ResolvedEncryptionScope;
            const fingerprint = getDataKeyFingerprint(dataKey);
            const existing = this.sessionEncryptions.get(sessionId);
            const existingFingerprint = this.sessionKeyFingerprints.get(sessionId);
            const previousScope = this.sessionEncryptionScopes.get(sessionId);
            const scopeChanged = previousScope
                ? previousScope.accountId !== sessionScope.accountId || previousScope.serverId !== sessionScope.serverId
                : false;
            // Skip only when both key and owner scope are unchanged; scope changes need a fresh native binding.
            if (existing && existingFingerprint === fingerprint && !scopeChanged) {
                continue;
            }

            if (scopeChanged && previousScope) {
                this.bumpGenerationForScope(previousScope);
            }

            if (existing && existingFingerprint !== fingerprint) {
                this.bumpGenerationForScope(sessionScope);
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey, sessionScope);

            // Create and cache session encryption
            const sessionEnc = new SessionEncryption(
                sessionId,
                encryptor,
                this.cache
            );
            this.sessionEncryptions.set(sessionId, sessionEnc);
            this.sessionKeyFingerprints.set(sessionId, fingerprint);
            this.sessionEncryptionScopes.set(sessionId, sessionScope);

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

    clearSessionCache(sessionId: string): void {
        this.cache.clearSession(sessionId);
    }

    //
    // Machine operations
    //

    /**
     * Initialize machines with their encryption keys
     * This should be called once when machines are loaded
     */
    async initializeMachines(machines: Map<string, Uint8Array | null>, options?: Readonly<{ unavailableMachineIds?: ReadonlySet<string>; plainMachineIds?: ReadonlySet<string> }>): Promise<void> {
        for (const machineId of options?.unavailableMachineIds ?? []) {
            this.machineEncryptions.delete(machineId);
            this.machineKeyFingerprints.delete(machineId);
            this.cache.clearMachineCache(machineId);
        }
        for (const [machineId, dataKey] of machines) {
            const isPlain = options?.plainMachineIds?.has(machineId) === true;
            const fingerprint = isPlain ? '__plain__' : getDataKeyFingerprint(dataKey);
            const existing = this.machineEncryptions.get(machineId);
            const existingFingerprint = this.machineKeyFingerprints.get(machineId);
            // Skip if already initialized with the same key (or both missing).
            if (existing && existingFingerprint === fingerprint) {
                continue;
            }

            this.cache.clearMachineCache(machineId);

            // A keyless account cannot read a legacy encrypted row. Keep other plain rows usable.
            if (!isPlain && !dataKey && !this.hasEncryptionMaterial()) {
                this.machineEncryptions.delete(machineId);
                this.machineKeyFingerprints.delete(machineId);
                continue;
            }
            const encryptor = isPlain ? null : await this.openEncryption(dataKey);

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
                const encrypted = await this.requireFallbackEncryption().encrypt([data]);
                return encodeBase64(encrypted[0], 'base64');
            },
        );
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        this.requireFallbackEncryption();
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.account.decryptRaw',
                { items: 1 },
                async () => this.requireFallbackEncryption().decrypt([encryptedData]),
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

                    const decrypted = await this.automationTemplateEncryption!.decrypt([encryptedData]);
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
        // Keyless accounts may retain encrypted history alongside readable plain rows.
        // A missing recipient key has the same per-envelope result as a key that cannot open it.
        if (!this.contentKeyPair) return encryptedValues.map(() => null);
        const contentKeyPair = this.contentKeyPair;
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.account.decryptDataKey',
            { items: encryptedValues.length },
            async () => {
                const routing = normalizeNativeCryptoWorkerRouting(this.nativeCryptoWorkerRouting);
                // Every item is an asymmetric envelope open; a cold start on a large
                // account runs thousands of them, so the JS path must not hold the thread.
                const referenceRun = async () => mapCryptoBatchWithYield(encryptedValues, (value) => {
                    try {
                        const encryptedKey = decodeBase64(value, 'base64');
                        const opened = openEncryptedDataKeyEnvelopeV1({
                            envelope: encryptedKey,
                            recipientSecretKeyOrSeed: contentKeyPair.privateKey,
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
                    + estimateCryptoWorkerRawBytesBridgeBytes(contentKeyPair.privateKey).totalBridgeBytes * encryptedValues.length;
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
                        const recipientSecretKeyOrSeedBase64 = bytesToCryptoWorkerBase64(contentKeyPair.privateKey);
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
                    recipientPublicKey: this.requireContentKeyPair().publicKey,
                    randomBytes: getRandomBytes,
                });
            },
        );
    }

    generateId(): string {
        return randomUUID();
    }
}

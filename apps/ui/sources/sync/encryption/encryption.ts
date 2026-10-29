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
import { DataKeyOpenings } from './dataKeyOpenings';
import { createUiAccountKvCipher } from './accountKvCipher';
import { mapCryptoBatchWithYield } from "./cryptoBatchYield";
import { SessionEncryption } from "./sessionEncryption";
import { areMachineEncryptionContextInputsEqual, MachineEncryption } from "./machineEncryption";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium, { type LibsodiumKeyPair } from '@/encryption/libsodium.lib';
import { decryptBox, encryptBox } from "@/encryption/libsodium";
import { randomUUID } from '@/platform/randomUUID';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { ENCRYPTED_DATA_KEY_V1_BYTES, openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodePlainMachineStoredContent, isMachineDataEncryptionKeyTransferableV1, resolvePublishedMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachineContentKeyPreparationErrorV1, prepareMachineContentKeyV1, type MachinePublishedRowV1, type MachineContentKeyTransitionInputV1, type MachineContentKeyTransitionResultV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1, type AutomationTriggerDefinitionBindingV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { AutomationEncryptedTriggerDefinitionEnvelopeV1Schema, type AutomationEncryptedTriggerDefinitionEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { AutomationEventTriggerDefinitionStoredPayloadV1 } from '@happier-dev/protocol/automations/event';
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
    NativeCryptoWorkerQueueCancelledError,
    runNativeCryptoWorkerQueuedBatch,
} from './nativeCryptoWorker/nativeCryptoWorkerQueue';
import { getDefaultNativeCryptoWorkerRouting } from './nativeCryptoWorker/nativeCryptoWorkerRoutingConfig';
import { recordNativeCryptoWorkerBridgeSerialization } from './nativeCryptoWorker/nativeCryptoWorkerTelemetry';
import { probeNativeCryptoWorkerCapabilities } from './nativeCryptoWorker/probeNativeCryptoWorkerCapabilities';
import {
    NATIVE_CRYPTO_WORKER_OPERATION,
    type CryptoWorkerScope,
    type CryptoWorkerWorkClass,
    type NativeCryptoWorker,
    type NativeCryptoWorkerCapability,
} from './nativeCryptoWorker/types';

export type EncryptionScopeInput = Readonly<{
    accountId?: string;
    serverId?: string | null;
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
    /** Explicit control demand must not wait for inventory envelope hydration. */
    workClass?: CryptoWorkerWorkClass;
}>;

export type SessionEncryptionScopeInput = EncryptionScopeInput & Readonly<{
    /** Rechecked after async opening and immediately before installing each Session. */
    isSessionCurrent?: (sessionId: string) => boolean;
}>;

export type MachineEncryptionContextInput = Readonly<{
    /** Envelope this viewer can open; distinct from the owner's write identity on shared rows. */
    dataEncryptionKey: string | null;
    expectedDataEncryptionKey: string | null | undefined;
    resourceMode?: 'plain' | 'e2ee';
    accessState?: 'ready' | 'key_pending' | 'refused' | 'unavailable';
    installationId?: string | null;
    installationPublicKey?: string | null;
    contentPublicKeyFingerprint?: string | null;
    custodianAccountId?: string | null;
    accessRole?: 'use' | 'manage' | null;
}>;

export type MachineEncryptionContext = MachineEncryptionContextInput & Readonly<{
    isCurrent: () => boolean;
}>;

const machineContextReadObservation = Symbol('machineContextReadObservation');
type MachineEncryptionContextEntry = MachineEncryptionContext & Readonly<{
    [machineContextReadObservation]?: object;
}>;

export type EncryptionGenerationScope = Readonly<{
    accountId: string;
    serverId: string | null;
    generation: number;
}>;

/**
 * The generation half of the Account encryption owner, named once so consumers depend on the pair
 * rather than redeclaring it.
 *
 * `Encryption` implements it. Any consumer that needs to know whether the key material it captured
 * is still the current material takes this, so nobody has to probe for the methods at runtime.
 */
export type EncryptionGenerationScopeAuthority = Readonly<{
    getCurrentEncryptionGenerationScope: (scope?: EncryptionScopeInput) => EncryptionGenerationScope;
    isCurrentEncryptionGenerationScope: (scope: EncryptionGenerationScope) => boolean;
}>;

/**
 * Capture one Account-encryption generation and keep its currentness decision at
 * the Account-encryption owner. Callers use the returned scope to bind async
 * work and the predicate at every effect boundary; they must not recreate the
 * account/server/generation comparison themselves.
 */
export function captureEncryptionGenerationCurrentness(
    authority: EncryptionGenerationScopeAuthority | null | undefined,
    scope: EncryptionScopeInput = {},
): Readonly<{
    capturedScope: EncryptionGenerationScope | null;
    isCurrent: () => boolean;
}> {
    const capturedScope = authority?.getCurrentEncryptionGenerationScope(scope) ?? null;
    return {
        capturedScope,
        isCurrent: () => capturedScope === null
            || authority?.isCurrentEncryptionGenerationScope(capturedScope) === true,
    };
}

export function isCapturedEncryptionGenerationScopeCurrent(
    authority: EncryptionGenerationScopeAuthority | null | undefined,
    capturedScope: EncryptionGenerationScope | null | undefined,
): boolean {
    return capturedScope == null
        || authority?.isCurrentEncryptionGenerationScope(capturedScope) === true;
}

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
    private readonly rawAccountCipher: ReturnType<typeof createUiAccountKvCipher>;
    readonly anonID: string;
    readonly contentDataKey: Uint8Array;

    // Session and machine encryption management
    private sessionEncryptions = new Map<string, SessionEncryption>();
    private sessionKeyFingerprints = new Map<string, string>();
    private machineEncryptions = new Map<string, MachineEncryption>();
    private machineKeyFingerprints = new Map<string, string>();
    private machineEncryptionContexts = new Map<string, MachineEncryptionContextEntry>();
    private machineEncryptionOpenings = new Map<string, object>();
    // The Account encryption owner retains successful pure envelope work in the
    // same scope as in-flight work. This never grants access to a row; callers
    // still admit its mode, access and current envelope before requesting a key.
    private readonly dataKeyOpenings = new DataKeyOpenings();
    private dataKeyOpeningRecipient: Uint8Array;
    private readonly accountMaterialLifetime = new AbortController();
    private accountMaterialCurrentness: () => boolean = () => true;
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
        this.dataKeyOpeningRecipient = contentKeyPair.privateKey.slice();
        this.masterSecret = masterSecret;
        this.accountScopedCryptoMaterial = useDataKeyFallback
            ? { type: 'dataKey', machineKey: masterSecret }
            : { type: 'legacy', secret: masterSecret };
        this.rawAccountCipher = createUiAccountKvCipher('e2ee', this.accountScopedCryptoMaterial);
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

    /** The authenticated Home owner supplies custody, not a key-presence verdict. */
    bindAccountMaterialCurrentness(isCurrent: () => boolean): void {
        this.accountMaterialCurrentness = isCurrent;
    }

    private isAccountMaterialCurrent(): boolean {
        return !this.accountMaterialLifetime.signal.aborted && this.accountMaterialCurrentness();
    }

    /** Credential withdrawal retires existing readers and pending pure openings together. */
    retireAccountMaterial(): void {
        this.accountMaterialLifetime.abort();
        this.dataKeyOpenings.clear();
        this.machineEncryptionContexts.clear();
        this.machineEncryptionOpenings.clear();
        this.machineEncryptions.clear();
        this.machineKeyFingerprints.clear();
        this.sessionEncryptions.clear();
        this.sessionKeyFingerprints.clear();
        this.sessionEncryptionScopes.clear();
        this.cache.clearAll();
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
            if (generation > this.getGenerationForScope(scope)) {
                this.dataKeyOpenings.delete(`${key}\u0000${this.getGenerationForScope(scope)}`);
            }
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
        this.dataKeyOpenings.delete(`${getScopeKey(scope)}\u0000${this.getGenerationForScope(scope)}`);
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
        if (!this.isAccountMaterialCurrent()) return false;
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
    async initializeSessions(
        sessions: Map<string, Uint8Array | null>,
        scopeInput: SessionEncryptionScopeInput = {},
    ): Promise<EncryptionGenerationScope | null> {
        const scope = this.resolveEncryptionScope(scopeInput);
        const shouldContinue = () => (
            scopeInput.signal?.aborted !== true
            && scopeInput.shouldContinue?.() !== false
        );
        const pending: Array<Readonly<{
            sessionId: string;
            dataKey: Uint8Array | null;
            fingerprint: string;
            encryptor: Encryptor & Decryptor;
        }>> = [];
        for (const [sessionId, dataKey] of sessions) {
            if (!shouldContinue()) return null;
            if (scopeInput.isSessionCurrent?.(sessionId) === false) continue;
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

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey, scope);
            if (!shouldContinue()) return null;

            pending.push({
                sessionId,
                dataKey,
                fingerprint,
                encryptor,
            });
        }

        // Opening may yield, so currentness is checked above before any mutation. Apply the
        // prepared replacements synchronously after that check: a key change intentionally
        // advances the owning generation, but must not cancel the same guarded replacement that
        // caused the advance. The returned post-commit scope lets callers keep guarding later
        // cache publication without mistaking this owner-authored advance for an Account switch.
        for (const entry of pending) {
            if (scopeInput.isSessionCurrent?.(entry.sessionId) === false) continue;
            // Another initializer may have committed while this entry's encryptor was opening.
            // Re-read the owner and key at the synchronous commit boundary so displacing that
            // initializer invalidates the scope it actually installed, not only the pre-await view.
            const currentExisting = this.sessionEncryptions.get(entry.sessionId);
            const currentFingerprint = this.sessionKeyFingerprints.get(entry.sessionId);
            const currentScope = this.sessionEncryptionScopes.get(entry.sessionId);
            const currentScopeChanged = currentScope
                ? currentScope.accountId !== scope.accountId || currentScope.serverId !== scope.serverId
                : false;
            if (currentScopeChanged && currentScope) {
                this.bumpGenerationForScope(currentScope);
            }

            if (
                currentExisting
                && currentFingerprint !== entry.fingerprint
            ) {
                this.bumpGenerationForScope(scope);
            }

            // Create and cache session encryption
            const sessionEnc: SessionEncryption = new SessionEncryption(
                entry.sessionId,
                entry.encryptor,
                this.cache,
                // Whichever secret actually seals this Session: its own data key,
                // or the account secret behind the fallback encryptor.
                entry.dataKey ?? this.masterSecret,
                // A retired/replaced reader must not refill the shared plaintext cache
                // when an already-running platform decrypt completes.
                () => this.sessionEncryptions.get(entry.sessionId) === sessionEnc,
            );
            this.sessionEncryptions.set(entry.sessionId, sessionEnc);
            this.sessionKeyFingerprints.set(entry.sessionId, entry.fingerprint);
            this.sessionEncryptionScopes.set(entry.sessionId, scope);

            // If the session key changed (often due to decryptEncryptionKey becoming available later),
            // clear cached decrypted session data so future reads use the updated encryptor.
            // Note: message cache is keyed only by messageId; encrypted messages that previously
            // failed to decrypt must not be permanently cached (handled in SessionEncryption).
            if (currentExisting) {
                this.cache.clearSessionCache(entry.sessionId);
            }
        }
        return this.getCurrentEncryptionGenerationScope(scope);
    }

    /**
     * Get session encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.isAccountMaterialCurrent() ? this.sessionEncryptions.get(sessionId) || null : null;
    }

    /**
     * Remove session encryption from memory when a Session is deleted or its key
     * stops opening.
     *
     * Symmetric with `initializeSessions`: clearing a live reader intentionally
     * advances the owning generation, and the post-commit scope is returned so the
     * caller that *caused* the advance can adopt it instead of reading its own
     * clear as another writer's Account switch. `null` means nothing was removed
     * and no generation moved.
     */
    removeSessionEncryption(sessionId: string): EncryptionGenerationScope | null {
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
        return existing && scope ? this.getCurrentEncryptionGenerationScope(scope) : null;
    }

    //
    // Machine operations
    //

    captureMachineEncryptionContext(machineId: string, input: MachineEncryptionContextInput): MachineEncryptionContext {
        const existing = this.machineEncryptionContexts.get(machineId);
        if (existing && areMachineEncryptionContextInputsEqual(existing, input)) return existing;
        this.removeMachineEncryption(machineId);
        const context: MachineEncryptionContext = {
            ...input,
            isCurrent: () => this.isAccountMaterialCurrent() && this.machineEncryptionContexts.get(machineId) === context,
        };
        this.machineEncryptionContexts.set(machineId, context);
        return context;
    }

    /** Atomically admit siblings of one physical observation without reviving a retired read. */
    captureMachineEncryptionContextForRead(machineId: string, input: MachineEncryptionContextInput, read: Readonly<{
        incumbent: MachineEncryptionContext | undefined;
        observation: object;
    }>): MachineEncryptionContext | null {
        const current = this.machineEncryptionContexts.get(machineId);
        if (current !== read.incumbent && current?.[machineContextReadObservation] !== read.observation) return null;
        const context = this.captureMachineEncryptionContext(machineId, input);
        if (context !== current) {
            // Non-enumerable so ordinary context/input copies cannot carry admission proof.
            // Unchanged observations never overwrite the first admitted read's provenance.
            Object.defineProperty(context, machineContextReadObservation, { value: read.observation });
        }
        return context;
    }

    getMachineEncryptionContext(machineId: string): MachineEncryptionContext | undefined {
        return this.machineEncryptionContexts.get(machineId);
    }

    /** Bind a pending list read to each incumbent selection, including absent entries. */
    captureMachineEncryptionContextRead(): (machineId: string) => boolean {
        const contexts = new Map(this.machineEncryptionContexts);
        return (machineId) => this.machineEncryptionContexts.get(machineId) === contexts.get(machineId);
    }

    getMachineDataEncryptionKey(machineId: string): string | null | undefined {
        return this.machineEncryptionContexts.get(machineId)?.expectedDataEncryptionKey;
    }

    removeMachineEncryption(machineId: string): void {
        this.machineEncryptionOpenings.delete(machineId);
        this.machineEncryptions.delete(machineId);
        this.machineKeyFingerprints.delete(machineId);
        this.cache.clearMachineCache(machineId);
    }

    /**
     * Initialize machines with their encryption keys
     * This should be called once when machines are loaded
     */
    async initializeMachines(
        machines: Map<string, Uint8Array | null>,
        unavailableMachineIds?: ReadonlySet<string>,
        options: Readonly<{ isMachineCurrent?: (machineId: string) => boolean }> = {},
    ): Promise<void> {
        if (!this.isAccountMaterialCurrent()) return;
        // Failed present envelopes are unavailable, never the null legacy-key
        // compatibility input. Retire their previous ciphers before any await.
        for (const machineId of unavailableMachineIds ?? []) {
            if (options.isMachineCurrent?.(machineId) === false) continue;
            this.removeMachineEncryption(machineId);
        }
        for (const [machineId, dataKey] of machines) {
            if (unavailableMachineIds?.has(machineId) || options.isMachineCurrent?.(machineId) === false) continue;
            const fingerprint = dataKey ? encodeBase64(dataKey, 'base64') : '__no_key__';
            const existing = this.machineEncryptions.get(machineId);
            const existingFingerprint = this.machineKeyFingerprints.get(machineId);
            // Skip if already initialized with the same key (or both missing).
            if (existing && existingFingerprint === fingerprint) {
                continue;
            }

            // Retire before platform opening yields; only this latest opening may install.
            this.removeMachineEncryption(machineId);
            const opening = {};
            this.machineEncryptionOpenings.set(machineId, opening);

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);
            if (!this.isAccountMaterialCurrent() || this.machineEncryptionOpenings.get(machineId) !== opening
                || options.isMachineCurrent?.(machineId) === false) continue;

            // Create and cache machine encryption
            const machineEnc = new MachineEncryption(
                machineId,
                encryptor,
                this.cache,
                () => this.machineEncryptions.get(machineId) === machineEnc,
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
        return this.isAccountMaterialCurrent() ? this.machineEncryptions.get(machineId) || null : null;
    }

    //
    // Raw Account JSON. Session/Machine fallback encryption is separately owned.
    //

    async encryptRaw(data: unknown): Promise<string> {
        return syncPerformanceTelemetry.measureAsync(
            'sync.encryption.account.encryptRaw',
            { items: 1 },
            async () => {
                return await this.rawAccountCipher.seal(data);
            },
        );
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const opened = await syncPerformanceTelemetry.measureAsync(
                'sync.encryption.account.decryptRaw',
                { items: 1 },
                async () => this.rawAccountCipher.open(encrypted),
            );
            return opened.value;
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

    /**
     * Seals one private Event definition through the canonical Account-scoped
     * Automation trigger envelope. Callers provide the exact persisted-row
     * binding; this owner supplies the current Account material and entropy.
     */
    sealAutomationTriggerDefinition(params: Readonly<{
        binding: AutomationTriggerDefinitionBindingV1;
        definition: AutomationEventTriggerDefinitionStoredPayloadV1;
    }>): AutomationEncryptedTriggerDefinitionEnvelopeV1 {
        return AutomationEncryptedTriggerDefinitionEnvelopeV1Schema.parse(
            sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: 'e2ee',
                material: this.accountScopedCryptoMaterial,
                randomBytes: getRandomBytes,
                binding: params.binding,
                definition: params.definition,
            }),
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

    /** Owner material is transferable only when C40 rules out historical Account borrowing. */
    async readTransferableMachineDataKey(encrypted: string, scope?: EncryptionScopeInput): Promise<Uint8Array | null> {
        const key = await this.decryptEncryptionKey(encrypted, scope);
        return isMachineDataEncryptionKeyTransferableV1({ publishedDataEncryptionKey: encrypted,
            openedDataEncryptionKey: key, accountScopedMaterial: this.accountScopedCryptoMaterial }) ? key : null;
    }

    /** Thin crypto adapter to the same C40 lifecycle used by ApiClient. */
    async prepareMachineContentKey(params: Readonly<{
        machineId: string;
        custodianAccountId: string;
        /** Only predecessor rows without explicit resource mode need Account mode. */
        readAccountMode: () => Promise<'plain' | 'e2ee'>;
        observe: (signal?: AbortSignal) => Promise<MachinePublishedRowV1>;
        transition: (input: MachineContentKeyTransitionInputV1, signal?: AbortSignal) => Promise<MachineContentKeyTransitionResultV1<MachinePublishedRowV1>>;
        isCurrent: () => boolean;
        signal?: AbortSignal;
    }>): Promise<Readonly<{ row: MachinePublishedRowV1; encryptionMode: 'plain' | 'e2ee'; encryptionKey?: Uint8Array }>> {
        type Opened = Readonly<{ row: MachinePublishedRowV1; encryptionMode: 'plain' | 'e2ee'; encryptionKey?: Uint8Array; legacy?: boolean }>;
        const scope = { accountId: params.custodianAccountId, signal: params.signal, shouldContinue: params.isCurrent };
        const decodeStored = async (opened: Opened, ciphertext: string): Promise<unknown> => {
            if (opened.encryptionMode === 'plain') return decodePlainMachineStoredContent(ciphertext);
            const codec = opened.legacy ? this.fallbackEncryption : await this.openEncryption(opened.encryptionKey ?? null, scope);
            const [value] = await codec.decrypt([decodeBase64(ciphertext)], { signal: params.signal });
            return value;
        };
        return await prepareMachineContentKeyV1<Opened>({ ...params, material: this.accountScopedCryptoMaterial,
            ...(this.accountScopedCryptoMaterial.type === 'dataKey' ? { dataKeyPublicKey: this.contentKeyPair.publicKey } : {}), randomBytes: getRandomBytes,
            open: async row => {
                const openedKey = row.dataEncryptionKey ? await this.decryptEncryptionKey(row.dataEncryptionKey, scope) : null;
                const resolution = resolvePublishedMachineDataEncryptionKeyV1({ machine: row, openedDataEncryptionKey: openedKey,
                    expectedAccountMode: row.access?.resourceMode ?? row.storageMode ?? await params.readAccountMode(), viewerAccountId: params.custodianAccountId });
                if (resolution.status === 'unavailable') throw new MachineContentKeyPreparationErrorV1('encryption_material_unavailable');
                const opened: Opened = resolution.status === 'plain' ? { row, encryptionMode: 'plain' }
                    : { row, encryptionMode: 'e2ee', encryptionKey: resolution.status === 'e2ee' ? resolution.dataKey
                        : this.accountScopedCryptoMaterial.type === 'dataKey' ? this.accountScopedCryptoMaterial.machineKey : this.accountScopedCryptoMaterial.secret,
                        ...(resolution.status === 'legacy' ? { legacy: true } : {}) };
                if ((row.metadata !== null && await decodeStored(opened, row.metadata) === null)
                    || (row.daemonState !== null && await decodeStored(opened, row.daemonState) === null)) throw new MachineContentKeyPreparationErrorV1('encryption_material_unavailable');
                return opened;
            },
            decodeStored,
            encodeStored: async (key, value) => encodeBase64((await new AES256Encryption(key).encrypt([value]))[0]!),
        });
    }

    async decryptEncryptionKeys(encryptedValues: readonly string[], scopeInput: EncryptionScopeInput = {}): Promise<Array<Uint8Array | null>> {
        if (encryptedValues.length === 0) return [];
        if (this.dataKeyOpeningRecipient.length !== this.contentKeyPair.privateKey.length
            || !this.dataKeyOpeningRecipient.every((byte, index) => byte === this.contentKeyPair.privateKey[index])) {
            this.dataKeyOpenings.clear();
            this.dataKeyOpeningRecipient = this.contentKeyPair.privateKey.slice();
        }
        const scope = this.getCurrentNativeCryptoWorkerScope(scopeInput);
        const recipient = this.dataKeyOpeningRecipient;
        const isScopeCurrent = () => this.isCurrentNativeCryptoWorkerScope(scope)
            && this.dataKeyOpeningRecipient === recipient
            && recipient.every((byte, index) => byte === this.contentKeyPair.privateKey[index]);
        const scopeKey = `${getScopeKey(scope)}\u0000${scope.generation}`;
        return await this.dataKeyOpenings.open(encryptedValues, {
            scopeKey, isScopeCurrent, signal: scopeInput.signal,
            shouldContinue: scopeInput.shouldContinue, workClass: scopeInput.workClass,
            open: (values, signal) => this.openDataKeyEnvelopes(values, {
                ...scope, signal, shouldContinue: isScopeCurrent, workClass: scopeInput.workClass,
            }),
        });
    }

    private async openDataKeyEnvelopes(encryptedValues: readonly string[], scopeInput: EncryptionScopeInput): Promise<Array<Uint8Array | null>> {
        // Nothing to open. Short-circuited before routing so an empty call is not
        // recorded as a routing decision it never made.
        if (encryptedValues.length === 0) return [];
        const cancellation = mergeAbortSignals([scopeInput.signal, this.accountMaterialLifetime.signal]);
        try {
            return await this.runDataKeyEnvelopeBatch(encryptedValues, { ...scopeInput, signal: cancellation.signal });
        } finally { cancellation.dispose(); }
    }

    private async runDataKeyEnvelopeBatch(encryptedValues: readonly string[], scopeInput: EncryptionScopeInput): Promise<Array<Uint8Array | null>> {
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
                    nativeRun: async (dispatchSignal) => {
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
                                signal: dispatchSignal,
                                // This borrower's currentness cancels only its own queued entries.
                                shouldContinue: scopeInput.shouldContinue,
                                workClass: scopeInput.workClass,
                                dispatch: async (queuedItems, context) => {
                                    // A shared queue outlives its first borrower. The queue
                                    // owns per-entry cancellation; dispatch only shares the
                                    // Account generation and this actual batch's signal.
                                    if (!this.isCurrentNativeCryptoWorkerScope(scope) || context.signal?.aborted === true) {
                                        return queuedItems.map(() => null);
                                    }
                                    const nativeResult = await this.nativeCryptoWorker.decryptDataKeyEnvelopeV1({
                                        scope,
                                        items: queuedItems,
                                        signal: context.signal,
                                        workClass: scopeInput.workClass,
                                        startupTimeoutMs: routing.timeoutMs,
                                    });
                                    if (nativeResult.status !== 'ok') {
                                        throw new Error('native data-key envelope decrypt batch did not complete');
                                    }
                                    return nativeResult.items;
                                },
                            });
                            bytesOut = estimateCryptoWorkerBatchBridgeBytes(items.filter((item): item is string => typeof item === 'string')).totalBridgeBytes;
                            return items;
                        } catch (error) {
                            // A borrower that stopped while queued is a stopped read, not a
                            // native failure that may degrade routing or fall back to JS.
                            if (error instanceof NativeCryptoWorkerQueueCancelledError && refreshCancellation()) {
                                return nativeItems.map(() => null);
                            }
                            throw error;
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
                    const opened = cryptoWorkerBase64ToBytes(value);
                    // A native worker is trusted for speed, not for the fixed
                    // data-key contract: anything that is not exactly one data
                    // key never reaches the Session ciphers.
                    return opened?.length === ENCRYPTED_DATA_KEY_V1_BYTES ? opened : null;
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

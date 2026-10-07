import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';

import type { EncryptionGenerationScope, EncryptionScopeInput } from './encryption';

/**
 * Per-Session outcome of opening the current viewer's Session data-key envelope.
 *
 * `legacy_fallback_ready` is the owner-only Account-scoped compatibility reader for a genuinely
 * absent envelope. It never yields a transferable standalone Session DEK, so it must not be
 * reached by a non-owner, and a present-but-unopenable envelope must never be normalized into
 * absence to reach it.
 */
export type SessionDataKeyHydrationState =
    | 'not_required'
    | 'legacy_fallback_ready'
    | 'ready'
    | 'missing_envelope'
    | 'unopenable_envelope';

/**
 * Whether the current viewer reads the Session as its owner or through a grant.
 *
 * Released projections only carry `share`, so absent `share` is the owner signal there. Once a
 * marked normalized access projection is available the caller passes its role explicitly and this
 * owner never re-infers ownership from `share`.
 */
export type SessionDataKeyViewerRole = 'owner' | 'recipient';

/** Local opening material this device actually holds. */
export type SessionDataKeyCredentialKind = 'keyless' | 'legacy_secret' | 'data_key';

type SessionDataKeyRow = Readonly<{
    id: string;
    encryptionMode?: string | null;
    dataEncryptionKey?: unknown;
    effectiveAccess?: unknown;
    share?: unknown;
    metadataLayoutVersion?: unknown;
    viewerRole?: SessionDataKeyViewerRole;
}>;

export type SessionDataKeyHydrationEncryption = Readonly<{
    decryptEncryptionKeys: (values: readonly string[], scope?: EncryptionScopeInput) => Promise<Array<Uint8Array | null>>;
    getCurrentEncryptionGenerationScope?: (scope?: EncryptionScopeInput) => EncryptionGenerationScope;
    isCurrentEncryptionGenerationScope?: (scope: EncryptionGenerationScope) => boolean;
}>;

type SessionDataKeyHydrationPlanEntry = Readonly<{
    sessionId: string;
    envelope: string | null;
    cachedKey: Uint8Array | null;
    needsDecrypt: boolean;
    /** Owner-only Account-scoped compatibility reader for a genuinely absent envelope. */
    fallbackReader: boolean;
    /** Non-null when the outcome is already decided without opening anything. */
    settledState: SessionDataKeyHydrationState | null;
}>;

export type SessionDataKeyHydrationPlan = Readonly<{
    entries: readonly SessionDataKeyHydrationPlanEntry[];
    encryptedCount: number;
    plainCount: number;
    cachedDataKeyHits: number;
    dataKeyDecryptCount: number;
}>;

export type SessionDataKeyHydrationResult = Readonly<{
    /**
     * Keys to hand to the Session encryption runtime. A `null` value is the deliberate
     * Account-scoped fallback reader request for `legacy_fallback_ready`; sessions with no usable
     * reader are absent here and listed in `sessionEncryptionClears` instead.
     */
    sessionKeys: Map<string, Uint8Array | null>;
    sessionEncryptionClears: readonly string[];
    states: ReadonlyMap<string, SessionDataKeyHydrationState>;
    stale: boolean;
}>;

type SessionDataKeyEnvelopeRead =
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'openable'; envelope: string }>
    | Readonly<{ kind: 'malformed' }>;

function isValidSessionDataKey(value: Uint8Array | null): value is Uint8Array {
    return value?.byteLength === ENCRYPTED_DATA_KEY_V1_BYTES;
}

export function readSessionDataKeyCredentialKind(
    credentials: AuthCredentials | null | undefined,
): SessionDataKeyCredentialKind {
    if (!credentials || typeof credentials !== 'object') return 'keyless';
    const encryption = (credentials as { encryption?: unknown }).encryption;
    if (encryption && typeof encryption === 'object') {
        const record = encryption as { publicKey?: unknown; machineKey?: unknown };
        if (
            typeof record.publicKey === 'string' && record.publicKey.length > 0
            && typeof record.machineKey === 'string' && record.machineKey.length > 0
        ) {
            return 'data_key';
        }
    }
    const secret = (credentials as { secret?: unknown }).secret;
    if (typeof secret === 'string' && secret.length > 0) return 'legacy_secret';
    return 'keyless';
}

export function resolveSessionDataKeyViewerRole(row: Readonly<{
    effectiveAccess?: unknown;
    share?: unknown;
    metadataLayoutVersion?: unknown;
    viewerRole?: SessionDataKeyViewerRole;
}>): SessionDataKeyViewerRole {
    if (row.viewerRole) return row.viewerRole;
    // This fallback is only for released records. A marked current projection is
    // parsed by the shared normalizer first; malformed current authority therefore
    // cannot become eligible for the owner-only Account-key compatibility reader.
    return normalizeSessionAccessProjection(row, { allowLegacy: true })?.role ?? 'recipient';
}

/**
 * Absence and malformed presence are different facts. A present value that cannot be an envelope
 * fails closed instead of falling through to owner-only Account-scoped material.
 */
function readSessionDataKeyEnvelope(value: unknown): SessionDataKeyEnvelopeRead {
    // Only `null`/`undefined` is the genuinely absent envelope of section 13.3. The released
    // projection types this column as `z.string().nullable()`, so an empty string is a present
    // value that cannot be an envelope: it fails closed for repair rather than routing an owner to
    // Account-scoped material that was never this Session's DEK.
    if (value === null || value === undefined) return { kind: 'absent' };
    if (typeof value !== 'string' || value.length === 0) return { kind: 'malformed' };
    return { kind: 'openable', envelope: value };
}

function canReadAbsentEnvelopeWithAccountMaterial(
    credentialKind: SessionDataKeyCredentialKind,
): boolean {
    return credentialKind === 'legacy_secret' || credentialKind === 'data_key';
}

export function createSessionDataKeyHydrationPlan(params: Readonly<{
    sessions: readonly SessionDataKeyRow[];
    credentialKind: SessionDataKeyCredentialKind;
    sessionDataKeys: ReadonlyMap<string, Uint8Array>;
    sessionDataKeyEnvelopes?: ReadonlyMap<string, string>;
}>): SessionDataKeyHydrationPlan {
    const entries: SessionDataKeyHydrationPlanEntry[] = [];
    let plainCount = 0;
    let cachedDataKeyHits = 0;
    let dataKeyDecryptCount = 0;

    for (const session of params.sessions) {
        if (session.encryptionMode === 'plain') {
            plainCount += 1;
            entries.push({
                sessionId: session.id,
                envelope: null,
                cachedKey: null,
                needsDecrypt: false,
                fallbackReader: false,
                settledState: 'not_required',
            });
            continue;
        }

        const envelopeRead = readSessionDataKeyEnvelope(session.dataEncryptionKey);
        if (envelopeRead.kind === 'malformed') {
            entries.push({
                sessionId: session.id,
                envelope: null,
                cachedKey: null,
                needsDecrypt: false,
                fallbackReader: false,
                settledState: 'unopenable_envelope',
            });
            continue;
        }

        if (envelopeRead.kind === 'absent') {
            const isOwner = resolveSessionDataKeyViewerRole(session) === 'owner';
            const fallbackReader = isOwner
                && canReadAbsentEnvelopeWithAccountMaterial(params.credentialKind);
            entries.push({
                sessionId: session.id,
                envelope: null,
                cachedKey: null,
                needsDecrypt: false,
                fallbackReader,
                settledState: fallbackReader ? 'legacy_fallback_ready' : 'missing_envelope',
            });
            continue;
        }

        const envelope = envelopeRead.envelope;
        const cachedKey = params.sessionDataKeys.get(session.id) ?? null;
        if (
            params.credentialKind !== 'keyless'
            && isValidSessionDataKey(cachedKey)
            && params.sessionDataKeyEnvelopes?.get(session.id) === envelope
        ) {
            cachedDataKeyHits += 1;
            entries.push({
                sessionId: session.id,
                envelope,
                cachedKey,
                needsDecrypt: false,
                fallbackReader: false,
                settledState: 'ready',
            });
            continue;
        }

        dataKeyDecryptCount += 1;
        entries.push({
            sessionId: session.id,
            envelope,
            cachedKey: null,
            needsDecrypt: true,
            fallbackReader: false,
            settledState: null,
        });
    }

    return {
        entries,
        encryptedCount: params.sessions.length - plainCount,
        plainCount,
        cachedDataKeyHits,
        dataKeyDecryptCount,
    };
}

function isHydrationScopeCurrent(params: Readonly<{
    encryption: SessionDataKeyHydrationEncryption;
    capturedScope: EncryptionGenerationScope | null;
    shouldContinue: () => boolean;
}>): boolean {
    if (!params.shouldContinue()) return false;
    if (!params.capturedScope) return true;
    return params.encryption.isCurrentEncryptionGenerationScope?.(params.capturedScope) ?? true;
}

async function decryptBatch(params: Readonly<{
    encryption: SessionDataKeyHydrationEncryption;
    envelopes: readonly string[];
    scope: EncryptionScopeInput;
}>): Promise<Array<Uint8Array | null>> {
    return params.encryption.decryptEncryptionKeys(params.envelopes, params.scope);
}

export async function hydrateSessionDataKeys(params: Readonly<{
    plan: SessionDataKeyHydrationPlan;
    encryption: SessionDataKeyHydrationEncryption;
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: Map<string, string>;
    scope?: EncryptionScopeInput;
    shouldContinue?: () => boolean;
}>): Promise<SessionDataKeyHydrationResult> {
    const scope = params.scope ?? {};
    const shouldContinue = params.shouldContinue ?? (() => true);
    const capturedScope = params.encryption.getCurrentEncryptionGenerationScope?.(scope) ?? null;
    const sessionKeys = new Map<string, Uint8Array | null>();
    const sessionEncryptionClears: string[] = [];
    const states = new Map<string, SessionDataKeyHydrationState>();
    if (!isHydrationScopeCurrent({ encryption: params.encryption, capturedScope, shouldContinue })) {
        return { sessionKeys, sessionEncryptionClears, states, stale: true };
    }

    const decryptEntries = params.plan.entries.filter((entry) => entry.needsDecrypt && entry.envelope);
    const decryptedKeys = decryptEntries.length > 0
        ? await decryptBatch({
            encryption: params.encryption,
            envelopes: decryptEntries.map((entry) => entry.envelope!),
            scope,
        })
        : [];

    if (!isHydrationScopeCurrent({ encryption: params.encryption, capturedScope, shouldContinue })) {
        return { sessionKeys, sessionEncryptionClears, states, stale: true };
    }

    const decryptedBySessionId = new Map<string, Uint8Array | null>();
    for (let index = 0; index < decryptEntries.length; index += 1) {
        decryptedBySessionId.set(decryptEntries[index]!.sessionId, decryptedKeys[index] ?? null);
    }

    const forgetCachedDataKey = (sessionId: string) => {
        params.sessionDataKeys.delete(sessionId);
        params.sessionDataKeyEnvelopes?.delete(sessionId);
    };

    for (const entry of params.plan.entries) {
        const openedKey = entry.needsDecrypt
            ? decryptedBySessionId.get(entry.sessionId) ?? null
            : entry.cachedKey;
        const state: SessionDataKeyHydrationState = entry.settledState
            ?? (isValidSessionDataKey(openedKey) ? 'ready' : 'unopenable_envelope');
        states.set(entry.sessionId, state);

        switch (state) {
            case 'not_required':
                // A plain Session keeps no per-Session key material.
                forgetCachedDataKey(entry.sessionId);
                break;
            case 'legacy_fallback_ready':
                // No standalone DEK exists; `null` asks the runtime for the Account-scoped reader.
                forgetCachedDataKey(entry.sessionId);
                sessionKeys.set(entry.sessionId, null);
                break;
            case 'ready':
                sessionKeys.set(entry.sessionId, openedKey!);
                params.sessionDataKeys.set(entry.sessionId, openedKey!);
                if (entry.envelope) {
                    params.sessionDataKeyEnvelopes?.set(entry.sessionId, entry.envelope);
                }
                break;
            case 'missing_envelope':
            case 'unopenable_envelope':
                forgetCachedDataKey(entry.sessionId);
                sessionEncryptionClears.push(entry.sessionId);
                break;
        }
    }

    return { sessionKeys, sessionEncryptionClears, states, stale: false };
}

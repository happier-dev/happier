import type { EncryptionGenerationScope, EncryptionScopeInput } from './encryption';

type SessionDataKeyRow = Readonly<{
    id: string;
    encryptionMode?: string | null;
    dataEncryptionKey?: string | null;
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
    hasEnvelope: boolean;
    shouldClearRuntimeEncryption: boolean;
}>;

export type SessionDataKeyHydrationPlan = Readonly<{
    entries: readonly SessionDataKeyHydrationPlanEntry[];
    encryptedCount: number;
    plainCount: number;
    cachedDataKeyHits: number;
    dataKeyDecryptCount: number;
}>;

export type SessionDataKeyHydrationResult = Readonly<{
    sessionKeys: Map<string, Uint8Array | null>;
    sessionEncryptionClears: readonly string[];
    stale: boolean;
}>;

export function createSessionDataKeyHydrationPlan(params: Readonly<{
    sessions: readonly SessionDataKeyRow[];
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
                hasEnvelope: false,
                shouldClearRuntimeEncryption: false,
            });
            continue;
        }

        const envelope = typeof session.dataEncryptionKey === 'string' && session.dataEncryptionKey.length > 0
            ? session.dataEncryptionKey
            : null;
        if (!envelope) {
            entries.push({
                sessionId: session.id,
                envelope: null,
                cachedKey: null,
                needsDecrypt: false,
                hasEnvelope: false,
                shouldClearRuntimeEncryption: true,
            });
            continue;
        }

        const cachedKey = params.sessionDataKeys.get(session.id) ?? null;
        if (cachedKey && params.sessionDataKeyEnvelopes?.get(session.id) === envelope) {
            cachedDataKeyHits += 1;
            entries.push({
                sessionId: session.id,
                envelope,
                cachedKey,
                needsDecrypt: false,
                hasEnvelope: true,
                shouldClearRuntimeEncryption: false,
            });
            continue;
        }

        dataKeyDecryptCount += 1;
        entries.push({
            sessionId: session.id,
            envelope,
            cachedKey: null,
            needsDecrypt: true,
            hasEnvelope: true,
            shouldClearRuntimeEncryption: false,
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
    if (!isHydrationScopeCurrent({ encryption: params.encryption, capturedScope, shouldContinue })) {
        return { sessionKeys, sessionEncryptionClears, stale: true };
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
        return { sessionKeys, sessionEncryptionClears, stale: true };
    }

    const decryptedBySessionId = new Map<string, Uint8Array | null>();
    for (let index = 0; index < decryptEntries.length; index += 1) {
        decryptedBySessionId.set(decryptEntries[index]!.sessionId, decryptedKeys[index] ?? null);
    }

    for (const entry of params.plan.entries) {
        if (!entry.hasEnvelope) {
            params.sessionDataKeys.delete(entry.sessionId);
            params.sessionDataKeyEnvelopes?.delete(entry.sessionId);
            if (entry.shouldClearRuntimeEncryption) {
                sessionEncryptionClears.push(entry.sessionId);
            }
            continue;
        }

        const decryptedKey = entry.needsDecrypt
            ? decryptedBySessionId.get(entry.sessionId) ?? null
            : entry.cachedKey;
        if (decryptedKey) {
            sessionKeys.set(entry.sessionId, decryptedKey);
            params.sessionDataKeys.set(entry.sessionId, decryptedKey);
            if (entry.envelope) {
                params.sessionDataKeyEnvelopes?.set(entry.sessionId, entry.envelope);
            }
        } else {
            params.sessionDataKeys.delete(entry.sessionId);
            params.sessionDataKeyEnvelopes?.delete(entry.sessionId);
            sessionEncryptionClears.push(entry.sessionId);
        }
    }

    return { sessionKeys, sessionEncryptionClears, stale: false };
}

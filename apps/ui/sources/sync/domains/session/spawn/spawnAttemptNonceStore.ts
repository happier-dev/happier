import { getPersistenceStorage } from '@/sync/domains/state/persistence';
import {
    serverAccountScopedStorageKey,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { withTimeout } from '@/utils/timing/time';

import { createUiSessionSpawnNonce, normalizeSpawnSessionNonce } from './spawnSessionNonce';

const STORAGE_KEY_PREFIX = 'session-spawn-attempts-v1';
const LOCK_NAME_PREFIX = 'happier:session-spawn-attempts-v2';
const SPAWN_ATTEMPT_MUTATION_LOCK_TIMEOUT_MS = 5_000;

export type PersistedSpawnAttempt = Readonly<{
    v: 2;
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
    nonce: string;
    phase: 'spawning' | 'post_spawn';
    createdSessionId: string | null;
    firstTurnLocalId: string;
    attachmentMessageLocalId: string;
}>;

type PersistedSpawnAttempts = Readonly<Record<string, PersistedSpawnAttempt>>;
type QuarantinedSpawnAttempts = Readonly<Record<string, Readonly<{
    raw: unknown;
    reason: string;
}>>>;

export type SpawnAttemptCustodyStoreState =
    | Readonly<{ status: 'missing' }>
    | Readonly<{
        status: 'valid';
        attempts: PersistedSpawnAttempts;
        quarantined?: QuarantinedSpawnAttempts;
    }>
    | Readonly<{
        status: 'unreadable';
        diagnostic: Readonly<{ raw: string; reason: string }>;
    }>;

export type AcquireSpawnAttemptCustodyResult =
    | Readonly<{ status: 'acquired'; record: PersistedSpawnAttempt; reused: boolean }>
    | Readonly<{ status: 'unreadable' }>
    | Readonly<{ status: 'lock_unavailable' }>;

function normalizeRequired(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function recordId(machineId: string, targetFingerprint: string, userAttemptId: string): string {
    return `${machineId.length}:${machineId}${targetFingerprint.length}:${targetFingerprint}${userAttemptId.length}:${userAttemptId}`;
}

function storageKey(scope: ServerAccountScope): string {
    return serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope);
}

function lockName(scope: ServerAccountScope): string {
    return `${LOCK_NAME_PREFIX}:${encodeURIComponent(scope.serverId)}:${encodeURIComponent(scope.accountId)}`;
}

function isWebRuntime(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readWebLockManager(): LockManager | null {
    if (typeof navigator === 'undefined') return null;
    return navigator.locks ?? null;
}

async function withSpawnAttemptMutationLock<T>(
    scope: ServerAccountScope,
    mutate: () => T,
): Promise<Readonly<{ status: 'completed'; value: T }> | Readonly<{ status: 'lock_unavailable' }>> {
    const webLockManager = readWebLockManager();
    if (webLockManager) {
        const abortController = new AbortController();
        let mayMutate = true;
        let lockAcquired = false;
        try {
            return await withTimeout(
                webLockManager.request(lockName(scope), { signal: abortController.signal }, async () => {
                    if (!mayMutate) return { status: 'lock_unavailable' as const };
                    lockAcquired = true;
                    return {
                        status: 'completed' as const,
                        value: mutate(),
                    };
                }),
                SPAWN_ATTEMPT_MUTATION_LOCK_TIMEOUT_MS,
                'session spawn custody mutation lock',
            );
        } catch (error) {
            if (lockAcquired) throw error;
            return { status: 'lock_unavailable' };
        } finally {
            mayMutate = false;
            abortController.abort();
        }
    }
    if (isWebRuntime()) {
        return { status: 'lock_unavailable' };
    }
    // Native and non-browser runtimes have one synchronous MMKV owner in this JS runtime.
    // The mutation contains no await, so calls cannot interleave between read and write.
    return { status: 'completed', value: mutate() };
}

export function readSpawnAttemptCustodyState(scope: ServerAccountScope): SpawnAttemptCustodyStoreState {
    const raw = getPersistenceStorage().getString(storageKey(scope));
    if (raw === undefined || raw === null || raw.length === 0) return { status: 'missing' };

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                status: 'unreadable',
                diagnostic: { raw, reason: 'invalid_top_level' },
            };
        }

        const parsedRecord = parsed as Record<string, unknown>;
        if (
            parsedRecord.v !== 3
            || !parsedRecord.attempts
            || typeof parsedRecord.attempts !== 'object'
            || Array.isArray(parsedRecord.attempts)
        ) {
            return {
                status: 'unreadable',
                diagnostic: { raw, reason: 'invalid_top_level' },
            };
        }
        const rawAttempts = parsedRecord.attempts as Record<string, unknown>;
        const existingQuarantine = parsedRecord.quarantined
            && typeof parsedRecord.quarantined === 'object'
            && !Array.isArray(parsedRecord.quarantined)
            ? parsedRecord.quarantined as QuarantinedSpawnAttempts
            : {};
        const attempts: Record<string, PersistedSpawnAttempt> = {};
        const quarantined: Record<string, { raw: unknown; reason: string }> = {
            ...existingQuarantine,
        };
        for (const [id, value] of Object.entries(rawAttempts)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                quarantined[id] = { raw: value, reason: 'invalid_record' };
                continue;
            }
            const record = value as Record<string, unknown>;
            const machineId = normalizeRequired(record.machineId);
            const targetFingerprint = normalizeRequired(record.targetFingerprint);
            const userAttemptId = normalizeRequired(record.userAttemptId);
            const nonce = normalizeSpawnSessionNonce(record.nonce);
            const recordScope = record.scope && typeof record.scope === 'object' && !Array.isArray(record.scope)
                ? record.scope as Record<string, unknown>
                : null;
            if (
                record.v !== 2
                || !machineId
                || !targetFingerprint
                || !userAttemptId
                || !nonce
                || recordScope?.serverId !== scope.serverId
                || recordScope?.accountId !== scope.accountId
                || id !== recordId(machineId, targetFingerprint, userAttemptId)
            ) {
                quarantined[id] = { raw: value, reason: 'invalid_record' };
                continue;
            }
            const phase = record.phase === 'spawning' || record.phase === 'post_spawn'
                ? record.phase
                : null;
            const createdSessionId = record.createdSessionId === null
                ? null
                : normalizeRequired(record.createdSessionId);
            const firstTurnLocalId = normalizeRequired(record.firstTurnLocalId);
            const attachmentMessageLocalId = normalizeRequired(record.attachmentMessageLocalId);
            if (
                !phase
                || (phase === 'spawning' ? record.createdSessionId !== null : !createdSessionId)
                || !firstTurnLocalId
                || !attachmentMessageLocalId
            ) {
                quarantined[id] = { raw: value, reason: 'invalid_record' };
                continue;
            }
            attempts[id] = {
                v: 2,
                scope,
                machineId,
                targetFingerprint,
                userAttemptId,
                nonce,
                phase,
                createdSessionId,
                firstTurnLocalId,
                attachmentMessageLocalId,
            };
        }
        return {
            status: 'valid',
            attempts,
            ...(Object.keys(quarantined).length > 0 ? { quarantined } : {}),
        };
    } catch {
        return {
            status: 'unreadable',
            diagnostic: { raw, reason: 'invalid_json' },
        };
    }
}

export function findSpawnAttemptCustody(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    userAttemptId: string;
}>): PersistedSpawnAttempt | null {
    const machineId = normalizeRequired(params.machineId);
    const userAttemptId = normalizeRequired(params.userAttemptId);
    if (!machineId || !userAttemptId) return null;
    const state = readSpawnAttemptCustodyState(params.scope);
    if (state.status !== 'valid') return null;
    const matches = Object.values(state.attempts).filter((candidate) => (
        candidate.machineId === machineId
        && candidate.userAttemptId === userAttemptId
    ));
    return matches.length === 1 ? matches[0]! : null;
}

function writeAttempts(
    scope: ServerAccountScope,
    attempts: PersistedSpawnAttempts,
    quarantined: QuarantinedSpawnAttempts = {},
): void {
    const storage = getPersistenceStorage();
    const key = storageKey(scope);
    if (Object.keys(attempts).length === 0 && Object.keys(quarantined).length === 0) {
        storage.delete(key);
        return;
    }
    storage.set(key, JSON.stringify({
        v: 3,
        attempts,
        quarantined,
    }));
}

export function normalizeSpawnAttemptKey(value: unknown): string | null {
    return normalizeRequired(value);
}

export function normalizeSpawnUserAttemptId(value: unknown): string | null {
    return normalizeRequired(value);
}

export async function acquireSpawnAttemptCustody(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId?: string | null;
    createUserAttemptId?: () => string;
    seedNonce?: string | null;
    firstTurnLocalId?: string | null;
    attachmentMessageLocalId?: string | null;
}>): Promise<AcquireSpawnAttemptCustodyResult> {
    const machineId = normalizeRequired(params.machineId);
    const targetFingerprint = normalizeRequired(params.targetFingerprint);
    const userAttemptId = normalizeRequired(params.userAttemptId)
        ?? normalizeRequired(params.createUserAttemptId?.());
    if (!machineId || !targetFingerprint) {
        throw new Error('Spawn attempt custody scope is incomplete');
    }
    if (!userAttemptId) throw new Error('Spawn attempt user action identity is unavailable');

    const locked = await withSpawnAttemptMutationLock(params.scope, (): AcquireSpawnAttemptCustodyResult => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status === 'unreadable') return { status: 'unreadable' };
        const attempts = state.status === 'valid' ? state.attempts : {};
        const quarantined = state.status === 'valid' ? state.quarantined : undefined;
        const id = recordId(machineId, targetFingerprint, userAttemptId);
        const existing = attempts[id];
        if (existing) {
            return { status: 'acquired', record: existing, reused: true };
        }

        const nonce = normalizeSpawnSessionNonce(params.seedNonce) ?? createUiSessionSpawnNonce();
        const record: PersistedSpawnAttempt = {
            v: 2,
            scope: params.scope,
            machineId,
            targetFingerprint,
            userAttemptId,
            nonce,
            phase: 'spawning',
            createdSessionId: null,
            firstTurnLocalId: normalizeRequired(params.firstTurnLocalId)
                ?? `spawn-first-turn:${userAttemptId}`,
            attachmentMessageLocalId: normalizeRequired(params.attachmentMessageLocalId)
                ?? `spawn-attachments:${userAttemptId}`,
        };
        writeAttempts(params.scope, { ...attempts, [id]: record }, quarantined);
        return { status: 'acquired', record, reused: false };
    });
    return locked.status === 'completed' ? locked.value : locked;
}

export async function markSpawnAttemptSessionCreated(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
    createdSessionId: string;
}>): Promise<boolean> {
    const machineId = normalizeRequired(params.machineId);
    const targetFingerprint = normalizeRequired(params.targetFingerprint);
    const userAttemptId = normalizeRequired(params.userAttemptId);
    const createdSessionId = normalizeRequired(params.createdSessionId);
    if (!machineId || !targetFingerprint || !userAttemptId || !createdSessionId) return false;

    const locked = await withSpawnAttemptMutationLock(params.scope, () => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status !== 'valid') return false;
        const id = recordId(machineId, targetFingerprint, userAttemptId);
        const existing = state.attempts[id];
        if (!existing) return false;
        writeAttempts(params.scope, {
            ...state.attempts,
            [id]: {
                ...existing,
                phase: 'post_spawn',
                createdSessionId,
            },
        }, state.quarantined);
        return true;
    });
    return locked.status === 'completed' ? locked.value : false;
}

export async function clearSpawnAttemptCustody(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
}>): Promise<boolean> {
    const machineId = normalizeRequired(params.machineId);
    const targetFingerprint = normalizeRequired(params.targetFingerprint);
    const userAttemptId = normalizeRequired(params.userAttemptId);
    if (!machineId || !targetFingerprint || !userAttemptId) return false;

    const locked = await withSpawnAttemptMutationLock(params.scope, () => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status !== 'valid') return false;
        const id = recordId(machineId, targetFingerprint, userAttemptId);
        const existing = state.attempts[id];
        if (!existing) return false;
        const next = { ...state.attempts };
        delete next[id];
        writeAttempts(params.scope, next, state.quarantined);
        return true;
    });
    return locked.status === 'completed' ? locked.value : false;
}

export async function reconcileSpawnAttemptCustodyFromOperation(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    userAttemptId: string;
    requestId: string;
    outcome:
        | Readonly<{ kind: 'succeeded'; createdSessionId: string }>
        | Readonly<{ kind: 'failed' | 'cancelled' }>;
}>): Promise<
    | Readonly<{ status: 'reconciled'; record: PersistedSpawnAttempt }>
    | Readonly<{ status: 'removed' }>
    | Readonly<{ status: 'not_found' }>
> {
    const requestId = normalizeSpawnSessionNonce(params.requestId);
    const existing = findSpawnAttemptCustody(params);
    if (!requestId || !existing || existing.nonce !== requestId) return { status: 'not_found' };

    if (params.outcome.kind !== 'succeeded') {
        const removed = await clearSpawnAttemptCustody({
            scope: params.scope,
            machineId: existing.machineId,
            targetFingerprint: existing.targetFingerprint,
            userAttemptId: existing.userAttemptId,
        });
        return removed ? { status: 'removed' } : { status: 'not_found' };
    }

    const createdSessionId = normalizeRequired(params.outcome.createdSessionId);
    if (!createdSessionId) return { status: 'not_found' };
    const reconciled = await markSpawnAttemptSessionCreated({
        scope: params.scope,
        machineId: existing.machineId,
        targetFingerprint: existing.targetFingerprint,
        userAttemptId: existing.userAttemptId,
        createdSessionId,
    });
    if (!reconciled) return { status: 'not_found' };
    return {
        status: 'reconciled',
        record: {
            ...existing,
            phase: 'post_spawn',
            createdSessionId,
        },
    };
}

export async function resetUnreadableSpawnAttemptCustody(scope: ServerAccountScope): Promise<boolean> {
    const locked = await withSpawnAttemptMutationLock(scope, () => {
        const state = readSpawnAttemptCustodyState(scope);
        if (state.status !== 'unreadable') return false;
        const storage = getPersistenceStorage();
        storage.delete(storageKey(scope));
        return true;
    });
    return locked.status === 'completed' ? locked.value : false;
}

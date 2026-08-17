import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import {
    serverAccountScopedStorageKey,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { buildSpawnedFirstTurnLocalId } from '@happier-dev/protocol';
import { withTimeout } from '@/utils/timing/time';

import { createUiSessionSpawnNonce, normalizeSpawnSessionNonce } from './spawnSessionNonce';

const STORAGE_KEY_PREFIX = 'session-spawn-attempts-v1';
const QUARANTINE_STORAGE_KEY_PREFIX = 'session-spawn-attempts-quarantine-v1';
const LOCK_NAME_PREFIX = 'happier:session-spawn-attempts-v2';
const SPAWN_ATTEMPT_MUTATION_LOCK_TIMEOUT_MS = 5_000;

export type PersistedSpawnAttempt = Readonly<{
    v: 3;
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
    nonce: string;
    submissionState: 'prepared' | 'submitted';
    createdSessionId: string | null;
    firstTurnLocalId: string;
    attachmentMessageLocalId: string;
}>;

type PersistedSpawnAttempts = Readonly<Record<string, PersistedSpawnAttempt>>;

export type SpawnAttemptCustodyStoreState =
    | Readonly<{ status: 'missing' }>
    | Readonly<{
        status: 'valid';
        attempts: PersistedSpawnAttempts;
        quarantinedRecordIds?: readonly string[];
    }>
    | Readonly<{ status: 'corrupt' }>;

export type AcquireSpawnAttemptCustodyResult =
    | Readonly<{ status: 'acquired'; record: PersistedSpawnAttempt; reused: boolean }>
    | Readonly<{ status: 'corrupt' }>
    | Readonly<{ status: 'lock_unavailable' }>;

export type SpawnAttemptCustodyQuarantine =
    | Readonly<{ kind: 'rows'; rows: Readonly<Record<string, unknown>> }>
    | Readonly<{ kind: 'unreadable_blob'; raw: string }>;

function normalizeRequired(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function recordId(machineId: string, targetFingerprint: string, userAttemptId: string): string {
    return `${machineId.length}:${machineId}${targetFingerprint.length}:${targetFingerprint}${userAttemptId.length}:${userAttemptId}`;
}

function legacyRecordId(machineId: string, targetFingerprint: string): string {
    return `${machineId.length}:${machineId}${targetFingerprint.length}:${targetFingerprint}`;
}

function storageKey(scope: ServerAccountScope): string {
    return serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope);
}

function quarantineStorageKey(scope: ServerAccountScope): string {
    return serverAccountScopedStorageKey(QUARANTINE_STORAGE_KEY_PREFIX, scope);
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
            writeQuarantine(scope, { kind: 'unreadable_blob', raw });
            return { status: 'corrupt' };
        }

        const parsedRecord = parsed as Record<string, unknown>;
        const isRemotePredecessorEnvelope = parsedRecord.v === 3
            && parsedRecord.attempts
            && typeof parsedRecord.attempts === 'object'
            && !Array.isArray(parsedRecord.attempts);
        const rawAttempts = isRemotePredecessorEnvelope
            ? parsedRecord.attempts as Record<string, unknown>
            : parsedRecord;
        const attempts: Record<string, PersistedSpawnAttempt> = {};
        const quarantinedRows: Record<string, unknown> = {};
        if (
            isRemotePredecessorEnvelope
            && parsedRecord.quarantined
            && typeof parsedRecord.quarantined === 'object'
            && !Array.isArray(parsedRecord.quarantined)
        ) {
            for (const [id, value] of Object.entries(parsedRecord.quarantined as Record<string, unknown>)) {
                quarantinedRows[id] = value
                    && typeof value === 'object'
                    && !Array.isArray(value)
                    && Object.prototype.hasOwnProperty.call(value, 'raw')
                    ? (value as Record<string, unknown>).raw
                    : value;
            }
        }
        for (const [id, value] of Object.entries(rawAttempts)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                quarantinedRows[id] = value;
                continue;
            }
            const record = value as Record<string, unknown>;
            const machineId = normalizeRequired(record.machineId);
            const targetFingerprint = normalizeRequired(record.targetFingerprint);
            const userAttemptId = normalizeRequired(record.userAttemptId);
            const nonce = normalizeSpawnSessionNonce(record.nonce);
            const submissionState = record.v === 2
                ? 'submitted'
                : record.submissionState === 'prepared' || record.submissionState === 'submitted'
                    ? record.submissionState
                    : null;
            const recordScope = record.scope && typeof record.scope === 'object' && !Array.isArray(record.scope)
                ? record.scope as Record<string, unknown>
                : null;
            if (
                (record.v !== 2 && record.v !== 3)
                || !machineId
                || !targetFingerprint
                || !userAttemptId
                || !nonce
                || !submissionState
                || recordScope?.serverId !== scope.serverId
                || recordScope?.accountId !== scope.accountId
                || (
                    id !== recordId(machineId, targetFingerprint, userAttemptId)
                    && id !== legacyRecordId(machineId, targetFingerprint)
                )
            ) {
                quarantinedRows[id] = value;
                continue;
            }
            const firstTurnLocalId = normalizeRequired(record.firstTurnLocalId)
                ?? buildSpawnedFirstTurnLocalId(nonce);
            const attachmentMessageLocalId = normalizeRequired(record.attachmentMessageLocalId)
                ?? `spawn-attachment:${nonce}`;
            if (!firstTurnLocalId || !attachmentMessageLocalId) {
                quarantinedRows[id] = value;
                continue;
            }
            attempts[recordId(machineId, targetFingerprint, userAttemptId)] = {
                v: 3,
                scope,
                machineId,
                targetFingerprint,
                userAttemptId,
                nonce,
                submissionState,
                createdSessionId: normalizeRequired(record.createdSessionId),
                firstTurnLocalId,
                attachmentMessageLocalId,
            };
        }
        const quarantinedRecordIds = Object.keys(quarantinedRows);
        if (quarantinedRecordIds.length > 0) {
            writeQuarantine(scope, { kind: 'rows', rows: quarantinedRows });
        }
        return {
            status: 'valid',
            attempts,
            ...(quarantinedRecordIds.length > 0 ? { quarantinedRecordIds } : {}),
        };
    } catch {
        writeQuarantine(scope, { kind: 'unreadable_blob', raw });
        return { status: 'corrupt' };
    }
}

function writeQuarantine(scope: ServerAccountScope, quarantine: SpawnAttemptCustodyQuarantine): void {
    getPersistenceStorage().set(quarantineStorageKey(scope), JSON.stringify(quarantine));
}

export function readSpawnAttemptCustodyQuarantine(
    scope: ServerAccountScope,
): SpawnAttemptCustodyQuarantine | null {
    const raw = getPersistenceStorage().getString(quarantineStorageKey(scope));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as SpawnAttemptCustodyQuarantine;
        if (parsed?.kind === 'unreadable_blob' && typeof parsed.raw === 'string') return parsed;
        if (parsed?.kind === 'rows' && parsed.rows && typeof parsed.rows === 'object') return parsed;
    } catch {
        // The quarantine is diagnostic-only; an unreadable diagnostic cannot authorize mutation.
    }
    return null;
}

export function resetUnreadableSpawnAttemptCustody(scope: ServerAccountScope): boolean {
    const state = readSpawnAttemptCustodyState(scope);
    const quarantine = readSpawnAttemptCustodyQuarantine(scope);
    if (state.status !== 'corrupt' || quarantine?.kind !== 'unreadable_blob') return false;
    getPersistenceStorage().delete(storageKey(scope));
    return true;
}

function writeAttempts(scope: ServerAccountScope, attempts: PersistedSpawnAttempts): void {
    const storage = getPersistenceStorage();
    const key = storageKey(scope);
    if (Object.keys(attempts).length === 0) {
        storage.delete(key);
        return;
    }
    storage.set(key, JSON.stringify(attempts));
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
}>): Promise<AcquireSpawnAttemptCustodyResult> {
    const machineId = normalizeRequired(params.machineId);
    const targetFingerprint = normalizeRequired(params.targetFingerprint);
    if (!machineId || !targetFingerprint) {
        throw new Error('Spawn attempt custody scope is incomplete');
    }
    const userAttemptId = normalizeRequired(params.userAttemptId)
        ?? normalizeRequired(params.createUserAttemptId?.());
    if (!userAttemptId) throw new Error('Spawn attempt user action identity is unavailable');

    const locked = await withSpawnAttemptMutationLock(params.scope, (): AcquireSpawnAttemptCustodyResult => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status === 'corrupt') return { status: 'corrupt' };
        const attempts = state.status === 'valid' ? state.attempts : {};
        const id = recordId(machineId, targetFingerprint, userAttemptId);
        const existing = attempts[id];
        if (existing) {
            return { status: 'acquired', record: existing, reused: true };
        }

        const nonce = normalizeSpawnSessionNonce(params.seedNonce) ?? createUiSessionSpawnNonce();
        const firstTurnLocalId = buildSpawnedFirstTurnLocalId(nonce);
        if (!firstTurnLocalId) throw new Error('Spawn attempt first-turn identity is unavailable');
        const record: PersistedSpawnAttempt = {
            v: 3,
            scope: params.scope,
            machineId,
            targetFingerprint,
            userAttemptId,
            nonce,
            submissionState: 'prepared',
            createdSessionId: null,
            firstTurnLocalId,
            attachmentMessageLocalId: `spawn-attachment:${nonce}`,
        };
        writeAttempts(params.scope, { ...attempts, [id]: record });
        return { status: 'acquired', record, reused: false };
    });
    return locked.status === 'completed' ? locked.value : locked;
}

export async function markSpawnAttemptCreated(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
    nonce: string;
    createdSessionId: string;
}>): Promise<PersistedSpawnAttempt | null> {
    const machineId = normalizeRequired(params.machineId);
    const targetFingerprint = normalizeRequired(params.targetFingerprint);
    const userAttemptId = normalizeRequired(params.userAttemptId);
    const nonce = normalizeSpawnSessionNonce(params.nonce);
    const createdSessionId = normalizeRequired(params.createdSessionId);
    if (!machineId || !targetFingerprint || !userAttemptId || !nonce || !createdSessionId) return null;

    const locked = await withSpawnAttemptMutationLock(params.scope, () => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status !== 'valid') return null;
        const id = recordId(machineId, targetFingerprint, userAttemptId);
        const existing = state.attempts[id];
        if (!existing || existing.userAttemptId !== userAttemptId || existing.nonce !== nonce) return null;
        if (existing.createdSessionId && existing.createdSessionId !== createdSessionId) return null;
        const created = { ...existing, createdSessionId };
        writeAttempts(params.scope, { ...state.attempts, [id]: created });
        return created;
    });
    return locked.status === 'completed' ? locked.value : null;
}

export async function markSpawnAttemptSubmitted(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
    nonce: string;
}>): Promise<PersistedSpawnAttempt | null> {
    const machineId = normalizeRequired(params.machineId);
    const targetFingerprint = normalizeRequired(params.targetFingerprint);
    const userAttemptId = normalizeRequired(params.userAttemptId);
    const nonce = normalizeSpawnSessionNonce(params.nonce);
    if (!machineId || !targetFingerprint || !userAttemptId || !nonce) return null;

    const locked = await withSpawnAttemptMutationLock(params.scope, () => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status !== 'valid') return null;
        const id = recordId(machineId, targetFingerprint, userAttemptId);
        const existing = state.attempts[id];
        if (!existing || existing.userAttemptId !== userAttemptId || existing.nonce !== nonce) return null;
        if (existing.submissionState === 'submitted') return existing;
        const submitted: PersistedSpawnAttempt = { ...existing, submissionState: 'submitted' };
        writeAttempts(params.scope, { ...state.attempts, [id]: submitted });
        return submitted;
    });
    return locked.status === 'completed' ? locked.value : null;
}

export async function clearSpawnAttemptCustody(params: Readonly<{
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
    nonce?: string | null;
}>): Promise<boolean> {
    const machineId = normalizeRequired(params.machineId);
    const targetFingerprint = normalizeRequired(params.targetFingerprint);
    const userAttemptId = normalizeRequired(params.userAttemptId);
    const nonce = params.nonce == null ? null : normalizeSpawnSessionNonce(params.nonce);
    if (!machineId || !targetFingerprint || !userAttemptId) return false;

    const locked = await withSpawnAttemptMutationLock(params.scope, () => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status !== 'valid') return false;
        const id = recordId(machineId, targetFingerprint, userAttemptId);
        const existing = state.attempts[id];
        if (
            !existing
            || existing.userAttemptId !== userAttemptId
            || (nonce !== null && existing.nonce !== nonce)
        ) return false;
        const next = { ...state.attempts };
        delete next[id];
        writeAttempts(params.scope, next);
        return true;
    });
    return locked.status === 'completed' ? locked.value : false;
}

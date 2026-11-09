import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SessionCreationKeyV1Schema, deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';

import { createUiSessionSpawnNonce, normalizeSpawnSessionNonce } from './spawnSessionNonce';
import { normalizeRequired, recordId, readSpawnAttemptCustodyState, writeAttempts,
    type PersistedSpawnAttempt } from './custodyPersistence';
export { readSpawnAttemptCustodyState, readSpawnAttemptCustodyQuarantine, resetUnreadableSpawnAttemptCustody,
    type PersistedSpawnAttempt, type SpawnAttemptCustodyStoreState, type SpawnAttemptCustodyQuarantine } from './custodyPersistence';

const LOCK_NAME_PREFIX = 'happier:session-spawn-attempts-v2';

export type AcquireSpawnAttemptCustodyResult =
    | Readonly<{ status: 'acquired'; record: PersistedSpawnAttempt; reused: boolean;
        previousSubmissionState?: PersistedSpawnAttempt['submissionState'] }>
    | Readonly<{ status: 'corrupt' }>
    | Readonly<{ status: 'lock_unavailable' }>;

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
        let lockAcquired = false;
        try {
            return await webLockManager.request(lockName(scope), {}, () => {
                lockAcquired = true;
                return {
                    status: 'completed' as const,
                    value: mutate(),
                };
            });
        } catch (error) {
            if (lockAcquired) throw error;
            return { status: 'lock_unavailable' };
        }
    }
    if (isWebRuntime()) {
        return { status: 'lock_unavailable' };
    }
    // Native and non-browser runtimes have one synchronous MMKV owner in this JS runtime.
    // The mutation contains no await, so calls cannot interleave between read and write.
    return { status: 'completed', value: mutate() };
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
    /** Commit dispatch custody in this transaction; raw Machine callers prepare their payload first. */
    submissionState?: 'submitted';
    authoringOriginPersistence?: PersistedSpawnAttempt['authoringOriginPersistence'];
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
            let record = existing;
            if (params.submissionState === 'submitted' && !existing.terminalResult) {
                if (existing.submissionState === 'prepared') {
                    record = { ...existing, submissionState: 'submitted' };
                } else if (existing.createdSessionId === null && !existing.hasSubmittedRetry) {
                    record = { ...existing, hasSubmittedRetry: true };
                }
            }
            if (record !== existing) writeAttempts(params.scope, { ...attempts, [id]: record });
            return { status: 'acquired', record, reused: true,
                ...(params.submissionState === 'submitted' ? { previousSubmissionState: existing.submissionState } : {}) };
        }

        const nonce = normalizeSpawnSessionNonce(params.seedNonce) ?? createUiSessionSpawnNonce();
        const creationKey = SessionCreationKeyV1Schema.parse(`manual:${userAttemptId}`);
        const firstTurnLocalId = buildSessionSpawnInitialInputLocalIdV1({
            sessionCreationTag: deriveSessionCreationTagV1({
                callerCreationNamespace: 'user',
                creationKey,
            }),
        });
        const record: PersistedSpawnAttempt = {
            v: 3,
            scope: params.scope,
            machineId,
            targetFingerprint,
            userAttemptId,
            nonce,
            submissionState: params.submissionState ?? 'prepared',
            createdSessionId: null,
            firstTurnLocalId,
            // Attachment preparation and text admission compose one Message;
            // both phases use its sole creation-derived retry identity.
            attachmentMessageLocalId: firstTurnLocalId,
            ...(params.authoringOriginPersistence ? { authoringOriginPersistence: params.authoringOriginPersistence } : {}),
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
        const { terminalResult: _terminalResult, ...withoutTerminalResult } = existing;
        const created = { ...withoutTerminalResult, createdSessionId };
        writeAttempts(params.scope, { ...state.attempts, [id]: created });
        return created;
    });
    return locked.status === 'completed' ? locked.value : null;
}

/** Retain the original typed refusal; it is never represented as a native operation. */
export async function markSpawnAttemptRefused(params: Readonly<{
    record: PersistedSpawnAttempt;
    result: NonNullable<PersistedSpawnAttempt['terminalResult']>;
}>): Promise<PersistedSpawnAttempt | null> {
    const { record, result } = params;
    const locked = await withSpawnAttemptMutationLock(record.scope, () => {
        const state = readSpawnAttemptCustodyState(record.scope);
        if (state.status !== 'valid') return null;
        const id = recordId(record.machineId, record.targetFingerprint, record.userAttemptId);
        const existing = state.attempts[id];
        if (!existing || existing.nonce !== record.nonce || existing.createdSessionId !== null
            || existing.hasSubmittedRetry || result.retryable) return null;
        const refused = { ...existing, terminalResult: result };
        writeAttempts(record.scope, { ...state.attempts, [id]: refused });
        return refused;
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
    /** No-effect settlement cannot discard a committed receipt or a subsequent submission. */
    onlyIfUncommitted?: true;
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
            || (params.onlyIfUncommitted === true && (existing.createdSessionId !== null || existing.hasSubmittedRetry === true))
        ) return false;
        const next = { ...state.attempts };
        delete next[id];
        writeAttempts(params.scope, next);
        return true;
    });
    return locked.status === 'completed' ? locked.value : false;
}

/**
 * Settles the one crash-stable manual launch record after a rehydrated Action
 * operation has delivered its created Session to the UI.
 */
export async function clearCreatedSpawnAttemptCustodyForSession(params: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
}>): Promise<boolean | null> {
    const sessionId = normalizeRequired(params.sessionId);
    if (!sessionId) return null;
    const state = readSpawnAttemptCustodyState(params.scope);
    if (state.status === 'missing') return null;
    if (state.status !== 'valid') return false;
    const matchingRecords = Object.values(state.attempts)
        .filter((record) => record.createdSessionId === sessionId);
    if (matchingRecords.length === 0) return null;
    if (matchingRecords.length !== 1) return false;
    const [record] = matchingRecords;
    return await clearSpawnAttemptCustody({
        scope: record.scope,
        machineId: record.machineId,
        targetFingerprint: record.targetFingerprint,
        userAttemptId: record.userAttemptId,
        nonce: record.nonce,
    });
}

/**
 * Completes custody after Action-operation rehydration. The operation request
 * ID is the persisted manual user-attempt ID, so this can settle a submitted
 * record even when the initiating process stopped before recording Session ID.
 */
export async function settleSpawnAttemptCustodyFromActionOperation(params: Readonly<{
    scope: ServerAccountScope;
    userAttemptId: string;
    createdSessionId: string;
}>): Promise<boolean | null> {
    const userAttemptId = normalizeRequired(params.userAttemptId);
    const createdSessionId = normalizeRequired(params.createdSessionId);
    if (!userAttemptId || !createdSessionId) return null;

    const locked = await withSpawnAttemptMutationLock(params.scope, () => {
        const state = readSpawnAttemptCustodyState(params.scope);
        if (state.status === 'missing') return null;
        if (state.status !== 'valid') return false;
        const matches = Object.entries(state.attempts).filter(([, record]) => (
            record.userAttemptId === userAttemptId
            && (record.createdSessionId === null || record.createdSessionId === createdSessionId)
        ));
        if (matches.length === 0) return null;
        if (matches.length !== 1) return false;
        const [id] = matches[0];
        const next = { ...state.attempts };
        delete next[id];
        writeAttempts(params.scope, next);
        return true;
    });
    return locked.status === 'completed' ? locked.value : false;
}

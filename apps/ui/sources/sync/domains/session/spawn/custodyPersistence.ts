import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { buildSpawnedFirstTurnLocalId } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';

import { normalizeSpawnSessionNonce } from './spawnSessionNonce';
import { SessionSpawnNewResultV1Schema, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

const STORAGE_KEY_PREFIX = 'session-spawn-attempts-v1';
const QUARANTINE_STORAGE_KEY_PREFIX = 'session-spawn-attempts-quarantine-v1';

export type PersistedSpawnAttempt = Readonly<{
    v: 3;
    scope: ServerAccountScope;
    machineId: string;
    targetFingerprint: string;
    userAttemptId: string;
    nonce: string;
    submissionState: 'prepared' | 'submitted';
    /** A later dispatch may have an effect even if the first dispatch proves none. */
    hasSubmittedRetry?: true;
    createdSessionId: string | null;
    /** The local Action can refuse during preparation, before a native operation exists. */
    terminalResult?: Extract<SessionSpawnNewResultV1, { type: 'error' }>;
    firstTurnLocalId: string;
    attachmentMessageLocalId: string;
    /** Per-creation writer choice, captured before dispatch and never reselected on recovery. */
    authoringOriginPersistence?: 'daemon-birth' | 'legacy-checkpoint';
}>;

export type PersistedSpawnAttempts = Readonly<Record<string, PersistedSpawnAttempt>>;

export type SpawnAttemptCustodyStoreState =
    | Readonly<{ status: 'missing' }>
    | Readonly<{
        status: 'valid';
        attempts: PersistedSpawnAttempts;
        quarantinedRecordIds?: readonly string[];
    }>
    | Readonly<{ status: 'corrupt' }>;

export type SpawnAttemptCustodyQuarantine =
    | Readonly<{ kind: 'rows'; rows: Readonly<Record<string, unknown>> }>
    | Readonly<{ kind: 'unreadable_blob'; raw: string }>;

export function normalizeRequired(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

export function recordId(machineId: string, targetFingerprint: string, userAttemptId: string): string {
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
            const terminalResult = record.terminalResult === undefined ? null : SessionSpawnNewResultV1Schema.safeParse(record.terminalResult);
            if (terminalResult && (!terminalResult.success || terminalResult.data.type !== 'error'
                || terminalResult.data.retryable || normalizeRequired(record.createdSessionId) || record.hasSubmittedRetry === true)) {
                quarantinedRows[id] = value;
                continue;
            }
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
                ...(record.hasSubmittedRetry === true ? { hasSubmittedRetry: true as const } : {}),
                createdSessionId: normalizeRequired(record.createdSessionId),
                ...(terminalResult?.success && terminalResult.data.type === 'error' ? { terminalResult: terminalResult.data } : {}),
                firstTurnLocalId,
                attachmentMessageLocalId,
                ...(record.authoringOriginPersistence === 'daemon-birth' || record.authoringOriginPersistence === 'legacy-checkpoint'
                    ? { authoringOriginPersistence: record.authoringOriginPersistence } : {}),
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

export function writeAttempts(scope: ServerAccountScope, attempts: PersistedSpawnAttempts): void {
    const storage = getPersistenceStorage();
    const key = storageKey(scope);
    if (Object.keys(attempts).length === 0) {
        storage.delete(key);
        return;
    }
    storage.set(key, JSON.stringify(attempts));
}

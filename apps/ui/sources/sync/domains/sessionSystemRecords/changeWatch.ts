import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { SessionSystemRecordRepository } from './repository';
import { isSessionSystemRecordUnchangedHintV1, readSessionSystemRecordChangeV1, type SessionSystemRecordInvalidationV1 } from '@happier-dev/protocol/sessions/board/changeHint';

/** Session and sharing publications can change the exact Session's records or access. */
export function isSessionSystemRecordChangeKind(kind: string): boolean {
    return kind === 'session' || kind === 'share';
}

/** Called by the incumbent AccountChange publisher, outside its cursor work. */
export function invalidateSessionSystemRecordsFromChanges(params: Readonly<{
    scope: ServerAccountScope;
    changes: readonly ApiChangeEntry[];
    repository: SessionSystemRecordRepository;
}>): void {
    if (!areServerAccountScopesEqual(params.scope, params.repository.scope)) return;
    const targets: SessionSystemRecordInvalidationV1[] = [];
    for (const change of params.changes) {
        const record = readSessionSystemRecordChangeV1(change);
        if (record) { targets.push(record); continue; }
        if (!isSessionSystemRecordChangeKind(change.kind)) continue;
        if (change.kind === 'session' && isSessionSystemRecordUnchangedHintV1(change.hint)) {
            params.repository.invalidateLegacyWorkflows({ serverId: params.scope.serverId, sessionId: change.entityId });
            continue;
        }
        const sessionId = typeof change.entityId === 'string' ? change.entityId.trim() : '';
        if (sessionId) targets.push({ sessionId });
    }
    invalidateSessionSystemRecordsFromTargets({ ...params, targets });
}

/** Both the durable feed and secondary-Home wake use the same query invalidation owner. */
export function invalidateSessionSystemRecordsFromTargets(params: Readonly<{
    scope: ServerAccountScope;
    targets: readonly SessionSystemRecordInvalidationV1[];
    repository: SessionSystemRecordRepository;
}>): void {
    if (!areServerAccountScopesEqual(params.scope, params.repository.scope)) return;
    const sessions = new Map<string, SessionSystemRecordInvalidationV1[]>();
    for (const target of params.targets) {
        const retained = sessions.get(target.sessionId) ?? [];
        retained.push(target);
        sessions.set(target.sessionId, retained);
    }
    for (const [sessionId, targets] of sessions) params.repository.invalidate({ serverId: params.scope.serverId, sessionId },
        targets.some(target => !target.address) ? undefined : targets.flatMap(target => target.address?.owner === 'host' ? [target.address] : []));
}

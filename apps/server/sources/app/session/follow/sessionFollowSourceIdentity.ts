import type { FollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { createHash } from 'node:crypto';

type SessionFollowSourceIdentityV1 = Exclude<FollowSourceRefV1, { kind: 'rule' }>;

/** Durable edge identity; equal raw ids from different source domains stay distinct. */
export function sourceKeyForSessionFollowSourceV1(source: SessionFollowSourceIdentityV1): string {
    switch (source.kind) {
        case 'session': return `session:${source.sessionId}`;
        case 'discussion': return `discussion:${source.discussionId}`;
        case 'execution_run': return `execution_run:${createHash('sha256').update(JSON.stringify('sessionId' in source
            ? [source.sessionId, source.runId] : ['machine', source.machineId, source.runId])).digest('hex')}`;
        case 'workflow_run': return `workflow_run:${createHash('sha256').update(JSON.stringify([source.runId])).digest('hex')}`;
    }
}

/** Exact durable source identity; malformed keys are unavailable, never Session aliases. */
export function sourceForSessionFollowSourceKeyV1(sourceKey: string): SessionFollowSourceIdentityV1 | null {
    const separator = sourceKey.indexOf(':');
    if (separator < 0) return null;
    const kind = sourceKey.slice(0, separator);
    const id = sourceKey.slice(separator + 1);
    if (!id) return null;
    if (kind === 'session') return { kind, sessionId: id };
    if (kind === 'discussion') return { kind, discussionId: id };
    return null;
}

/** Digest keys never stand in for a raw Run ref; collisions fail closed. */
export function sourceForSessionFollowEdgeV1(row: Readonly<{
    sourceKey: string;
    sourceSessionId?: string | null;
    sourceDiscussionId?: string | null;
    sourceExecutionRunSessionId: string | null;
    sourceExecutionRunMachineId?: string | null;
    sourceExecutionRunId: string | null;
    sourceWorkflowRunId: string | null;
}>): SessionFollowSourceIdentityV1 | null {
    const machineId = row.sourceExecutionRunMachineId ?? null;
    const raw = row.sourceExecutionRunId !== null
        && (row.sourceExecutionRunSessionId !== null) !== (machineId !== null)
        && row.sourceWorkflowRunId === null
        ? row.sourceExecutionRunSessionId !== null
            ? { kind: 'execution_run' as const, sessionId: row.sourceExecutionRunSessionId, runId: row.sourceExecutionRunId }
            : { kind: 'execution_run' as const, machineId: machineId!, runId: row.sourceExecutionRunId }
        : row.sourceWorkflowRunId !== null && row.sourceExecutionRunSessionId === null && machineId === null && row.sourceExecutionRunId === null
            ? { kind: 'workflow_run' as const, runId: row.sourceWorkflowRunId }
            : row.sourceExecutionRunSessionId === null && machineId === null && row.sourceExecutionRunId === null && row.sourceWorkflowRunId === null
                ? sourceForSessionFollowSourceKeyV1(row.sourceKey) : null;
    if (!raw || sourceKeyForSessionFollowSourceV1(raw) !== row.sourceKey) return null;
    if (row.sourceSessionId !== undefined && row.sourceSessionId !== (raw.kind === 'session' ? raw.sessionId : null)) return null;
    if (row.sourceDiscussionId !== undefined && row.sourceDiscussionId !== (raw.kind === 'discussion' ? raw.discussionId : null)) return null;
    return raw;
}

/** Narrow database projections before passing them to Session-only graph owners. */
export function hasSessionFollowSessionSource<T extends { sourceSessionId: string | null }>(row: T): row is T & { sourceSessionId: string } {
    return row.sourceSessionId !== null;
}

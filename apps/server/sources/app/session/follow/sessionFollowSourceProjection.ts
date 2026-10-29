import { isDeepStrictEqual } from 'node:util';
import { FollowPolicyV1Schema, type FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { deriveSessionFollowInputLocalIdV1, deriveSessionFollowOriginalOccurrenceKeyV1, resolveExecutionRunFollowOccurrenceV1, type RunFollowOriginalV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { FollowSourceRelationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import type { Fastify } from '@/app/api/types';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Tx } from '@/storage/inTx';
import { hasCanonicalFollowProviderInputAcceptanceInTx } from './providerInputAcceptance';
import { isExecutionRunFollowFrontierWitnessCurrentInTx, readCurrentExecutionRunFollowSource, type ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { sourceForSessionFollowEdgeV1, sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';

export interface SessionFollowProjectionEdge {
    readonly sourceKey: string;
    readonly destinationSessionId: string;
    readonly policyJson: string;
    readonly deliveredTranscriptSeq: number;
    readonly deliveredWorkflowRunRevision: number | null;
    readonly deliveredExecutionRunTerminalEventId: string | null;
    readonly sourceSessionId: string | null;
    readonly sourceDiscussionId: string | null;
    readonly sourceExecutionRunSessionId: string | null;
    readonly sourceExecutionRunMachineId?: string | null;
    readonly sourceExecutionRunId: string | null;
    readonly sourceWorkflowRunId: string | null;
}

export function readStoredPolicy(raw: string): FollowPolicyV1 | null {
    try {
        const parsed = FollowPolicyV1Schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

/** Same original/progress decision for route delivery and the public pending fact. */
export async function hasPendingRunFollowOccurrenceInTx(tx: Tx, edge: Pick<SessionFollowProjectionEdge,
    'destinationSessionId' | 'deliveredExecutionRunTerminalEventId' | 'deliveredWorkflowRunRevision'>,
    original: RunFollowOriginalV1): Promise<boolean> {
    if ('terminalEventId' in original) return edge.deliveredExecutionRunTerminalEventId !== original.terminalEventId;
    if ('revision' in original) return (edge.deliveredWorkflowRunRevision ?? 0) < original.revision;
    if ('permissionRequests' in original) {
        // Permission originals have no terminal cursor. The same retained mute
        // decision ends their demand without claiming provider acceptance.
        const pending = await tx.sessionPendingMessage.findUnique({ where: { sessionId_localId: {
            sessionId: edge.destinationSessionId,
            localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: edge.destinationSessionId, original }),
        } }, select: { status: true, discardedReason: true } });
        if (pending?.status === 'discarded' && pending.discardedReason === 'session_input_muted') return false;
        const acceptedFollowOriginalKey = deriveSessionFollowOriginalOccurrenceKeyV1(original);
        const accepted = await tx.sessionMessage.findFirst({ where: { sessionId: edge.destinationSessionId,
            acceptedFollowOriginalKey }, select: { localId: true, seq: true } });
        return !(accepted?.localId && await hasCanonicalFollowProviderInputAcceptanceInTx(tx, {
            destinationSessionId: edge.destinationSessionId, localInputId: accepted.localId,
            userMessageSeq: accepted.seq, requireProviderAccepted: true,
        }));
    }
    return false; // Ready outputs have personal one-shot custody, never a Session edge.
}

/** No network IO under a database snapshot. Probe only already-authorized, selected rows, once per exact Run. */
export async function readExecutionRunFollowProjectionFrontiers(input: Readonly<{
    app?: Pick<Fastify, 'forwardRpcForUser'>;
    accountId: string;
    authentication: SessionAccessAuthentication;
    sources: readonly FollowSourceRelationV1[];
}>): Promise<Map<string, ExecutionRunFollowFrontierWitness>> {
    const frontiers = new Map<string, ExecutionRunFollowFrontierWitness>();
    const app = input.app;
    if (!app) return frontiers;
    const sources = new Map(input.sources.flatMap(row => 'source' in row && row.source.kind === 'execution_run'
        && row.deliveryState !== 'paused_archived' ? [[sourceKeyForSessionFollowSourceV1(row.source), row.source] as const] : []));
    await Promise.all([...sources].map(async ([key, source]) => {
        const result = await readCurrentExecutionRunFollowSource({ app, accountId: input.accountId,
            authentication: input.authentication, ...source });
        if (result.ok) frontiers.set(key, result.value);
    }));
    return frontiers;
}

/** One content-free projection for public set/get/list and reverse inspection. */
export async function projectOtherFollowSourceInTx(tx: Tx, edge: SessionFollowProjectionEdge,
    destinationArchived: boolean, executionRunFrontier?: ExecutionRunFollowFrontierWitness): Promise<FollowSourceRelationV1 | null> {
    const source = sourceForSessionFollowEdgeV1(edge);
    if (!source || source.kind === 'session') return null;
    const policy = readStoredPolicy(edge.policyJson);
    if (!policy) return null;
    let available = false;
    let pending: boolean | null = null;
    let archived = false;
    if (source.kind === 'discussion') {
        const row = await tx.discussion.findUnique({ where: { id: source.discussionId },
            select: { archivedAt: true, messageSeq: true } });
        available = row !== null;
        archived = row?.archivedAt != null;
        pending = row ? row.messageSeq > edge.deliveredTranscriptSeq : null;
    } else if (source.kind === 'workflow_run') {
        const row = await tx.automationRun.findUnique({ where: { id: source.runId },
            select: { workflowCustodyState: true, revision: true } });
        available = row?.workflowCustodyState !== null && row !== null;
        pending = available && row && edge.deliveredWorkflowRunRevision !== null
            ? row.revision > edge.deliveredWorkflowRunRevision : null;
    } else if (executionRunFrontier && isDeepStrictEqual(executionRunFrontier.source, source)
        && await isExecutionRunFollowFrontierWitnessCurrentInTx(tx, executionRunFrontier)) {
        available = true;
        const occurrence = resolveExecutionRunFollowOccurrenceV1({ ...executionRunFrontier, ...source });
        pending = occurrence ? await hasPendingRunFollowOccurrenceInTx(tx, edge, occurrence.original)
            : executionRunFrontier.status === 'running' && executionRunFrontier.attention === undefined ? false : null;
    }
    return { source, destinationSessionId: edge.destinationSessionId, policy,
        relation: 'follower', deliveryState: destinationArchived || archived ? 'paused_archived' : 'eligible',
        sourceAvailability: available ? 'available' : 'unavailable', hasPendingUpdates: pending };
}

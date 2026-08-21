import {
    SessionAgentTransitionBriefPreviewRequestV1Schema,
    SessionAgentTransitionBriefPreviewV1Schema,
    type SessionAgentTransitionBriefPreviewV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

/**
 * `session.agentTransition.briefPreview` as the UI can honestly report it.
 *
 * Mirrors `sessionContinuationInspection` deliberately, because the transport
 * facts are the same ones: `METHOD_NOT_AVAILABLE` collapses "daemon predates the
 * operation" and "machine unreachable" into the daemon's own
 * `operation_unavailable`, while a timeout, an aborted call, a broken socket or
 * an unparseable response prove NOTHING and must not be dressed up as an answer.
 * A card that reported "nothing was carried over" because a socket dropped would
 * be the exact lie this surface exists to avoid.
 */
export type SessionAgentTransitionBriefPreviewQueryV1 =
    /** The machine answered — including its own typed `unavailable` reasons. */
    | Readonly<{ status: 'answered'; preview: SessionAgentTransitionBriefPreviewV1 }>
    /** The call failed for a reason that establishes nothing about the daemon. */
    | Readonly<{ status: 'indeterminate' }>;

const OPERATION_UNAVAILABLE: SessionAgentTransitionBriefPreviewQueryV1 = {
    status: 'answered',
    preview: { type: 'unavailable', reason: 'operation_unavailable' },
};

export type PreviewSessionAgentTransitionBriefOnMachineInput = Readonly<{
    /** The machine hosting the Session. Only it can rebuild the brief. */
    machineId: string;
    serverId: string | null;
    sessionId: string;
    /** The cutoff the divider recorded — the rebuild's UPPER bound, exactly as the transition set it. */
    sourceCutoffSeqInclusive: number;
    /**
     * The divider's native-return bound — the rebuild's exclusive LOWER bound —
     * or `null` for a fresh target, whose boundary had none. Without it the
     * machine reruns an unbounded-below pass and the card shows the whole
     * prefix for a boundary that only sent the away-delta.
     */
    returningAgentLastSeenSeqInclusive: number | null;
    /** The boundary's two Agents, exactly as the divider records them. */
    sourceAgentId: string;
    targetAgentId: string;
}>;

/**
 * Rebuilds what the target Agent was handed at one transition boundary.
 *
 * Read-only and effect-free. It carries no authorization envelope because it is
 * not a Session write — the same standing as `session.continuation.inspect`.
 */
export async function previewSessionAgentTransitionBriefOnMachine(
    input: PreviewSessionAgentTransitionBriefOnMachineInput,
): Promise<SessionAgentTransitionBriefPreviewQueryV1> {
    const payload = SessionAgentTransitionBriefPreviewRequestV1Schema.parse({
        v: 1,
        sessionId: input.sessionId,
        sourceCutoffSeqInclusive: input.sourceCutoffSeqInclusive,
        // Absent, not null: the wire shape spells "this boundary had no lower
        // bound" exactly one way, and the daemon reads absence as the full
        // replay a fresh target really got.
        ...(input.returningAgentLastSeenSeqInclusive === null
            ? {}
            : { returningAgentLastSeenSeqInclusive: input.returningAgentLastSeenSeqInclusive }),
        sourceAgentId: input.sourceAgentId,
        targetAgentId: input.targetAgentId,
    });
    let raw: unknown;
    try {
        raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW,
            payload,
        });
    } catch (error) {
        return readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
            ? OPERATION_UNAVAILABLE
            : { status: 'indeterminate' };
    }
    const parsed = SessionAgentTransitionBriefPreviewV1Schema.safeParse(raw);
    // A daemon that answered with a shape this client cannot read is not an old
    // daemon and is not offline. Say nothing rather than say the wrong thing.
    return parsed.success ? { status: 'answered', preview: parsed.data } : { status: 'indeterminate' };
}

import { resolveExecutionRunInteractionAffordances } from '@happier-dev/protocol/execution/runs/interactionAffordances';
import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import type { ScmDiffSummaryResult } from '@happier-dev/protocol/scm/diffSummaryResult';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';

export type ScmDiffSummaryDiscussionTarget =
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{
        kind: 'continue';
        recipient: Extract<ParticipantRecipientV1, { kind: 'execution_run' }>;
        href: string;
        needsResume: boolean;
    }>;

export type ScmDiffSummaryStopDiscussionContext = Readonly<{
    resultId: string;
    revision: number;
    stopIds: readonly string[];
}>;

/** Capture selected stops from this displayed revision, not a later regenerated result. */
export function selectScmDiffSummaryStopDiscussionContext(
    result: ScmDiffSummaryResult,
    stopIds: readonly string[],
): ScmDiffSummaryStopDiscussionContext | null {
    if (!result.output.success || stopIds.length === 0 || new Set(stopIds).size !== stopIds.length) return null;
    const stops = result.output.outputs?.walkthrough?.value?.stops;
    if (!stops || stopIds.some((id) => !stops.some((stop) => stop.id === id))) return null;
    return { resultId: result.resultId, revision: result.revision, stopIds: [...stopIds] };
}

/** Open the generating Run itself; transcript reconstructions never grant interaction. */
export function resolveScmDiffSummaryDiscussionTarget(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    runId: string;
    run: ExecutionRunPublicState | null | undefined;
    source: 'session_rpc' | 'transcript_fallback' | 'daemon_fallback';
    canControlExecutionRuns: boolean;
}>): ScmDiffSummaryDiscussionTarget {
    if (!params.canControlExecutionRuns || params.source !== 'session_rpc' || params.run?.runId !== params.runId) {
        return { kind: 'unavailable' };
    }
    const affordances = resolveExecutionRunInteractionAffordances(params.run);
    if (!affordances.canSend && !affordances.canResume) return { kind: 'unavailable' };
    const href = buildSessionExecutionRunRouteHref(params);
    if (!href) return { kind: 'unavailable' };
    return {
        kind: 'continue', recipient: { kind: 'execution_run', runId: params.runId },
        href, needsResume: !affordances.canSend && affordances.canResume,
    };
}

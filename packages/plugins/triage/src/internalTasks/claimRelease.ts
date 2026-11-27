import { deriveTodoClaimReleaseV1 } from '@happier-dev/plugin-sdk/protocol';
import type { SessionStateV1 } from '@happier-dev/plugin-sdk/ui';

export type TriageTaskClaimReleaseReasonV1 = NonNullable<
  ReturnType<typeof deriveTodoClaimReleaseV1>
>;

/**
 * A still-claimed Happier Task's positive release fact, read from its claiming Session's own task-claim facts: the
 * claimed Run ended, or the claim's host went away after the claim. A pending question holds the claim. The list's
 * Ready lens and the Task's detail both read release through this one reader.
 */
export function readTriageTaskClaimReleaseV1(
  claim: Parameters<typeof deriveTodoClaimReleaseV1>[0],
  facts: SessionStateV1['taskClaimFacts'] | undefined,
): TriageTaskClaimReleaseReasonV1 | null {
  const binding = claim.attemptBinding;
  if (binding === undefined || facts === undefined || facts.questionPending)
    return null;
  const { sessionId, runId } = binding;
  const terminal =
    runId !== undefined && facts.terminalRunIds?.includes(runId)
      ? deriveTodoClaimReleaseV1(claim, {
          kind: 'run_terminal',
          sessionId,
          runId,
        })
      : null;
  return (
    terminal ??
    (facts.hostLostAt === undefined
      ? null
      : deriveTodoClaimReleaseV1(claim, {
          kind: 'host_lost',
          sessionId,
          observedAt: facts.hostLostAt,
        }))
  );
}

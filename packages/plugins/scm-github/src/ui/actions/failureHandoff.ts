import type { ForgeCiFailureSummaryV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSessionHandoffInputV1 } from '@happier-dev/triage-protocol/v1';
import { requestTriageSessionHandoffV1, type TriageSessionHandoffHostV1 } from '@happier-dev/triage-sources/runtime';

/** Explicit mounted Fix only: no acquisition or Session effects on mount.
 * The configured runner alone renders the external evidence and chooses delivery. */
export async function handoffGithubCiFailureV1(host: TriageSessionHandoffHostV1, input: Readonly<{
  summary: ForgeCiFailureSummaryV1;
  configuredActionId: TriageSessionHandoffInputV1['configuredActionId'];
  workspace?: Extract<TriageSessionHandoffInputV1['context'], { kind: 'repository' }>['workspace'];
  sessionChoice: TriageSessionHandoffInputV1['sessionChoice'];
  agentChoice: TriageSessionHandoffInputV1['agentChoice'];
  delivery: TriageSessionHandoffInputV1['delivery'];
}>, options: Readonly<{ signal?: AbortSignal }> = {}) {
  const run = input.summary.selection.kind === 'run' ? input.summary.selection.run : input.summary.selection.attempt.run;
  return requestTriageSessionHandoffV1(host, {
    task: 'fix', configuredActionId: input.configuredActionId,
    context: { kind: 'repository', repository: run.repository, ...(input.workspace === undefined ? {} : { workspace: input.workspace }) },
    evidence: [{ kind: 'hostedCi', summary: input.summary }],
    sessionChoice: input.sessionChoice, agentChoice: input.agentChoice, delivery: input.delivery,
  }, options);
}

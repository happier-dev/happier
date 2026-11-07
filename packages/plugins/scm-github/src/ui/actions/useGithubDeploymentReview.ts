import type { ForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import { useForgeCiQueryV1, useForgeCiQueryStatusV1, useForgeCiQueryValueV1 } from '@happier-dev/forge-ci/ui';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import { ForgeCiActionInputSchemasV1, type ForgeCiActionInputByOperationV1 } from '../../actions/contracts.js';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../actions/actionIds.js';
import type { GithubDeploymentReviewLocationV1 } from '../../actions/deploymentReviewProtocol.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';

export type GithubDeploymentReviewActionV1 = Readonly<{
  action: PluginContributionRef;
  input: ForgeCiActionInputByOperationV1['approveDeployment'];
}>;

/** One data binding for Actions, the Inbox app page and phone; the UI lane composes the form. */
export function useGithubDeploymentReviewV1(input: Readonly<{
  reads: ForgeCiReadsV1 | null;
  repository: ScmHostingRepositoryIdentityV1;
  /** The run, attempt and environment under review; the page locator's repository id has already admitted `repository`. */
  location: Pick<GithubDeploymentReviewLocationV1, 'runId' | 'attempt' | 'environmentId'>;
  historyExpanded?: boolean;
}>) {
  const run = useForgeCiQueryV1(input.reads, 'readRun', { repository: input.repository, runId: input.location.runId });
  const deployments = useForgeCiQueryV1(input.reads, 'listDeployments', { repository: input.repository, runId: input.location.runId });
  const history = useForgeCiQueryV1(input.reads, 'readDeploymentHistory', { repository: input.repository, runId: input.location.runId }, input.historyExpanded === true);
  const runValue = useForgeCiQueryValueV1(run);
  const pendingValue = useForgeCiQueryValueV1(deployments);
  const historyValue = useForgeCiQueryValueV1(history);
  const runStatus = useForgeCiQueryStatusV1(run);
  const pendingStatus = useForgeCiQueryStatusV1(deployments);
  const historyStatus = useForgeCiQueryStatusV1(history);
  // The encoded attempt is a selection, not currentness proof. A superseded
  // attempt remains visible but cannot enable this form's submit.
  const currentAttempt = runValue?.currentAttempt?.attemptId;
  const stale = currentAttempt !== undefined && currentAttempt !== input.location.attempt;
  const selected = pendingValue?.rows.find(value => value.id === input.location.environmentId) ?? null;
  const canReview = currentAttempt === input.location.attempt && runValue?.ref.runId === input.location.runId && selected?.eligible === true
      && runStatus.snapshot?.pending === false && pendingStatus.snapshot?.pending === false
      && runStatus.snapshot.retired === false && pendingStatus.snapshot.retired === false
      && !runStatus.snapshot.failure && !pendingStatus.snapshot.failure;
  return { run: runValue, pending: pendingValue, history: historyValue, selected, stale,
    runStatus, pendingStatus, historyStatus, canReview,
    /** Bind to the shared declarative Action control; preparing a decision performs no IO. */
    reviewAction(decision: 'approve' | 'reject', environmentIds: readonly string[], comment: string): GithubDeploymentReviewActionV1 | null {
      if (!canReview) return null;
      const operation = decision === 'approve' ? 'approveDeployment' : 'rejectDeployment';
      const parsed = ForgeCiActionInputSchemasV1[operation].safeParse({ repository: input.repository,
        runId: input.location.runId, attempt: input.location.attempt, environmentIds: [...environmentIds], comment });
      if (!parsed.success) return null;
      const eligible = new Set(pendingValue?.rows.filter(value => value.eligible).map(value => value.id));
      if (parsed.data.environmentIds.some(id => !eligible.has(id))) return null;
      return { action: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_CI_ACTION_IDS_V1[operation] }, input: parsed.data };
    },
  };
}

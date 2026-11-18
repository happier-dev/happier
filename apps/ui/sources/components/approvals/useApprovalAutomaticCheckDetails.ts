import * as React from 'react';

import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { useWorkflowReferenceDefinition } from '@/components/workflows/presentation/useWorkflowReferenceDefinition';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useWorkflowRun } from '@/sync/domains/state/storage';
import { refreshWorkflowRunsByIds } from '@/sync/engine/workflows/refreshWorkflowRun';

/** The check card's exact Run and opened Review steps share the approval's Home binding.
 * Pass a reviewWorkflowId only while its content is demanded; the Run's recorded timestamps
 * let the elapsed-time leaf use the existing clock without another Run read.
 */
export function useApprovalAutomaticCheckDetails(input: Readonly<{
  runId: string | null;
  reviewWorkflowId?: string | null;
  serverId: string | null;
}>) {
  const { runId, serverId, reviewWorkflowId = null } = input;
  const { binding } = useServerCredentialAccountScopeBinding(runId || reviewWorkflowId ? serverId : '');
  const scope = binding?.scope ?? null;
  const run = useWorkflowRun(runId, { enabled: scope !== null, scope });
  const loaded = run !== null;
  React.useEffect(() => {
    if (!runId || !binding || loaded) return;
    const controller = new AbortController();
    void refreshWorkflowRunsByIds([runId], { accountLifetime: binding, fence: binding, signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [runId, binding, loaded]);
  const review = useWorkflowReferenceDefinition(reviewWorkflowId, true, binding);
  return {
    progress: run?.summary?.state === 'running' ? describeWorkflowRunProgress(run.summary.stepProgress) : null,
    runSummary: run?.summary ?? null,
    review,
  };
}

import * as React from 'react';

import { describeWorkflowRunProgress } from '@/components/workflows/presentation/workflowRunProgress';
import { useWorkflowReferenceDefinition } from '@/components/workflows/presentation/useWorkflowReferenceDefinition';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getStorage, useWorkflowRunRows } from '@/sync/domains/state/storage';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { refreshWorkflowRunsByIds } from '@/sync/engine/workflows/refreshWorkflowRun';

const NO_RUN_IDS: readonly string[] = Object.freeze([]);

/** The check card's exact Runs and opened Review steps share the approval's Home binding.
 * Pass a reviewWorkflowId only while its content is demanded; the Run's recorded timestamps
 * let the elapsed-time leaf use the existing clock without another Run read.
 */
export function useApprovalAutomaticCheckDetails(input: Readonly<{
  runIds: readonly string[];
  reviewWorkflowId?: string | null;
  serverId: string | null;
}>) {
  const { runIds, serverId, reviewWorkflowId = null } = input;
  const { binding } = useServerCredentialAccountScopeBinding(runIds.length || reviewWorkflowId ? serverId : '');
  const scope = binding?.scope ?? null;
  const rows = useWorkflowRunRows(scope ? runIds : NO_RUN_IDS, scope);
  const summaries = React.useMemo(() => new Map(rows.map(row => [row.id, row.summary])), [rows]);
  React.useEffect(() => {
    if (!binding || runIds.length === 0) return;
    const current = getStorage().getState();
    const missing = runIds.filter(runId => !current.workflowRunsById[workflowRunStoreKey(runId, binding.scope)]?.summary);
    if (missing.length === 0) return;
    const controller = new AbortController();
    void refreshWorkflowRunsByIds(missing, { accountLifetime: binding, fence: binding, signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, [runIds, binding]);
  const review = useWorkflowReferenceDefinition(reviewWorkflowId, true, binding);
  const active = summaries.get(runIds[0] ?? '');
  return {
    progress: active?.state === 'running' ? describeWorkflowRunProgress(active.stepProgress) : null,
    summaries,
    review,
  };
}

import * as React from 'react';
import { useRouter, type Href } from 'expo-router';
import type { WorkflowInvocationDetailV1, WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWorkflowInlineInvocationRetry } from '@/components/workflows/run/useWorkflowInlineRunControls';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

import { WorkflowAgentDetail } from '@/components/workflows/presentation/WorkflowAgentDetail';

/**
 * What a Workflow published here, under its summary: the typed result when it says more than the summary
 * (the shared clamped result preview). Open run stays on the Run's own header under the asking message.
 */
export function DiscussionWorkflowResult(
  props: Readonly<{ messageId: string; detail: string | null }>,
) {
  return props.detail ? (
    <WorkflowAgentDetail
      text={props.detail}
      detailTestID={`session-discussion-workflow-result-${props.messageId}`}
    />
  ) : null;
}


/** One failed published reply; uncertainty acknowledgement stays on the exact Run page. */
export function DiscussionWorkflowInvocationRetry(props: Readonly<{
  messageId: string;
  run: WorkflowRunSummaryV1;
  invocation: WorkflowInvocationDetailV1;
  canEdit: boolean;
  accountLifetime: ServerAccountScopeLifetime;
}>) {
  const router = useRouter();
  const control = useWorkflowInlineInvocationRetry(props);
  const openRun = () => router.push(createWorkflowRunRoute(props.run.id, props.accountLifetime.scope.serverId) as Href);
  return <SurfaceStateCard size="line" kind={control.accepted ? 'success' : 'error'}
    testID={`discussion-workflow-recovery:${props.messageId}`} accessibilitySemantics="status"
    title={t(control.accepted ? 'session.collaboration.discussion.workflowRound.retryReceipt'
      : 'session.collaboration.discussion.workflowRound.failedReply')}
    reason={control.error?.message}
    action={control.accepted ? undefined : control.canRetry ? {
      testID: `discussion-workflow-retry:${props.messageId}`, label: t('common.retry'),
      onPress: () => void control.retry(), busy: control.pending, disabled: control.pending,
    } : { testID: `discussion-workflow-open-run:${props.messageId}`, label: t('workflows.run.open'), onPress: openRun }} />;
}

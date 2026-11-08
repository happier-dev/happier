import * as React from 'react';
import type { ApprovalRequest} from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { describeApprovalRequestFields } from '@happier-dev/protocol/actions';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { presentApprovalFailure, useApprovalDecisionHandler } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { ActionApprovalFieldsCard } from './ActionApprovalFieldsCard';
import { useActionApprovalReview } from './actionApprovalReview';
import { ApprovalDecisionBar } from './ApprovalDecisionBar';

function isTargetActionRequest(request: ApprovalRequest | TargetActionApprovalRequestV1): request is TargetActionApprovalRequestV1 {
  return 'kind' in request && request.kind === 'plugin_target_action';
}

/**
 * Deciding a request in place, outside a Session transcript (a Discussion thread): the same decision
 * owner, the same shared review (admission, declared verb, irreversibility) and the same fields card
 * the Session prompt card draws. Only a request the shared review shows whole is decided here; anything
 * that needs its own page keeps `onOpenPage`.
 */
export function useInlineApprovalDecision(
  artifact: Pick<DecryptedArtifact, 'id' | 'header'>,
  request: ApprovalRequest | TargetActionApprovalRequestV1,
  sessionId: string,
  serverId: string,
  onDecided?: (decision: 'approve' | 'reject') => void,
) {
  const decide = useApprovalDecisionHandler(artifact, request, sessionId, serverId);
  const [deciding, setDeciding] = React.useState<'approve' | 'reject' | null>(null);
  const [failure, setFailure] = React.useState<Readonly<{ decision: 'approve' | 'reject'; cause: unknown }> | null>(null);
  // A plugin target-action request has no shared built-in review; it keeps its page.
  const builtIn = isTargetActionRequest(request) ? null : request;
  const review = useActionApprovalReview(builtIn);
  const answer = React.useCallback(async (decision: 'approve' | 'reject') => {
    if (deciding !== null) return;
    setDeciding(decision);
    setFailure(null);
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      onDecided?.(decision);
    };
    try {
      if (await decide(decision, { onExecution: record })) record();
      else setFailure({ decision, cause: null });
    } catch (error) {
      setFailure({ decision, cause: error });
    } finally {
      setDeciding(null);
    }
  }, [decide, deciding, onDecided]);
  const fields = React.useMemo(
    () => (builtIn && review?.simple ? review.admission?.presentation ?? describeApprovalRequestFields(builtIn) : null),
    [builtIn, review],
  );
  return { request: builtIn, review, fields, deciding, failure, answer, decidesHere: review?.simple === true };
}

export type InlineApprovalDecision = ReturnType<typeof useInlineApprovalDecision>;

export function ApprovalInlineFields(props: Readonly<{ decision: InlineApprovalDecision; serverId: string; collapsed: boolean }>) {
  const { fields } = props.decision;
  return fields && fields.rows.length > 0
    ? <ActionApprovalFieldsCard presentation={fields} request={props.decision.request ?? undefined} serverId={props.serverId} collapsed={props.collapsed} />
    : null;
}

export function ApprovalInlineDecisionBar(props: Readonly<{
  decision: InlineApprovalDecision;
  testIDPrefix: string;
  layout: 'inline' | 'stacked';
  /** Where a request that needs its own page is decided; also the wording-free fallback for the primary action. */
  onOpenPage: () => void;
  openPageLabel: string;
  /** A request kind's own word for declining (a private draft); otherwise the bar's "Deny". */
  declineLabel?: string;
  /** A request kind's own word for approving ("Post"); otherwise the Action's declared verb. */
  approveLabel?: string;
}>) {
  const { decision } = props;
  const failure = decision.failure ? presentApprovalFailure(decision.failure.cause) : null;
  return (
    <>
    <ApprovalDecisionBar
      size="small"
      layout={props.layout}
      disabled={decision.deciding !== null}
      irreversible={decision.decidesHere && decision.review?.irreversible === true}
      approve={decision.decidesHere ? {
        label: props.approveLabel ?? decision.review?.approveVerb ?? undefined,
        testID: `${props.testIDPrefix}-approve`,
        busy: decision.deciding === 'approve',
        onPress: () => { void decision.answer('approve'); },
      } : {
        label: props.openPageLabel,
        testID: `${props.testIDPrefix}-review`,
        onPress: props.onOpenPage,
      }}
      reject={{
        label: props.declineLabel,
        testID: `${props.testIDPrefix}-decline`,
        busy: decision.deciding === 'reject',
        onPress: () => { void decision.answer('reject'); },
      }}
    />
    {failure && decision.failure ? <SurfaceStateCard
      testID={`${props.testIDPrefix}-failure`}
      size="line"
      kind="error"
      title={failure.reason}
      diagnosticCode={failure.code}
      action={{ label: t('common.retry'), onPress: () => { if (decision.failure) void decision.answer(decision.failure.decision); } }}
    /> : null}
    </>
  );
}

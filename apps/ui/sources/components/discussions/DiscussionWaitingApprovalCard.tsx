import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useRouter, type Href } from 'expo-router';
import { approvalArtifactBodyMatchesHeaderV1, type ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { DiscussionDraftAnswer, readDiscussionDraftApproval } from '@/components/approvals/discussionDraftApproval';

import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { ApprovalInlineDecisionBar, ApprovalInlineFields, useInlineApprovalDecision } from '@/components/approvals/ApprovalInlineDecision';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { readApprovalArtifactTitleInput, useApprovalRequestTitle } from '@/components/approvals/approvalRequestTitle';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifact, useSessionDisplayNameProjections } from '@/sync/store/hooks';
import { useDiscussionSessionLabelProjection } from './discussionSessionLabel';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';

/**
 * A private draft or request waiting on this viewer, decided in the Discussion thread the way a Session
 * decides its own: the shared inline decision core, with the request page one tap away. Specialized
 * or unavailable requests keep the caller's recovery surface, or open the shared review in place.
 */
export const DiscussionWaitingApprovalCard = React.memo(function DiscussionWaitingApprovalCard(props: Readonly<{
  approvalId: string;
  serverId: string;
  returnHref?: string;
  /** Rendered when the request cannot be decided here. */
  fallback?: React.ReactElement;
}>) {
  const artifact = useArtifact(props.approvalId);
  const parsed = React.useMemo(
    () => (artifact && typeof artifact.body === 'string'
      ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null),
    [artifact],
  );
  const request = parsed?.family === 'built_in' && parsed.request.v === 2 && parsed.request.status === 'open' ? parsed.request : null;
  const fallback = props.fallback ?? <WaitingApprovalReview approvalId={props.approvalId} serverId={props.serverId} />;
  if (!artifact || !parsed || !request) return fallback;
  return <Card {...props} fallback={fallback} artifact={artifact} parsed={parsed as BuiltInApproval} request={request} />;
});

/** Specialized requests retain the same full review in place as requester-bound thread cards. */
function WaitingApprovalReview(props: Readonly<{ approvalId: string; serverId: string }>) {
  const [reviewRequested, setReviewRequested] = React.useState(false);
  const review = useInPlaceApprovalReview({ approvalId: props.approvalId, serverId: props.serverId, approvalPending: reviewRequested });
  const openReview = React.useCallback(() => {
    setReviewRequested(true);
    review.reopen();
  }, [review.reopen]);
  return <SurfaceStateCard
    testID="session-discussion-waiting-approval"
    size="line"
    kind="warning"
    accessibilitySemantics="status"
    title={t('session.collaboration.discussion.home.approvalPending')}
    action={{ testID: 'session-discussion-waiting-approval-review', label: t('approvals.review'), onPress: openReview }}
  />;
}

type BuiltInApproval = Extract<ParsedApprovalArtifactBodyV1, { family: 'built_in' }>;

function Card(props: Readonly<{
  artifact: DecryptedArtifact;
  approvalId: string;
  parsed: BuiltInApproval;
  request: BuiltInApproval['request'];
  serverId: string;
  returnHref?: string;
  fallback: React.ReactElement;
}>) {
  const router = useRouter();
  const phone = useDeviceType() === 'phone';
  const { artifact, request } = props;
  const sessionId = request.v === 2 ? request.executionOriginV1.sessionId ?? request.createdBy.sessionId ?? '' : '';
  const decision = useInlineApprovalDecision({ id: artifact.id, header: artifact.header ?? null }, request, sessionId, props.serverId);
  const titleInput = readApprovalArtifactTitleInput(artifact, props.parsed, [sessionId]);
  const requestTitle = useApprovalRequestTitle(titleInput, props.serverId).title;
  const draftApproval = readDiscussionDraftApproval(request);
  const draft = draftApproval !== null;
  // Who is waiting leads the card (lab T2-A), as the list line names them; a request that names no one keeps the
  // Action's own title with the generic line.
  const waitingName = useSessionDisplayNameProjections(
    sessionId ? [{ serverId: props.serverId, sessionId }] : [], useDiscussionSessionLabelProjection(true))[0]?.trim() || null;
  const title = waitingName
    ? t(draft ? 'session.collaboration.discussion.home.draftWaitingNamed' : 'session.collaboration.discussion.home.approvalPendingNamed', { name: waitingName })
    : requestTitle;
  // A draft is read as the answer it would post; the Action's operands wait behind Details.
  const draftAnswer = draftApproval?.answer ?? null;
  const openPage = React.useCallback(() => {
    router.push(buildApprovalHref(artifact.id, props.serverId, props.returnHref) as Href);
  }, [artifact.id, props.returnHref, props.serverId, router]);
  if (!decision.decidesHere) return props.fallback;
  return (
    <ApprovalPromptChrome
      testID="session-discussion-waiting-approval"
      title={title}
      subtitle={waitingName
        ? draft ? undefined : requestTitle
        : draft ? t('session.collaboration.discussion.home.draftWaiting') : t('session.collaboration.discussion.home.approvalPending')}
      subtitleNumberOfLines={2}
      tone="attention"
      footer={
        <View style={phone ? styles.stacked : undefined}>
          <ApprovalInlineDecisionBar
            decision={decision}
            testIDPrefix="session-discussion-waiting-approval"
            layout={phone ? 'stacked' : 'inline'}
            onOpenPage={openPage}
            openPageLabel={t('approvals.review')}
            approveLabel={draftApproval?.postLabel}
            declineLabel={draftApproval?.declineLabel}
          />
        </View>
      }
    >
      {draftAnswer !== null ? <DiscussionDraftAnswer testID="session-discussion-waiting-approval-draft" answer={draftAnswer} /> : null}
      <ApprovalInlineFields decision={decision} serverId={props.serverId} collapsed={phone || draftAnswer !== null} />
    </ApprovalPromptChrome>
  );
}

const styles = StyleSheet.create(() => ({
  stacked: { width: '100%' },
}));

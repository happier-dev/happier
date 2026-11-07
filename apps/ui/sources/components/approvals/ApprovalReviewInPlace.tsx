import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';

import { useApprovalReview, type ApprovalReviewInput } from './useApprovalReview';

type ApprovalReviewModalProps = CustomModalInjectedProps &
  Readonly<{
    artifactId: string;
    serverId: string;
    /** The host owns withdrawal or reopening when the person closes the review. */
    onDismissed: () => void;
    onDecisionRecorded?: ApprovalReviewInput['onDecisionRecorded'];
  }>;

/**
 * An approval reviewed where it was asked for: the same review and decision controller as the Inbox page
 * (`useApprovalReview`), in a dialog (a bottom sheet on a phone). What is decided fills the body and the
 * decision stays in the card's footer. The requester facts identify who asked and which Account runs it.
 */
function ApprovalReviewModal(props: ApprovalReviewModalProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const { onClose, onDismissed, setChrome } = props;
  const close = React.useCallback(() => {
    onDismissed();
    onClose();
  }, [onClose, onDismissed]);
  const review = useApprovalReview({
    artifactId: props.artifactId,
    serverId: props.serverId,
    onBack: close,
    onDecisionRecorded: props.onDecisionRecorded,
  });
  const ready = review.kind === 'ready' ? review : null;
  const decision = ready ? (ready.decisionBar ?? ready.capabilityDecisions ?? null) : null;
  // Chrome follows the review on every render; the modal skips republishing equal chrome.
  React.useEffect(() => {
    setChrome?.({
      kind: 'card',
      ...(ready
        ? { title: ready.title, subtitle: ready.description ?? null }
        : {}),
      footer: decision,
    });
  });

  if (review.kind === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivitySpinner size="large" color={theme.colors.text.secondary} />
      </View>
    );
  }
  if (review.kind !== 'ready') {
    return (
      <View style={styles.body}>
        <SurfaceStateCard
          testID="approvals.in-place.unavailable"
          size="line"
          kind="error"
          title={review.message}
          action={
            review.kind === 'error' && review.retry
              ? { label: t('common.retry'), onPress: review.retry }
              : undefined
          }
        />
      </View>
    );
  }
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <View testID="approvals.in-place" style={styles.body}>
        {/* While it waits, the facts are the whole story; once answered, its status and outcome lead. */}
        {review.open && !review.requestNotice ? null : review.requestGroup}
        {review.sections}
        {review.confidential}
        {review.requesterConfirmationSection}
        {review.requesterContext}
        {review.requesterConfirmationSection ? (
          <View style={styles.recordFooter}>
            <Text variant="meta" style={styles.recordText}>
              {t('approvals.requesterRecord')}
            </Text>
            <TextLinkButton
              testID="approvals.in-place.actions-settings"
              label={t('approvals.requesterActionsSettings')}
              size="meta"
              onPress={() => {
                close();
                router.push('/settings/actions');
              }}
            />
          </View>
        ) : null}
        {/* Without card chrome (an embedding host), the decision ends the body. */}
        {setChrome ? null : decision}
      </View>
    </ListPresentationProvider>
  );
}

/** Presents one approval in place; returns the modal id so its host can withdraw it. */
export function showApprovalReview(
  input: Readonly<{
    artifactId: string;
    serverId: string;
    onDismissed: () => void;
    onDecisionRecorded?: ApprovalReviewInput['onDecisionRecorded'];
  }>,
): string {
  return Modal.show({
    component: ApprovalReviewModal,
    props: input,
    onRequestClose: input.onDismissed,
    // A stray click outside never closes a consent; Close, Escape and the decisions do.
    closeOnBackdrop: false,
    chrome: {
      kind: 'card',
      title: t('approvals.review'),
      testID: 'approvals.in-place.modal',
      phonePresentation: 'sheet',
      scrollHost: 'bounded',
      bodyScroll: 'auto',
      dimensions: {
        width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
        maxHeightRatio: 0.9,
        size: 'md',
      },
    },
  });
}

/**
 * Presents a mounted Action's pending approval where the person pressed the control
 * (`useMountedActionExecution().approval`): it opens once per approval, closes when the approval
 * settles, and a review closed without an answer can be reopened from the surface's waiting line.
 */
export function useInPlaceApprovalReview(
  approval: Readonly<{
    approvalId: string | null;
    approvalPending: boolean;
    serverId: string | null;
    onDecisionRecorded?: ApprovalReviewInput['onDecisionRecorded'];
  }>,
) {
  const { approvalId, approvalPending, serverId } = approval;
  const [closedId, setClosedId] = React.useState<string | null>(null);
  const shown = React.useRef<Readonly<{
    artifactId: string;
    modalId: string;
  }> | null>(null);
  const presentId =
    approvalPending && approvalId && serverId && closedId !== approvalId
      ? approvalId
      : null;
  React.useEffect(() => {
    const current = shown.current;
    if (current && current.artifactId !== presentId) {
      shown.current = null;
      Modal.hide(current.modalId);
    }
    if (!presentId || !serverId || shown.current) return;
    const modalId = showApprovalReview({
      artifactId: presentId,
      serverId,
      onDecisionRecorded: approval.onDecisionRecorded,
      onDismissed: () => {
        if (shown.current?.modalId === modalId) shown.current = null;
        setClosedId(presentId);
      },
    });
    shown.current = { artifactId: presentId, modalId };
  }, [presentId, serverId, approval.onDecisionRecorded]);
  // The surface that asked owns the review: leaving it withdraws the dialog, never the request.
  React.useEffect(
    () => () => {
      if (shown.current) Modal.hide(shown.current.modalId);
      shown.current = null;
    },
    [],
  );
  const reopen = React.useCallback(() => setClosedId(null), []);
  return {
    waiting: Boolean(approvalPending && approvalId && closedId === approvalId),
    reopen,
  };
}

export type InPlaceApprovalReview = ReturnType<typeof useInPlaceApprovalReview>;

const styles = StyleSheet.create((theme) => ({
  // Card chrome pads only its header and footer; the body aligns with the title's edge.
  body: {
    gap: theme.space.s16,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
  loading: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordFooter: {
    gap: theme.space.s4,
    alignItems: 'flex-start',
  },
  recordText: {
    color: theme.colors.text.secondary,
  },
}));

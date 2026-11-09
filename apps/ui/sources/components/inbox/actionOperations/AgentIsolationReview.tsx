import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  AttentionBanner,
  type AttentionBannerAction,
} from '@/components/ui/lists/AttentionBanner';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  createFrontDoorActionExecute,
  type FrontDoorActionExecute,
} from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

import {
  projectAgentIsolationRecovery,
  type AgentIsolationReviewDetail,
} from './actionOperationDetailPresentation';
import type { AgentIsolationRecoveryCheck } from './useAgentIsolationRecovery';
import { AgentIsolationEffectsGroup } from './agentIsolationEffects';
import {
  refreshAgentIsolationReview,
  submitAgentIsolationReview,
  type AgentIsolationReviewSubmission,
} from './submitAgentIsolationReview';

type Decision =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'refreshing' }>
  | Readonly<{ kind: 'settled'; outcome: AgentIsolationReviewSubmission }>;

let frontDoor: FrontDoorActionExecute | undefined;
function resolveFrontDoor(): FrontDoorActionExecute {
  return (frontDoor ??= createFrontDoorActionExecute());
}

/**
 * The person's decision on one held isolation review. Approving submits the reviewed set on the held
 * operation's original request identity; the operation owner decides what happens next and its push
 * clears the review. A changed review, or an outcome the owner could not confirm, is never retried here.
 */
function useAgentIsolationReviewDecision(
  operation: QualifiedActionOperation | null,
  detail: AgentIsolationReviewDetail | null,
  execute: () => FrontDoorActionExecute = resolveFrontDoor,
  /** Recovery from an unknown outcome applies as a new request; a held review resumes its own. */
  recheck?: AgentIsolationRecoveryCheck['recheck'],
) {
  const [decision, setDecision] = React.useState<Decision>({ kind: 'idle' });
  const controllerRef = React.useRef<AbortController | null>(null);
  const operationId = operation?.snapshot.operationId;
  const planDigest = detail?.review.current.plan.planDigest;

  // A fresh review (or another operation) is a new decision.
  React.useEffect(() => {
    setDecision({ kind: 'idle' });
    return () => controllerRef.current?.abort();
  }, [operationId, planDigest]);

  // Only an untouched review, or a refusal that left it open, may be approved; a changed review or
  // an unconfirmed outcome never replays.
  const canApprove =
    (Boolean(detail?.requestId) || Boolean(recheck)) &&
    (decision.kind === 'idle' ||
      decision.kind === 'pending' ||
      (decision.kind === 'settled' &&
        (decision.outcome.kind === 'refused' ||
          decision.outcome.kind === 'failed')));
  const approve = React.useCallback(() => {
    if (!operation || !detail || !canApprove || decision.kind === 'pending')
      return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setDecision({ kind: 'pending' });
    void submitAgentIsolationReview({
      operation,
      detail: recheck ? { ...detail, requestId: randomUUID() } : detail,
      execute: execute(),
      signal: controller.signal,
    })
      .catch((): AgentIsolationReviewSubmission => ({
        kind: 'failed',
        errorCode: 'request_failed',
      }))
      .then((outcome) => {
        if (!controller.signal.aborted)
          setDecision({ kind: 'settled', outcome });
      });
  }, [canApprove, decision.kind, detail, execute, operation, recheck]);

  const reviewAgain = React.useCallback(() => {
    if (!operation || decision.kind !== 'settled') return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setDecision({ kind: 'refreshing' });
    void (recheck
      ? recheck()
      : refreshAgentIsolationReview(operation, controller.signal, execute())
    )
      .catch(() => false)
      .then((found) => {
        if (controller.signal.aborted) return;
        // The fresh review arrives through the store and resets this decision; anything else says so.
        setDecision(
          found
            ? { kind: 'idle' }
            : {
                kind: 'settled',
                outcome: { kind: 'failed', errorCode: 'request_failed' },
              },
        );
      });
  }, [decision.kind, execute, operation, recheck]);

  return { decision, retried: Boolean(recheck), canApprove, approve, reviewAgain };
}

type AgentIsolationReviewDecision = ReturnType<
  typeof useAgentIsolationReviewDecision
>;

function describeNotice(
  decision: Decision,
  reviewAgain: () => void,
  retried: boolean,
): Readonly<{
  tone: 'warning' | 'neutral' | 'danger';
  title: string;
  description?: string;
  action?: AttentionBannerAction;
}> | null {
  if (decision.kind === 'refreshing')
    return {
      tone: 'warning',
      title: t('inbox.actionOperations.isolationReview.changedTitle'),
      description: t(
        'inbox.actionOperations.isolationReview.changedDescription',
      ),
      action: {
        label: t('inbox.actionOperations.isolationReview.reviewAgain'),
        onPress: reviewAgain,
        loading: true,
        disabled: true,
      },
    };
  if (decision.kind !== 'settled') return null;
  const { outcome } = decision;
  switch (outcome.kind) {
    // Accepted: the operation applies it and its own push replaces this view when it settles.
    case 'applying':
      return retried
        ? {
            tone: 'neutral',
            title: t('inbox.actionOperations.isolationRecovery.appliedTitle'),
            description: t(
              'inbox.actionOperations.isolationRecovery.appliedDescription',
            ),
          }
        : {
            tone: 'neutral',
            title: t('inbox.actionOperations.isolationRecovery.applyingTitle'),
            description: t(
              'inbox.actionOperations.isolationRecovery.applyingHint',
            ),
          };
    case 'review_changed':
      return {
        tone: 'warning',
        title: t('inbox.actionOperations.isolationReview.changedTitle'),
        description: t(
          'inbox.actionOperations.isolationReview.changedDescription',
        ),
        action: {
          label: t('inbox.actionOperations.isolationReview.reviewAgain'),
          onPress: reviewAgain,
        },
      };
    case 'approval_requested':
      return null;
    case 'outcome_unknown':
      return {
        tone: 'warning',
        title: t('inbox.actionOperations.isolationReview.unknownTitle'),
        description: t(
          'inbox.actionOperations.isolationReview.unknownDescription',
        ),
      };
    case 'refused':
      return {
        tone: 'danger',
        title:
          outcome.code === 'denied'
            ? t('inbox.actionOperations.isolationReview.denied')
            : outcome.code === 'cancelled'
              ? t('inbox.actionOperations.isolationReview.cancelled')
              : t('inbox.actionOperations.isolationReview.unavailable'),
      };
    case 'failed':
      return {
        tone: 'danger',
        title: t('inbox.actionOperations.isolationReview.failed'),
      };
  }
}

const noop = () => {};

/** The Account's own setting asked first: the waiting approval, with the way to its Inbox review. */
function IsolationApprovalNotice(
  props: Readonly<{ artifactId: string; serverId: string }>,
) {
  const approval = useActionApprovalContinuation({
    scopeKey: `agent-isolation-review:${props.artifactId}`,
    serverId: props.serverId,
    onExecuted: noop,
  });
  const { requestApproval } = approval;
  React.useEffect(
    () => requestApproval(props.artifactId),
    [props.artifactId, requestApproval],
  );
  if (!approval.approvalPending) return null;
  return (
    <ActionApprovalPendingNotice
      testID="action-operation-isolation-approval"
      presentation="banner"
      message={t('approvals.waitingForYou')}
      description={t('inbox.actionOperations.isolationReview.approvalDescription')}
      onOpenApproval={approval.openApproval}
    />
  );
}

/**
 * The held review as the lab's review card reads it: the exact change first (policy, checkouts,
 * parent folders, sessions that restart, administrator steps), the plan's own references as secondary
 * technical facts. The Machine is named by the operation's Details row.
 */
export const AgentIsolationReviewFacts = React.memo(
  function AgentIsolationReviewFacts(
    props: Readonly<{
      operation: QualifiedActionOperation;
      detail: AgentIsolationReviewDetail;
      decision: AgentIsolationReviewDecision;
    }>,
  ) {
    const { review } = props.detail;
    const { plan } = review.current;
    const notice = describeNotice(
      props.decision.decision,
      props.decision.reviewAgain,
      props.decision.retried,
    );
    const settled =
      props.decision.decision.kind === 'settled'
        ? props.decision.decision.outcome
        : null;
    return (
      <>
        {settled?.kind === 'approval_requested' ? (
          <IsolationApprovalNotice
            artifactId={settled.artifactId}
            serverId={props.operation.serverId}
          />
        ) : null}
        {notice ? (
          <AttentionBanner
            testID="action-operation-isolation-notice"
            placement="inline"
            tone={notice.tone}
            title={notice.title}
            {...(notice.description ? { description: notice.description } : {})}
            {...(notice.action ? { action: notice.action } : {})}
          />
        ) : null}
        <AgentIsolationEffectsGroup
          enabled={review.enabled}
          plan={plan}
          metadataVersion={review.current.metadataVersion}
        />
      </>
    );
  },
);

/**
 * The held Agent isolation review and its one decision: the facts, then "Approve and apply" beneath
 * them, where the lab's review card keeps its buttons. After an unknown outcome (`recheck`), the same
 * review is what the fresh CHECK says is left, applied again only when the person asks.
 */
export const AgentIsolationReview = React.memo(function AgentIsolationReview(
  props: Readonly<{
    operation: QualifiedActionOperation;
    detail: AgentIsolationReviewDetail;
    execute?: () => FrontDoorActionExecute;
    recheck?: AgentIsolationRecoveryCheck['recheck'];
  }>,
) {
  const decision = useAgentIsolationReviewDecision(
    props.operation,
    props.detail,
    props.execute,
    props.recheck,
  );
  const pending = decision.decision.kind === 'pending';
  return (
    <>
      <AgentIsolationReviewFacts
        operation={props.operation}
        detail={props.detail}
        decision={decision}
      />
      {decision.canApprove ? (
        <View style={styles.actions}>
          <RoundButton
            title={
              props.recheck
                ? t('inbox.actionOperations.isolationRecovery.retry')
                : t('inbox.actionOperations.isolationReview.approve')
            }
            testID={
              props.recheck
                ? 'action-operation-isolation-retry'
                : 'action-operation-isolation-approve'
            }
            loading={pending}
            disabled={pending}
            onPress={decision.approve}
          />
        </View>
      ) : null}
    </>
  );
});

/**
 * An isolation change whose own effect restarted the daemon settled "not confirmed". Beneath that
 * receipt, what the one fresh CHECK found: still checking, nothing left, still applying, can't be
 * checked, or what still needs applying (the review again, applied only when the person asks).
 */
export const AgentIsolationRecovery = React.memo(function AgentIsolationRecovery(
  props: Readonly<{
    operation: QualifiedActionOperation;
    check: AgentIsolationRecoveryCheck;
    execute?: () => FrontDoorActionExecute;
  }>,
) {
  const { theme } = useUnistyles();
  const recovery = props.operation.agentIsolationRecovery;
  const projected = recovery
    ? projectAgentIsolationRecovery(recovery, props.operation.snapshot.scope.machineId)
    : null;
  if (projected?.kind === 'needs')
    return (
      <>
        <AttentionBanner
          testID="action-operation-isolation-recovery"
          placement="inline"
          tone="warning"
          title={t('inbox.actionOperations.isolationRecovery.needsTitle')}
          description={t('inbox.actionOperations.isolationRecovery.needsDescription')}
        />
        <AgentIsolationReview
          operation={props.operation}
          detail={projected.detail}
          recheck={props.check.recheck}
          execute={props.execute}
        />
      </>
    );
  const checking = !projected && props.check.state === 'checking';
  const row = projected?.kind === 'satisfied'
    ? {
        title: projected.enabled
          ? t('inbox.actionOperations.isolationRecovery.onTitle')
          : t('inbox.actionOperations.isolationRecovery.offTitle'),
        hint: projected.enabled
          ? t('inbox.actionOperations.isolationRecovery.onHint')
          : t('inbox.actionOperations.isolationRecovery.offHint'),
      }
    : projected?.kind === 'applying'
      ? {
          title: t('inbox.actionOperations.isolationRecovery.applyingTitle'),
          hint: t('inbox.actionOperations.isolationRecovery.applyingHint'),
        }
      : checking
        ? {
            title: t('inbox.actionOperations.isolationRecovery.checkingTitle'),
            hint: t('inbox.actionOperations.isolationRecovery.checkingHint'),
          }
        : {
            title: t('inbox.actionOperations.isolationRecovery.unavailableTitle'),
            hint: t('inbox.actionOperations.isolationRecovery.unavailableHint'),
          };
  return (
    <ItemGroup
      testID="action-operation-isolation-recovery"
      title={t('inbox.actionOperations.isolationRecovery.title')}
    >
      <Item
        testID="action-operation-isolation-recovery-state"
        mode="info"
        title={row.title}
        subtitle={row.hint}
        subtitleLines={0}
        loading={checking}
        {...(projected?.kind === 'satisfied'
          ? { icon: <Icon name="check-circle" size={ICON_SIZE.md} color={theme.colors.text.secondary} /> }
          : {})}
      />
    </ItemGroup>
  );
});

const styles = StyleSheet.create(() => ({
  actions: { flexDirection: 'row', justifyContent: 'flex-end' },
}));

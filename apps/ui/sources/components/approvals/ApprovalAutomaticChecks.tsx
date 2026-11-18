import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  actionAutomationTriggerKeyV1,
  type ApprovalAutomaticChecksV1,
} from '@happier-dev/protocol/approvals/approvalAutomaticChecks';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useWorkflowReferenceTitles } from '@/components/workflows/presentation/workflowReferenceOptions';
import { useApprovalAccountLabel } from '@/components/approvals/ApprovalRequesterConfirmationSection';
import { resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { Modal } from '@/modal';
import { alertApprovalFailure, type ApprovalDecisionOptions } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import type { ApprovalAutomaticChecksPresentation } from './useApprovalAutomaticChecksPresentation';
import { useApprovalAutomaticCheckDetails } from './useApprovalAutomaticCheckDetails';
import { ApprovalCheckReviewSteps } from './ApprovalCheckReviewSteps';
import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import { useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';

/**
 * Which decision the card offers while an Action's before checks hold it (05 S6/S8/S9): a shared check waiting for
 * this person's consent (Allow · Skip), a running check (Cancel), a failed check a person may override
 * (Approve anyway · Deny). Everything else keeps the card's ordinary decision.
 */
export type ApprovalAutomaticChecksDecision =
  | Readonly<{ kind: 'consent'; automationId: string; triggerId: string }>
  | Readonly<{ kind: 'checking' }>
  | Readonly<{ kind: 'override' }>
  | null;

export function readApprovalAutomaticChecksDecision(
  checks: ApprovalAutomaticChecksV1 | null | undefined,
): ApprovalAutomaticChecksDecision {
  if (!checks) return null;
  if (checks.phase === 'consent') {
    const pending = checks.consents.find(
      (consent) => consent.decision === 'pending',
    );
    return pending
      ? {
          kind: 'consent',
          automationId: pending.automationId,
          triggerId: pending.triggerId,
        }
      : null;
  }
  if (checks.phase === 'checking') return { kind: 'checking' };
  if (checks.phase === 'override') return { kind: 'override' };
  return null;
}

/** Whether the checks have anything to tell: a pending consent, a running check, a failure, or a visible Skip. */
export function readApprovalAutomaticChecksShown(checks: ApprovalAutomaticChecksV1): boolean {
  const failed = checks.results.some((result) => result.outcome === 'failed' || result.outcome === 'unavailable');
  return (checks.phase === 'consent' && checks.consents.some((consent) => consent.decision === 'pending'))
    || checks.phase === 'checking'
    || ((checks.phase === 'override' || checks.phase === 'refused') && failed)
    || checks.consents.some((consent) => consent.decision === 'skip')
    || checks.notices.some((notice) => notice.code === 'action_automation_skipped');
}

/**
 * The card's answers while before checks hold the Action, through the card's one decision owner: a shared check's
 * consent (approving the Action is not consent), and Cancel for a running check. Failures alert as every decision does.
 */
export function useApprovalAutomaticChecksControls(input: Readonly<{
  checks: ApprovalAutomaticChecksV1 | null | undefined;
  decide: (decision: 'approve' | 'reject' | 'cancel', options?: ApprovalDecisionOptions) => Promise<boolean>;
  unavailable: boolean;
  isDeciding: boolean;
  setIsDeciding: (deciding: boolean) => void;
}>) {
  const decision = readApprovalAutomaticChecksDecision(input.checks);
  const { decide, unavailable, isDeciding, setIsDeciding } = input;
  const run = React.useCallback(async (operation: () => Promise<boolean>) => {
    if (unavailable || isDeciding) return;
    try {
      setIsDeciding(true);
      if (!(await operation())) Modal.alert(t('common.error'), t('approvals.decisionError'));
    } catch (error) {
      alertApprovalFailure(error);
    } finally {
      setIsDeciding(false);
    }
  }, [isDeciding, setIsDeciding, unavailable]);
  const consent = decision?.kind === 'consent' ? decision : null;
  const answerConsent = React.useCallback((answer: 'allow' | 'skip') => consent ? run(() => decide('approve', {
    triggerConsent: { automationId: consent.automationId, triggerId: consent.triggerId, decision: answer } })) : Promise.resolve(),
  [consent?.automationId, consent?.triggerId, decide, run]);
  const cancelChecks = React.useCallback(() => run(() => decide('cancel')), [decide, run]);
  return { decision, answerConsent, cancelChecks };
}

/** The running check's elapsed time, ticking in this leaf only so the card above it never re-renders per second. */
const CheckElapsed = React.memo(function CheckElapsed(props: Readonly<{ fromMs: number }>) {
  const elapsedSeconds = useElapsedTime(props.fromMs);
  return <Text variant="meta" style={stylesheet.secondary}>{formatElapsedDuration(elapsedSeconds * 1000)}</Text>;
});

const stylesheet = StyleSheet.create((theme) => ({
  block: {
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.inset,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    gap: theme.space.s4,
  },
  lead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  leadText: { flexShrink: 1 },
  // Text inherits no ink on web: every line in the block names its colour.
  primary: { color: theme.colors.text.primary },
  secondary: { color: theme.colors.text.secondary },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s8,
  },
}));

/**
 * The before checks an Action is waiting on, told inside its card: who set a shared check up and what changed when it
 * asks again, the running check, a refusal or a check that could not run, and the visible Skips. Decisions stay in the
 * card's footer; this body only says what they are about.
 */
export const ApprovalAutomaticChecks = React.memo(
  function ApprovalAutomaticChecks(
    props: Readonly<Partial<ApprovalAutomaticChecksPresentation> & {
      checks: ApprovalAutomaticChecksV1;
      actionTitle: string;
      serverId: string | null;
      /** Opens an in-app route (a check's Run, a shared check's workflow); absent where the card cannot navigate. */
      onOpenRoute?: (route: string) => void;
      testID?: string;
    }>,
  ) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { checks } = props;
    const workflowRefs = React.useMemo(
      () => checks.selected.map((selected) => selected.workflowId),
      [checks.selected],
    );
    const resolveTitle = useWorkflowReferenceTitles(workflowRefs, true);
    const selectedByKey = React.useMemo(
      () =>
        new Map(
          checks.selected.map((row) => [
            actionAutomationTriggerKeyV1(row),
            row,
          ]),
        ),
      [checks.selected],
    );
    const nameOf = (
      ref: Readonly<{ automationId: string; triggerId: string }>,
    ) => {
      const workflowId = selectedByKey.get(
        actionAutomationTriggerKeyV1(ref),
      )?.workflowId;
      return (
        (workflowId ? resolveTitle(workflowId) : null) ??
        t('workflows.triggers.checks.aCheck')
      );
    };
    const runOf = (
      ref: Readonly<{ automationId: string; triggerId: string }>,
    ) =>
      checks.runs.find(
        (run) =>
          actionAutomationTriggerKeyV1(run) ===
          actionAutomationTriggerKeyV1(ref),
      )?.runId ?? null;
    const pending =
      checks.phase === 'consent'
        ? (checks.consents.find((consent) => consent.decision === 'pending') ??
          null)
        : null;
    const pendingOwner = pending
      ? selectedByKey.get(actionAutomationTriggerKeyV1(pending))?.ownerAccountId
      : undefined;
    const ownerLabel =
      useApprovalAccountLabel(props.serverId, pendingOwner, 'sentence') ??
      resolveUnknownAccountActorName('sentence');
    const failed =
      checks.results.find(
        (result) =>
          result.outcome === 'failed' || result.outcome === 'unavailable',
      ) ?? null;
    const skippedConsents = checks.consents.filter(
      (consent) => consent.decision === 'skip',
    );
    // Typed reasons come from the held request's projection; a reason this version cannot read says only that it skipped.
    const skippedNotices: ApprovalAutomaticChecksPresentation['automaticCheckSkips'] = props.automaticCheckSkips ?? checks.notices.flatMap((notice) =>
      notice.code === 'action_automation_skipped' ? [{ notice, reason: null }] : [],
    );
    const checkingRun = checks.phase === 'checking'
      ? (checks.selected.find((row) => runOf(row) !== null) ?? checks.selected[0] ?? null) : null;
    const pendingWorkflowId = pending ? selectedByKey.get(actionAutomationTriggerKeyV1(pending))?.workflowId ?? null : null;
    // Review steps opens in place; a check that asks again because its steps changed opens with them shown.
    const [reviewToggled, setReviewToggled] = React.useState<boolean | null>(null);
    const reviewOpen = pendingWorkflowId !== null && (reviewToggled ?? pending?.review?.reason === 'steps');
    const disclosure = useCoreDisclosureToggleBinding();
    const changedBlockIds = React.useMemo(() => new Set(pending?.review?.changedSteps?.map((step) => step.blockId) ?? []),
      [pending?.review?.changedSteps]);
    const { progress: checkingProgress, runSummary: checkingRunSummary, review } = useApprovalAutomaticCheckDetails({
      runId: checkingRun ? runOf(checkingRun) : null, serverId: props.serverId,
      reviewWorkflowId: reviewOpen ? pendingWorkflowId : null,
    });
    const checkingStartedMs = checkingRunSummary?.state === 'running' ? Date.parse(checkingRunSummary.createdAt) : Number.NaN;
    const openRun = (runId: string | null) =>
      runId && props.onOpenRoute ? (
        <TextLinkButton
          label={t('workflows.triggers.checks.openRun')}
          size="meta"
          onPress={() => props.onOpenRoute?.(createWorkflowRunRoute(runId, props.serverId))}
        />
      ) : null;

    let body: React.ReactNode = null;
    if (pending) {
      const workflow = nameOf(pending);
      const workflowId = selectedByKey.get(
        actionAutomationTriggerKeyV1(pending),
      )?.workflowId;
      const title =
        pending.review?.reason === 'steps'
          ? t('workflows.triggers.checks.consentChangedSteps', { workflow })
          : pending.review?.reason === 'match'
            ? t('workflows.triggers.checks.consentChangedMatch', { workflow })
            : t('workflows.triggers.checks.consentTitle', { workflow });
      body = (
        <View
          style={styles.block}
          testID={props.testID ? `${props.testID}:consent` : undefined}
        >
          <View style={styles.lead}>
            <Icon
              name="shield-check"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
            <Text variant="body" emphasis="semiBold" style={[styles.primary, styles.leadText]}>
              {title}
            </Text>
          </View>
          <Text variant="meta" style={styles.secondary}>
            {t('workflows.triggers.checks.consentFacts', { name: ownerLabel })}
          </Text>
          {pending.review ? (
            <Text variant="meta" style={styles.secondary}>
              {t('workflows.triggers.checks.consentReask')}
            </Text>
          ) : null}
          {workflowId ? (
            <HappierDisclosureToggle
              testID={props.testID ? `${props.testID}:review` : undefined}
              label={t('workflows.triggers.checks.reviewSteps')}
              open={reviewOpen}
              onPress={() => setReviewToggled(!reviewOpen)}
              caret={disclosure.renderCaret(reviewOpen)}
              renderLabel={disclosure.renderLabel}
              focusColor={disclosure.focusColor}
            />
          ) : null}
          {reviewOpen ? (
            <ApprovalCheckReviewSteps review={review} changedBlockIds={changedBlockIds}
              testID={props.testID ? `${props.testID}:review-steps` : undefined} />
          ) : null}
          <Text variant="meta" style={styles.secondary}>
            {t('workflows.triggers.checks.consentOnlyYou')}
          </Text>
        </View>
      );
    } else if (checks.phase === 'checking') {
      const running = checkingRun;
      body = (
        <View
          style={styles.block}
          testID={props.testID ? `${props.testID}:checking` : undefined}
        >
          <View style={styles.lead}>
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            <Text variant="body" emphasis="semiBold" style={[styles.primary, styles.leadText]}>
              {t('workflows.triggers.checks.checkingBefore', {
                action: props.actionTitle,
              })}
            </Text>
          </View>
          {running ? (
            <View style={styles.line}>
              <Text variant="meta" style={styles.secondary}>
                {checkingProgress ? `${nameOf(running)} · ${checkingProgress}` : nameOf(running)}
                {Number.isFinite(checkingStartedMs) ? <>{' · '}<CheckElapsed fromMs={checkingStartedMs} /></> : null}
              </Text>
              {openRun(runOf(running))}
            </View>
          ) : null}
        </View>
      );
    } else if (
      (checks.phase === 'override' || checks.phase === 'refused') &&
      failed
    ) {
      const workflow = nameOf(failed);
      body = (
        <View
          style={styles.block}
          testID={props.testID ? `${props.testID}:${checks.phase}` : undefined}
        >
          <View style={styles.lead}>
            <Icon
              name="warning"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
            <Text variant="body" emphasis="semiBold" style={[styles.primary, styles.leadText]}>
              {checks.phase === 'override'
                ? t('workflows.triggers.checks.overrideTitle', { workflow })
                : failed.outcome === 'unavailable'
                  ? t('workflows.triggers.checks.couldNotRun', { workflow })
                  : t('workflows.triggers.checks.refused', { workflow })}
            </Text>
          </View>
          {/* The workflow's own reason for failing, as it said it. A refusal settles the request, whose failure
              already leads with that reason, so only the open override says it here. */}
          {checks.phase === 'override' && failed.reason ? (
            <Text variant="body" style={styles.primary} testID={props.testID ? `${props.testID}:reason` : undefined}>{failed.reason}</Text>
          ) : null}
          <View style={styles.line}>
            {checks.phase === 'override' ? (
              <Text variant="meta" style={styles.secondary}>
                {t('workflows.triggers.checks.overrideNote')}
              </Text>
            ) : null}
            {openRun(failed.runId)}
          </View>
        </View>
      );
    }
    const skipped = [
      ...skippedConsents.map((row) =>
        t('workflows.triggers.checks.skipped', { workflow: nameOf(row) }),
      ),
      ...skippedNotices.map(({ notice, reason }) => reason === 'machineRequired'
        ? t('workflows.triggers.checks.skippedNeedsMachine', { workflow: nameOf(notice) })
        // A shared Bot asked by someone else: the line names the Account holder who has not allowed it.
        : reason === 'actorConsentUnavailableForRequester' && props.automaticChecksExecutionAccountName
          ? t('workflows.triggers.checks.skippedNotAllowedBy', { workflow: nameOf(notice),
            name: props.automaticChecksExecutionAccountName })
          : t('workflows.triggers.checks.skippedUnavailable', { workflow: nameOf(notice) }),
      ),
    ];
    if (!readApprovalAutomaticChecksShown(checks)) return null;
    return (
      <>
        {body}
        {skipped.map((line, index) => (
          <View key={index} style={styles.lead}>
            <Icon name="minus-circle" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text
              variant="meta"
              style={[styles.secondary, styles.leadText]}
              testID={
                props.testID ? `${props.testID}:skipped:${index}` : undefined
              }
            >
              {line}
            </Text>
          </View>
        ))}
      </>
    );
  },
);

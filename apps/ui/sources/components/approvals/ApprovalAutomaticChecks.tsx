import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  actionAutomationTriggerKeyV1,
  type ApprovalAutomaticChecksV1,
} from '@happier-dev/protocol/approvals/approvalAutomaticChecks';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useWorkflowReferenceTitles } from '@/components/workflows/presentation/workflowReferenceOptions';
import { useApprovalAccountLabel } from '@/components/approvals/ApprovalRequesterConfirmationSection';
import { resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { createWorkflowDefinitionRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { Modal } from '@/modal';
import { alertApprovalFailure, type ApprovalDecisionOptions } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import type { ApprovalAutomaticChecksPresentation } from './useApprovalAutomaticChecksPresentation';

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

const stylesheet = StyleSheet.create((theme) => ({
  block: {
    borderRadius: 10,
    backgroundColor: theme.colors.surface.inset,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    gap: theme.space.s4,
  },
  lead: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  leadText: { flexShrink: 1 },
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
    const skippedNotices = checks.notices.flatMap((notice) =>
      notice.code === 'action_automation_skipped' ? [notice] : [],
    );
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
              size={16}
              color={theme.colors.text.secondary}
            />
            <Text variant="body" emphasis="semiBold" style={styles.leadText}>
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
          {workflowId && props.onOpenRoute ? (
            <View style={styles.line}>
              <TextLinkButton
                label={t('workflows.triggers.checks.reviewSteps')}
                size="meta"
                tone="strong"
                testID={props.testID ? `${props.testID}:review` : undefined}
                onPress={() => props.onOpenRoute?.(createWorkflowDefinitionRoute(workflowId, props.serverId))}
              />
            </View>
          ) : null}
          <Text variant="meta" style={styles.secondary}>
            {t('workflows.triggers.checks.consentOnlyYou')}
          </Text>
        </View>
      );
    } else if (checks.phase === 'checking') {
      const running =
        checks.selected.find((row) => runOf(row) !== null) ??
        checks.selected[0];
      body = (
        <View
          style={styles.block}
          testID={props.testID ? `${props.testID}:checking` : undefined}
        >
          <View style={styles.lead}>
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            <Text variant="body" emphasis="semiBold" style={styles.leadText}>
              {t('workflows.triggers.checks.checkingBefore', {
                action: props.actionTitle,
              })}
            </Text>
          </View>
          {running ? (
            <View style={styles.line}>
              <Text variant="meta" style={styles.secondary}>
                {nameOf(running)}
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
              size={16}
              color={theme.colors.text.secondary}
            />
            <Text variant="body" emphasis="semiBold" style={styles.leadText}>
              {checks.phase === 'override'
                ? t('workflows.triggers.checks.overrideTitle', { workflow })
                : failed.outcome === 'unavailable'
                  ? t('workflows.triggers.checks.couldNotRun', { workflow })
                  : t('workflows.triggers.checks.refused', { workflow })}
            </Text>
          </View>
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
      ...skippedNotices.map((notice) =>
        t('workflows.triggers.checks.skippedUnavailable', {
          workflow: nameOf(notice),
        }),
      ),
    ];
    if (!body && skipped.length === 0) return null;
    return (
      <>
        {body}
        {skipped.map((line, index) => (
          <Text
            key={index}
            variant="meta"
            style={styles.secondary}
            testID={
              props.testID ? `${props.testID}:skipped:${index}` : undefined
            }
          >
            {line}
          </Text>
        ))}
      </>
    );
  },
);

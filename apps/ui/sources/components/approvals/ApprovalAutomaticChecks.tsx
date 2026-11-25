import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  actionAutomationTriggerKeyV1,
  type ApprovalAutomaticChecksV1,
} from '@happier-dev/protocol/approvals/approvalAutomaticChecks';
import { readActionFailurePresentationV1, type ActionFailurePresentationV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { isApprovalRequestV2TerminalStatus, type ApprovalRequest, type ApprovalRequestV2 }
  from '@happier-dev/protocol/approvals/approvalRequestV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowReferenceTitles } from '@/components/workflows/presentation/workflowReferenceOptions';
import { useApprovalAccountLabel } from '@/components/approvals/ApprovalRequesterConfirmationSection';
import { resolveUnknownAccountActorName } from '@/sync/domains/account/accountActorPresentation';
import { createWorkflowDefinitionRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { Modal } from '@/modal';
import { alertApprovalFailure, ApprovalExecutionError, type ApprovalDecisionOptions } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import type { ApprovalAutomaticChecksPresentation } from './useApprovalAutomaticChecksPresentation';
import { useApprovalAutomaticCheckDetails } from './useApprovalAutomaticCheckDetails';
import { ApprovalCheckReviewSteps } from './ApprovalCheckReviewSteps';
import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import { useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { formatWorkflowInvocationElapsedLabel } from '@/components/workflows/presentation/workflowUsagePresentation';
import { formatAutomaticCheckSkipNotice, formatAutomationsNotCheckedNotice } from './formatAutomaticCheckSkipNotice';
import { readApprovalAutomaticChecksDecision } from './approvalAutomaticChecksDecision';
import { useMachinePresenceSummary, type MachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { presentWorkflowRunMachineWait } from '@/components/work/status/workflowWorkStatusFacts';

type PresentedApprovalAutomaticChecks = Omit<ApprovalAutomaticChecksV1, 'phase'> & {
  phase: ApprovalAutomaticChecksV1['phase'] | null;
  startRefusal?: ActionFailurePresentationV1['startRefusal'];
};

/** A settled request keeps recorded check history without a live phase. */
export function readApprovalAutomaticChecksForRequest(
  request: Readonly<{ status: ApprovalRequestV2['status']; automaticChecks?: ApprovalAutomaticChecksV1;
    execution?: Readonly<{ ok?: boolean; errorCode?: string; details?: unknown }> }> | null,
): PresentedApprovalAutomaticChecks | null {
  if (!request?.automaticChecks) return null;
  const checks = request.automaticChecks;
  if ((checks.phase === 'consent' || checks.phase === 'checking' || checks.phase === 'override')
    && isApprovalRequestV2TerminalStatus(request.status)) {
    return { ...checks, phase: request.status === 'rejected' && checks.phase === 'override' ? 'refused' : null };
  }
  if (request.status !== 'open' && checks.phase === 'consent') {
    return { ...checks, consents: checks.consents.filter(consent => consent.decision !== 'pending') };
  }
  const execution = request.execution;
  if (checks.phase === 'refused' && execution?.ok === false) {
    const startRefusal = readActionFailurePresentationV1(execution.errorCode, execution.details)?.startRefusal;
    if (startRefusal) return { ...checks, startRefusal };
  }
  return checks;
}

/**
 * A check's recorded reason is either the Workflow's own deliverable text or the typed code its wait settled with
 * (`workflow_failed` when it ended with neither). Codes read through the one failure-copy owner; a code it has no sentence
 * for says nothing here, so the block's human lead speaks instead of the code.
 */
function presentAutomaticCheckReason(reason: string | null | undefined): string | null {
  const text = reason?.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*$/.test(text)) return text;
  const presented = presentActionFailureOutcome({ error: text, errorCode: text }, 'workflowCheck').reason;
  return presented && presented !== text ? presented : null;
}

/** Run admission's ineligible reasons for a check whose Automation or trigger no longer exists. */
const CHECK_REMOVED_START_REASONS: ReadonlySet<string> = new Set(['automationNotFound', 'triggerNotFound']);

function readFailedApprovalAutomaticCheck(checks: Pick<ApprovalAutomaticChecksV1, 'results'>) {
  return checks.results.find(result => result.outcome === 'failed' || result.outcome === 'unavailable');
}

/** The retained check result owns the exact Run for a declined request's receipt. */
export function readDeclinedApprovalCheckRunId(approval: ApprovalRequest): string | null {
  if (approval.v !== 2 || approval.status !== 'rejected') return null;
  const checks = readApprovalAutomaticChecksForRequest(approval);
  return checks?.phase === 'refused' ? readFailedApprovalAutomaticCheck(checks)?.runId ?? null : null;
}

/** The check line reads only reachability and name; a heartbeat that changes neither wakes nothing. */
function isSameMachineWaitFacts(left: MachinePresenceSummary, right: MachinePresenceSummary): boolean {
  return left.reachability === right.reachability && left.name === right.name;
}

export function ApprovalCheckRunLink(props: Readonly<{
  runId: string | null;
  serverId?: string | null;
  onOpenRoute?: ((route: string) => void) | null;
  testID?: string;
}>) {
  const { runId, serverId, onOpenRoute } = props;
  if (!runId || !onOpenRoute) return null;
  return <TextLinkButton
    label={t('workflows.triggers.checks.openRun')}
    size="meta"
    testID={props.testID}
    onPress={() => onOpenRoute(createWorkflowRunRoute(runId, serverId))}
  />;
}

/** Whether the checks have anything to tell: a pending consent, a running check, a failure, or a visible Skip. */
export function readApprovalAutomaticChecksShown(checks: PresentedApprovalAutomaticChecks): boolean {
  const failed = readFailedApprovalAutomaticCheck(checks) !== undefined;
  return (checks.phase === 'consent' && checks.consents.some((consent) => consent.decision === 'pending'))
    || checks.phase === 'checking'
    || (checks.phase === 'passed' && checks.results.some(result => result.outcome === 'passed'))
    || (checks.phase === 'override' && failed)
    || readApprovalAutomaticChecksCarryRefusal(checks)
    || checks.consents.some((consent) => consent.decision === 'skip')
    || checks.notices.some((notice) => notice.code === 'action_automation_skipped' || notice.code === 'action_automations_not_checked');
}

/**
 * A refusal the checks themselves explain: the card's own failure line would repeat it, so the checks block carries the
 * reason (lab `wait-v-arefused`) and the card leaves its loose failure paragraph out.
 */
export function readApprovalAutomaticChecksCarryRefusal(checks: PresentedApprovalAutomaticChecks | null | undefined): boolean {
  return checks?.phase === 'refused'
    && (Boolean(checks.startRefusal) || readFailedApprovalAutomaticCheck(checks) !== undefined);
}

/**
 * The card's answers while before checks hold the Action, through the card's one decision owner: a shared check's
 * consent (approving the Action is not consent), and Cancel for a running check. Failures alert as every decision does.
 */
export function useApprovalAutomaticChecksControls(input: Readonly<{
  checks: PresentedApprovalAutomaticChecks | null | undefined;
  decide: (decision: 'approve' | 'reject' | 'cancel', options?: ApprovalDecisionOptions) => Promise<boolean>;
  unavailable: boolean;
  isDeciding: boolean;
  setIsDeciding: (deciding: boolean) => void;
}>) {
  const decision = readApprovalAutomaticChecksDecision(input.checks);
  const { decide, unavailable, isDeciding, setIsDeciding } = input;
  const [isCancellingChecks, setIsCancellingChecks] = React.useState(false);
  const cancelInFlight = React.useRef(false);
  const run = React.useCallback(async (operation: () => Promise<boolean>, cancel = false) => {
    if (unavailable || (cancel ? cancelInFlight.current : isDeciding)) return;
    const setBusy = cancel ? setIsCancellingChecks : setIsDeciding;
    if (cancel) cancelInFlight.current = true;
    try {
      setBusy(true);
      if (!(await operation())) Modal.alert(t('common.error'), t('approvals.decisionError'));
    } catch (error) {
      if (!(error instanceof ApprovalExecutionError)) alertApprovalFailure(error);
    } finally {
      if (cancel) cancelInFlight.current = false;
      setBusy(false);
    }
  }, [isDeciding, setIsDeciding, unavailable]);
  const consent = decision?.kind === 'consent' ? decision : null;
  const answerConsent = React.useCallback((answer: 'allow' | 'skip') => consent ? run(() => decide('approve', {
    triggerConsent: { automationId: consent.automationId, triggerId: consent.triggerId, decision: answer } })) : Promise.resolve(),
  [consent?.automationId, consent?.triggerId, decide, run]);
  // Checking is published while Approve awaits the Run. Only an outstanding Cancel holds this control.
  const checking = decision?.kind === 'checking';
  const cancelChecks = React.useCallback(() => checking ? run(() => decide('cancel'), true) : Promise.resolve(),
    [checking, decide, run]);
  return { decision, answerConsent, cancelChecks, isCancellingChecks, cancelDisabled: unavailable || isCancellingChecks };
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
  // A failed check a person may override needs them (amber); one that refused the Action failed (rose).
  attentionBlock: { backgroundColor: theme.colors.state.warning.background },
  dangerBlock: { backgroundColor: theme.colors.state.danger.background },
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
      checks: PresentedApprovalAutomaticChecks;
      actionTitle: string;
      serverId: string | null;
      /** Opens an in-app route (a check's Run, a shared check's workflow); absent where the card cannot navigate. */
      onOpenRoute?: (route: string) => void;
      /** The settled request's failure reason, which a refusal's block carries (the card then leaves it out). */
      failureReason?: string | null;
      accountLifetime?: ServerAccountScopeLifetime | null;
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
    const resolveTitle = useWorkflowReferenceTitles(workflowRefs, true, props.accountLifetime);
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
    const knownNameOf = (ref: Readonly<{ automationId: string; triggerId: string }>) => {
      const workflowId = selectedByKey.get(actionAutomationTriggerKeyV1(ref))?.workflowId;
      return workflowId ? resolveTitle(workflowId) : null;
    };
    // Decision sentences can still refer to a check whose name is unavailable.
    const nameOf = (ref: Parameters<typeof knownNameOf>[0], position: 'lead' | 'inline' = 'lead') =>
      knownNameOf(ref) ?? t(position === 'lead' ? 'workflows.triggers.checks.aCheckLead' : 'workflows.triggers.checks.aCheck');
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
    const startRefusal = checks.startRefusal;
    const refusedSelection = startRefusal ? selectedByKey.get(actionAutomationTriggerKeyV1(startRefusal)) : undefined;
    const checkOwner = pending ? selectedByKey.get(actionAutomationTriggerKeyV1(pending))?.ownerAccountId
      : refusedSelection?.ownerAccountId;
    const ownerLabel =
      useApprovalAccountLabel(props.serverId, checkOwner, 'sentence') ??
      resolveUnknownAccountActorName('sentence');
    const failed = readFailedApprovalAutomaticCheck(checks);
    const failureReason = presentAutomaticCheckReason(failed?.reason) ?? presentAutomaticCheckReason(props.failureReason);
    const skippedConsents = checks.consents.filter(
      (consent) => consent.decision === 'skip',
    );
    // Typed reasons come from the held request's projection; a reason this version cannot read says only that it skipped.
    const skippedNotices: ApprovalAutomaticChecksPresentation['automaticCheckSkips'] = props.automaticCheckSkips ?? checks.notices.flatMap((notice) =>
      notice.code === 'action_automation_skipped' ? [{ notice, reason: null }] : [],
    );
    const checkingRun = checks.phase === 'checking'
      ? (checks.selected.find((row) => runOf(row) !== null) ?? checks.selected[0] ?? null) : null;
    const pendingSelection = pending ? selectedByKey.get(actionAutomationTriggerKeyV1(pending)) ?? null : null;
    const pendingWorkflowId = pendingSelection?.workflowId ?? null;
    const reviewKey = pendingSelection ? JSON.stringify([actionAutomationTriggerKeyV1(pendingSelection),
      pendingSelection.triggerRevision, pendingSelection.workflowId, pendingSelection.workflowRevision]) : null;
    // Review steps opens in place; a check that asks again because its steps changed opens with them shown.
    const [reviewToggled, setReviewToggled] = React.useState<Readonly<{ key: string | null; open: boolean }> | null>(null);
    const reviewOpen = pendingWorkflowId !== null && (reviewToggled?.key === reviewKey
      ? reviewToggled.open : pending?.review?.reason === 'steps');
    const disclosure = useCoreDisclosureToggleBinding();
    const changedBlockIds = React.useMemo(() => new Set(pending?.review?.changedSteps?.map((step) => step.blockId) ?? []),
      [pending?.review?.changedSteps]);
    const passedChecks = React.useMemo(() => checks.phase === 'passed'
      ? checks.results.filter(result => result.outcome === 'passed') : [], [checks.phase, checks.results]);
    const checkingRunId = checkingRun ? runOf(checkingRun) : null;
    const runIds = React.useMemo(() => checkingRunId ? [checkingRunId] : passedChecks.map(result => result.runId),
      [checkingRunId, passedChecks]);
    const { progress: checkingProgress, summaries, review } = useApprovalAutomaticCheckDetails({
      runIds, serverId: props.serverId, reviewWorkflowId: reviewOpen ? pendingWorkflowId : null,
    });
    const checkingRunSummary = checkingRunId ? summaries.get(checkingRunId) : null;
    const checkingStartedMs = checkingRunSummary?.state === 'running' ? Date.parse(checkingRunSummary.createdAt) : Number.NaN;
    // A queued check names its offline Machine (R12 M3): the Run's assigned Machine and that one Machine's pushed presence.
    const checkingMachine = useMachinePresenceSummary(props.serverId,
      checkingRunSummary?.state === 'queued' ? checkingRunSummary.machineId : null, undefined, isSameMachineWaitFacts);
    const checkingMachineWait = checkingRunSummary ? presentWorkflowRunMachineWait(checkingRunSummary.state, {
      reachable: checkingMachine.reachability === 'unknown' ? undefined : checkingMachine.reachability === 'reachable',
      name: checkingMachine.name,
    }) : null;
    const openRun = (runId: string | null) =>
      <ApprovalCheckRunLink runId={runId} serverId={props.serverId} onOpenRoute={props.onOpenRoute} />;

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
              onPress={() => setReviewToggled({ key: reviewKey, open: !reviewOpen })}
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
            {/* A check Run that has not started yet is held, not progressing: only a running Run shows motion. */}
            {checkingRunSummary?.state === 'queued' ? (
              <Icon name="clock" size={ICON_SIZE.sm} color={theme.colors.text.secondary}
                testID={props.testID ? `${props.testID}:queued-glyph` : undefined} />
            ) : <ActivitySpinner size="small" color={theme.colors.text.secondary} />}
            <Text variant="body" emphasis="semiBold" style={[styles.primary, styles.leadText]}>
              {/* A check held on an offline Machine leads with that hold, not with progress (R12 M3). */}
              {checkingMachineWait ?? t('workflows.triggers.checks.checkingBefore', {
                action: props.actionTitle,
              })}
            </Text>
          </View>
          {running ? (
            <View style={styles.line}>
              <Text variant="meta" style={styles.secondary}>
                {checkingMachineWait ? nameOf(running)
                  : checkingProgress ? `${nameOf(running)} · ${checkingProgress}` : nameOf(running)}
                {Number.isFinite(checkingStartedMs) ? <>{' · '}<CheckElapsed fromMs={checkingStartedMs} /></> : null}
              </Text>
              {openRun(runOf(running))}
            </View>
          ) : null}
        </View>
      );
    } else if (checks.phase === 'override' && failed) {
      // Needs the person: amber, the question first, the workflow's own reason, then who can answer and its Run.
      const workflow = nameOf(failed);
      body = (
        <View style={[styles.block, styles.attentionBlock]} testID={props.testID ? `${props.testID}:override` : undefined}>
          <View style={styles.lead}>
            <Icon name="warning" size={ICON_SIZE.sm} color={theme.colors.state.warning.foreground} />
            <Text variant="body" emphasis="semiBold" style={[styles.primary, styles.leadText]}>
              {t('workflows.triggers.checks.overrideTitle', { workflow })}
            </Text>
          </View>
          {failureReason ? (
            <Text variant="body" style={styles.primary} testID={props.testID ? `${props.testID}:reason` : undefined}>{failureReason}</Text>
          ) : null}
          <View style={styles.line}>
            <Text variant="meta" style={styles.secondary}>{t('workflows.triggers.checks.overrideNote')}</Text>
            {openRun(failed.runId)}
          </View>
        </View>
      );
    } else if (checks.phase === 'refused' && (startRefusal || failed)) {
      // The refusal settled the request: its reason leads the block (said once, here), the check's name and Run beneath
      // (lab `wait-v-arefused`). Without a reason the block says which check refused or couldn't run.
      const workflowName = failed ? knownNameOf(failed) : null;
      const refusedWorkflowId = refusedSelection?.workflowId;
      // The admission owner's typed cause says the check itself is gone: nothing to open and no one to ask.
      const checkRemoved = startRefusal ? CHECK_REMOVED_START_REASONS.has(startRefusal.reason) : false;
      const viewerOwnsCheck = props.accountLifetime?.isCurrent() === true
        && props.accountLifetime.scope.accountId === refusedSelection?.ownerAccountId;
      body = (
        <View style={[styles.block, styles.dangerBlock]} testID={props.testID ? `${props.testID}:refused` : undefined}>
          {!startRefusal && failureReason ? (
            <View style={styles.lead}>
              <Icon name="warning" size={ICON_SIZE.sm} color={theme.colors.state.danger.foreground}
                testID={props.testID ? `${props.testID}:refused-glyph` : undefined} />
              <Text variant="body" style={[styles.primary, styles.leadText]} testID={props.testID ? `${props.testID}:reason` : undefined}>{failureReason}</Text>
            </View>
          ) : (
            <View style={styles.lead}>
              <Icon name="warning" size={ICON_SIZE.sm} color={theme.colors.state.danger.foreground}
                testID={props.testID ? `${props.testID}:refused-glyph` : undefined} />
              <Text variant="body" emphasis="semiBold" style={[styles.primary, styles.leadText]}>
                {startRefusal ? checkRemoved ? t('workflows.triggers.checks.startRefusedRemoved')
                  : t('workflows.triggers.checks.startRefused', { workflow: nameOf(startRefusal) })
                  : failed?.outcome === 'unavailable'
                    ? t('workflows.triggers.checks.couldNotRun', { workflow: nameOf(failed) })
                    : failed && t('workflows.triggers.checks.refused', { workflow: nameOf(failed, 'inline') })}
              </Text>
            </View>
          )}
          <View style={styles.line}>
            {startRefusal ? checkRemoved ? null : (
              viewerOwnsCheck && refusedWorkflowId ? props.onOpenRoute && <TextLinkButton
                label={t('workflows.triggers.row.openWorkflow')} size="meta"
                testID={props.testID ? `${props.testID}:open-workflow` : undefined}
                onPress={() => props.onOpenRoute?.(createWorkflowDefinitionRoute(refusedWorkflowId, props.serverId))}
              /> : <Text variant="meta" style={styles.secondary}>
                {t('workflows.triggers.checks.startRefusedAskOwner', { name: ownerLabel })}
              </Text>
            ) : <>
              {failureReason && workflowName ? <Text variant="meta" emphasis="semiBold" style={styles.primary}>{workflowName}</Text> : null}
              {openRun(failed?.runId ?? null)}
            </>}
          </View>
        </View>
      );
    } else if (checks.phase === 'passed') {
      body = passedChecks.map(result => {
        const summary = summaries.get(result.runId);
        const duration = summary?.finishedAt == null ? null : formatWorkflowInvocationElapsedLabel({
          startedAt: summary.createdAt, finishedAt: summary.finishedAt,
        });
        return (
          // A passed check's receipt reads at the lead's size with its mark (lab wait-v-apassed), as the waiting check did.
          <View key={actionAutomationTriggerKeyV1(result)} style={styles.lead}
            testID={props.testID ? `${props.testID}:passed` : undefined}>
            {/* Healthy is quiet: the receipt's mark stays ink (lab wait-v-apassed); colour speaks only for a check that needs you. */}
            <Icon name="check-circle" size={ICON_SIZE.sm} color={theme.colors.text.primary} />
            <Text variant="body" style={[styles.primary, styles.leadText]}>
              {t('workflows.triggers.checks.passed', { workflow: nameOf(result) })}
              {duration ? <Text variant="body" style={styles.secondary}>{` · ${duration}`}</Text> : null}
            </Text>
            {openRun(result.runId)}
          </View>
        );
      });
    }
    // One Skip per check: a person's Skip is one consent and one skip notice for the same trigger, so rows are keyed on
    // the trigger identity and the person's own answer (it asks again next time) speaks for it.
    const skipped = new Map<string, string>();
    for (const row of skippedConsents) {
      const key = actionAutomationTriggerKeyV1(row);
      if (!skipped.has(key)) skipped.set(key, t('workflows.triggers.checks.skipped', { workflow: nameOf(row, 'inline') }));
    }
    for (const { notice, reason } of skippedNotices) {
      const key = actionAutomationTriggerKeyV1(notice);
      if (!skipped.has(key)) skipped.set(key, formatAutomaticCheckSkipNotice({
        reason, workflow: nameOf(notice, 'inline'), executionAccountName: props.automaticChecksExecutionAccountName ?? undefined,
      }));
    }
    // R11: the Action proceeds without its checks, and its own card says so (never a dialog).
    for (const notice of checks.notices) {
      if (notice.code !== 'action_automations_not_checked') continue;
      const line = formatAutomationsNotCheckedNotice(notice.reason);
      if (!skipped.has(`not-checked:${line}`)) skipped.set(`not-checked:${line}`, line);
    }
    if (!readApprovalAutomaticChecksShown(checks)) return null;
    return (
      <>
        {body}
        {[...skipped].map(([key, line], index) => (
          <View key={key} style={styles.lead}>
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

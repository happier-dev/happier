import * as React from 'react';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { InvestigationAgentActionButtons } from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { View, type ViewStyle } from 'react-native';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveManagedConfigurationCost } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { ManagedMachineStateRow, type ManagedLifecycleHandlers } from './ManagedMachineStateRow';
import { nativeIdentityLines } from './managedMachineDisplay';
import { canRetryManagedInstallation, currentManagedCreationOperation, describeManagedInstallationFailure, isManagedCreationStateRowVisible, managedCreationSetup, managedCreationState, readManagedInstallationPrompt, type ManagedCreationContext } from './managedCreationPresentation';
import { describeManagedLifecycleState, type ManagedLifecycleState } from './managedLifecyclePresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { isManagedMachineBootstrapIncomplete } from '@/sync/domains/actionOperations/managedMachineOperation';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { describeManagedNativeFailureDiagnostic, describeManagedOperationDiagnostic } from './managedNativeFailurePresentation';
import { confirmSshHostKey } from '@/components/ssh/SshHostKeyTrustSheet';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';

/** Only durable allocation/enrollment observations; task stages are supplied by their operation owner. */
export function ManagedCreationProgress(props: Readonly<{ machine: ManagedMachineV1; handlers?: ManagedLifecycleHandlers;
    provider?: string;
    providerAvailable?: boolean;
    /** The provider's mark, so the resource row reads as what it is. */
    mark?: React.ReactNode;
    /** The controller's name and presence: an offline one is what an unsubmitted creation waits on. */
    controller?: Readonly<{ name: string; online: boolean }>;
    enrolledMachine?: ManagedCreationContext['enrolledMachine'];
    operation?: ActionOperationProjection | null;
    /** D53: a failed Set up recovers on this same machine, or is skipped; never re-acquired. */
    setupRecovery?: Readonly<{ retry?: () => void; skip?: () => void }>;
    /** Answers the installer task's current trust, sign-in or service-replacement question. */
    answerPrompt?: (approved: boolean) => void;
    /** The page's name for this resource (its enrolled Machine's name); the launch name is only what Create was given. */
    title?: string;
    /** Opens the exact Ask the shared executor holds this operation on (Inbox). */
    reviewApproval?: (artifactId: string) => void;
    /** The created-machine list could not be re-read: this is the last answer, and its one freshness says so with Retry. */
    staleRead?: Readonly<{ retry: () => void }>;
    /** Check now is running: its button shows the work until the check settles. */
    checking?: boolean;
    /** Start is running: its button shows the work. */
    starting?: boolean;
    /** The controller's current guest payload differs from the enrolled guest identity. */
    guestPayloadStale?: boolean }>) {
    const { machine } = props;
    const name = props.title ?? machine.launch.name;
    const state = managedCreationState(machine, { controller: props.controller, provider: props.provider,
        providerAvailable: props.providerAvailable, operation: props.operation, enrolledMachine: props.enrolledMachine });
    const lifecycle = describeManagedLifecycleState(state);
    const nothingCreated = state.kind === 'notCreated' || state.kind === 'creationCanceled';
    const checkNow = nothingCreated ? undefined : props.handlers?.checkNow;
    const showStateRow = isManagedCreationStateRowVisible(machine, state, { offersStart: Boolean(props.handlers?.start) });
    const operation = currentManagedCreationOperation(machine, props.operation, props);
    const status = operation ? resolveActionOperationStatus(operation.snapshot, operation.observation) : null;
    const canRetryInstallation = canRetryManagedInstallation(machine, props.operation, props);
    const installationActionLabel = props.guestPayloadStale ? t('common.update') : t('managedMachines.creation.retryInstall');
    const prompt = readManagedInstallationPrompt(operation);
    const trustPrompt = prompt?.kind === 'ssh.trustHost' || prompt?.kind === 'ssh.replaceHostKey' ? prompt : null;
    // A host key is asked in the one trust sheet (lab af-ssh Kp), never inline: the row names the question and opens it.
    const promptMessage = trustPrompt ? trustPrompt.kind === 'ssh.replaceHostKey'
        ? t('addFlows.hostKeyChangedTitle', { host: trustPrompt.host }) : t('addFlows.hostKeyTitle')
        : prompt?.kind === 'daemon.replaceRemoteBackgroundServices' ? t('machine.backgroundServicePrompt.replaceTitle') : prompt?.message;
    const reviewHostKey = trustPrompt && props.answerPrompt ? () => {
        const answer = props.answerPrompt!;
        void confirmSshHostKey({ host: trustPrompt.host, keyType: trustPrompt.keyType, fingerprint: trustPrompt.fingerprint,
            existingFingerprint: trustPrompt.kind === 'ssh.replaceHostKey' ? trustPrompt.existingFingerprint : null }).then(answer);
    } : null;
    const progress = operation?.snapshot.progress;
    // A held Ask is the user's step, not a stage to wait on: say so and open it (QB76 projection).
    const heldAsk = operation?.snapshot.state === 'running' && progress?.kind === 'phase' ? progress.approval ?? null : null;
    const setup = managedCreationSetup(machine);
    // A local machine runs on its controller and never bills; "may bill" would contradict its receipt.
    const mayBill = resolveManagedConfigurationCost({ ...machine.reviewedFacts, provider: props.provider ?? null }).kind !== 'local';
    // Native identity is for finding a resource Happier may have lost; a healthy one is already named by its size and image.
    const needsRecovery = Boolean(machine.recovery) || machine.creationState !== 'active' || machine.allocation === 'may-exist' || Boolean(machine.cleanup);
    const installationRetryOnly = !(operation && status) && canRetryInstallation && Boolean(props.handlers?.reinstall);
    // A Keep wait the operation reports (busy, draining, activity unknown) is the machine's state: its row says it once.
    const observation = machine.observation;
    const bootstrapRunning = operation?.snapshot.state === 'running' && isManagedMachineBootstrapIncomplete(machine);
    // Bootstrap evidence is written during the attempt, before its operation settles.
    const operationTime = (observation?.reason?.startsWith('bootstrap.') ? operation?.snapshot.startedAt : operation?.snapshot.settledAt)
        ?? operation?.snapshot.startedAt ?? operation?.snapshot.createdAt ?? 0;
    // A newer check supersedes the old error; the pre-IO bootstrap marker is not a completed check.
    const newerObservation = !prompt && !heldAsk && !bootstrapRunning && observation
        && (!operation || observation.observedAt > operationTime) ? observation : null;
    const error = !prompt && !heldAsk && !newerObservation ? operation?.snapshot.error : undefined;
    const observationDiagnostic = newerObservation && (newerObservation.reason || newerObservation.nativeCause) ? newerObservation : null;
    const failure = observationDiagnostic ? {
        title: machine.allocation === 'confirmed-absent' ? t('managedMachines.inspect.notCreated')
            : resolveSystemTaskFailureMessage({ code: observationDiagnostic.reason }) ?? t('managedMachines.inspect.checkFailed'),
        detail: describeManagedNativeFailureDiagnostic(observationDiagnostic.reason ?? 'provider_unavailable', observationDiagnostic.nativeCause),
    } : error ? {
        title: nothingCreated ? lifecycle.line
            : describeManagedInstallationFailure(error, operation?.snapshot.progress) ?? t('managedMachines.creation.installFailedTitle', { name }),
        detail: describeManagedOperationDiagnostic(error),
    } : null;
    // A failed install is evidence Investigate can hand to Triage; a newer check's diagnostic has no operation to hand.
    const failedOperation = error && operation?.snapshot.state === 'failed' ? operation : null;
    const operationIsState = STATE_FROM_OPERATION.has(state.kind);
    const operationCard = Boolean(observationDiagnostic) || !operationIsState
        && Boolean(operation && status && status.tone !== 'success' && !(newerObservation && operation.snapshot.error))
        || installationRetryOnly && !(showStateRow && !lifecycle.banner);
    // While the install task tells the story, a quiet creation state would be a second, contradicting card:
    // the task's stage is the state, and the resource's freshness joins its card.
    const operationTells = operationCard && !lifecycle.banner && (QUIET_UNDER_OPERATION.has(state.kind)
        || bootstrapRunning && state.kind === 'observationUnavailable');
    const stateRow = showStateRow && !operationTells;
    const stateRowChecks = stateRow && lifecycle.actions.includes('checkNow') && Boolean(checkNow);
    // Freshness qualifies the state it dates: on the state row's own sheet, or standing alone with Check now or Retry.
    // With neither there is nothing to date and nothing to do, and it stays off the page.
    // A failed re-read is said here too, not in a second "As of" line above the page: one freshness per page.
    const staleRead = props.staleRead;
    // A failure that can't be retried yet carries Check now itself; the freshness row must not offer it twice.
    const failureChecks = Boolean(failure && !stateRowChecks && !(canRetryInstallation && props.handlers?.reinstall) && checkNow);
    const observationChecks = !(stateRowChecks || failureChecks || !checkNow || machine.enrolledMachineId && !failure);
    const observationRow = machine.observation || staleRead ? <Item testID="managed-machine.observation" mode="info" showChevron={false}
        title={machine.observation ? t('surfaceState.asOf', { time: formatAsOfTime(machine.observation.observedAt) })
            : t('managedMachines.detail.loadFailed')}
        subtitle={machine.observation && staleRead ? t('managedMachines.detail.loadFailed') : undefined}
        subtitleLines={0}
        accessoryLayout={staleRead ? 'adaptive' : undefined}
        rightElement={staleRead ? <RoundButton title={t('common.retry')} display="inverted" size="small"
                testID="managed-machine.observation-retry" onPress={staleRead.retry} />
            : !observationChecks ? undefined
            : <RoundButton title={t('managedMachines.inspect.checkNow')} display="inverted" size="small"
                loading={props.checking === true} testID="managed-machine.observation-check" onPress={checkNow} />} /> : null;
    const installationRetry = canRetryInstallation && props.handlers?.reinstall ?
        <RoundButton title={installationActionLabel} display="secondary" size="small"
            testID="managed-machine.installation-retry" onPress={props.handlers.reinstall} /> : undefined;
    const failureAction = canRetryInstallation && props.handlers?.reinstall ? { label: installationActionLabel,
        onPress: props.handlers.reinstall, testID: 'managed-machine.installation-retry' }
        : checkNow && !stateRowChecks ? { label: t('managedMachines.inspect.checkNow'), onPress: checkNow,
            testID: 'managed-machine.installation-check', busy: props.checking === true } : undefined;
    return <>
        {setup?.state === 'failed' ? <ItemGroup>
            <Item title={t('managedMachines.creation.setupFailed', { name: machine.launch.name })} titleLines={0}
                mode="info" showChevron={false}
                testID="managed-machine.setup" accessoryLayout="adaptive"
                rightElement={props.setupRecovery?.retry || props.setupRecovery?.skip ? <View style={setupActions}>
                    {props.setupRecovery.skip ? <RoundButton title={t('managedMachines.creation.skipSetup')} display="inverted" size="small"
                        testID="managed-machine.setup-skip" onPress={props.setupRecovery.skip} /> : null}
                    {props.setupRecovery.retry ? <RoundButton title={t('managedMachines.creation.retrySetup')} display="secondary" size="small"
                        testID="managed-machine.setup-retry" onPress={props.setupRecovery.retry} /> : null}
                </View> : undefined} />
        </ItemGroup> : null}
        {operationCard ? <ItemGroup>
            {/* The task waits on the user here: its own question replaces the stage, with its answer beside it. */}
            {failure ? <SectionContentRow>
                {/* One story: the short cause in the app's words with its recovery; the installer's own message waits behind Details. */}
                {failedOperation ? <FailedInstallationCard operation={failedOperation} title={failure.title} detail={failure.detail}
                    action={failureAction} /> : <SurfaceStateCard kind="error" size="details" layout="inline" title={failure.title}
                    diagnosticCode={failure.detail} testID="managed-machine.installation-error" action={failureAction} />}
            </SectionContentRow> : <Item title={name} subtitle={prompt ? promptMessage : heldAsk ? t('approvals.waitingForYou')
                : status ? describeActionOperationStatusLabel(status.label) : lifecycle.line}
                mode="info" showChevron={false} testID="managed-machine.installation" subtitleLines={prompt ? 0 : undefined}
                accessoryLayout={prompt && props.answerPrompt ? 'adaptive' : undefined}
                subtitleLeading={!prompt && !heldAsk && status?.tone === 'active' ? <ActivitySpinner size="small"
                    accessibilityElementsHidden importantForAccessibility="no" /> : undefined}
                rightElement={heldAsk && props.reviewApproval ? <RoundButton title={t('approvals.review')} display="secondary" size="small"
                    testID="managed-machine.installation-review" onPress={() => props.reviewApproval?.(heldAsk.artifactId)} />
                : reviewHostKey ? <RoundButton title={t('approvals.review')} display="secondary" size="small"
                    testID="managed-machine.installation-prompt-review" onPress={reviewHostKey} />
                : prompt && props.answerPrompt ? <View style={setupActions}>
                    <RoundButton title={t('common.cancel')} display="inverted" size="small"
                        testID="managed-machine.installation-prompt-decline" onPress={() => props.answerPrompt?.(false)} />
                    <RoundButton title={t('common.continue')} size="small"
                        testID="managed-machine.installation-prompt-approve" onPress={() => props.answerPrompt?.(true)} />
                </View> : installationRetry} />}
            {operationTells ? observationRow : null}
        </ItemGroup> : null}
        {/* A blocking or billing-uncertain state is the page's banner, which already says what may bill. */}
        {stateRow && lifecycle.banner ? <ManagedMachineStateRow name={name} mark={null}
            state={state} provider={props.provider} handlers={props.handlers ?? {}} testID="managed-machine.progress" /> : null}
        {stateRow && !lifecycle.banner ? <ItemGroup>
            {/* The page header already names the machine: an ended or canceled one's row leads with its state word. */}
            <ManagedMachineStateRow name={lifecycle.word ?? name}
                mark={props.mark ?? <Icon name="desktop" />}
                state={state} provider={props.provider} handlers={props.handlers ?? {}}
                pendingAction={props.starting ? 'start' : props.checking ? 'checkNow' : undefined}
                ended={machine.allocation === 'confirmed-absent'} testID="managed-machine.progress" />
            {/* Without an operation to report, the install is a step of this same resource, not a second copy of its row. */}
            {installationRetryOnly && !failure ? <Item title={t('managedMachines.creation.install')} mode="info" showChevron={false}
                testID="managed-machine.installation" rightElement={installationRetry} /> : null}
            {mayBill && machine.allocation !== 'confirmed-absent' && (machine.allocation === 'may-exist' || machine.cleanup) ? <Item title={t('managedMachines.creation.mayBill')}
                mode="info" showChevron={false} titleLines={0} testID="managed-machine.possible-cost" /> : null}
            {observationRow}
        </ItemGroup> : observationRow && !operationTells && (staleRead || observationChecks) ? <ItemGroup>{observationRow}</ItemGroup> : null}
        {needsRecovery && (machine.resource || machine.recovery) ? <ItemGroup title={t('managedMachines.detail.recoveryTitle')} testID="managed-machine.recovery">
            {machine.resource ? <Item title={t('managedMachines.detail.nativeIdentity')} mode="info" showChevron={false}
                testID="managed-machine.recovery-native" accessoryLayout="stacked" rightElement={
                    <Text selectable style={styles.identity}>{nativeIdentityLines(machine.resource.value).join('\n')}</Text>
                } /> : null}
            {machine.recovery ? <Item title={t(machine.recovery.reference === machine.id ? 'managedMachines.detail.happierTag' : 'managedMachines.detail.recoveryReference')} mode="info" showChevron={false}
                testID="managed-machine.recovery-tag" accessoryLayout="stacked" rightElement={
                    <Text selectable style={styles.identity}>{machine.recovery.reference}</Text>
                } /> : null}
            {machine.allocation !== 'confirmed-absent' && (machine.cleanup || machine.allocation === 'may-exist')
                && !machine.recovery?.consoleUrl ? <Item title={t('managedCleanup.consoleHelp')} mode="info" showChevron={false}
                    titleLines={0} testID="managed-machine.recovery-manual" /> : null}
        </ItemGroup> : null}
    </>;
}

/**
 * A failed install, in the app's words with its recovery (Retry, else Check now), and Investigate beside it (D5): it
 * hands this exact operation to configured Triage through the Account's one investigation owner.
 */
function FailedInstallationCard(props: Readonly<{
    operation: ActionOperationProjection;
    title: string;
    detail: string | null;
    action: SurfaceStateAction | undefined;
}>) {
    const { serverId, snapshot } = props.operation;
    const subject = React.useMemo(() => ({ kind: 'managedMachineOperation' as const,
        operation: { serverId, machineId: snapshot.scope.machineId, operationId: snapshot.operationId } }),
    [serverId, snapshot.scope.machineId, snapshot.operationId]);
    const investigationOptions = React.useMemo(() => ({ agentActions: 'withDefault' as const,
        externalActionTarget: { kind: 'machine' as const, machineId: snapshot.scope.machineId },
    }), [snapshot.scope.machineId]);
    const investigation = useInvestigateFailure(subject, investigationOptions);
    return <>
        {/* Retry when the failed install is confirmed; while its history can't be read, Check now re-reads it. */}
        <AttentionBanner tone="danger" title={props.title} testID="managed-machine.installation-error"
            details={props.detail ? [props.detail] : undefined}
            action={props.action ? { label: props.action.label, onPress: () => { void props.action?.onPress(); },
                disabled: props.action.disabled, loading: props.action.busy, testID: props.action.testID } : undefined}
            control={<InvestigationAgentActionButtons actions={investigation.actions ?? [{
                label: t('inbox.work.healthNotice.investigate'), launchMode: 'review', startable: true,
            }]} pending={investigation.pending} compact={false}
                onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }} />} />
        {investigation.showOutcome && investigation.outcome ? <InvestigationOutcomeBanner outcome={investigation.outcome} serverId={serverId}
            testID="managed-machine.investigate" onChoosePlacement={investigation.investigateWithPlacement} pending={investigation.pending} /> : null}
    </>;
}

/** Creation states an install task's own stage already says; anything that blocks or may bill still speaks. */
const QUIET_UNDER_OPERATION: ReadonlySet<ManagedLifecycleState['kind']> = new Set(['resourceReady', 'creating', 'creationWaiting', 'notCreated']);
const STATE_FROM_OPERATION: ReadonlySet<ManagedLifecycleState['kind']> = new Set(['busy', 'draining', 'activityUnknown']);

/** A flat native value reads as one fact per line; anything nested keeps its JSON on that line. */
const styles = StyleSheet.create(theme => ({
    identity: { ...Typography.mono(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
}));

const setupActions: ViewStyle = { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' };

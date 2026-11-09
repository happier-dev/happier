import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectNativeRefV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { WidgetGlanceRow } from '@/components/widgets/glance/WidgetGlanceRow';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useProjectCommandOutputOpener } from '@/components/inbox/actionOperations/projectCommandOutputHost';
import { ProjectCommandOutputPane } from '@/components/inbox/actionOperations/ProjectCommandOutputPane';
import { ProjectCommandOutputFrame } from '@/components/inbox/actionOperations/ProjectCommandOutputFrame';
import { WorkerDestinationPicker } from '@/components/projects/workers/WorkerDestinationPicker';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { useManagedWorkerWake } from '@/components/projects/workers/useManagedWorkerWake';
import { describeManagedCreationProgress } from '@/components/settings/machines/managed/managedCreationProgressPresentation';
import type { ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import { resolveMachineDestinationWorkerRefusal, describeMachineDestinationCopySetupAction } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import { readProjectWorkerNoAcceptanceFailureV1, type ProjectWorkerNoAcceptanceFailureDetailsV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { ProjectScriptRunChoice } from './useProjectScriptsController';
import type { ManagedMachineConfigurationContinuation } from '@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers';

import { RowStatusLine } from '@/components/ui/status/RowStatusLine';

import {
  presentProjectRun,
  projectRunStatusTone,
  type ProjectRunPresentation,
} from './projectScriptPresentation';
import { RunClock, RunGlyph } from './ProjectRunMarks';
import { ProjectNativeInvocationDetail } from './ProjectNativeInvocationDetail';

export type ProjectScriptRowProps = Readonly<{
  testID: string;
  workspace: WorkspaceAddressV1;
  name: string;
  /** The source badge ("package.json", "mise"); a literal command has none. */
  badge: string | null;
  /** What runs, as declared: a native target or a literal command. */
  command: string | null;
  nativeSource?: ProjectNativeRefV1;
  accountId?: string | null;
  portable: boolean;
  operation: ActionOperationProjection | null;
  /** Copy for a row that has not run here yet ("Waits for setup", "Not run in this checkout yet"). */
  idleText: string;
  pending: boolean;
  failureCode: string | null;
  /** What the failure says when the script's own environment explains it (plan 24); generic otherwise. */
  failureText?: string | null;
  /** The selected native environment's name: its pending review and preparation say so. */
  toolchainName?: string | null;
  compact: boolean;
  /**
   * The Overview widget's row: drawn with the shared widget glance row like its sibling widgets (run
   * mark, name, how it last went on one line). It has no Run control; a row with a run opens its output.
   */
  glance?: boolean;
  showDivider?: boolean;
  /** Where this checkout sends portable runs by default (its worker preference), for the Run on check. */
  defaultChoice?: ProjectExecutionChoiceV1 | null;
  runChoice?: ProjectScriptRunChoice | null;
  onRunChoiceChange?: (choice: ProjectScriptRunChoice) => void;
  memoryDemand?: ProjectMemoryDemandV1;
  /** The current Run needs an exact target; choosing resumes that intent, not a later Run. */
  choiceRequired?: boolean;
  onChooseForRun?: (choice: ProjectExecutionChoiceV1) => void;
  onDismissChoice?: () => void;
  /** Opens this checkout's Workers settings (Run on › Worker settings…). */
  onOpenWorkerSettings?: () => void;
  /** The typed "no worker can accept" refusal of this row's last Run request, when that is why it did not start. */
  workerRefusal?: ProjectWorkerNoAcceptanceFailureDetailsV1 | null;
  initialManagedConfiguration?: ManagedMachineConfigurationContinuation;
  /** A new machine being created for this row's Run (FX13), with the reviewed recipe's name. */
  managedCreation?: Readonly<{ machineName: string; progress: ManagedMachineCreationProgress }> | null;
  /** Retires the waiting continuation only; the machine resource is left as it is. */
  onCancelManagedRun?: () => void;
  /** Inspects the same acquired resource again and continues the Run when it joins. */
  onResumeManagedRun?: () => void;
  onRun: (choice?: ProjectExecutionChoiceV1, managed?: ManagedMachineSelectionDraft) => void;
}>;

/**
 * One finite script row (lab `s-scripts` row): status glyph, name + source, `what runs · how it
 * went`, the producer's latest output line while it runs, a disclosure chevron, and the joined
 * Run|Stop + target control.
 */
export const ProjectScriptRow = React.memo(function ProjectScriptRow(
  props: ProjectScriptRowProps,
) {
  const { theme } = useUnistyles();
  const phone = useDeviceType() === 'phone';
  const attachment =
    props.operation?.snapshot.domainRef?.kind === 'projectCommand'
      ? props.operation.snapshot.domainRef
      : null;
  const target = useServerScopedMachine(
    attachment?.serverId ?? props.workspace.serverId,
    attachment?.machineId ?? props.workspace.machineId,
  );
  // The checkout's own Machine: "This checkout" in the target menu is the Source, never a past target.
  const source = useServerScopedMachine(props.workspace.serverId, props.workspace.machineId);
  // The actual target, never the operation's custody Machine.
  const targetName = (target ? getMachineSentenceName(target) : null) ?? attachment?.machineId ?? null;
  const presentation = presentProjectRun(props.operation, targetName, props.idleText, props.toolchainName ?? null);
  const stop = useActionOperationStopControl(props.operation);
  // A Run held for the setup review leaves that decision to the Setup card; the row says what it waits for.
  const waitsForSetup = presentation.live && Boolean(props.operation?.snapshot.setupReview);
  const [expanded, setExpanded] = React.useState(false);
  // A failed operation carries the same strict refusal as an immediate Run failure: one parser.
  const operationError = props.operation?.snapshot.error;
  const workerRefusal = props.workerRefusal
    ?? (operationError ? readProjectWorkerNoAcceptanceFailureV1({ ok: false, ...operationError })?.details ?? null : null);
  // "Don't run" puts the banner away; the next Run brings a new refusal back.
  const [refusalDismissed, setRefusalDismissed] = React.useState(false);
  React.useEffect(() => {
    if (props.pending) setRefusalDismissed(false);
  }, [props.pending]);
  // The exact worker this Run went to; while the Run waits, its inventory may say it is waking.
  const [runTarget, setRunTarget] = React.useState<string | null>(null);
  const wakeTargetId = props.pending ? runTarget : null;
  const wakeTarget = useServerScopedMachine(props.workspace.serverId, wakeTargetId ?? '');
  const wake = useManagedWorkerWake(props.workspace.serverId, wakeTargetId);
  const creation = props.managedCreation && props.managedCreation.progress.kind !== 'idle' && props.managedCreation.progress.kind !== 'ready'
    ? props.managedCreation : null;
  const creationPresentation = creation ? describeManagedCreationProgress(creation.machineName, creation.progress) : null;
  const statusText = creationPresentation && !creationPresentation.failed
    ? creationPresentation.label
    : wake === 'starting' && wakeTargetId
    ? `${t('managedWake.starting', { machine: (wakeTarget ? getMachineSentenceName(wakeTarget) : null) ?? wakeTargetId })} · ${t('projectWorkers.scriptStartsWhenReady', { script: props.name })}`
    : workerRefusal
    ? t('projectWorkers.empty')
    : props.failureCode
    ? props.failureText ?? t('projects.scripts.run.refused')
    : stop.pending || stop.stopRequested
      ? t('projects.scripts.run.stopping')
      // A live run an agent started from a Session says so (lab `s-agent` PANE); Stop stays one owner.
      : presentation.live && props.operation?.snapshot.scope.sessionId
        ? `${presentation.text} · ${t('projects.scripts.byAgent')}`
        : waitsForSetup ? t('projects.scripts.run.waitsForSetup') : presentation.text;
  const tone = props.failureCode ? 'danger' : waitsForSetup ? 'quiet' : presentation.tone;
  // Output opens as the host's bottom terminal tab named after the script and its actual Machine
  // (plan 21 §8); hosts without one (phone, widgets) open the operation detail.
  const output = useProjectCommandOutputOpener();
  const openOutput = output.open;
  const outputTitle = targetName ? `${props.name} · ${targetName}` : props.name;
  const openDetail = () => {
    if (props.operation) void openOutput(props.operation, { title: outputTitle, name: props.name, command: props.command });
  };
  // A Run never opens the terminal by itself: the row owns the running state (elapsed time and the
  // producer's latest output line) and the output stays one press away.
  const run = (choice?: ProjectExecutionChoiceV1, managed?: ManagedMachineSelectionDraft) => {
    const target = managed ? null : choice ?? props.defaultChoice ?? null;
    setRunTarget(target?.kind === 'workers' && target.destination.kind === 'machine' ? target.destination.machineId : null);
    props.onRun(choice, managed);
  };
  // Desktop page rows open into their output; phone and compact rows open it directly (the host's
  // bottom terminal tab where it has one, otherwise the operation detail).
  const discloses = (!phone && !props.compact) || Boolean(props.nativeSource && !props.operation);
  // The phone row's press is its disclosure: only the Run control sits right of the status (lab PAGEp).
  const showsCaret = discloses || (!phone && Boolean(props.operation));
  const glyph = props.failureCode ? 'failed' : waitsForSetup ? 'idle' : presentation.glyph;

  if (props.glance) {
    return (
      <WidgetGlanceRow
        testID={props.testID}
        mark={<RunGlyph glyph={glyph} size={ICON_SIZE.sm} />}
        title={props.name}
        fact={statusText || null}
        factTone={tone}
        trailing={presentation.live && presentation.startedAt ? <RunClock startedAt={presentation.startedAt} /> : null}
        onPress={props.operation ? openDetail : null}
      />
    );
  }

  const header = (headerProps?: Readonly<Record<string, unknown>>) => (
    <Item
      {...headerProps}
      testID={props.testID}
      icon={
        <RunGlyph glyph={glyph} />
      }
      title={props.name}
      titleAccessory={
        <RowSource
          badge={props.badge}
          portable={props.portable}
          // The phone row keeps the source badge only; the Run control names where it runs.
          // The phone row keeps the source badge only; the Run control names where it runs.
          compact={props.compact || phone}
        />
      }
      subtitle={
        <View>
          <RowStatusLine
            // Phone rows omit command text but keep their source badge (plan 30 phone composition).
            lead={props.compact || phone ? null : props.command}
            text={statusText}
            tone={projectRunStatusTone(tone)}
            // The row's run glyph already carries the state.
            marked
            numberOfLines={2}
            testID={`${props.testID}.status`}
          />
          {presentation.tail && !props.compact && !phone ? (
            <Text
              testID={`${props.testID}.tail`}
              numberOfLines={1}
              style={[
                styles.meta,
                styles.mono,
                { color: theme.colors.text.tertiary },
              ]}
            >
              {presentation.tail}
            </Text>
          ) : null}
        </View>
      }
      subtitleLines={props.compact ? 1 : 3}
      rightElement={
        <View style={styles.tail}>
          {presentation.live && presentation.startedAt ? (
            <RunClock startedAt={presentation.startedAt} />
          ) : null}
          {showsCaret ? (
            <Icon
              testID={`${props.testID}.caret`}
              name="caret-right"
              size={14}
              color={theme.colors.text.tertiary}
            />
          ) : null}
          <RunControl
            testID={`${props.testID}.run`}
            workspace={props.workspace}
            defaultChoice={props.defaultChoice ?? null}
            runChoice={props.runChoice}
            onRunChoiceChange={props.onRunChoiceChange}
            memoryDemand={props.memoryDemand}
            initialManagedConfiguration={props.initialManagedConfiguration}
            choiceRequired={props.choiceRequired}
            onChooseForRun={props.onChooseForRun}
            onDismissChoice={props.onDismissChoice}
            onOpenWorkerSettings={props.onOpenWorkerSettings}
            name={props.name}
            presentation={presentation}
            portable={props.portable}
            machineName={
              (source ? getMachineSentenceName(source) : null) ??
              props.workspace.machineId
            }
            pending={props.pending || stop.pending || stop.stopRequested}
            canStop={
              presentation.live &&
              props.operation?.snapshot.cancellation === 'supported'
            }
            onRun={run}
            onStop={stop.requestStop}
          />
        </View>
      }
      rightElementOutsidePressable
      accessoryLayout="inline"
      showChevron={false}
      showDivider={props.showDivider}
      {...(!headerProps && props.operation ? { onPress: openDetail } : {})}
    />
  );

  const refusal = workerRefusal && !refusalDismissed ? (
    <NoWorkerBanner
      testID={`${props.testID}.noWorker`}
      refusal={workerRefusal}
      workspace={props.workspace}
      pending={props.pending}
      onRun={run}
      onDismiss={() => setRefusalDismissed(true)}
    />
  ) : null;
  const managedNotice = creation && creationPresentation ? (
    <ManagedCreationNotice
      testID={`${props.testID}.managed`}
      scriptName={props.name}
      machineName={creation.machineName}
      progress={creation.progress}
      presentation={creationPresentation}
      onCancel={props.onCancelManagedRun}
      onResume={props.onResumeManagedRun}
    />
  ) : null;
  const notices = <>{refusal}{managedNotice}</>;

  // A refusal is newer than the run the row still holds; that run's output is history, not what just happened.
  const outputBody = props.failureCode ? null : expanded && props.operation && attachment?.terminalId ? (
    <ProjectCommandOutputPane
      operation={props.operation}
      operationStopPending={stop.pending || stop.stopRequested}
      ownerStatesExit
      title={props.name}
      {...(output.opensInTerminal ? { onOpenInTerminal: openDetail } : { onOpenDetail: openDetail })}
    />
  ) : expanded && !presentation.live ? (
    // A live run without a terminal has said what it is doing in the row; only a run with nothing to read says so.
    <SurfaceStateCard
      size="line"
      kind="empty"
      title={t('projects.scripts.output.empty')}
      testID={`${props.testID}.noOutput`}
    />
  ) : null;

  if (!discloses) return <>{header()}{notices}</>;
  return (
    <>
    <ExpandableItem
      testID={`${props.testID}.disclosure`}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={props.showDivider}
      header={({ headerProps }) =>
        header(headerProps as Readonly<Record<string, unknown>>)
      }
    >
      {expanded && props.nativeSource ? <ProjectNativeInvocationDetail
        workspace={props.workspace} accountId={props.accountId ?? null} source={props.nativeSource}
        usage="script" testID={`${props.testID}.nativeDetail`} /> : null}
      {outputBody ? <ProjectCommandOutputFrame>{outputBody}</ProjectCommandOutputFrame> : null}
    </ExpandableItem>
    {notices}
    </>
  );
});

/**
 * The new machine this Run waits on (FX13, lab `m-pick` creating frames): its latest observed stage,
 * then Cancel, which only stops waiting. After a stop or failure, continuing re-inspects the same
 * resource; nothing is created again or retried by itself.
 */
function ManagedCreationNotice(
  props: Readonly<{
    testID: string;
    scriptName: string;
    machineName: string;
    progress: ManagedMachineCreationProgress;
    presentation: ReturnType<typeof describeManagedCreationProgress>;
    onCancel?: () => void;
    onResume?: () => void;
  }>,
) {
  const stopped = props.progress.kind === 'failed' && props.progress.code === 'continuation_retired';
  const failed = props.presentation.failed;
  return (
    <View style={styles.refusal}>
      <AttentionBanner
        testID={props.testID}
        tone={failed && !stopped ? 'warning' : 'neutral'}
        title={stopped ? t('projectWorkers.creationStopped', { machine: props.machineName }) : props.presentation.label}
        description={failed ? undefined : t('projectWorkers.runWaitsForMachine', { script: props.scriptName, machine: props.machineName })}
        action={failed
          ? props.onResume ? { label: t('projectWorkers.continueWithMachine', { machine: props.machineName }),
              testID: `${props.testID}.resume`, onPress: props.onResume } : null
          : props.onCancel ? { label: t('common.cancel'), testID: `${props.testID}.cancel`, onPress: props.onCancel } : null}
      />
    </View>
  );
}

function describeNoWorkerReason(reason: ProjectWorkerNoAcceptanceFailureDetailsV1['reason']): string {
  switch (reason) {
    case 'empty':
    case 'no_available_machine': return t('projectWorkers.emptyDetail');
    case 'not_accepting': return `${t('projectWorkers.notAccepting')}. ${t('projectWorkers.notAcceptingDetail')}`;
    case 'draining': return t('projectWorkers.draining');
    case 'unsupported': return t('projectWorkers.unsupported');
    case 'forbidden': return t('projectWorkers.accessRefused');
    case 'worker_copy_missing': return t('projectWorkers.copyMissingFact');
    case 'workspace_unavailable': return t('projectWorkers.workspaceUnavailable');
    case 'memory_insufficient': return t('projectWorkers.tooSmallGeneric');
  }
}

/**
 * "No eligible workers" (plan 30 §2 Fallback, lab `s-workers STATES` 8): the run was not accepted by
 * any worker. Nothing falls back by itself: "Run here instead" (offered unless the saved fallback is
 * Don't run) sends a new, explicit primary choice; "Don't run" puts the refusal away and runs nothing.
 * Another machine is picked from the row's own Run on control.
 */
function NoWorkerBanner(
  props: Readonly<{
    testID: string;
    refusal: ProjectWorkerNoAcceptanceFailureDetailsV1;
    workspace: WorkspaceAddressV1;
    pending: boolean;
    onRun: (choice?: ProjectExecutionChoiceV1) => void;
    onDismiss: () => void;
  }>,
) {
  const dontRun = {
    label: t('projectWorkers.fallbackFail'),
    testID: `${props.testID}.dontRun`,
    onPress: props.onDismiss,
  };
  const runHere = props.refusal.unavailable === 'fail' ? null : {
    label: t('projectWorkers.fallbackPrimary'),
    testID: `${props.testID}.runHere`,
    disabled: props.pending,
    onPress: () => props.onRun({ kind: 'primary' }),
  };
  // The chosen Machine has no copy of this checkout yet (31): setting one up is Sync's own creator
  // and approval. It never retries this Run; the next Run is the user's.
  const eligibility = resolveMachineDestinationWorkerRefusal(props.refusal);
  const copyAction = eligibility.reason === 'needs_copy' ? eligibility.action : null;
  const missingCopy = copyAction?.workerCopy;
  const copyTarget = useServerScopedMachine(
    props.workspace.serverId,
    missingCopy?.targetMachineId ?? props.workspace.machineId,
  );
  if (copyAction && missingCopy) {
    const machine = (copyTarget ? getMachineSentenceName(copyTarget) : null) ?? missingCopy.targetMachineId;
    return (
      <View style={styles.refusal}>
        <AttentionBanner
          testID={props.testID}
          tone="neutral"
          title={t('projectWorkers.copyMissing', { machine })}
          action={{
            ...describeMachineDestinationCopySetupAction(copyAction, props.workspace, machine),
            testID: `${props.testID}.setUpCopy`,
          }}
          secondaryAction={runHere ?? dontRun}
          {...(runHere ? { moreActions: [dontRun] } : {})}
        />
      </View>
    );
  }
  return (
    <View style={styles.refusal}>
      <AttentionBanner
        testID={props.testID}
        tone="neutral"
        title={t('projectWorkers.empty')}
        description={describeNoWorkerReason(props.refusal.reason)}
        action={runHere ?? dontRun}
        secondaryAction={runHere ? dontRun : null}
      />
    </View>
  );
}

function RowSource(
  props: Readonly<{
    badge: string | null;
    portable: boolean;
    compact: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  if (!props.badge && !props.portable) return null;
  return (
    <View style={styles.source}>
      {props.badge ? (
        <StatusPill
          variant="neutral"
          label={props.badge}
          hideDot
          labelStyle={styles.mono}
        />
      ) : null}
      {props.portable && !props.compact ? (
        <View style={styles.anyWorker}>
          <Icon name="stack" size={13} color={theme.colors.text.tertiary} />
          <Text style={[styles.meta, { color: theme.colors.text.tertiary }]}>
            {t('projects.scripts.anyWorker')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The joined Run|Stop + target control: Run and Stop share one reserved slot, and on a script that
 * may run on workers the ⌄ half opens "Run <script> on" (plan 30s2/30s3, lab `s-workers RUNON`):
 * the canonical purpose-qualified destination list. Choosing only sets where the next Run goes;
 * it never starts, wakes or allocates anything. Run without a choice follows the checkout's default.
 */
function RunControl(
  props: Readonly<{
    testID: string;
    workspace: WorkspaceAddressV1;
    defaultChoice: ProjectExecutionChoiceV1 | null;
    runChoice?: ProjectScriptRunChoice | null;
    onRunChoiceChange?: (choice: ProjectScriptRunChoice) => void;
    memoryDemand?: ProjectMemoryDemandV1;
    initialManagedConfiguration?: ManagedMachineConfigurationContinuation;
    choiceRequired?: boolean;
    onChooseForRun?: (choice: ProjectExecutionChoiceV1) => void;
    onDismissChoice?: () => void;
    onOpenWorkerSettings?: () => void;
    name: string;
    presentation: ProjectRunPresentation;
    portable: boolean;
    machineName: string;
    pending: boolean;
    canStop: boolean;
    onRun: (choice?: ProjectExecutionChoiceV1, managed?: ManagedMachineSelectionDraft) => void;
    onStop: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View>(null);
  const [open, setOpen] = React.useState(false);
  const choice = props.runChoice?.kind === 'existing' ? props.runChoice.choice : null;
  const managedChoice = props.runChoice?.kind === 'managed' ? props.runChoice.draft : null;
  const pickerOpen = open || props.choiceRequired === true;
  const selected: ProjectExecutionChoiceV1 = choice ?? props.defaultChoice ?? { kind: 'primary' };
  const poolSelection = selected.kind === 'workers' && selected.destination.kind === 'pool'
    ? selected.destination.selection : 'automatic';
  const stopping = props.presentation.live;
  const address = React.useMemo(
    () => ({ serverId: props.workspace.serverId, refId: props.workspace.workspaceId }),
    [props.workspace.serverId, props.workspace.workspaceId],
  );
  const openWorkerSettings = props.onOpenWorkerSettings;
  const dismissChoice = props.onDismissChoice;
  const trailingSections = React.useMemo(
    () => openWorkerSettings
      ? [{
          kind: 'static' as const,
          id: 'worker-settings',
          options: [{
            id: 'worker-settings',
            testID: `${props.testID}.target.settings`,
            label: t('projectWorkers.workerSettings'),
            subtitle: t('projectWorkers.workerSettingsDetail'),
            icon: <Icon name="sliders-horizontal" size={18} color={theme.colors.text.secondary} />,
            onSelect: () => { setOpen(false); dismissChoice?.(); openWorkerSettings(); },
          }],
        }]
      : [],
    [dismissChoice, openWorkerSettings, props.testID, theme.colors.text.secondary],
  );
  const primary = React.useMemo(
    () => ({ title: props.machineName, subtitle: `${t('projectWorkers.primary')} · ${t('projectWorkers.noCopyNeeded')}` }),
    [props.machineName],
  );
  const run = (
    <IconButton
      testID={props.testID}
      variant="plain"
      tone="primary"
      iconName={stopping ? 'stop' : 'play'}
      iconSize={14}
      accessibilityLabel={
        stopping
          ? t('projects.scripts.stopScript', { name: props.name })
          : t('projects.scripts.runScript', { name: props.name })
      }
      disabled={props.pending || (stopping && !props.canStop)}
      onPress={() => (stopping ? props.onStop() : props.onRun(choice ?? undefined, managedChoice ?? undefined))}
    />
  );
  return (
    <View ref={anchorRef} collapsable={false} style={[styles.joined, { borderColor: theme.colors.border.default }]}>
      {run}
      {props.portable ? (
        <>
          <View
            style={[
              styles.joinedDivider,
              { backgroundColor: theme.colors.border.default },
            ]}
          />
          <IconButton
            testID={`${props.testID}.target`}
            variant="plain"
            iconName="caret-down"
            iconSize={12}
            accessibilityLabel={t('projects.scripts.chooseTarget', {
              name: props.name,
            })}
            hasPopup="menu"
            expanded={pickerOpen}
            disabled={stopping || props.pending}
            onPress={() => {
              if (pickerOpen) { setOpen(false); dismissChoice?.(); }
              else setOpen(true);
            }}
          />
          <WorkerDestinationPicker
            testID={`${props.testID}.target.list`}
            open={pickerOpen}
            onRequestClose={() => { setOpen(false); props.onDismissChoice?.(); }}
            anchorRef={anchorRef}
            title={t('projectWorkers.runOn', { name: props.name })}
            purpose="finite"
            workspace={address}
            sourceMachineId={props.workspace.machineId}
            subjectName={props.name}
            memoryDemand={props.memoryDemand}
            primary={primary}
            poolSelection={poolSelection}
            exactTargetOnly={props.choiceRequired}
            presentPoolAsAutomatic={poolSelection === 'automatic' && !props.choiceRequired}
            selected={selected}
            selectedManagedMachine={managedChoice}
            initialManagedConfiguration={props.initialManagedConfiguration}
            onChooseManagedMachine={(draft) => { props.onRunChoiceChange?.({ kind: 'managed', draft }); setOpen(false); }}
            onChoose={(next) => {
              setOpen(false);
              if (props.choiceRequired) props.onChooseForRun?.(next);
              else props.onRunChoiceChange?.({ kind: 'existing', choice: next });
            }}
            trailingSections={trailingSections}
            footer={(
              <View style={styles.footnote}>
                <Icon name="arrow-right" size={14} color={theme.colors.text.tertiary} />
                <Text style={[styles.meta, styles.footnoteText, { color: theme.colors.text.tertiary }]}>
                  {t('projectWorkers.oneWayCopy')}
                </Text>
              </View>
            )}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  tail: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 8,
    flexShrink: 1,
  },
  anyWorker: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
  },
  mono: { ...Typography.mono() },
  joined: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
  },
  footnote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  footnoteText: { flex: 1 },
  refusal: { marginHorizontal: 16, marginBottom: 12 },
  joinedDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    marginVertical: 6,
  },
}));

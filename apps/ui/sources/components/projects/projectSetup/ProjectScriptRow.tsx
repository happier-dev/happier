import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ProjectMemoryDemandV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectMemoryDemandV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useProjectCommandOutputOpener } from '@/components/inbox/actionOperations/projectCommandOutputHost';
import { ProjectCommandOutputPane } from '@/components/inbox/actionOperations/ProjectCommandOutputPane';
import { WorkerDestinationPicker } from '@/components/projects/workers/WorkerDestinationPicker';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { openWorkspaceSyncWorkerCopySetup } from '@/components/workspaces/sync/openWorkspaceSyncAddMachine';
import { openWorkspaceSyncRelationshipDetails } from '@/components/workspaces/sync/openWorkspaceSyncRelationshipDetails';
import { readProjectWorkerNoAcceptanceFailureV1, type ProjectWorkerNoAcceptanceFailureDetailsV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import {
  formatRunClock,
  presentProjectRun,
  type ProjectRunGlyph,
  type ProjectRunPresentation,
} from './projectScriptPresentation';

export type ProjectScriptRowProps = Readonly<{
  testID: string;
  workspace: WorkspaceAddressV1;
  name: string;
  /** The source badge ("package.json", "mise"); a literal command has none. */
  badge: string | null;
  /** What runs, as declared: a native target or a literal command. */
  command: string | null;
  portable: boolean;
  operation: ActionOperationProjection | null;
  /** Copy for a row that has not run here yet ("Waits for setup", "Not run in this checkout yet"). */
  idleText: string;
  pending: boolean;
  failureCode: string | null;
  compact: boolean;
  showDivider?: boolean;
  /** Where this checkout sends portable runs by default (its worker preference), for the Run on check. */
  defaultChoice?: ProjectExecutionChoiceV1 | null;
  memoryDemand?: ProjectMemoryDemandV1;
  /** The current Run needs an exact target; choosing resumes that intent, not a later Run. */
  choiceRequired?: boolean;
  onChooseForRun?: (choice: ProjectExecutionChoiceV1) => void;
  onDismissChoice?: () => void;
  /** Opens this checkout's Workers settings (Run on › Worker settings…). */
  onOpenWorkerSettings?: () => void;
  /** The typed "no worker can accept" refusal of this row's last Run request, when that is why it did not start. */
  workerRefusal?: ProjectWorkerNoAcceptanceFailureDetailsV1 | null;
  onRun: (choice?: ProjectExecutionChoiceV1) => void;
}>;

function RunGlyph(props: Readonly<{ glyph: ProjectRunGlyph }>) {
  const { theme } = useUnistyles();
  if (props.glyph === 'running')
    return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;
  const name =
    props.glyph === 'succeeded'
      ? 'check-circle'
      : props.glyph === 'failed'
        ? 'x-circle'
        : props.glyph === 'queued'
          ? 'hourglass'
          : props.glyph === 'attention'
            ? 'warning-circle'
            : props.glyph === 'stopped'
              ? 'stop-circle'
              : 'circle';
  const color =
    props.glyph === 'failed'
      ? theme.colors.status.error
      : props.glyph === 'attention'
        ? theme.colors.state.attention.foreground
        : theme.colors.text.secondary;
  return <Icon name={name} size={18} color={color} />;
}

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
  const targetName = (target ? getMachineDisplayName(target) : null) ?? attachment?.machineId ?? null;
  const presentation = presentProjectRun(props.operation, targetName, props.idleText);
  const stop = useActionOperationStopControl(props.operation);
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
  const statusText = workerRefusal
    ? t('projectWorkers.empty')
    : props.failureCode
    ? t('projects.scripts.run.refused', { reason: props.failureCode })
    : stop.pending || stop.stopRequested
      ? t('projects.scripts.run.stopping')
      // A live run an agent started from a Session says so (lab `s-agent` PANE); Stop stays one owner.
      : presentation.live && props.operation?.snapshot.scope.sessionId
        ? `${presentation.text} · ${t('projects.scripts.byAgent')}`
        : presentation.text;
  const tone = props.failureCode ? 'danger' : presentation.tone;
  // Output opens as the host's bottom terminal tab named after the script and its actual Machine
  // (plan 21 §8); hosts without one (phone, widgets) open the operation detail.
  const output = useProjectCommandOutputOpener();
  const openOutput = output.open;
  const outputTitle = targetName ? `${props.name} · ${targetName}` : props.name;
  const openDetail = () => {
    if (props.operation) void openOutput(props.operation, { title: outputTitle });
  };
  // A Run started here also opens its tab once that new run has a terminal (lab `s-scripts` RAIL).
  // `previous` is the operation the row showed when Run was pressed; no clock comparison.
  const runRequest = React.useRef<Readonly<{ previous: string | null }> | null>(null);
  const terminalId = attachment?.terminalId ?? null;
  React.useEffect(() => {
    const operation = props.operation;
    const request = runRequest.current;
    if (!operation || !terminalId || !request || operation.snapshot.operationId === request.previous) return;
    runRequest.current = null;
    void openOutput(operation, { title: outputTitle, fallbackToDetail: false });
  }, [openOutput, outputTitle, props.operation, terminalId]);
  // A refused Run has no new operation to open.
  React.useEffect(() => {
    if (props.failureCode || props.workerRefusal) runRequest.current = null;
  }, [props.failureCode, props.workerRefusal]);
  const run = (choice?: ProjectExecutionChoiceV1) => {
    if (output.opensInTerminal) runRequest.current = { previous: props.operation?.snapshot.operationId ?? null };
    props.onRun(choice);
  };
  // Desktop page rows open into their output; phone and compact rows open it directly (the host's
  // bottom terminal tab where it has one, otherwise the operation detail).
  const discloses = !phone && !props.compact;
  const opens = discloses || Boolean(props.operation);

  const header = (headerProps?: Readonly<Record<string, unknown>>) => (
    <Item
      {...headerProps}
      testID={props.testID}
      icon={
        <RunGlyph glyph={props.failureCode ? 'failed' : presentation.glyph} />
      }
      title={props.name}
      titleAccessory={
        <RowSource
          badge={props.badge}
          portable={props.portable}
          compact={props.compact}
        />
      }
      subtitle={
        <View>
          <RowStatus
            // Phone rows omit command text but keep their source badge (plan 30 phone composition).
            command={props.compact || phone ? null : props.command}
            text={statusText}
            tone={tone}
            testID={`${props.testID}.status`}
          />
          {presentation.tail && !props.compact ? (
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
          {opens ? (
            <Icon
              name="caret-right"
              size={14}
              color={theme.colors.text.tertiary}
            />
          ) : null}
          <RunControl
            testID={`${props.testID}.run`}
            workspace={props.workspace}
            defaultChoice={props.defaultChoice ?? null}
            memoryDemand={props.memoryDemand}
            choiceRequired={props.choiceRequired}
            onChooseForRun={props.onChooseForRun}
            onDismissChoice={props.onDismissChoice}
            onOpenWorkerSettings={props.onOpenWorkerSettings}
            name={props.name}
            presentation={presentation}
            portable={props.portable}
            machineName={
              (source ? getMachineDisplayName(source) : null) ??
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

  if (!discloses) return <>{header()}{refusal}</>;
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
      <View
        style={[styles.output, { borderColor: theme.colors.border.subtle }]}
      >
        {expanded && props.operation && attachment?.terminalId ? (
          <ProjectCommandOutputPane
            operation={props.operation}
            title={props.name}
            {...(output.opensInTerminal ? { onOpenInTerminal: openDetail } : { onOpenDetail: openDetail })}
          />
        ) : expanded ? (
          <SurfaceStateCard
            size="line"
            kind="empty"
            title={presentation.live ? presentation.text : t('projects.scripts.output.empty')}
            testID={`${props.testID}.noOutput`}
          />
        ) : null}
      </View>
    </ExpandableItem>
    {refusal}
    </>
  );
});

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
  const missingCopy = props.refusal.reason === 'worker_copy_missing' ? props.refusal.workerCopy ?? null : null;
  const copyTarget = useServerScopedMachine(
    props.workspace.serverId,
    missingCopy?.targetMachineId ?? props.workspace.machineId,
  );
  if (missingCopy) {
    const machine = (copyTarget ? getMachineDisplayName(copyTarget) : null) ?? missingCopy.targetMachineId;
    return (
      <View style={styles.refusal}>
        <AttentionBanner
          testID={props.testID}
          tone="neutral"
          title={t('projectWorkers.copyMissing', { machine })}
          action={{
            label: t('projectWorkers.setUpCopy', { machine }),
            testID: `${props.testID}.setUpCopy`,
            onPress: () => {
              openWorkspaceSyncWorkerCopySetup(props.workspace, props.refusal,
                (summary) => openWorkspaceSyncRelationshipDetails(summary, props.workspace.workspaceId));
            },
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

function RowStatus(
  props: Readonly<{
    command: string | null;
    text: string;
    tone: ProjectRunPresentation['tone'];
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const color =
    props.tone === 'danger'
      ? theme.colors.status.error
      : props.tone === 'attention'
        ? theme.colors.state.attention.foreground
        : theme.colors.text.secondary;
  return (
    <Text
      testID={props.testID}
      numberOfLines={2}
      style={[styles.meta, { color: theme.colors.text.secondary }]}
    >
      {props.command ? (
        <Text
          style={[
            styles.meta,
            styles.mono,
            { color: theme.colors.text.secondary },
          ]}
        >
          {props.command}
        </Text>
      ) : null}
      {props.command ? (
        <Text style={{ color: theme.colors.text.tertiary }}>{' · '}</Text>
      ) : null}
      <Text style={[styles.meta, { color }]}>{props.text}</Text>
    </Text>
  );
}

function RunClock(props: Readonly<{ startedAt: number }>) {
  const { theme } = useUnistyles();
  const seconds = useElapsedTime(props.startedAt);
  return (
    <Text
      style={[styles.meta, styles.clock, { color: theme.colors.text.tertiary }]}
    >
      {formatRunClock(seconds)}
    </Text>
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
    memoryDemand?: ProjectMemoryDemandV1;
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
    onRun: (choice?: ProjectExecutionChoiceV1) => void;
    onStop: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View>(null);
  const [open, setOpen] = React.useState(false);
  // An invocation-only choice: it changes this Run's input, never the saved preference.
  const [choice, setChoice] = React.useState<ProjectExecutionChoiceV1 | null>(null);
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
      iconName={stopping ? 'stop' : 'play'}
      iconSize={14}
      accessibilityLabel={
        stopping
          ? t('projects.scripts.stopScript', { name: props.name })
          : t('projects.scripts.runScript', { name: props.name })
      }
      disabled={props.pending || (stopping && !props.canStop)}
      onPress={() => (stopping ? props.onStop() : props.onRun(choice ?? undefined))}
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
            onChoose={(next) => {
              setOpen(false);
              if (props.choiceRequired) props.onChooseForRun?.(next);
              else setChoice(next);
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

const styles = StyleSheet.create((theme) => ({
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
  clock: { fontVariant: ['tabular-nums'] },
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
  output: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: theme.colors.surface.base,
  },
}));

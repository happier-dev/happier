import * as React from 'react';
import { machineServiceLogReadFailureReason } from '@/components/machines/services/machineServicesPresentation';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1, DeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import type { DeploymentStepV1 } from '@happier-dev/deployments/contracts/v1';

import { formatElapsedDuration } from '@/components/machines/durationWords';
import {
  createNativeLogView,
  NativeLogLines,
  isNativeLogBlank,
} from '@/components/machines/services/MachineServiceLogs';
import { NativeLogToolbar } from '@/components/machines/services/NativeLogToolbar';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist/PlanChecklistCard';
import type {
  PlanChecklistItem,
  PlanChecklistItemStatus,
  PlanChecklistLogEntry,
} from '@/components/systemTasks/planChecklist/types';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Typography } from '@/constants/Typography';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';
import { Modal } from '@/modal';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { t } from '@/text';

import {
  useDeploymentStepLog,
  type DeploymentLogReference,
  type DeploymentReadLogs,
} from './useDeploymentStepLog';
import { useReceiptRead } from './useDeploymentReads';

type Row = Readonly<{ id: string; label: string; step: DeploymentStepV1 | null; log: DeploymentLogReference | null }>;
type Filter = 'all' | 'failed';

const ADMISSION_CODES = new Set([
  'service_admission_unavailable',
  'admission_unavailable',
]);
/** What "Failed only" keeps: the steps the receipt recorded as failed or left unresolved. */
const isFailedStep = (step: DeploymentStepV1) =>
  step.state === 'failed' || step.state === 'outcome_unknown';

/** A receipt's step rows with the log each opens, then the operation logs no step recorded (the whole deploy log). */
function deploymentStepLogRows(
  steps: readonly DeploymentStepV1[],
  facts: DeploymentReceiptFactsV1,
  machineId: string | undefined,
  machineNames: Readonly<Record<string, string>>,
): readonly Row[] {
  const recorded: Row[] = steps.map((step) => ({
    id: step.id,
    label: step.label,
    step,
    log:
      facts.steps.find(
        (candidate) =>
          candidate.id === step.id && candidate.machineId === machineId,
      )?.stageLogs[0]?.reference ?? null,
  }));
  return [...recorded, ...facts.logs.filter(({ reference }) =>
    (machineId === undefined || reference.machineId === machineId) &&
    // A step without its own stage log has no reference to match; a platform log carries no Machine.
    !recorded.some(({ log }) => log !== null && log.machineId === reference.machineId && log.installationId === reference.installationId),
  ).map(({ reference }) => ({ id: `build-log.${reference.machineId}.${reference.installationId}`,
    // Beside steps it is the whole deploy log; with no steps, sibling logs differ only by their Machine.
    label: recorded.length > 0 || facts.placement === 'platform' ? t('projects.deployments.deployLog')
      : reference.machineId ? machineNames[reference.machineId] ?? t('projects.deployments.aMachine')
        : t('projects.deployments.deployLog'),
    step: null, log: reference }))];
}

/** The log a receipt opens by itself: the running step's while it runs, the failed step's after, else a stepless log. */
function automaticStepLogRow(rows: readonly Row[], running: boolean, stepless: boolean): Row | undefined {
  return rows.find(
    (row) =>
      row.log &&
      (row.step ? (running ? row.step.state === 'running' : isFailedStep(row.step)) : stepless),
  );
}

const NO_MACHINE_NAMES: Readonly<Record<string, string>> = {};

/**
 * The live log band on the Environment's deploy card (lab siaR3 Q8 `r3-log`): the newest lines of the log the receipt
 * opens by itself (the running step's, following while it grows; the failed step's after), on the inset band, full
 * bleed. When no step recorded its own log, the whole deploy log stands in. Its states (reading, refused, offline,
 * empty) are the step log's own; the whole log with Find, copy and download is the receipt's, one press away.
 */
export function DeploymentLogBand(
  props: Readonly<{
    testID: string;
    serverId: string;
    steps: readonly DeploymentStepV1[];
    facts: DeploymentReceiptFactsV1;
    running: boolean;
    readLogs: DeploymentReadLogs | null;
    /** The newest lines it holds. */
    lines: number;
    /** The card is presented (mounted, visible, focused): only then does a running log follow. */
    active: boolean;
    /** Where the band sits in its card (full bleed), applied only when there is a log to show. */
    style?: StyleProp<ViewStyle>;
  }>,
) {
  const { facts, steps } = props;
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(props.serverId);
  const rows = React.useMemo(() => deploymentStepLogRows(steps, facts, undefined, NO_MACHINE_NAMES), [facts, steps]);
  const open = automaticStepLogRow(rows, props.running, steps.length === 0)
    ?? rows.find((row) => row.step === null && row.log) ?? null;
  const view = React.useMemo(() => createNativeLogView(), [open?.id]);
  const logs = useDeploymentStepLog({
    serverId: props.serverId,
    lifetime,
    reference: open?.log ?? null,
    readLogs: props.readLogs,
    followable: props.running && open !== null && (open.step === null || open.step.state === 'running'),
    active: props.active && open !== null,
    fileName: `deploy-${open?.log?.deploymentId ?? ''}-${open?.id ?? 'step'}.log`,
    view,
    surfaceId: `deployment-log-band:${open?.log?.deploymentId ?? ''}:${open?.id ?? ''}`,
    containsFocus: alwaysFalse,
    isInputFocused: alwaysFalse,
  });
  if (!open || !props.readLogs) return null;
  return (
    <View testID={props.testID} style={[styles.band, props.style]}>
      <StepLogBody testID={props.testID} logs={logs} machineName={null} offlineLogMachine={null} tail={props.lines} />
    </View>
  );
}

const alwaysFalse = () => false;

/**
 * The band for a deploy the Environment card carries: that deploy's own receipt lease (the one its receipt page and
 * the Logs companion read), mounted only while the card shows it, so an idle Overview reads nothing more.
 */
export function DeploymentReceiptLogBand(
  props: Readonly<{
    testID: string;
    serverId: string;
    controller: DeploymentReadControllerV1;
    environmentId: string;
    deploymentId: string;
    demand: DeploymentReadDemandV1;
    running: boolean;
    readLogs: DeploymentReadLogs | null;
    lines: number;
    style?: StyleProp<ViewStyle>;
  }>,
) {
  const value = useReceiptRead(props.controller, props.environmentId, props.deploymentId, props.demand).snapshot.value;
  if (!value?.content) return null;
  const { content } = value;
  return (
    <DeploymentLogBand testID={props.testID} serverId={props.serverId} facts={value.facts}
      steps={content.steps.length > 0 ? content.steps : (content.machineResults[0]?.steps ?? NO_STEPS)}
      running={props.running} readLogs={props.readLogs} lines={props.lines}
      active={props.demand.mounted && props.demand.visible && props.demand.focused} style={props.style} />
  );
}

const NO_STEPS: readonly DeploymentStepV1[] = [];

/**
 * A receipt's steps with their own logs (lab d3 `live|failed`): each step that recorded a stage-log ref opens into
 * its masked log. One log is open at a time, so Find, copy, download and Follow above the steps always act on the
 * log you are reading. While the deploy runs, the running step opens itself and follows until you pick another;
 * a failed receipt opens its failed step. Steps without refs stay plain rows. Operation log references without
 * corresponding step entries open the same viewer. A receipt that recorded no steps is its log: the section is the
 * deploy log, the first log opens on arrival, and a lone log shows with no row to open it.
 */
export function DeploymentStepLogs(
  props: Readonly<{
    testID: string;
    title: string;
    machineName: string;
    /** Machine names by id, for the rows of a receipt that recorded several logs and no steps. */
    machineNames: Readonly<Record<string, string>>;
    /** What happened on this Machine (restored, its health), when the receipt has several. */
    outcome?: string;
    /** The Machine whose results these steps are, or undefined for the deployment's own step list. */
    machineId: string | undefined;
    steps: readonly DeploymentStepV1[];
    facts: DeploymentReceiptFactsV1;
    /** The receipt is still running: a running step's log can grow and be followed. */
    running: boolean;
    followLog?: boolean;
    serverId: string;
    readLogs: DeploymentReadLogs | null;
    fileStem: string;
  }>,
) {
  useUnistyles();
  const { facts, machineId, steps, machineNames } = props;
  const stepless = steps.length === 0;
  // The follow Resource binds to this Home's current Account, as every native log read does.
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(props.serverId);
  const rows = React.useMemo(() => deploymentStepLogRows(steps, facts, machineId, machineNames),
    [facts, machineId, steps, machineNames]);
  const hasFailed = rows.some((row) => row.step && isFailedStep(row.step));
  const [filter, setFilter] = React.useState<Filter>('all');
  // Undefined until the person picks: the open log then follows the receipt (the running or failed step).
  const [chosen, setChosen] = React.useState<string | null | undefined>(
    undefined,
  );
  // With no steps recorded, the first log is the page's content and opens on arrival.
  const automatic = automaticStepLogRow(rows, props.running, stepless);
  const openId = chosen === undefined ? (automatic?.id ?? null) : chosen;
  const open = rows.find((row) => row.id === openId && row.log) ?? null;
  const machineName = facts.placement === 'machine' ? props.machineName : null;
  const logMachineId = machineName !== null && props.readLogs ? open?.log?.machineId : undefined;
  const [logMachine] = useMachinePresenceSummaries(props.serverId, logMachineId ? [logMachineId] : [], lifetime);
  const offlineLogMachine = logMachine?.presenceOnline === false
    ? logMachine.sentenceName ?? (logMachineId ? machineNames[logMachineId] : undefined) ?? machineName
    : null;
  const visible =
    filter === 'failed' && hasFailed
      ? rows.filter((row) => row.step && isFailedStep(row.step))
      : rows;
  const followable = props.running && props.followLog !== false && open !== null && (open.step === null || open.step.state === 'running');

  const view = React.useMemo(() => createNativeLogView(), [openId]);
  const root = React.useRef<View>(null);
  const inputFocused = React.useRef(false);
  const containsFocus = React.useCallback(() => {
    if (Platform.OS !== 'web') return true;
    const node = root.current as unknown as HTMLElement | null;
    return Boolean(
      node &&
      typeof document !== 'undefined' &&
      document.activeElement &&
      node.contains(document.activeElement),
    );
  }, []);
  const isInputFocused = React.useCallback(() => inputFocused.current, []);
  const logs = useDeploymentStepLog({
    serverId: props.serverId,
    lifetime,
    reference: open?.log ?? null,
    readLogs: props.readLogs,
    followable,
    active: open !== null,
    fileName: `${props.fileStem}-${open?.id ?? 'step'}.log`,
    view,
    surfaceId: `deployment-step-log:${open?.log?.deploymentId ?? ''}:${openId ?? ''}`,
    containsFocus,
    isInputFocused,
  });
  const viewer = logs.viewer;
  const shared = viewer?.findRegistration ?? null;
  const registration = React.useMemo(
    () =>
      shared
        ? {
            ...shared,
            containsTarget: (target: unknown) =>
              isFindSurfaceTarget(
                root.current as unknown as Element | null,
                target,
              ),
          }
        : null,
    [shared],
  );
  useFindSurfaceRegistration(registration);
  const findOpen = viewer?.findSnapshot.isOpen === true;
  const filterTabs = React.useMemo(
    (): ReadonlyArray<SegmentedTab<Filter>> => [
      { id: 'all', label: t('projects.deployments.allSteps') },
      { id: 'failed', label: t('projects.deployments.failedOnly') },
    ],
    [],
  );

  // A receipt with no steps and one log is that log: no row to open, nothing else to choose.
  const lone = stepless && rows.length === 1 ? rows[0]! : null;
  const download = async () => {
    const outcome = await logs.download();
    if (outcome === 'failed')
      Modal.alert(
        t('common.error'),
        t('projects.deployments.stepLogSaveFailed'),
      );
  };
  const renderLog = React.useCallback(
    () => <StepLogBody testID={props.testID} logs={logs} machineName={machineName} offlineLogMachine={offlineLogMachine} />,
    [logs, machineName, props.testID, offlineLogMachine],
  );
  const checklist = React.useMemo(() => ({
    items: visible.map((row): PlanChecklistItem => ({
      ...(row.step ? stepChecklistItem(row.step) : { id: row.id, satisfied: false, disabled: true }),
      id: row.id,
      title: row.label,
      ...(row.log ? { renderDetails: renderLog } : {}),
    })),
    execution: Object.fromEntries(visible.flatMap((row) => row.step ? [[row.id, stepExecution(row.step, props.running)]] : [])),
  }), [visible, renderLog, props.running]);
  if (!props.readLogs || !rows.some((row) => row.log)) {
    // A receipt that recorded no steps and no log has nothing here: the block is left out (lab d3).
    if (steps.length === 0) return null;
    return (
      <ItemGroup
        testID={props.testID}
        title={props.title}
        description={props.outcome ?? machineName ?? undefined}
        surface="none"
      >
        <StepRows steps={steps} running={props.running} />
      </ItemGroup>
    );
  }
  return (
    <View ref={root} style={styles.section}>
      <ItemGroup
        testID={props.testID}
        title={stepless ? t('projects.deployments.deployLog') : props.title}
        description={machineName === null ? props.outcome : [
          props.outcome,
          t(stepless ? 'projects.deployments.logWhole' : 'projects.deployments.stepLogsDescription', { machine: machineName }),
        ].filter(Boolean).join(' · ')}
        surface="none"
      >
        <NativeLogToolbar
          findOpen={findOpen}
          viewer={viewer}
          testID={`${props.testID}.toolbar`}
          partTestID={(part) => `${props.testID}.${part === 'save' ? 'download' : part}`}
          inputFocused={inputFocused}
          filter={hasFailed ? (
            <SegmentedTabBar
              tabs={filterTabs}
              activeTabId={filter}
              onSelectTab={setFilter}
              testIDPrefix={`${props.testID}.filter`}
              compact
              segmentSizing="content"
              role="radiogroup"
            />
          ) : null}
          follow={followable ? { on: logs.follow, toggle: () => logs.setFollow((value) => !value) } : null}
          navigation={followable ? logs.navigation : null}
          onCopy={() => {
            void logs.copyLoaded();
          }}
          copyDisabled={logs.index === null}
          onSave={() => {
            void download();
          }}
          saveDisabled={open === null}
        />
      </ItemGroup>
      {lone ? (
        <ItemGroup header="none" testID={`${props.testID}.list`}>
          <View style={styles.lone}>
            {renderLog()}
          </View>
        </ItemGroup>
      ) : (
        // The canonical execution checklist (Plan 40): each step's state and duration, and the open step's
        // native log in the row's own details slot. A row without a log ref of its own has nothing to open.
        // The group gives the card the page column's inset, as every other checklist consumer has.
        <ItemGroup header="none" surface="none">
          <PlanChecklistCard
            testID="project-deployments.receipt.step"
            items={checklist.items}
            phase="execute"
            selectedIds={NO_IDS}
            executionById={checklist.execution}
            expandedIds={open ? [open.id] : NO_IDS}
            onToggleExpanded={(id) => {
              if (rows.some((row) => row.id === id && row.log)) setChosen(open?.id === id ? null : id);
            }}
          />
        </ItemGroup>
      )}
    </View>
  );
}

const NO_IDS: readonly string[] = [];
const NO_LOG_ENTRIES: readonly PlanChecklistLogEntry[] = [];

/** A deploy step's state in the checklist's own vocabulary. */
function checklistStatus(step: DeploymentStepV1, running: boolean): PlanChecklistItemStatus {
  switch (step.state) {
    case 'pending':
      return 'queued';
    case 'running':
      // Retained step records cannot keep activity alive after the receipt has settled.
      return running ? 'running' : 'idle';
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'error';
    case 'skipped':
    case 'cancelled':
    case 'outcome_unknown':
      return 'idle';
  }
}

/** One recorded step as a checklist row: its label, its duration, and a word for states without a glyph. */
function stepChecklistItem(step: DeploymentStepV1): PlanChecklistItem {
  return {
    id: step.id,
    title: step.label,
    subtitle: stepStateNote(step),
    badge: step.durationMs !== undefined ? formatElapsedDuration(step.durationMs) : undefined,
    satisfied: false,
    disabled: true,
  };
}

function stepExecution(step: DeploymentStepV1, running: boolean) {
  return { status: checklistStatus(step, running), logs: NO_LOG_ENTRIES };
}

/** The states the checklist has no glyph of its own for say themselves under the step. */
function stepStateNote(step: DeploymentStepV1): string | undefined {
  if (step.state === 'cancelled') return t('projects.deployments.stateCancelled');
  if (step.state === 'outcome_unknown') return t('projects.deployments.stateUnknown');
  return undefined;
}

/** The open step's log in its states: reading, refused, changed, stale but retained, empty, or its lines. */
function StepLogBody(
  props: Readonly<{
    testID: string;
    logs: ReturnType<typeof useDeploymentStepLog>;
    machineName: string | null;
    offlineLogMachine: string | null;
    /** The deploy card's band: only the newest lines, no scroll. */
    tail?: number;
  }>,
) {
  const { logs, machineName } = props;
  const id = `${props.testID}.log`;
  const projection = logs.projection;
  const retry = {
    label: t('common.retry'),
    onPress: () => {
      void logs.readAgain();
    },
  };
  if (projection?.kind === 'unavailable') {
    return (
      <View style={styles.body}>
        <SurfaceStateCard
          testID={`${id}.unavailable`}
          kind={projection.reason === 'denied' ? 'denied' : 'unavailable'}
          size="line"
          title={
            machineName === null
              ? t('machineServices.logs.error.title')
              : projection.reason === 'admission_unavailable'
              ? t('projects.deployments.stepLogAdmission', {
                  machine: machineName,
                })
              : t(`machineServices.logs.unavailable.${projection.reason}`, {
                  machine: machineName,
                })
          }
          diagnosticCode={projection.reason}
          action={retry}
        />
      </View>
    );
  }
  const viewer = logs.viewer;
  if (!logs.index || !viewer) {
    const first = logs.first;
    let state: React.ReactNode;
    if (props.offlineLogMachine !== null) {
      state = <SurfaceStateCard testID={`${id}.offline`} kind="unavailable" size="line"
        title={t('machineServices.logs.needMachineOnline', { machine: props.offlineLogMachine })} />;
    } else if (first.kind === 'failed') {
      state = ADMISSION_CODES.has(first.error.code) ? (
        <SurfaceStateCard
          testID={`${id}.unavailable`}
          kind="unavailable"
          size="line"
          title={machineName === null ? t('machineServices.logs.error.title')
            : t('projects.deployments.stepLogAdmission', { machine: machineName })}
          diagnosticCode={first.error.code}
          action={retry}
        />
      ) : (
        <SurfaceStateCard
          testID={`${id}.error`}
          kind="error"
          size="line"
          title={t('machineServices.logs.error.title')}
          reason={machineName === null ? undefined : machineServiceLogReadFailureReason(first.error, machineName)}
          diagnosticCode={first.error.code}
          action={retry}
        />
      );
    } else if (first.kind === 'approval') {
      state = (
        <SurfaceStateCard
          testID={`${id}.approval`}
          kind="warning"
          size="line"
          title={t('machineServices.logs.approval')}
        />
      );
    } else if (projection?.kind === 'sourceChanged') {
      state = <SourceChanged testID={id} onReadAgain={logs.readAgain} />;
    } else {
      state = (
        <SurfaceStateCard
          testID={`${id}.reading`}
          kind="loading"
          size="line"
          title={t('machineServices.logs.reading')}
        />
      );
    }
    return <View style={props.tail !== undefined ? styles.bandBody : styles.body}>{state}</View>;
  }
  // The card's band only ever holds the newest lines: saying earlier ones are missing would be noise there.
  const truncated = props.tail === undefined && projection?.kind === 'index' && projection.truncated;
  return (
    <View style={props.tail !== undefined ? styles.bandBody : styles.body} testID={id}>
      {projection?.kind === 'sourceChanged' ? (
        <SourceChanged testID={id} onReadAgain={logs.readAgain} />
      ) : logs.stale ? (
        <SurfaceFreshnessLine
          testID={`${id}.stale`}
          asOf={logs.first.kind === 'read' ? logs.first.readAt : null}
          tone="warning"
          reason={machineName === null ? '' : t('machineServices.logs.stale', { machine: machineName })}
          busy={
            logs.followed?.pending !== undefined &&
            logs.followed.pending !== 'idle'
          }
          action={{
            label: t('common.retry'),
            onPress: () => {
              void logs.followed?.refresh();
            },
          }}
        />
      ) : null}
      {truncated ? (
        <Text style={styles.note} testID={`${id}.truncated`}>
          {t('machineServices.logs.truncated')}
        </Text>
      ) : null}
      {isNativeLogBlank(viewer.lines) ? (
        <SurfaceStateCard
          testID={`${id}.empty`}
          kind="empty"
          size="line"
          title={t('projects.deployments.stepLogEmpty')}
        />
      ) : (
        <NativeLogLines
          testID={`${id}.lines`}
          lines={viewer.lines}
          getLineRanges={viewer.getLineRanges}
          revealedLine={viewer.viewState?.revealedLine ?? null}
          navigation={logs.navigation}
          {...(props.tail !== undefined ? { tail: props.tail } : {})}
        />
      )}
    </View>
  );
}

function SourceChanged(
  props: Readonly<{ testID: string; onReadAgain: () => void | Promise<void> }>,
) {
  return (
    <SurfaceStateCard
      testID={`${props.testID}.sourceChanged`}
      kind="warning"
      size="line"
      title={t('projects.deployments.stepLogRestarted')}
      action={{
        label: t('machineServices.logs.readAgain'),
        onPress: () => {
          void props.onReadAgain();
        },
      }}
    />
  );
}

/** The plain step list, for receipts whose steps recorded no log refs of their own (never empty). */
export const StepRows = React.memo(function StepRows(
  props: Readonly<{ steps: readonly DeploymentStepV1[]; running: boolean }>,
) {
  return (
    <PlanChecklistCard
      testID="project-deployments.receipt.step"
      items={props.steps.map(stepChecklistItem)}
      phase="execute"
      selectedIds={NO_IDS}
      executionById={Object.fromEntries(props.steps.map((step) => [step.id, stepExecution(step, props.running)]))}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.space.s8 },
  body: {
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s12,
  },
  note: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  // Without a disclosure row above it, the log keeps the same inset on every edge.
  lone: { paddingTop: theme.space.s12 },
  // The card's floor (lab siaR3 `r3-log`): the inset surface edge to edge under the strip.
  band: { backgroundColor: theme.colors.surface.inset },
  bandBody: { gap: theme.space.s8, paddingHorizontal: PAGE_LIST_METRICS.cardPaddingPx, paddingVertical: theme.space.s12 },
}));

import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CompositionStrip } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineProcessesAnswerV1,
  OwnerRowV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { VoiceTrackedSessionAddressV1Schema } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { buildProcessesSummaryRows } from '@/components/machines/processes/processesCollectionAnatomy';
import { useProcessOwnerTitles } from '@/components/machines/processes/processOwnerIdentity';
import {
  buildMachineProcessesView,
  selectMachineProcessesTotals,
  type ProcessesItem,
  type ProcessesOwnerItem,
  type ProcessesSort,
} from '@/components/machines/processes/processesPresentation';
import {
  useProcessesController,
  type ProcessesController,
} from '@/components/machines/processes/useProcessesController';
import { COMPOSITION_INK } from '@/components/machines/vitals/MemoryTile';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import {
  readCoarsePrimaryPointer,
  useRowActionHoverHost,
} from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { withUsageAccentAlpha } from '@/components/settings/usage/usageAccent';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import type { MachineProcessesActionScope } from '@/sync/domains/machines/processes/machineProcessesActions';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { useSession } from '@/sync/store/hooks';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';

import {
  MachineProcessesHero,
  MachineProcessesWidgetGate,
  MachineProcessesWidgetRows,
  MachineWidgetSectionLabel,
  machineMemoryHeroParts,
  readMachineProcessesWidgetAnswer,
  readMachineProcessesWidgetFreshness,
} from './machineProcessesWidgetParts';
import {
  MachineWidgetColumn,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  useMachineWidgetFreshness,
  useMachineWidgetMachine,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetTarget,
} from './machineWidgetKit';

const BY_MEMORY: ProcessesSort = { key: 'memory', direction: 'descending' };
/** How many owners each size has room for (lab `rw` C); Tall and Large list them all. */
const OWNER_ROWS: Readonly<Record<WidgetSizeV1, number | undefined>> = {
  small: 3,
  wide: 3,
  medium: 6,
  full: 6,
  tall: undefined,
  large: undefined,
};
/** Session states in which a stop interrupts work or a question: asked in place once (R16, AGW-18). */
const WORKING_STATES: ReadonlySet<string> = new Set([
  'thinking',
  'action_required',
  'permission_required',
  'pending_input',
  'background_active',
]);
const NOOP = () => {};

/**
 * "Using the most" (plan 60 EU-6, lab `rw` C): Happier's own work on one machine by what started it — the
 * Processes tab's rows and totals from plan 30's one process store. Stop is offered only for what wakes or
 * restarts on demand (a service, the browser, a session that resumes on the next message) through the tab's
 * own controller and `machines.processes.stop` (approval is that Action's own setting, R41), with the way back
 * on the row and in the presentation notice. Destructive kills stay in the tab.
 */
export function MachineTopConsumersWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  if (!target)
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.common.unknownMachine')}
        testID={props.testID}
      />
    );
  return (
    <TopConsumersBody
      target={target}
      sessionId={readSessionScope(props.input)}
      testID={props.testID}
    />
  );
}

function readSessionScope(
  input: MachineWidgetBodyProps['input'],
): string | null {
  if (input.scope !== 'session') return null;
  const session = VoiceTrackedSessionAddressV1Schema.safeParse(input.session);
  return session.success ? session.data.sessionId : null;
}

function ownerSessionId(owner: OwnerRowV1['owner']): string | null {
  return 'sessionId' in owner && typeof owner.sessionId === 'string'
    ? owner.sessionId
    : null;
}

/** A Companion's "This session": only the owners that session started (its runner, services and terminals). */
function scopeAnswer(
  answer: MachineProcessesAnswerV1 | null,
  sessionId: string | null,
): MachineProcessesAnswerV1 | null {
  if (!answer || !sessionId) return answer;
  return {
    ...answer,
    owners: answer.owners.filter(
      (owner) => ownerSessionId(owner.owner) === sessionId,
    ),
  };
}

function isStoppable(item: ProcessesItem): item is ProcessesOwnerItem {
  if (item.kind !== 'owner' || !item.rootRef) return false;
  const kind = item.owner.owner.kind;
  return kind === 'session' || kind === 'service' || kind === 'browser_sidecar';
}

function TopConsumersBody(
  props: Readonly<{
    target: MachineWidgetTarget;
    sessionId: string | null;
    testID: string;
  }>,
) {
  const { target, testID } = props;
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(target);
  const processes = useMachineProcesses({
    serverId: target.serverId,
    machineId: target.machineId,
    scope: 'happier',
    view: 'owners',
    enabled: facts.online === true,
  });
  useMachineWidgetFreshness(
    readMachineProcessesWidgetFreshness(processes, facts.online),
    testID,
  );
  const answer = readMachineProcessesWidgetAnswer(processes);
  const scoped = React.useMemo(
    () => scopeAnswer(answer, props.sessionId),
    [answer, props.sessionId],
  );
  const titles = useProcessOwnerTitles(scoped?.owners, target.serverId);
  const summary = useMachineResourceSummary(target);
  const memory =
    summary?.kind === 'reporting' ? (summary.summary?.memory ?? null) : null;
  const cpuBusy =
    summary?.kind === 'reporting'
      ? (summary.summary?.cpu.busyPct ?? null)
      : null;
  const binding = processes.accountBinding;
  const isCurrent = React.useCallback(
    () => Boolean(binding?.isCurrent()),
    [binding],
  );
  const stale = answer !== null && processes.status === 'error';
  const unavailableReason = facts.online === null ? t('common.unknown') : facts.online === false
    ? t('machineProcesses.states.offlineTitle', { machine: facts.name })
    : stale
      ? t('machineProcesses.menu.unavailable', { machine: facts.name })
      : null;
  const controller = useProcessesController({
    serverId: target.serverId,
    machineId: target.machineId,
    machineName: facts.name,
    answer,
    titles,
    expectedAccountId: binding?.accountId ?? null,
    isCurrent,
    unavailableReason,
    focusAfter: NOOP,
  });
  useStopNotice(controller, target.machineId);
  const open = useOpenMachinePage(target);
  const openProcesses = React.useCallback(
    () => open({ id: 'processes', sort: 'memory' }),
    [open],
  );
  const [confirming, setConfirming] = React.useState<((accepted: boolean) => void) | null>(null);
  const pendingConfirmation = React.useRef<((accepted: boolean) => void) | null>(null);
  React.useEffect(() => () => pendingConfirmation.current?.(false), []);
  const requestStopConfirmation = React.useCallback<NonNullable<MachineProcessesActionScope['confirmation']>>(
    ({ context }) => new Promise<boolean>((resolve) => {
      pendingConfirmation.current?.(false);
      if (context.signal?.aborted) { resolve(false); return; }
      const settle = (accepted: boolean) => {
        context.signal?.removeEventListener('abort', onAbort);
        if (pendingConfirmation.current === settle) {
          pendingConfirmation.current = null;
          setConfirming(null);
        }
        resolve(accepted);
      };
      const onAbort = () => settle(false);
      pendingConfirmation.current = settle;
      context.signal?.addEventListener('abort', onAbort, { once: true });
      setConfirming(() => settle);
    }),
    [],
  );
  const accessory = React.useCallback(
    (item: ProcessesItem) =>
      isStoppable(item) && !unavailableReason ? (
        <StopAccessory
          item={item}
          serverId={target.serverId}
          controller={controller}
          onConfirm={requestStopConfirmation}
          testID={testID}
        />
      ) : null,
    [controller, requestStopConfirmation, target.serverId, testID, unavailableReason],
  );

  const wideTable = size === 'large';
  const items = React.useMemo(
    () =>
      scoped
        ? buildMachineProcessesView({
            answer: scoped,
            scope: 'happier',
            sort: BY_MEMORY,
            ownersOnly: true,
            ...(OWNER_ROWS[size] !== undefined
              ? { limit: OWNER_ROWS[size] }
              : {}),
            ownerTitle: (owner) => titles.get(owner.rowId) ?? null,
            hidden: controller.hidden,
          }).items
        : [],
    [controller.hidden, scoped, size, titles],
  );
  const happierBytes = React.useMemo(() => {
    if (!scoped) return null;
    const bytes = props.sessionId
      ? scoped.owners.reduce<number | null>(
          (sum, owner) =>
            sum === null || owner.totals.memoryBytes === null
              ? null
              : sum + owner.totals.memoryBytes,
          0,
        )
      : scoped.totals.happier.memoryBytes;
    // The hero counts down by what a stop gave back before the next sample measures it.
    return bytes === null
      ? null
      : Math.max(0, bytes - controller.pendingFreedBytes);
  }, [controller.pendingFreedBytes, props.sessionId, scoped]);
  const usedMemory =
    memory && memory.totalBytes !== null && memory.availableBytes !== null
      ? memory.totalBytes - memory.availableBytes
      : null;
  const summaryRows = React.useMemo(
    () =>
      wideTable && scoped && !props.sessionId
        ? buildProcessesSummaryRows({
            totals: selectMachineProcessesTotals(scoped, {
              usedMemoryBytes: usedMemory,
              cpuBusyPercent: cpuBusy,
            }),
            machineName: facts.name,
          })
        : undefined,
    [cpuBusy, facts.name, props.sessionId, scoped, usedMemory, wideTable],
  );

  const gate = (
    <MachineProcessesWidgetGate
      processes={processes}
      facts={facts}
      rows={OWNER_ROWS[size] ?? 6}
      testID={testID}
    />
  );
  if (!scoped) return gate;
  if (items.length === 0 && !controller.meterNote) {
    return facts.online ? (
      <MachineWidgetState
        kind="empty"
        title={
          props.sessionId
            ? t('machines.widgets.body.topConsumers.emptySessionTitle')
            : t('machines.widgets.body.topConsumers.emptyTitle')
        }
        reason={t('machines.widgets.body.topConsumers.emptyBody')}
        testID={testID}
      />
    ) : (
      <MachineWidgetState
        kind="offline"
        machineName={facts.name}
        lastSeenAt={facts.lastSeenAt}
        detail={t('machines.widgets.body.topConsumers.offlineBody')}
        testID={testID}
      />
    );
  }

  const heroParts = machineMemoryHeroParts(happierBytes);
  const share =
    happierBytes !== null && memory?.totalBytes
      ? Math.round((happierBytes / memory.totalBytes) * 100)
      : null;
  const hero = (
    <MachineProcessesHero
      testID={`${testID}.total`}
      label={t('machines.widgets.body.topConsumers.happierTotal')}
      value={heroParts.value}
      unit={heroParts.unit}
      caption={
        props.sessionId
          ? t('machines.widgets.body.topConsumers.thisSession')
          : share !== null
            ? t('machines.widgets.body.topConsumers.happierTotalShare', {
                percent: String(share),
              })
            : t('machines.widgets.body.topConsumers.happierTotal')
      }
    />
  );
  const elseLine =
    usedMemory !== null &&
    scoped.totals.happier.memoryBytes !== null &&
    !props.sessionId ? (
      <Text style={styles.caption}>
        {t('machines.widgets.body.topConsumers.everythingElse', {
          machine: facts.name,
          amount: formatMachineBytes(
            Math.max(0, usedMemory - scoped.totals.happier.memoryBytes),
            'memory',
          ),
        })}
      </Text>
    ) : null;
  const rows = (
    <>
      <StoppedLine controller={controller} testID={testID} />
      <MachineProcessesWidgetRows
        serverId={target.serverId}
        machineId={target.machineId}
        machineName={facts.name}
        items={items}
        titles={titles}
        cpuCapacityCores={null}
        table={wideTable}
        onOpen={openProcesses}
        accessory={accessory}
        leaving={controller.leaving}
        accessibilityLabel={t('machines.widgets.body.topConsumers.tableLabel', {
          machine: facts.name,
        })}
        {...(summaryRows ? { summaryRows } : {})}
        testID={`${testID}.rows`}
      />
      {confirming ? (
        <ConfirmStop
          onDone={confirming}
          testID={testID}
        />
      ) : null}
    </>
  );
  const composition = props.sessionId ? null : (
    <OwnerComposition answer={scoped} testID={testID} />
  );

  if (size === 'small')
    return <MachineWidgetColumn testID={testID}>{rows}</MachineWidgetColumn>;
  if (size === 'wide')
    return (
      <MachineWidgetTwoColumns
        lead={
          <>
            {hero}
            {composition}
          </>
        }
        rest={rows}
      />
    );
  if (size === 'medium')
    return (
      <MachineWidgetColumn testID={testID}>
        {hero}
        {rows}
      </MachineWidgetColumn>
    );
  if (size === 'full')
    return (
      <MachineWidgetTwoColumns
        lead={
          <>
            {hero}
            {composition}
            {elseLine}
          </>
        }
        rest={
          <>
            <MachineWidgetSectionLabel
              title={t('machines.widgets.body.topConsumers.byWhatStartedIt')}
              meta={t('machines.widgets.body.topConsumers.memory')}
            />
            {rows}
          </>
        }
      />
    );
  if (size === 'tall')
    return (
      <MachineWidgetColumn testID={testID}>
        {hero}
        {composition}
        {rows}
        {elseLine}
      </MachineWidgetColumn>
    );
  return (
    <MachineWidgetColumn testID={testID}>
      {hero}
      {composition}
      {rows}
      {props.sessionId ? null : (
        <Text style={styles.caption}>
          {t('machines.widgets.body.topConsumers.allProcessesHint')}
        </Text>
      )}
    </MachineWidgetColumn>
  );
}

/** One Stop where it wakes or restarts on demand; shared policy can ask about working sessions in place. */
function StopAccessory(
  props: Readonly<{
    item: ProcessesOwnerItem;
    serverId: string;
    controller: ProcessesController;
    onConfirm: NonNullable<MachineProcessesActionScope['confirmation']>;
    testID: string;
  }>,
) {
  const { item, controller, onConfirm } = props;
  const owner = item.owner.owner;
  const session = useSession(
    owner.kind === 'session' ? owner.sessionId : '',
    props.serverId,
  );
  const status = useSessionStatus(
    owner.kind === 'session' ? (session ?? null) : null,
    { workingTextMode: 'static', subscribeToTranscript: false },
  );
  const working =
    owner.kind === 'session' &&
    status !== null &&
    WORKING_STATES.has(status.state);
  const hover = useRowActionHoverHost();
  const alwaysShown = useDeviceType() === 'phone' || readCoarsePrimaryPointer();
  const name = controller.titleOf(item);
  const press = React.useCallback(
    () => controller.stop(item, working ? onConfirm : undefined),
    [controller, item, onConfirm, working],
  );
  return (
    <View {...hover.hoverProps}>
      <RowActionRevealSlot
        revealed={alwaysShown || hover.isHovered}
        testID={`${props.testID}.stop-slot-${item.key}`}
      >
        <IconButton
          testID={`${props.testID}.stop-${item.key}`}
          iconName="stop"
          variant="plain"
          accessibilityLabel={t('machines.widgets.body.topConsumers.stop', {
            name,
          })}
          minimumInteractiveTargetSize={alwaysShown ? 44 : undefined}
          onPress={press}
        />
      </RowActionRevealSlot>
    </View>
  );
}

/** The shared policy's in-place presentation (lab `rw` C confirm), with no separate dispatch. */
function ConfirmStop(
  props: Readonly<{
    onDone: (accepted: boolean) => void;
    testID: string;
  }>,
) {
  const { onDone } = props;
  return (
    <View
      style={styles.confirm}
      accessibilityRole="alert"
      testID={`${props.testID}.confirm`}
    >
      <Text style={styles.confirmText}>
        {t('machines.widgets.body.topConsumers.confirmWorking')}
      </Text>
      <RoundButton
        size="small"
        display="secondary"
        title={t('machines.widgets.body.topConsumers.cancel')}
        onPress={() => onDone(false)}
        testID={`${props.testID}.confirm-cancel`}
      />
      <RoundButton
        size="small"
        title={t('machines.widgets.body.topConsumers.confirmStop')}
        testID={`${props.testID}.confirm-stop`}
        onPress={() => onDone(true)}
      />
    </View>
  );
}

/** After a stop: what it gave back (memory is freed at once, R25), and the way back where there is one. */
function StoppedLine(
  props: Readonly<{ controller: ProcessesController; testID: string }>,
) {
  const note = props.controller.meterNote;
  if (note?.kind !== 'freed') return null;
  return (
    <View
      style={styles.stopped}
      accessibilityLiveRegion="polite"
      testID={`${props.testID}.stopped`}
    >
      <Text numberOfLines={1} style={styles.stoppedText}>
        {note.bytes === null
          ? t('machines.widgets.body.topConsumers.stopped', { name: note.name })
          : t('machines.widgets.body.topConsumers.stoppedFreed', {
              name: note.name,
              amount: formatMachineBytes(note.bytes, 'memory'),
            })}
      </Text>
      {note.startAgain ? (
        <TextLinkButton
          testID={`${props.testID}.undo`}
          tone="strong"
          label={t('machines.widgets.body.topConsumers.undo')}
          onPress={note.startAgain}
        />
      ) : null}
    </View>
  );
}

/** The same way back, for 6 s, through the app's one presentation notice owner (AGW-18). */
function useStopNotice(controller: ProcessesController, machineId: string) {
  const note = controller.meterNote;
  React.useEffect(() => {
    if (note?.kind !== 'freed') return;
    const startAgain = note.startAgain;
    publishPresentationNotice({
      key: `machine-widget:stopped:${machineId}`,
      severity: 'info',
      message:
        note.bytes === null
          ? t('machines.widgets.body.topConsumers.stopped', { name: note.name })
          : t('machines.widgets.body.topConsumers.stoppedFreed', {
              name: note.name,
              amount: formatMachineBytes(note.bytes, 'memory'),
            }),
      emphasis: note.name,
      ...(startAgain
        ? {
            undo: {
              label: t('machines.widgets.body.topConsumers.undo'),
              run: startAgain,
            },
          }
        : {}),
    });
  }, [machineId, note]);
}

const GROUP_OF: Readonly<
  Record<
    OwnerRowV1['owner']['kind'],
    'sessions' | 'browser' | 'services' | 'other'
  >
> = {
  session: 'sessions',
  browser_sidecar: 'browser',
  service: 'services',
  container: 'services',
  terminal: 'services',
  run: 'other',
  workspace_sync: 'other',
  happier: 'other',
};
const GROUPS = ['sessions', 'browser', 'services', 'other'] as const;
const GROUP_LABEL_KEYS = {
  sessions: 'machines.widgets.body.topConsumers.groups.sessions',
  browser: 'machines.widgets.body.topConsumers.groups.browser',
  services: 'machines.widgets.body.topConsumers.groups.services',
  other: 'machines.widgets.body.topConsumers.groups.other',
} as const;

/** Happier's memory by what started it, in the Overview's composition strip (lab `rw` C Full/Tall/Large). */
function OwnerComposition(
  props: Readonly<{ answer: MachineProcessesAnswerV1; testID: string }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const segments = React.useMemo(() => {
    const bytes = new Map<string, number>();
    for (const owner of props.answer.owners) {
      const group = GROUP_OF[owner.owner.kind];
      bytes.set(
        group,
        (bytes.get(group) ?? 0) + (owner.totals.memoryBytes ?? 0),
      );
    }
    return GROUPS.filter((group) => (bytes.get(group) ?? 0) > 0).map(
      (group, index) => ({
        id: group,
        label: t(GROUP_LABEL_KEYS[group]),
        value: bytes.get(group)!,
        color: withUsageAccentAlpha(
          theme.colors.text.primary,
          COMPOSITION_INK[Math.min(index, COMPOSITION_INK.length - 1)]!,
        ),
      }),
    );
  }, [language, props.answer.owners, theme.colors.text.primary]);
  if (segments.length === 0) return null;
  return (
    <CompositionStrip
      theme={pluginTheme}
      label={t('machines.widgets.body.topConsumers.compositionLabel')}
      total={props.answer.totals.happier.memoryBytes}
      segments={segments}
      size="tile"
      segmentGap={2}
      valueFormatter={(value) => formatMachineBytes(value, 'memory')}
      appearance={{ legend: 'compact', height: 6 }}
      testID={`${props.testID}.composition`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  caption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  confirm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    borderRadius: 10,
    backgroundColor: theme.colors.surface.inset,
  },
  confirmText: {
    ...Typography.default(),
    flex: 1,
    color: theme.colors.text.primary,
  },
  stopped: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  stoppedText: {
    ...Typography.variant('meta'),
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
}));

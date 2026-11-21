import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  useHappierCollection,
  type CollectionHeaderSlots,
  type CollectionSummaryRow,
} from '@happier-dev/plugin-ui';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachinePageState } from '@/components/machines/page/machinePageContext';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import type {
  MachinePageTabBodyProps,
  MachinePageTabParams,
} from '@/components/machines/page/machinePageTabQuery';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { useMachineStartSession } from '@/components/machines/page/useMachineStartSession';
import { MachineFreshnessChip, type MachineFreshness } from '@/components/machines/page/MachineFreshnessChip';
import { useMachineHeadlineResources } from '@/components/machines/summary/useMachineHeadlineResources';
import { resolveMachineCpuCapacityCores } from '@/components/machines/vitals/machineVitalsPresentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import { EMPTY_MACHINE_RESOURCE_STATE, machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import { useMachineDaemonReadTarget } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useMachineResourceLiveDemand } from '@/sync/domains/machines/resources/useMachineResourceLiveDemand';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { ProcessDetail } from './ProcessDetail';
import { ProcessesOwnerPage } from './ProcessesOwnerPage';
import { ProcessesStateCard } from './ProcessesStateCard';
import {
  ProcessesShowDetailsContext,
  useProcessRowActions,
} from './ProcessRowMenu';
import { ProcessesTiles } from './ProcessesTiles';
import { ProcessRowPresence } from './processesMotion';
import {
  buildProcessesSummaryRows,
  ProcessesRowNotesContext,
  formatProcessCpu,
  formatProcessMemory,
  useProcessesCollectionAnatomy,
} from './processesCollectionAnatomy';
import { useProcessOwnerTitles } from './processOwnerIdentity';
import {
  applyProcessOrder,
  buildMachineProcessesView,
  mergeStableProcessOrder,
  selectMachineProcessesTotals,
  type ProcessesItem,
  type ProcessesSort,
} from './processesPresentation';
import { MachinePortActionsProvider } from '@/components/machines/localServices/MachinePortActions';
import {
  ProcessesControllerContext,
  useProcessesController
} from './useProcessesController';

type ProcessesParams = Extract<MachinePageTabParams, { id: 'processes' }>;
type Scope = 'happier' | 'all';

/** A live sample never reorders rows under the pointer: the order holds until it has rested this long. */
const ORDER_HOLD_AFTER_POINTER_MS = 5_000;
const TABLE_MIN_WIDTH_PX = 520;

/** The owners a person opened, per machine, for this app session (lab `rp` ST: the tree keeps what was open). */
const OPEN_OWNERS_THIS_SESSION = new Map<string, readonly string[]>();

const keyOf = (item: ProcessesItem) => item.key;
const parentKeyOf = (item: ProcessesItem) => item.parentKey;
const groupOf = (item: ProcessesItem) => item.group;

/** Reads the tab's params from the route query; unknown values fall back to the defaults. */
export function parseMachineProcessesParams(
  raw: Readonly<Record<string, string | undefined>>,
): MachinePageTabParams {
  const sort =
    raw.sort === 'cpu' || raw.sort === 'memory' ? raw.sort : undefined;
  const filter = raw.filter === 'leftBehind' ? raw.filter : undefined;
  const scope = raw.scope === 'all' ? raw.scope : undefined;
  const page =
    raw.page === 'owner' && raw.owner
      ? 'owner'
      : raw.page === 'process' && raw.process
        ? 'process'
        : raw.page === 'app' && raw.app
          ? 'app'
          : undefined;
  return {
    id: 'processes',
    ...(sort ? { sort } : {}),
    ...(filter ? { filter } : {}),
    ...(scope ? { scope } : {}),
    ...(page === 'owner'
      ? { page, owner: raw.owner }
      : page === 'app'
        ? { page, app: raw.app }
      : page === 'process'
        ? {
            page,
            process: raw.process,
            ...(raw.owner ? { owner: raw.owner } : {}),
          }
        : {}),
  };
}

/**
 * Order recomputes when the sort changes, when the tab opens, or after the pointer has rested
 * {@link ORDER_HOLD_AFTER_POINTER_MS}; until then rows keep their place and new ones join the end of their level.
 */
function useStableProcessOrder(
  freshKeys: readonly string[],
  signature: string,
) {
  const [held, setHeld] = React.useState<readonly string[] | null>(null);
  const fresh = React.useRef(freshKeys);
  fresh.current = freshKeys;
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    setHeld(null);
  }, [signature]);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onPointerMove = React.useCallback(() => {
    setHeld((current) => current ?? fresh.current);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setHeld(null),
      ORDER_HOLD_AFTER_POINTER_MS,
    );
  }, []);
  return {
    order: held ? mergeStableProcessOrder(held, freshKeys) : null,
    onPointerMove,
  };
}

/** The machine's sample for the three vitals: plan 20's summary demand, held only while this tab is shown. */
function useMachineSample(
  serverId: string,
  machineId: string,
  online: boolean | null,
) {
  const keys = React.useMemo(
    () => [{ machineId, serverId }],
    [machineId, serverId],
  );
  useMachineResourceLiveDemand(keys, { detail: 'summary', enabled: online === true });
  const target = useMachineDaemonReadTarget({ serverId, machineId, online });
  const key = React.useMemo(
    () => ({ ...target.key, view: 'summary' as const }),
    [target.key],
  );
  const subscribe = React.useCallback(
    (listener: () => void) => machineResourceStore.observe(key, listener),
    [key],
  );
  const getSnapshot = React.useCallback(
    () => target.accountMatches ? machineResourceStore.getState(key) : EMPTY_MACHINE_RESOURCE_STATE,
    [key, target.accountMatches],
  );
  const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // CPU busy has legitimate gaps between samples; the summary retains the last measured figure.
  return { sample: state.snapshot?.sample ?? null, cpuBusyPct: state.summary?.cpu.busyPct ?? null };
}

/**
 * The machine page's Processes tab (plan 30 PROC-17/18/21, lab `rp`): what Happier started on this machine as
 * one tree by owner with its totals, the three vitals the stop moment moves, Left behind with its cleanup,
 * and — opt-in for this machine — everything else running here. Sampled only while it is shown.
 */
export const MachineProcessesTab = React.memo(function MachineProcessesTab(
  props: MachinePageTabBodyProps,
) {
  const params: ProcessesParams =
    props.params.id === 'processes' ? props.params : { id: 'processes' };
  if (params.page === 'owner' || params.page === 'process' || params.page === 'app')
    return <ProcessesOwnerPage {...props} params={params} />;
  return <MachineProcessesTree {...props} params={params} />;
});

function MachineProcessesTree(
  props: Omit<MachinePageTabBodyProps, 'params'> &
    Readonly<{ params: ProcessesParams }>,
) {
  const language = usePreferredLanguage();
  const { serverId, machineId, machineName, online, setParams } = props;
  const { theme } = useUnistyles();
  const compact = useDeviceType() === 'phone';
  const router = useRouter();
  const door = useMachinesDoor();
  const { target } = useMachinePageState();
  const published = useMachineHeadlineResources(serverId, target.machine);
  const homeDir = target.machine?.metadata?.homeDir;
  const startSession = useMachineStartSession({ serverId, machineId });

  const [scope, setScope] = React.useState<Scope>(props.params.scope === 'all' ? 'all' : 'happier');
  const [query, setQuery] = React.useState('');
  const [unfolded, setUnfolded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [detailRef, setDetailRef] = React.useState<string | null>(null);
  const [focusRequest, setFocusRequest] = React.useState<
    Readonly<{ key: string }> | undefined
  >(undefined);
  const sort: ProcessesSort = React.useMemo(
    () => ({ key: props.params.sort ?? 'memory', direction: 'descending' }),
    [props.params.sort],
  );

  const policy = useMachineResourcesPolicy({ serverId, machineId });
  const allVisible = policy.policy?.processes.allProcessesVisible === true;
  const wireScope: Scope = scope === 'all' && allVisible ? 'all' : 'happier';
  // All processes chosen but off for this machine (lab `rp` X0): the off state and the two totals, no rows.
  const allOff = scope === 'all' && !allVisible;
  const processes = useMachineProcesses({
    serverId,
    machineId,
    scope: wireScope,
    view: 'tree',
    online,
    ...(detailRef ? { detailToken: detailRef } : {}),
  });
  const answer = processes.answer?.state === 'live' ? processes.answer : null;
  const { sample, cpuBusyPct } = useMachineSample(serverId, machineId, online);
  const titles = useProcessOwnerTitles(answer?.owners, serverId);
  const recipient = answer?.othersWork !== undefined;
  // `filter=leftBehind` (a widget's Clean up): only Left behind, while there is any; otherwise the whole list.
  const leftBehindOnly =
    props.params.filter === 'leftBehind' &&
    wireScope === 'happier' &&
    (answer?.leftBehind.length ?? 0) > 0;
  const paramsSort = props.params.sort;
  const showEverything = React.useCallback(
    () => setParams({ id: 'processes', ...(paramsSort ? { sort: paramsSort } : {}) }),
    [paramsSort, setParams],
  );

  const stale = answer !== null && processes.status === 'error';
  // The tab's one freshness chip (lab `rp` ST 2–3): Live or Paused while sampling, "As of 10:42 · Retry" once the
  // machine stopped answering, "As of …" offline. Rows stay at full strength; the cause is said once, here.
  const capturedAtMs = answer?.capturedAtMs ?? null;
  const retryProcesses = processes.retry;
  const freshness = React.useMemo((): MachineFreshness => {
    if (online === null) return { kind: 'none' };
    if (online === false) return capturedAtMs !== null ? { kind: 'offline', at: capturedAtMs } : { kind: 'none' };
    if (stale && capturedAtMs !== null) return { kind: 'stale', at: capturedAtMs, onRetry: retryProcesses };
    if (capturedAtMs === null) return processes.status === 'loading' && !processes.paused
      ? { kind: 'checking', at: null } : { kind: 'none' };
    return processes.paused ? PAUSED : LIVE;
  }, [capturedAtMs, online, processes.paused, processes.status, retryProcesses, stale]);
  const unavailableReason = online === null ? t('common.unknown') : online === false
    ? t('machineProcesses.states.offlineTitle', { machine: machineName })
    : stale
      ? t('machineProcesses.menu.unavailable', { machine: machineName })
      : null;

  const itemsRef = React.useRef<readonly ProcessesItem[]>([]);
  const focusAfter = React.useCallback((key: string) => {
    const items = itemsRef.current;
    const index = items.findIndex((item) => item.key === key);
    const next =
      items
        .slice(index + 1)
        .find((item) => item.parentKey === items[index]?.parentKey) ??
      items[index - 1];
    if (next) setFocusRequest({ key: next.key });
  }, []);
  const binding = processes.accountBinding;
  const isCurrent = React.useCallback(
    () => Boolean(binding?.isCurrent()),
    [binding],
  );
  const controller = useProcessesController({
    serverId,
    machineId,
    machineName,
    answer,
    titles,
    expectedAccountId: binding?.accountId ?? null,
    isCurrent,
    unavailableReason,
    focusAfter,
  });
  const view = React.useMemo(
    () =>
      answer
        ? buildMachineProcessesView({
            answer,
            scope: wireScope,
            sort,
            query,
            ownerTitle: (owner) => titles.get(owner.rowId) ?? null,
            hidden: controller.hidden,
            unfolded,
            leftBehindOnly,
          })
        : null,
    [answer, controller.hidden, leftBehindOnly, query, sort, titles, unfolded, wireScope],
  );
  const fresh = React.useMemo(() => view?.items ?? [], [view]);
  const freshKeys = React.useMemo(() => fresh.map(keyOf), [fresh]);
  const stableOrder = useStableProcessOrder(
    freshKeys,
    `${sort.key}:${sort.direction}:${wireScope}:${query}`,
  );
  const items = React.useMemo(() => (allOff ? [] : applyProcessOrder(fresh, stableOrder.order)), [allOff, fresh, stableOrder.order]);
  itemsRef.current = items;

  // A phone's band names the group and its count; what the rows share is said on the owner's page (lab `rp` Hp).
  const groups = React.useMemo(
    () => ({
      axis: [
        { key: 'happier', title: '' },
        {
          key: 'leftBehind',
          title: t('machineProcesses.groups.leftBehind'),
          description: compact ? undefined : t('machineProcesses.groups.leftBehindDescription'),
        },
        {
          key: 'notHappier',
          title: t('machineProcesses.groups.notHappiers'),
          description: compact ? undefined : t('machineProcesses.groups.notHappiersDescription'),
        },
        {
          key: 'otherPeople',
          title: t('machineProcesses.groups.otherPeople'),
          description: compact ? undefined : t('machineProcesses.groups.otherPeopleDescription'),
        },
      ],
      groupOf,
    }),
    [language, answer?.notHappier, compact, view?.leftBehind.count],
  );

  const modelRef = React.useRef<ReturnType<
    typeof useHappierCollection<ProcessesItem>
  > | null>(null);
  const onOpenChange = React.useCallback(
    (key: string | null) => {
      const model = modelRef.current;
      const item = key
        ? itemsRef.current.find((candidate) => candidate.key === key)
        : undefined;
      if (!model || !item) return;
      if (item.kind === 'fold') {
        setUnfolded((current) => new Set([...current, item.key]));
        return;
      }
      if (item.kind === 'happier') {
        setScope('happier');
        return;
      }
      if (compact) {
        if (item.kind === 'app')
          setParams({
            id: 'processes',
            ...(props.params.sort ? { sort: props.params.sort } : {}),
            page: 'app',
            app: item.app.appGroup,
          });
        else if (item.kind === 'owner')
          setParams({
            id: 'processes',
            ...(props.params.sort ? { sort: props.params.sort } : {}),
            page: 'owner',
            owner: item.owner.rowId,
          });
        else if (item.kind === 'process' || item.kind === 'leftBehind')
          setParams({
            id: 'processes',
            page: 'process',
            process: item.row.ref,
            ...(item.kind === 'process' ? { owner: item.owner.rowId } : {}),
          });
        return;
      }
      if ((item.kind === 'owner' && item.hasChildren) || item.kind === 'app') {
        model.actions.setBranchOpen(
          item.key,
          !model.openBranches.has(item.key),
        );
        return;
      }
      // An external app's member has no detail to peek (its `peek` is null), so opening it would only leave an empty slot.
      if (item.kind === 'process' || item.kind === 'leftBehind')
        model.actions.toggleExpanded(item.key);
    },
    [compact, props.params.sort, setParams],
  );
  const openMemoryKey = `${serverId}\u0000${machineId}`;
  const model = useHappierCollection<ProcessesItem>({
    initialOpenBranches: OPEN_OWNERS_THIS_SESSION.get(openMemoryKey) ?? [],
    items,
    keyOf,
    parentKey: parentKeyOf,
    groups,
    openKey: null,
    onOpenChange,
    expandable: !compact,
  });
  modelRef.current = model;

  // Only one detail is open; the open one's ref is the watch's detail token (evidence, chain, history).
  const expanded = model.expanded;
  const lastExpanded = React.useRef<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const added = [...expanded].filter((key) => !lastExpanded.current.has(key));
    if (added.length > 0)
      for (const key of expanded)
        if (!added.includes(key)) model.actions.toggleExpanded(key);
    lastExpanded.current = expanded;
    const open = added[added.length - 1] ?? [...expanded][0];
    const item = open
      ? itemsRef.current.find((candidate) => candidate.key === open)
      : undefined;
    setDetailRef(
      item && (item.kind === 'process' || item.kind === 'leftBehind')
        ? item.row.ref
        : null,
    );
  }, [expanded, model.actions]);

  const revealed = React.useRef<ReadonlySet<string>>(new Set());
  React.useEffect(() => {

    OPEN_OWNERS_THIS_SESSION.set(openMemoryKey, [...model.openBranches].filter((key) => !revealed.current.has(key)));

  }, [model.openBranches, openMemoryKey]);

  // A search opens the owners its matches sit in, and closes them again when it is cleared.
  const revealKeys = view?.revealKeys;
  React.useEffect(() => {
    const next = new Set(revealKeys ?? []);
    for (const key of next)
      if (!model.openBranches.has(key)) model.actions.setBranchOpen(key, true);
    for (const key of revealed.current)
      if (!next.has(key)) model.actions.setBranchOpen(key, false);
    revealed.current = next;
  }, [model.actions, model.openBranches, revealKeys]);

  const showDetails = React.useCallback(
    (key: string) => {
      if (compact) {
        onOpenChange(key);
        return;
      }
      modelRef.current?.actions.toggleExpanded(key);
    },
    [compact, onOpenChange],
  );

  const anatomyInput = React.useMemo(
    () => ({
      serverId,
      machineId,
      machineName,
      titles,
      compact,
      cpuCapacityCores: published?.host ? resolveMachineCpuCapacityCores(published.host) : null,
      history: answer?.history,
      wrapItem: (item: ProcessesItem, content: React.ReactNode) => (
        <LeavingRow itemKey={item.key}>{content}</LeavingRow>
      ),
    }),
    [
      answer?.history,
      compact,
      machineId,
      machineName,
      published?.host?.logicalCores,
      published?.host?.effectiveCores,
      serverId,
      titles,
    ],
  );
  const baseAnatomy = useProcessesCollectionAnatomy(anatomyInput);
  const anatomy = React.useMemo(
    () => ({
      ...baseAnatomy,
      columnTitles: {
        title:
          wireScope === 'all'
            ? t('machineProcesses.columns.everything', { machine: machineName })
            : t('machineProcesses.columns.happier'),
      },
      peek: (item: ProcessesItem) =>
        item.kind === 'process' || item.kind === 'leftBehind' ? (
          <ProcessDetail
            row={item.row}
            owner={item.kind === 'process' ? item.owner.owner : item.row.owner}
            ownerTitle={
              item.kind === 'process'
                ? (titles.get(item.owner.rowId) ?? null)
                : null
            }
            machineName={machineName}
            platform={answer?.platform ?? 'linux'}
            homeDir={homeDir}
            samples={answer?.history?.[item.row.ref]}
            ceiling={item.kind === 'process' ? item.owner.ceiling : undefined}
            onCopyCommand={item.row.level === 'proven' ? controller.copy : null}
            onOpenSession={controller.openSession}
          />
        ) : null,
    }),
    [
      language,
      answer?.history,
      answer?.platform,
      baseAnatomy,
      controller.copy,
      controller.openSession,
      homeDir,
      machineName,
      titles,
      wireScope,
    ],
  );

  const totals = React.useMemo(
    () =>
      answer
        ? selectMachineProcessesTotals(
            answer,
            sample
              ? {
                  usedMemoryBytes: sample.memory.reported
                    ? sample.memory.usedBytes
                    : null,
                  cpuBusyPercent: sample.cpu.reported
                    ? sample.cpu.busyPct
                    : null,
                }
              : null,
          )
        : null,
    [answer, sample],
  );
  const clearQuery = React.useCallback(() => setQuery(''), []);
  const showAll = React.useCallback(() => setScope('all'), []);
  const summaryRows = React.useMemo((): readonly CollectionSummaryRow[] => {
    if (!totals || !view) return [];
    if (leftBehindOnly) {
      return [
        {
          key: 'left-behind-only',
          testID: 'machine-processes-total-left-behind-only',
          title: (
            <View style={styles.inline}>
              <Text style={styles.quiet}>
                {t('machineProcesses.totals.leftBehindOnly', {
                  count: view.leftBehind.count,
                })}
              </Text>
              <TextLinkButton
                testID="machine-processes-show-everything"
                label={t('machineProcesses.totals.showEverything')}
                tone="strong"
                onPress={showEverything}
              />
            </View>
          ),
          cells: {
            cpu: <Text style={styles.figure}>{formatProcessCpu(totals.leftBehind.cpuPercent)}</Text>,
            memory: <Text style={styles.figure}>{formatProcessMemory(totals.leftBehind.memoryBytes)}</Text>,
          },
        },
      ];
    }
    if (view.match) {
      return [
        {
          key: 'match',
          testID: 'machine-processes-total-match',
          title: (
            <View style={styles.inline}>
              <Text style={styles.quiet}>
                {t('machineProcesses.totals.match', {
                  count: view.match.matched,
                  total: view.match.total,
                  query: query.trim(),
                })}
              </Text>
              <TextLinkButton
                label={t('machineProcesses.totals.clear')}
                tone="strong"
                onPress={clearQuery}
              />
            </View>
          ),
          cells: {
            cpu: (
              <Text style={styles.figure}>
                {formatProcessCpu(view.match.cpuPercent)}
              </Text>
            ),
            memory: (
              <Text style={styles.figure}>
                {formatProcessMemory(view.match.memoryBytes)}
              </Text>
            ),
          },
        },
      ];
    }
    if (wireScope === 'all') {
      const used = sample?.memory.reported ? sample.memory.usedBytes : null;
      const busy = sample?.cpu.reported ? sample.cpu.busyPct : null;
      return [
        {
          key: 'machine',
          testID: 'machine-processes-total-machine',
          title: t('machineProcesses.totals.machine', { machine: machineName }),
          cells: {
            cpu: <Text style={styles.figure}>{formatProcessCpu(busy)}</Text>,
            memory: (
              <Text style={styles.figure}>{formatProcessMemory(used)}</Text>
            ),
          },
        },
      ];
    }
    return buildProcessesSummaryRows({
      totals,
      machineName,
      ...(recipient
        ? {}
        : {
            showAll: (
              <TextLinkButton
                testID="machine-processes-show-all"
                label={t('machineProcesses.totals.showAll')}
                tone="strong"
                onPress={showAll}
              />
            ),
          }),
    });
  }, [
      language,
    clearQuery,
    leftBehindOnly,
    showEverything,
    machineName,
    query,
    recipient,
    sample,
    showAll,
    totals,
    view,
    wireScope,
  ]);

  const leftBehindItems = React.useMemo(
    () =>
      items.filter(
        (item): item is Extract<ProcessesItem, { kind: 'leftBehind' }> =>
          item.kind === 'leftBehind',
      ),
    [items],
  );
  const groupAction = React.useCallback(
    (groupKey: string) =>
      groupKey === 'leftBehind' &&
      view &&
      view.leftBehind.count > 0 &&
      !unavailableReason
        ? {
            kind: 'operation' as const,
            label: t('machineProcesses.cleanUp', {
              count: view.leftBehind.count,
              amount: formatProcessMemory(view.leftBehind.memoryBytes),
            }),
            onPress: () => controller.cleanUp(leftBehindItems),
          }
        : null,
    [controller, leftBehindItems, unavailableReason, view],
  );
  const onSortChange = React.useCallback(
    (key: string) => {
      if (key === 'cpu' || key === 'memory')
        setParams({ id: 'processes', sort: key });
    },
    [setParams],
  );
  const sortProp = React.useMemo(
    () => ({
      key: sort.key,
      direction: sort.direction,
      onChange: onSortChange,
    }),
    [onSortChange, sort.direction, sort.key],
  );

  const turnOn = React.useCallback(() => {
    fireAndForget(policy.set({ processes: { allProcessesVisible: true } }), {
      tag: 'MachineProcesses.allOn',
    });
  }, [policy]);
  const turnOff = React.useCallback(() => {
    setScope('happier');
    fireAndForget(policy.set({ processes: { allProcessesVisible: false } }), {
      tag: 'MachineProcesses.allOff',
    });
  }, [policy]);
  const openDoctor = React.useCallback(() => {
    router.push(
      machinePageHref({
        door,
        target: { machineId, serverId },
        page: 'doctor',
      }) as never,
    );
  }, [door, machineId, router, serverId]);

  const scopeTabs = React.useMemo(
    () => [
      { id: 'happier' as const, label: t('machineProcesses.scope.happier') },
      { id: 'all' as const, label: t('machineProcesses.scope.all') },
    ],
    [language],
  );
  // The scope switch leads; the freshness chip and (inside the table's header) the search end the row (lab `rp` H).
  const renderToolbar = (search: React.ReactNode) => (
    <View style={[styles.toolbar, compact ? styles.toolbarCompact : null]}>
      {recipient ? (
        <View />
      ) : (
        <SegmentedTabBar<Scope>
          tabs={scopeTabs}
          activeTabId={scope}
          onSelectTab={setScope}
          segmentSizing={compact ? 'equal' : 'content'}
          accessibilityLabel={t('machineProcesses.scope.label')}
          testIDPrefix="machine-processes-scope"
        />
      )}
      {/* With the search here, the chip and the search share one line (lab `rp` H); the toolbar itself still wraps. */}
      <View style={[styles.toolbarEnd, search ? styles.toolbarEndOneLine : null]}>
        {wireScope === 'all' ? (
          <View style={styles.inline}>
            <Text style={styles.quiet}>
              {t('machineProcesses.onFor', { machine: machineName })}
            </Text>
            <Text style={styles.quiet} aria-hidden>
              ·
            </Text>
            <TextLinkButton
              testID="machine-processes-turn-off"
              label={t('machineProcesses.turnOff')}
              tone="strong"
              onPress={turnOff}
              disabled={!policy.editable}
            />
          </View>
        ) : null}
        <View style={styles.chip}>
          <MachineFreshnessChip testID={`machine-processes-${freshness.kind}`} lead={t('machineProcesses.sampledWhileLooking')} freshness={freshness} />
        </View>
        {search}
      </View>
    </View>
  );
  const toolbar = renderToolbar(null);

  const tiles = (
    <ProcessesTiles
      sample={sample}
      cpuBusyPct={cpuBusyPct}
      attention={published?.attention ?? null}
      happierBytes={answer?.totals.happier.memoryBytes ?? null}
      happierCount={answer?.totals.happier.processCount ?? 0}
      leftBehindCount={answer?.leftBehind.length ?? 0}
      pendingFreedBytes={controller.pendingFreedBytes}
      meterNote={controller.meterNote}
      onLeftBehind={
        leftBehindItems.length > 0 && !unavailableReason
          ? () => controller.cleanUp(leftBehindItems)
          : null
      }
      loading={answer === null && processes.status === 'loading'}
      compact={compact}
    />
  );

  // ---- whole-tab states (lab `rp` ST) ----
  if (
    answer === null &&
    (online !== true || processes.status !== 'loading') &&
    !(online && scope === 'all' && !allVisible)
  ) {
    return (
      <View testID="machine-processes">
        {/* Nothing retained to filter (lab `rp` ST 6): the header and tabs stay and the body is the state; the scope bar
            stays only while All processes failed, as the way back to what Happier started. */}
        {scope === 'all' ? <ItemGroup header="none" surface="none">{toolbar}</ItemGroup> : null}
        {/* Offline is one quiet line on the page's sheet, as Storage says it; the other states draw their own tile. */}
        <ItemGroup header="none" {...(online === false ? {} : { surface: 'none' as const })}>
          <ProcessesStateCard
            status={processes.status}
            reason={processes.answer?.reason ?? processes.reason}
            online={online}
            machineName={machineName}
            onRetry={processes.retry}
            onOpenDoctor={openDoctor}
          />
        </ItemGroup>
      </View>
    );
  }
  const nothingRunning =
    answer !== null &&
    !query &&
    wireScope === 'happier' &&
    answer.leftBehind.length === 0 &&
    answer.owners.every((owner) => owner.owner.kind === 'happier');
  // A calm machine with nothing running says only that (lab `rp` ST 5); one short on memory or CPU keeps its
  // vitals above it, since this is where the header's "Review processes" leads.
  const vitalsNeedYou = (published?.attention?.reasons ?? []).some(
    (reason) => reason.metric === 'memory' || reason.metric === 'cpu',
  );
  // The tab's own blocks above the table, each on the page column like every section (lab `rp` H):
  // the scope bar and any freshness line, the three tiles, then the table's sheet.
  // The outer group only caps the table to the page column; the header's sections return to the page's own insets.
  const renderHeader = (slots: CollectionHeaderSlots) => (
    <ListPresentationProvider value="page">
      <ItemGroup header="none" surface="none">
        {renderToolbar(slots.search)}
        {online === false && answer ? (
          <SurfaceStateCard
            testID="machine-processes-offline"
            kind="unavailable"
            size="line"
            title={t('machineProcesses.states.offlineTitle', {
              machine: machineName,
            })}
            reason={t('machineProcesses.states.offlineBody')}
            action={{
              label: t('machineProcesses.states.tryAgain'),
              onPress: processes.retry,
            }}
          />
        ) : null}
      </ItemGroup>
      {allOff || (nothingRunning && !vitalsNeedYou) ? null : tiles}
      {answer?.othersWork && answer.othersWork.count > 0 ? (
        <ItemGroup header="none" surface="none">
          <Text style={styles.quiet}>
            {t('machineProcesses.states.othersWork', {
              count: answer.othersWork.count,
            })}
          </Text>
        </ItemGroup>
      ) : null}
      {nothingRunning ? (
        // Happier itself is still listed below, so "nothing running" is its own sheet above the table (lab `rp` ST 5).
        <ItemGroup header="none">
          <EmptyState
            testID="machine-processes-nothing"
            layout="page"
            iconName="terminal"
            // Happier itself is still listed beneath, so the state names it rather than saying nothing runs.
            title={t(
              answer.owners.length > 0
                ? 'machineProcesses.states.onlyHappierTitle'
                : 'machineProcesses.states.nothingTitle',
              { machine: machineName },
            )}
            subtitle={t('machineProcesses.states.nothingBody')}
            primaryAction={{
              label: t('machineProcesses.states.startSession', {
                machine: machineName,
              }),
              onPress: startSession,
            }}
          />
        </ItemGroup>
      ) : null}
      {/* The table's sheet sits one toolbar gap under the blocks above it, as one composition (lab `rp` H). */}
      <View style={styles.headerEnd} />
    </ListPresentationProvider>
  );
  const empty = allOff ? (
    <EmptyState
      testID="machine-processes-all-off"
      layout="page"
      iconName="desktop"
      title={t('machineProcesses.allOff.title', { machine: machineName })}
      subtitle={t('machineProcesses.allOff.body', { machine: machineName })}
      primaryAction={{
        label: t('machineProcesses.allOff.action', { machine: machineName }),
        onPress: turnOn,
        testID: 'machine-processes-all-on',
      }}
      {...(policy.editable
        ? {}
        : {
            actionUnavailableReason: t('machineProcesses.allOff.custodianOnly'),
          })}
    />
  ) : query.trim() ? (
    <EmptyState
      testID="machine-processes-no-match"
      layout="line"
      title={
        wireScope === 'all'
          ? t('machineProcesses.noMatchAll', {
              machine: machineName,
              query: query.trim(),
            })
          : t('machineProcesses.noMatch', {
              machine: machineName,
              query: query.trim(),
            })
      }
      primaryAction={{
        label: t('machineProcesses.totals.clear'),
        onPress: clearQuery,
      }}
      {...(wireScope === 'happier' && !recipient
        ? {
            secondaryAction: {
              label: t('machineProcesses.lookInAll'),
              onPress: showAll,
            },
          }
        : {})}
    />
  ) : null;

  return (
    <ProcessesControllerContext.Provider
      value={unavailableReason && !answer ? null : controller}
    >
      <MachinePortActionsProvider serverId={serverId} machineId={machineId}>
      <ProcessesShowDetailsContext.Provider value={showDetails}>
          <ProcessesRowNotesContext.Provider value={controller.notes}>
        <View
          testID="machine-processes"
          onPointerMove={stableOrder.onPointerMove}
          onTouchStart={stableOrder.onPointerMove}
        >
          {/* The toolbar, tiles and states lead the table inside its header, so the search sits in the toolbar;
              the table draws its own page sheet on the tiles' edges (the Overview's "Using the most" composition). */}
          <ListPresentationProvider value="page" pageInsets="contained">
          <ItemGroup header="none" surface="none">
          <CoreCollectionScope>
            <Collection<ProcessesItem>
              testID="machine-processes-table"
              // A phone keeps the search on the list's own row; a wide table places it in the toolbar.
              header={compact ? renderHeader(PHONE_HEADER_SLOTS) : renderHeader}
              model={model}
              anatomy={anatomy}
              accessibilityLabel={t('machineProcesses.tableLabel', {
                machine: machineName,
              })}
              presentation={compact ? 'list' : 'table'}
              detail="none"
              scroll="page"
              minListWidth={TABLE_MIN_WIDTH_PX}
              minDetailWidth={TABLE_MIN_WIDTH_PX}
              preferredListRatio={1}
              footer={
                answer && !allOff ? (
                  <Text style={styles.platform}>
                    {t(`machineProcesses.platform.${answer.platform}`)}
                    {(answer.unverifiableCount ?? 0) > 0 ? <Text testID="machine-processes-unverifiable">{' '}{t('machineProcesses.states.unverifiable', { count: answer.unverifiableCount! })}</Text> : null}
                  </Text>
                ) : null
              }
              search={
                allOff
                  ? undefined
                  : {
                      label: t('machineProcesses.searchLabel'),
                      value: query,
                      onValueChange: setQuery,
                      placeholder: t('machineProcesses.searchPlaceholder'),
                      testID: 'machine-processes-search',
                    }
              }
              sort={sortProp}
              summaryRows={summaryRows}
              groupAction={groupAction}
              loading={answer === null && !allOff}
              empty={empty}
              useRowActions={useProcessRowActions}
              selection={focusRequest ? { focusRequest } : {}}
            />
          </CoreCollectionScope>
          </ItemGroup>
          </ListPresentationProvider>
        </View>
        </ProcessesRowNotesContext.Provider>
        </ProcessesShowDetailsContext.Provider>
      </MachinePortActionsProvider>
    </ProcessesControllerContext.Provider>
  );
}

/** A row leaving the tree reads the controller's leaving set (the Collection keeps rendering it until it is gone). */
function LeavingRow(
  props: Readonly<{ itemKey: string; children: React.ReactNode }>,
) {
  const controller = React.useContext(ProcessesControllerContext);
  return (
    <ProcessRowPresence
      leaving={controller?.leaving.has(props.itemKey) === true}
    >
      {props.children}
    </ProcessRowPresence>
  );
}

const PHONE_HEADER_SLOTS: CollectionHeaderSlots = { title: null, search: null, selection: null, pageActions: null };
const LIVE = { kind: 'live' } as const;
const PAUSED = { kind: 'paused' } as const;

const styles = StyleSheet.create((theme) => ({
  headerEnd: {
    height: theme.space.s12,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    marginBottom: theme.space.s12,
    flexWrap: 'wrap',
  },
  toolbarCompact: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  toolbarEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    // On a phone "On for … only · Turn off" and the freshness chip do not fit one line: the chip drops under it.
    flexWrap: 'wrap',
    columnGap: theme.space.s16,
    rowGap: theme.space.s4,
    marginLeft: 'auto',
  },
  toolbarEndOneLine: {
    flexWrap: 'nowrap',
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  // The chip says its whole line; the search gives way first.
  chip: {
    flexShrink: 0,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  figure: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    color: theme.colors.text.secondary,
    textAlign: 'right',
  },
  platform: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    paddingVertical: theme.space.s12,
    // On the rows' content edge, like the group band's label above it.
    paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
  },
}));

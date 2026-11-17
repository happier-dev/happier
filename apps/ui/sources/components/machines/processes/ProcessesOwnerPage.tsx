import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ProcessRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { useMachinePageState } from '@/components/machines/page/machinePageContext';
import { MachineTabSubHead } from '@/components/machines/page/MachineTabSubHead';
import type {
  MachinePageTabBodyProps,
  MachinePageTabParams,
} from '@/components/machines/page/machinePageTabQuery';
import { readMachinePublishedResources } from '@/components/machines/summary/machineResourceSentences';
import { resolveMachineCpuCapacityCores } from '@/components/machines/vitals/machineVitalsPresentation';
import { formatVitalsPercent } from '@/components/machines/vitals/vitalsFormat';
import { VitalsMeterRow } from '@/components/machines/vitals/VitalsMeterRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineProcesses } from '@/sync/domains/machines/processes/useMachineProcesses';
import { t } from '@/text';

import { ProcessDetail } from './ProcessDetail';
import { ProcessesStateCard } from './ProcessesStateCard';
import {
  formatProcessCpu,
  formatProcessMemory,
  ProcessOwnershipPill,
} from './processesCollectionAnatomy';
import {
  describeProcessIdentity,
  describeProcessTitle,
  ProcessOwnerMark,
  useProcessOwnerStatus,
  useProcessOwnerTitles,
} from './processOwnerIdentity';
import {
  buildMachineProcessesView,
  type ProcessesAppMemberItem,
  type ProcessesOwnerItem,
} from './processesPresentation';
import { useProcessRowActions } from './ProcessRowMenu';
import {
  ProcessesControllerContext,
  useProcessesController,
} from './useProcessesController';

type ProcessesParams = Extract<MachinePageTabParams, { id: 'processes' }>;

/**
 * Phone (lab `rp` Dp): a row pushes its owner — identity, its two meters, its processes, then the actions as
 * a quiet button row with the destructive one last and one sentence of consequence — and a process pushes
 * its detail. An external app (All processes) pushes its own page: its two meters and each of its processes
 * with the same row menu as the tree. The same watch and the same Actions as the tree.
 */
export function ProcessesOwnerPage(
  props: Omit<MachinePageTabBodyProps, 'params'> &
    Readonly<{ params: ProcessesParams }>,
) {
  const { serverId, machineId, machineName, online, setParams, params } = props;
  const { theme } = useUnistyles();
  const { target } = useMachinePageState();
  const daemonState: unknown = target.machine?.daemonState;
  const published = React.useMemo(
    () => readMachinePublishedResources(daemonState),
    [daemonState],
  );
  const processes = useMachineProcesses({
    serverId,
    machineId,
    scope: params.page === 'app' ? 'all' : 'happier',
    view: 'tree',
    online,
    ...(params.page === 'process' && params.process
      ? { detailToken: params.process }
      : {}),
  });
  const answer = processes.answer?.state === 'live' ? processes.answer : null;
  const titles = useProcessOwnerTitles(answer?.owners, serverId);
  const binding = processes.accountBinding;
  const isCurrent = React.useCallback(
    () => Boolean(binding?.isCurrent()),
    [binding],
  );
  const back = React.useCallback(() => {
    setParams(
      params.page === 'process' && params.owner
        ? { id: 'processes', page: 'owner', owner: params.owner }
        : params.page === 'app'
          ? { id: 'processes', scope: 'all', ...(params.sort ? { sort: params.sort } : {}) }
          : { id: 'processes' },
    );
  }, [params.owner, params.page, params.sort, setParams]);
  const controller = useProcessesController({
    serverId,
    machineId,
    machineName,
    answer,
    titles,
    expectedAccountId: binding?.accountId ?? null,
    isCurrent,
    unavailableReason: online === null ? t('common.unknown') : online
      ? null
      : t('machineProcesses.states.offlineTitle', { machine: machineName }),
    focusAfter: () => {},
  });
  const view = React.useMemo(
    () =>
      answer
        ? buildMachineProcessesView({
            answer,
            scope: params.page === 'app' ? 'all' : 'happier',
            sort: { key: params.sort ?? 'memory', direction: 'descending' },
            ...(params.page === 'app' ? { hidden: controller.hidden } : {}),
          })
        : null,
    [answer, controller.hidden, params.page, params.sort],
  );

  const backTo = { label: t('machineProcesses.phone.back'), onPress: back, testID: 'machine-processes-back' };
  const backLink = <MachineTabSubHead title={null} back={backTo} />;
  if (!answer || !view)
    return (
      <View style={styles.page}>
        {backLink}
        <ProcessesStateCard status={processes.status} reason={processes.reason}
          online={online} machineName={machineName} onRetry={processes.retry} />
      </View>
    );

  const memoryTotal = published?.host?.memoryTotalBytes ?? null;
  const cores = published?.host ? resolveMachineCpuCapacityCores(published.host) : null;
  if (params.page === 'process') {
    const process = answer.owners
      .flatMap((owner) => owner.members.map((row) => ({ row, owner })))
      .find((entry) => entry.row.ref === params.process);
    const left = answer.leftBehind.find((row) => row.ref === params.process);
    const row = process?.row ?? left;
    if (!row)
      return (
        <View style={styles.page}>
          {backLink}
          <SurfaceStateCard
            kind="empty"
            title={t('machineProcesses.kill.recheckedGone')}
          />
        </View>
      );
    return (
      <View style={styles.page} testID="machine-processes-process-page">
        <MachineTabSubHead title={describeProcessTitle(row)} back={backTo} />
        {/* The detail is drawn for a row's own region; on its page the column's gutter is its owner's, once. */}
        <ItemGroup surface="none" header="none">
          <ListPresentationProvider value="page" pageInsets="contained">
            <ProcessDetail
              row={row}
              owner={process?.owner.owner ?? left?.owner ?? null}
              ownerTitle={
                process ? (titles.get(process.owner.rowId) ?? null) : null
              }
              machineName={machineName}
              platform={answer.platform}
              homeDir={target.machine?.metadata?.homeDir}
              samples={answer.history?.[row.ref]}
              ceiling={process?.owner.ceiling}
              onCopyCommand={row.level === 'proven' ? controller.copy : null}
              onOpenSession={controller.openSession}
            />
          </ListPresentationProvider>
        </ItemGroup>
      </View>
    );
  }

  if (params.page === 'app') {
    const app = view.items.find((item) => item.kind === 'app' && item.app.appGroup === params.app);
    if (!app || app.kind !== 'app')
      return (
        <View style={styles.page}>
          {backLink}
          <SurfaceStateCard kind="empty" title={t('machineProcesses.kill.recheckedGone')} />
        </View>
      );
    const members = view.items.filter(
      (item): item is ProcessesAppMemberItem => item.kind === 'appMember' && item.parentKey === app.key,
    );
    return (
      <ProcessesControllerContext.Provider value={controller}>
        <View style={styles.page} testID="machine-processes-app-page">
          <MachineTabSubHead title={app.app.appGroup} back={backTo}
            mark={<Icon name="desktop" size={20} color={theme.colors.text.secondary} />} />
          <OwnerMeters memoryBytes={app.memoryBytes} cpuPercent={app.cpuPercent} memoryTotal={memoryTotal} cores={cores} />
          <ItemGroup title={t('machineProcesses.phone.ownerProcesses', { count: members.length })}>
            {members.map((item) => <AppMemberRow key={item.key} item={item} />)}
          </ItemGroup>
        </View>
      </ProcessesControllerContext.Provider>
    );
  }

  const owner = view.items.find(
    (item): item is ProcessesOwnerItem =>
      item.kind === 'owner' && item.owner.rowId === params.owner,
  );
  if (!owner)
    return (
      <View style={styles.page}>
        {backLink}
        <SurfaceStateCard
          kind="empty"
          title={t('machineProcesses.kill.recheckedGone')}
        />
      </View>
    );
  const members = view.items.filter(
    (item) => item.kind === 'process' && item.ownerKey === owner.key,
  );
  // An owner whose only top-level process is its root draws that root as the owner row, so the tree has no
  // row for it; the phone page lists it first so the count above the list is true and the process can open.
  const root = owner.rootRef ? owner.owner.members.find((row) => row.ref === owner.rootRef) : undefined;
  const ownerProcesses: readonly Readonly<{ key: string; row: ProcessRowV1; cpuPercent: number | null; memoryBytes: number | null }>[] = [
    ...(root && !members.some((item) => item.kind === 'process' && item.row.ref === root.ref)
      ? [{ key: `p:${root.rowId}`, row: root, cpuPercent: root.cpuPercent ?? null, memoryBytes: root.memoryBytes }]
      : []),
    ...members.flatMap((item) => (item.kind === 'process' ? [item] : [])),
  ];
  return (
    <View style={styles.page} testID="machine-processes-owner-page">
      <OwnerHeader
        back={backTo}
        owner={owner}
        title={titles.get(owner.owner.rowId) ?? ''}
        serverId={serverId}
        machineId={machineId}
      />
      <OwnerMeters memoryBytes={owner.memoryBytes} cpuPercent={owner.cpuPercent} memoryTotal={memoryTotal} cores={cores} />
      {owner.owner.ceiling ? <ItemGroup
        title={t('machineProcesses.ceiling.title')}
        description={t('machineProcesses.ceiling.scopeHelp')}
      >
        <Item testID="machine-processes-ceiling-usage" mode="info" title={t('machineProcesses.tiles.memory')}
          detail={formatProcessMemory(owner.memoryBytes, owner.owner.ceiling)} />
        <Item testID="machine-processes-ceiling-throttles" mode="info"
          title={owner.owner.ceiling.throttleCount5m === undefined ? t('machineProcesses.ceiling.throttlesUnknown')
            : t('machineProcesses.ceiling.throttles', { count: owner.owner.ceiling.throttleCount5m })} />
      </ItemGroup> : null}
      <ItemGroup
        title={t('machineProcesses.phone.ownerProcesses', {
          count: owner.processCount,
        })}
      >
        {ownerProcesses.map((item) => (
          <Item
            key={item.key}
            testID={`machine-processes-owner-row-${item.key}`}
            title={describeProcessTitle(item.row)}
            subtitle={
              <View style={styles.inline}>
                <ProcessIdentityText row={item.row} />
                <Text
                  style={styles.quiet}
                >{`${formatProcessCpu(item.cpuPercent)} ${t('machineProcesses.columns.cpu')}`}</Text>
                <ProcessOwnershipPill level={item.row.level} />
              </View>
            }
            detail={formatProcessMemory(item.memoryBytes)}
            onPress={() =>
              setParams({
                id: 'processes',
                page: 'process',
                process: item.row.ref,
                owner: owner.owner.rowId,
              })
            }
          />
        ))}
      </ItemGroup>
      <ItemGroup surface="none" header="none">
        <View style={styles.actions}>
          {owner.owner.owner.kind === 'session' ? (
            <>
              <RoundButton
                size="small"
                display="secondary"
                title={t('machineProcesses.menu.openSession')}
                onPress={() =>
                  owner.owner.owner.kind === 'session' &&
                  controller.openSession(owner.owner.owner.sessionId)
                }
              />
              <RoundButton
                size="small"
                display="secondary"
                title={t('machineProcesses.menu.stopSession')}
                disabled={!online}
                onPress={() => {
                  controller.stop(owner);
                  back();
                }}
              />
            </>
          ) : null}
          {owner.owner.owner.kind !== 'happier' ? (
            <RoundButton
              size="small"
              display="destructive"
              title={t('machineProcesses.menu.killTree')}
              disabled={!online}
              onPress={() => controller.killTree(owner)}
            />
          ) : null}
        </View>
        <Text style={styles.footnote}>{t('machineProcesses.phone.ownerFoot')}</Text>
      </ItemGroup>
    </View>
  );
}

/** What a row named by its display name also is ("Dev server · node"); nothing for a row its title already says. */
function ProcessIdentityText(props: Readonly<{ row: Parameters<typeof describeProcessIdentity>[0] }>) {
  const identity = describeProcessIdentity(props.row);
  return identity ? <Text numberOfLines={1} style={styles.quiet}>{identity}</Text> : null;
}

function OwnerMeters(
  props: Readonly<{
    memoryBytes: number | null;
    cpuPercent: number | null;
    memoryTotal: number | null;
    cores: number | null;
  }>,
) {
  const { memoryBytes, cpuPercent, memoryTotal, cores } = props;
  return (
    <ItemGroup header="none">
      <View style={styles.meters}>
        <VitalsMeterRow
          label={t('machineProcesses.tiles.memory')}
          strongLabel
          part={formatProcessMemory(memoryBytes)}
          whole={
            memoryTotal && memoryBytes !== null
              ? `· ${t('machineProcesses.phone.memoryOfMachine', { percent: formatVitalsPercent((memoryBytes / memoryTotal) * 100) })}`
              : ''
          }
              used={memoryBytes}
          capacity={memoryTotal ?? Math.max(1, memoryBytes ?? 1)}
          tone="calm"
          accessibilityLabel={`${t('machineProcesses.tiles.memory')} ${formatProcessMemory(memoryBytes)}`}
        />
        <VitalsMeterRow
          label={t('machineProcesses.tiles.cpu')}
          strongLabel
          part={formatProcessCpu(cpuPercent)}
          whole={
            cores
              ? `· ${t('machineProcesses.phone.cpuOfCores', { cores })}`
              : ''
          }
              used={cpuPercent}
          capacity={100}
          tone="calm"
          accessibilityLabel={`${t('machineProcesses.tiles.cpu')} ${formatProcessCpu(cpuPercent)}`}
        />
      </View>
    </ItemGroup>
  );
}

/** One process of an external app: its name and figures, with the tree's own row menu (copy its name, Kill). */
function AppMemberRow(props: Readonly<{ item: ProcessesAppMemberItem }>) {
  const { item } = props;
  const menu = useProcessRowActions(item).accessory;
  return (
    <Item
      testID={`machine-processes-app-row-${item.key}`}
      title={item.row.name}
      subtitle={
        <Text style={styles.quiet}>{`${formatProcessCpu(item.cpuPercent)} ${t('machineProcesses.columns.cpu')}`}</Text>
      }
      rightElement={
        <View style={styles.inline}>
          <Text style={styles.quiet}>{formatProcessMemory(item.memoryBytes)}</Text>
          {menu}
        </View>
      }
      rightElementOutsidePressable
      showChevron={false}
    />
  );
}

function OwnerHeader(
  props: Readonly<{
    owner: ProcessesOwnerItem;
    title: string;
    serverId: string;
    machineId: string;
    back: Readonly<{ label: string; onPress: () => void; testID: string }>;
  }>,
) {
  const status = useProcessOwnerStatus(props.owner.owner.owner, props.serverId);
  return (
    <MachineTabSubHead
      title={props.title}
      back={props.back}
      mark={
        <ProcessOwnerMark
          owner={props.owner.owner.owner}
          serverId={props.serverId}
          machineId={props.machineId}
          size={20}
        />
      }
    >
      {status ? (
        <Text
          style={[styles.quiet, status.color ? { color: status.color } : null]}
        >
          {status.text}
        </Text>
      ) : null}
    </MachineTabSubHead>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    gap: theme.space.s16,
  },
  meters: {
    gap: 14,
    padding: theme.space.s16,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  quiet: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s8,
  },
  footnote: {
    marginTop: theme.space.s12,
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));

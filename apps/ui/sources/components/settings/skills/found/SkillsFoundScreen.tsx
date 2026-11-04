import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { formatAgentNameListFolded } from '@/components/capabilities/identity/agentNameList';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { resolveProseDiffPresentation } from '@/components/ui/code/diff/diffPresentationStyle';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import {
  useFoundSkills,
  type FoundItem,
  type FoundMachineScan,
} from '@/sync/domains/skills/useFoundSkills';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useMachine } from '@/sync/store/hooks';
import { useReachMachines, type ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { formatLastSeen } from '@/utils/sessions/sessionUtils';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { skillHref } from '../skillsCollectionModel';
import {
  foldFoundRows,
  foundAddAllItems,
  groupFoundRowsByName,
  type FoundRowGroup,
  foundRowKind,
  orderFoundRows,
  partitionFoundMachines,
  resolveFoundMachineBody,
  type FoundRowKind,
} from './foundSkillsModel';

const NO_ITEMS: readonly FoundItem[] = Object.freeze([]);

/**
 * `/settings/skills/found`: the skills each machine's agents already keep in their own folders
 * (P6 §4.5, lab sf F/Fp). Read-only: Happier never edits them. One section per machine with the shared
 * capability rows, who reads each skill, Add to library (one, or all of a machine's), Make a copy for a
 * plugin's skill and Compare for a name the library already has. An offline machine keeps its last
 * known rows, dated, with Add off and the reason.
 */
export const SkillsFoundScreen = React.memo(function SkillsFoundScreen() {
  const { machines } = useReachMachines();
  const library = useSkillsLibrary();
  const ordered = React.useMemo(
    () => [...machines].sort((a, b) => Number(a.offline) - Number(b.offline)),
    [machines],
  );
  const machineIds = React.useMemo(
    () => ordered.map((machine) => machine.machineId),
    [ordered],
  );
  const found = useFoundSkills(machineIds);
  const placeMachines = React.useMemo(
    () => ordered.map((machine) => ({ machineId: machine.machineId, name: machineLabel(machine) })),
    [ordered],
  );
  // Names for every agent that reads a found skill, installed on its machine or not.
  const agentIds = React.useMemo(
    () => [
      ...new Set([
        ...ordered.flatMap((machine) => machine.agentIds),
        ...found.scans.flatMap((entry) => entry.result?.items.flatMap((item) => item.agents) ?? []),
      ]),
    ],
    [found.scans, ordered],
  );
  const { names } = useWhereItsOnNames({ agentIds, machines: placeMachines });
  const { scan } = found;
  const scanned = React.useRef(new Set<string>());

  // Only a machine REACH knows to be reachable is read: one whose presence is still unknown is not asked yet.
  const presence = useMachinePresenceSummaries(found.scope?.serverId, machineIds);
  const reachableIds = React.useMemo(
    () => machineIds.filter((_, index) => presence[index]?.reachability === 'reachable'),
    [machineIds, presence],
  );

  // Opening the page reads every machine that can answer, once; "Check again" reads them again.
  React.useEffect(() => {
    if (!found.ready) return;
    for (const machineId of reachableIds) {
      if (scanned.current.has(machineId)) continue;
      scanned.current.add(machineId);
      fireAndForget(scan(machineId), { tag: 'SkillsFound.scan' });
    }
  }, [found.ready, reachableIds, scan]);

  const checkAgain = React.useCallback(() => {
    for (const machineId of reachableIds) fireAndForget(scan(machineId), { tag: 'SkillsFound.checkAgain' });
  }, [reachableIds, scan]);

  const anyScanning = found.scans.some((entry) => entry.scanning);
  const libraryPending = library.status === 'loading' && library.items.length === 0;
  const libraryIdByName = React.useMemo(
    () => new Map(library.items.map((item) => [item.name, item.skillId])),
    [library.items],
  );
  const scanOf = React.useCallback(
    (machine: ReachMachine): FoundMachineScan =>
      found.scans.find((entry) => entry.machineId === machine.machineId) ?? emptyScan(machine.machineId),
    [found.scans],
  );

  return (
    <SkillsFoundPage
      machines={ordered}
      scanOf={scanOf}
      canCheckAgain={reachableIds.length > 0}
      checking={anyScanning}
      onCheckAgain={checkAgain}
      libraryIdByName={libraryIdByName}
      libraryPending={libraryPending}
      agentNames={names.agentNames}
      onScan={scan}
      adopt={found.adopt}
      readBoth={found.readBoth}
    />
  );
});

function emptyScan(machineId: string): FoundMachineScan {
  return { machineId, result: null, scanning: false, failure: null };
}

/**
 * The page itself, from data and handlers alone: the route feeds it live reads, the dev specimen feeds it
 * fixtures for the states a seeded Account cannot reach (offline, failed, older machine).
 */
export const SkillsFoundPage = React.memo(function SkillsFoundPage(
  props: Readonly<{
    machines: readonly ReachMachine[];
    scanOf: (machine: ReachMachine) => FoundMachineScan;
    canCheckAgain: boolean;
    checking: boolean;
    onCheckAgain: () => void;
    libraryIdByName: ReadonlyMap<string, string>;
    libraryPending: boolean;
    agentNames: (agentIds: readonly string[]) => readonly string[];
    onScan: (machineId: string) => Promise<void>;
    adopt: ReturnType<typeof useFoundSkills>['adopt'];
    readBoth: ReturnType<typeof useFoundSkills>['readBoth'];
  }>,
) {
  const { scanOf } = props;
  const { sections, unseenOffline } = React.useMemo(
    () => partitionFoundMachines(props.machines, scanOf),
    [props.machines, scanOf],
  );
  return (
    <ItemList keyboardShouldPersistTaps="handled">
      <PageHeader
        testID="skills.found.header"
        title={t('capabilities.skillsFound.title')}
        alwaysShowTitle
        description={t('capabilities.skillsFound.purpose')}
        actions={
          props.canCheckAgain ? (
            <SectionActionButton
              testID="skills.found.checkAgain"
              title={t('capabilities.skillsFound.checkAgain')}
              icon="arrow-clockwise"
              loading={props.checking}
              disabled={props.checking}
              onPress={props.onCheckAgain}
            />
          ) : undefined
        }
      />
      {props.machines.length === 0 ? (
        <SurfaceStateCard
          testID="skills.found.noMachines"
          size="page"
          kind="empty"
          title={t('capabilities.skillsFound.noMachinesTitle')}
          reason={t('capabilities.skillsFound.noMachinesBody')}
        />
      ) : null}
      {sections.map((machine) => (
        <FoundMachineSection
          key={machine.machineId}
          machine={machine}
          scan={scanOf(machine)}
          libraryIdByName={props.libraryIdByName}
          libraryPending={props.libraryPending}
          agentNames={props.agentNames}
          onScan={props.onScan}
          adopt={props.adopt}
          readBoth={props.readBoth}
        />
      ))}
      {unseenOffline > 0 ? (
        <ItemGroup header="none">
          <SurfaceStateCard
            testID="skills.found.unseenOffline"
            size="line"
            kind="unavailable"
            title={t('capabilities.skillsFound.offlineUnseen', { count: unseenOffline })}
          />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

function machineLabel(machine: ReachMachine): string {
  return machine.name ?? machine.machineId;
}

const FoundMachineSection = React.memo(function FoundMachineSection(
  props: Readonly<{
    machine: ReachMachine;
    scan: FoundMachineScan;
    libraryIdByName: ReadonlyMap<string, string>;
    /** The library is still being read: Compare keeps its place, off, rather than appearing late. */
    libraryPending: boolean;
    agentNames: (agentIds: readonly string[]) => readonly string[];
    onScan: (machineId: string) => Promise<void>;
    adopt: ReturnType<typeof useFoundSkills>['adopt'];
    readBoth: ReturnType<typeof useFoundSkills>['readBoth'];
  }>,
) {
  const { machine, scan } = props;
  const { theme } = useUnistyles();
  const router = useRouter();
  const name = machineLabel(machine);
  const homeDir = useMachine(machine.machineId)?.metadata?.homeDir ?? undefined;
  const [expanded, setExpanded] = React.useState(false);
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(() => new Set());
  const [comparing, setComparing] = React.useState<string | null>(null);
  const body = resolveFoundMachineBody(scan);
  const items = body.kind === 'rows' ? body.items : NO_ITEMS;
  // One row per skill name: the copies in other agents' folders fold into it.
  const groups = React.useMemo(() => groupFoundRowsByName(orderFoundRows(items)), [items]);
  const folded = foldFoundRows(groups, expanded);
  const addAll = React.useMemo(() => foundAddAllItems(groups.map((group) => group.item)), [groups]);
  const canAdd = machine.online === true;

  const open = React.useCallback(
    (skillId: string) => {
      const result = runGuardedNavigation(() => router.push(skillHref(skillId) as never));
      if (result !== true) fireAndForget(result, { tag: 'SkillsFound.open' });
    },
    [router],
  );

  // Adding keeps the row busy until the machine has been read again, so it settles on "In your library"
  // rather than flashing between states.
  const adopt = React.useCallback(
    async (batch: readonly FoundItem[]) => {
      const paths = batch.map((item) => item.path);
      setAdding((prev) => new Set([...prev, ...paths]));
      try {
        const outcome = await props.adopt(machine.machineId, batch);
        if (outcome === null) {
          Modal.alert(
            t('common.error'),
            t('capabilities.skillsFound.addFailed', { name: batch.length === 1 ? batch[0]!.name : name }),
          );
          return;
        }
        if (outcome.incomplete) {
          Modal.alert(
            t('common.error'),
            t('capabilities.skillsFound.addedPartial', { name: batch.length === 1 ? batch[0]!.name : name }),
          );
        }
        await props.onScan(machine.machineId);
      } finally {
        setAdding((prev) => {
          const next = new Set(prev);
          for (const path of paths) next.delete(path);
          return next;
        });
      }
    },
    [machine.machineId, name, props],
  );

  const titleAccessory = (
    <View style={styles.titleAccessory}>
      {body.kind === 'rows' ? (
        <Text variant="meta" style={styles.count}>
          {String(groups.length)}
        </Text>
      ) : null}
      {machine.offline ? (
        <CapabilityStatusChip
          testID={`skills.found.offline.${machine.machineId}`}
          status={{
            kind: 'offline',
            ...(scan.result
              ? { detail: t('capabilities.skillsFound.lastKnown', { time: formatLastSeen(machine.lastSeenAt ?? 0) }) }
              : {}),
          }}
        />
      ) : null}
    </View>
  );

  const renderRow = (group: FoundRowGroup) => {
    const { item } = group;
    const kind = foundRowKind(item);
    const busy = adding.has(item.path);
    const libraryId = item.inLibrary ?? props.libraryIdByName.get(item.name) ?? null;
    return (
      <React.Fragment key={item.path}>
        <CapabilityRow
          testID={`skills.found.row.${machine.machineId}.${item.name}`}
          title={item.name}
          description={item.description}
          facts={{
            presentation: 'row',
            extra: foundFacts(group, props.agentNames, homeDir),
          }}
          note={
            kind === 'masks' ? (
              <View style={styles.noteBox} testID={`skills.found.mask.${item.name}`}>
                <Icon name="copy" size={16} color={theme.colors.text.secondary} />
                <Text variant="body" style={styles.noteText}>
                  {t('capabilities.skillsFound.masks', { machine: name })}
                </Text>
              </View>
            ) : undefined
          }
          action={rowAction({
            kind,
            busy,
            canAdd,
            onAdd: () => void adopt([item]),
            onCompare: () => setComparing((current) => (current === item.path ? null : item.path)),
            comparing: comparing === item.path,
            compareAvailable: libraryId !== null,
            comparePending: props.libraryPending,
            onOpen: libraryId ? () => open(libraryId) : undefined,
            testID: `skills.found.action.${machine.machineId}.${item.name}`,
          })}
          stackActionWhenNarrow
          {...(kind === 'in_library' && libraryId ? { onPress: () => open(libraryId) } : {})}
          density="page"
        />
        {kind === 'masks' && comparing === item.path && libraryId ? (
          <FoundCompare
            machineName={name}
            machineId={machine.machineId}
            path={item.path}
            libraryId={libraryId}
            readBoth={props.readBoth}
            testID={`skills.found.compare.${item.name}`}
          />
        ) : null}
      </React.Fragment>
    );
  };

  return (
    <ItemGroup
      testID={`skills.found.machine.${machine.machineId}`}
      title={name}
      titleLeading={<Icon name="desktop" size={18} color={theme.colors.text.secondary} />}
      titleAccessory={titleAccessory}
      {...(addAll.length > 1 && canAdd
        ? {
            action: (
              <SectionActionButton
                testID={`skills.found.addAll.${machine.machineId}`}
                title={t('capabilities.skillsFound.addAll', { count: addAll.length })}
                icon="plus"
                loading={addAll.every((item) => adding.has(item.path))}
                disabled={addAll.some((item) => adding.has(item.path))}
                onPress={() => void adopt(addAll)}
              />
            ),
          }
        : {})}
      {...(machine.offline && scan.result
        ? { description: t('capabilities.skillsFound.offlineBring', { machine: name }) }
        : {})}
    >
      {body.kind === 'looking' ? (
        <SurfaceStateCard
          testID={`skills.found.looking.${machine.machineId}`}
          size="line"
          kind="loading"
          title={t('capabilities.skillsFound.looking')}
        />
      ) : null}
      {body.kind === 'older_machine' ? (
        <SurfaceStateCard
          testID={`skills.found.older.${machine.machineId}`}
          size="line"
          kind="empty"
          title={t('capabilities.skillsFound.olderMachine', { machine: name })}
        />
      ) : null}
      {machine.online === true && (body.kind === 'failed' || (scan.failure === 'failed' && body.kind !== 'older_machine')) ? (
        <SurfaceStateCard
          testID={`skills.found.failed.${machine.machineId}`}
          size="line"
          kind="error"
          title={t('capabilities.skillsFound.scanFailed', { machine: name })}
          action={{
            label: t('capabilities.skillsFound.tryAgain'),
            onPress: () => void props.onScan(machine.machineId),
          }}
        />
      ) : null}
      {body.kind === 'empty' ? (
        <SurfaceStateCard
          testID={`skills.found.empty.${machine.machineId}`}
          size="line"
          kind="empty"
          title={t('capabilities.skillsFound.nothingHere')}
        />
      ) : null}
      {scan.result?.roots
        .filter((root) => root.status === 'failed')
        .map((root) => (
          <SurfaceStateCard
            key={root.path}
            testID={`skills.found.rootFailed.${machine.machineId}`}
            size="line"
            kind="error"
            title={t('capabilities.skillsFound.rootFailed', { path: formatPathRelativeToHome(root.path, homeDir) })}
            action={{
              label: t('capabilities.skillsFound.checkAgain'),
              onPress: () => void props.onScan(machine.machineId),
            }}
          />
        ))}
      {folded.shown.map(renderRow)}
      {folded.hidden > 0 ? (
        <SectionContentRow showDivider testID={`skills.found.more.${machine.machineId}`}>
          <RoundButton
            size="small"
            display="inverted"
            title={t('capabilities.skillsFound.more', { count: folded.hidden })}
            textStyle={{ color: theme.colors.text.secondary }}
            onPress={() => setExpanded(true)}
          />
        </SectionContentRow>
      ) : null}
      {expanded && foldFoundRows(groups, false).hidden > 0 ? (
        <SectionContentRow showDivider testID={`skills.found.fewer.${machine.machineId}`}>
          <RoundButton
            size="small"
            display="inverted"
            title={t('capabilities.skillsFound.showFewer')}
            textStyle={{ color: theme.colors.text.secondary }}
            onPress={() => setExpanded(false)}
          />
        </SectionContentRow>
      ) : null}
    </ItemGroup>
  );
});

/** "Claude, Codex and 7 more read it · From the frontend plugin": who reads it, then provenance, then where it lives. */
function foundFacts(
  group: FoundRowGroup,
  agentNames: (agentIds: readonly string[]) => readonly string[],
  homeDir: string | undefined,
): readonly (string | Readonly<{ text: string; mono: true }>)[] {
  const { item } = group;
  const facts: (string | Readonly<{ text: string; mono: true }>)[] = [];
  const agents = agentNames(group.agents);
  if (agents.length > 0) {
    facts.push(t('capabilities.skillsFound.readBy', { agents: formatAgentNameListFolded(agents), count: agents.length }));
  }
  if (item.pluginOwned) {
    facts.push(t('capabilities.skillsFound.fromPlugin', { plugin: item.pluginOwned.pluginName }));
  } else if (item.happierInstalled) {
    facts.push(t('capabilities.skillsFound.installedByHappier'));
  }
  // Where it lives: its first folder, and how many other folders hold the same name.
  const [folder, ...others] = group.folders;
  if (folder !== undefined) facts.push({ text: formatPathRelativeToHome(folder, homeDir), mono: true });
  if (others.length > 0) facts.push(t('capabilities.where.more', { count: others.length }));
  return facts;
}

function rowAction(
  input: Readonly<{
    kind: FoundRowKind;
    busy: boolean;
    canAdd: boolean;
    onAdd: () => void;
    onCompare: () => void;
    comparing: boolean;
    compareAvailable: boolean;
    comparePending: boolean;
    onOpen: (() => void) | undefined;
    testID: string;
  }>,
): React.ReactNode {
  switch (input.kind) {
    case 'in_library':
      return (
        <Text variant="meta" style={styles.held} testID={input.testID}>
          {t('capabilities.skillsFound.inLibrary')}
        </Text>
      );
    case 'masks':
      return input.compareAvailable || input.comparePending ? (
        <RoundButton
          testID={input.testID}
          size="small"
          display="secondary"
          disabled={!input.compareAvailable}
          title={input.comparing ? t('capabilities.skillsFound.hideCompare') : t('capabilities.skillsFound.compare')}
          onPress={input.onCompare}
        />
      ) : null;
    case 'plugin':
    case 'addable':
      return (
        <RoundButton
          testID={input.testID}
          size="small"
          display="secondary"
          title={
            input.busy
              ? t('capabilities.skillsFound.adding')
              : input.kind === 'plugin'
                ? t('capabilities.skillsFound.makeCopy')
                : t('capabilities.skillsFound.add')
          }
          loading={input.busy}
          disabled={!input.canAdd || input.busy}
          onPress={input.onAdd}
        />
      );
  }
}

/** Compare (sf F): the library's SKILL.md beside the machine's, read when it opens. */
function FoundCompare(
  props: Readonly<{
    machineName: string;
    machineId: string;
    path: string;
    libraryId: string;
    readBoth: ReturnType<typeof useFoundSkills>['readBoth'];
    testID: string;
  }>,
) {
  const [state, setState] = React.useState<
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'failed' }>
    | Readonly<{ kind: 'ready'; yours: string; theirs: string }>
  >({ kind: 'loading' });
  const { readBoth, machineId, path, libraryId } = props;
  React.useEffect(() => {
    let cancelled = false;
    void readBoth(machineId, path, libraryId).then(
      (result) => {
        if (!cancelled) setState(result ? { kind: 'ready', ...result } : { kind: 'failed' });
      },
      () => {
        if (!cancelled) setState({ kind: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [readBoth, machineId, path, libraryId]);
  const [width, setWidth] = React.useState<number | null>(null);
  return (
    <SectionContentRow showDivider testID={props.testID}>
      {state.kind === 'ready' ? (
        <View onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}>
        <DiffViewer
          mode="text"
          face="prose"
          oldText={state.yours}
          newText={state.theirs}
          filePath="SKILL.md"
          wrapLines
          presentationStyleOverride={resolveProseDiffPresentation(width)}
          prose={{
            oldLabel: (
              <Text variant="label" emphasis="semiBold" style={styles.compareLabel}>
                {t('capabilities.skillsFound.compareYours')}
              </Text>
            ),
            newLabel: (
              <Text variant="label" emphasis="semiBold" style={styles.compareLabel}>
                {t('capabilities.skillsFound.compareTheirs', { machine: props.machineName })}
              </Text>
            ),
          }}
        />
        </View>
      ) : state.kind === 'failed' ? (
        <Text variant="meta" style={styles.quiet}>
          {t('capabilities.skillsFound.compareFailed', { machine: props.machineName })}
        </Text>
      ) : (
        <Text variant="meta" style={styles.quiet}>
          {t('capabilities.skillsFound.looking')}
        </Text>
      )}
    </SectionContentRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  titleAccessory: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexShrink: 1 },
  count: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  held: { color: theme.colors.text.secondary },
  compareLabel: { color: theme.colors.text.primary },
  quiet: { color: theme.colors.text.tertiary },
  noteBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.inset,
  },
  noteText: { flexShrink: 1, color: theme.colors.text.secondary },
}));

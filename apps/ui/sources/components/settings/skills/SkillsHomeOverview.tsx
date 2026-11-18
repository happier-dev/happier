import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import {
  usePathname,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { HomeOrbitMap } from '@/components/atmosphere/orbit/HomeOrbitMap';
import { layoutHomeOrbitScene } from '@/components/atmosphere/orbit/homeOrbitScene';
import { formatAgentNameList } from '@/components/capabilities/identity/agentNameList';
import {
  CapabilityReachLegend,
  type CapabilityReachLegendRow,
} from '@/components/capabilities/reach/CapabilityReachLegend';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { SkillMark } from './SkillKindGlyph';
import { pickMostBlockingCapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { shortWhereItsOn } from '@/components/capabilities/where/whereItsOnPresentation';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import {
  useOpenSkillAddModal,
  useSkillAddRouteParams,
} from './add/useOpenSkillAddModal';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  SKILLS_COLLECTION_ROUTE,
  buildSkillsReach,
  skillDisplayName,
  skillHref,
  skillSource,
  type SkillsPresent,
  type SkillsReach,
  foldReachMachines,
  skillsReachLegendCount,
  hasOwnSkills,
} from './skillsCollectionModel';
import { usePreviewedSkill } from './skillsPreviewStore';
import { arrivedReachDots } from './skillsReachTravel';
import { skillStatus } from './status/skillStatus';
import { useSkillsHomepageModel } from './useSkillsHomepageModel';
import { SKILLS_CHOOSE_ROUTE } from './firstRun/useSkillsFirstRun';
import {
  SKILLS_UPDATES_ROUTE,
  needsALookDestination,
} from './updates/skillsUpdatesModel';
import { useOpenSkillsFound } from './found/SkillsFoundBlock';
import { SKILLS_FOUND_ROUTE } from './found/foundSkillsModel';
import type { SkillNeedsALookEntry } from './status/skillStatus';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useFoundSkillsCount } from '@/sync/domains/skills/useFoundSkills';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useSkillSourceNames } from './useSkillSourceNames';

/**
 * The reach map's box beside its legend (lab hs-A: a 284 × 264 scene around a 42 px planet). The orbits
 * sit at the box's leading edge and the space after them holds the moons' names; the legend takes the
 * rest of the row, so a machine's name, its Agents and "Offline · last known" read whole (lab hs A2).
 */
const MAP_BOX = {
  width: 300,
  height: 268,
  planetRadius: 40,
  planetX: 128,
} as const;
/**
 * Machines the map and its legend draw: what fits beside the map at the legend's row height (four
 * described rows), so the map stays readable and its labels never pile up on a busy Account.
 */
const MAP_MACHINE_ROOM = 4;
/** The legend's narrowest useful column: a machine name, one line of agents and the count. */
const LEGEND_MIN_PX = 232;
/** The gap between map and legend (`theme.space.s24`). */
const REACH_GAP_PX = 24;
/** Beside the legend, the map gives up its name room first, down to the orbits plus a short name. */
const MAP_MIN_WIDTH_PX = 300;
/** Under this content width the legend moves beneath the map. */
const REACH_SIDE_BY_SIDE_MIN_PX =
  MAP_MIN_WIDTH_PX + REACH_GAP_PX + LEGEND_MIN_PX;

function useOpen() {
  const router = useRouter();
  return React.useCallback(
    (href: string) => {
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true)
        fireAndForget(result, { tag: 'SkillsHomepage.open' });
    },
    [router],
  );
}

/** Shared reach, present and attention; neither a scroll owner nor a recommendation reader. */
export type SkillsHomeReach = Pick<ReturnType<typeof useReachMachines>, 'machines' | 'placeMachines' | 'agentIds'>;

export const SkillsHomeOverview = React.memo(function SkillsHomeOverview(
  props: Readonly<{ library: SkillsLibrary; showHeader?: boolean }>,
) {
  const reach = useReachMachines();
  return <SkillsHomeOverviewView {...props} reach={reach} />;
});

/** The overview's presentation over the Machine facts admitted by its read owner. */
export const SkillsHomeOverviewView = React.memo(function SkillsHomeOverviewView(
  props: Readonly<{ library: SkillsLibrary; showHeader?: boolean; reach: SkillsHomeReach }>,
) {
  const { library } = props;
  const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
  const sourceNameFor = useSkillSourceNames();
  const open = useOpen();
  const openAdd = useOpenSkillAddModal();
  useSkillAddRouteParams();
  const { theme } = useUnistyles();
  const router = useRouter();
  const pathname = usePathname().replace(/\/+$/, '');
  const { machines, placeMachines, agentIds } = props.reach;
  const { names } = useWhereItsOnNames({
    agentIds,
    machines: placeMachines,
  });
  const { reach, needs, firstVisit, present } = useSkillsHomepageModel(
    library,
    machines,
  );
  const previewed = usePreviewedSkill();
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.machineId),
    [machines],
  );
  // Anticipation on an empty library: this device's last known scans, never a machine read on open.
  const foundCount = useFoundSkillsCount(machineIds);
  const openFound = useOpenSkillsFound();
  const filterMachine = React.useCallback(
    (machineId: string) => {
      const href = `${SKILLS_COLLECTION_ROUTE}?machine=${encodeURIComponent(machineId)}`;
      const result = runGuardedNavigation(() =>
        pathname === SKILLS_COLLECTION_ROUTE
          ? router.replace(href as never)
          : router.push(href as never),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'SkillsHomepage.filterMachine' });
    },
    [pathname, router],
  );

  const loading = library.status === 'loading' && library.items.length === 0;
  const unavailable =
    library.status === 'unavailable' && library.items.length === 0;
  // Only the person's own skills count: the built-in one is always listed (P6 §4.1).
  const empty = library.status === 'ready' && !hasOwnSkills(library.items);

  // A returning visit is titled by the page itself; the present lives in the sentence (lab hs A2/A3).
  // A brand-new library keeps the page's anatomy (lab hs A4): the map shows where a skill will ride.
  const headline = empty
    ? t('capabilities.skills.home.emptyTitle')
    : firstVisit
      ? t('capabilities.skills.home.firstHeadline')
      : t('capabilities.skills.title');
  const purpose = empty
    ? t('capabilities.skills.home.emptyBody')
    : firstVisit
      ? t('capabilities.skills.home.firstPurpose')
      : t('capabilities.skills.pageDescription');

  return (
    <>
      {props.showHeader === false ? null : (
        <PageHeader
          testID="skills.home.header"
          title={headline}
          alwaysShowTitle
          description={purpose}
          // The page's one primary action (lab k:home); brand new and first visit lead with their own first step.
          {...(empty || firstVisit || loading || unavailable
            ? {}
            : {
                actionsPlacement: 'page' as const,
                actions: (
                  <RoundButton
                    testID="skills.home.add"
                    title={t('capabilities.skills.addSkill')}
                    leading={
                      <Icon
                        name="plus"
                        size={16}
                        color={theme.colors.button.primary.tint}
                      />
                    }
                    onPress={() => openAdd()}
                  />
                ),
              })}
        />
      )}
      {/* What needs the person leads; the map says how the rest reaches the machines. */}
      {needs.length > 0 ? (
        <ItemGroup
          title={t('capabilities.skills.home.needsLook')}
          titleAccessory={
            <Text variant="meta" style={styles.groupCount}>
              {String(needs.length)}
            </Text>
          }
        >
          {needs.map((entry) => (
            <NeedsALookRow
              key={`${entry.kind}:${entry.key}`}
              entry={entry}
              names={names}
              installedPlugins={pluginUiProjection?.installedPackagesById}
              registrySourceName={
                entry.kind === 'unreadable'
                  ? undefined
                  : sourceNameFor(entry.item)
              }
              onOpen={() => {
                // Unreadable: read the library again. Masked: Compare lives on Found. Updates: the
                // Updates page; a dropped source: the skill itself.
                if (entry.kind === 'unreadable') library.retry();
                else if (entry.kind === 'masked') open(SKILLS_FOUND_ROUTE);
                else
                  open(
                    needsALookDestination(entry.item) === 'updates'
                      ? SKILLS_UPDATES_ROUTE
                      : skillHref(entry.item.skillId),
                  );
              }}
            />
          ))}
        </ItemGroup>
      ) : null}
      {/* The map, its legend and the sentence sit on the sections' content edge, under the header's text. */}
      <View style={styles.inset}>
        {unavailable ? (
          <SurfaceStateCard
            testID="skills.home.error"
            size="page"
            kind="error"
            title={t('capabilities.skills.loadFailed')}
            diagnosticCode={library.errorCode ?? undefined}
            action={{ label: t('common.retry'), onPress: library.retry }}
          />
        ) : (
          <ReachBlock
            reach={reach}
            items={library.items}
            loading={loading}
            previewed={previewed}
            firstVisit={firstVisit !== null}
            onMachinePress={filterMachine}
          />
        )}
        {loading || unavailable ? null : (
          <PresentSentence present={present} agentNames={names.agentNames} />
        )}
        {firstVisit && !empty ? (
          <View style={styles.acts}>
            <RoundButton
              testID="skills.home.choose"
              title={t('capabilities.skills.home.choose')}
              onPress={() => open(SKILLS_CHOOSE_ROUTE)}
            />
            <Text variant="meta" style={styles.actsNote}>
              {t('capabilities.skills.home.nothingElse')}
            </Text>
          </View>
        ) : null}
        {empty ? (
          <View style={styles.acts}>
            <RoundButton
              testID="skills.home.empty.add"
              title={t('capabilities.skills.addSkill')}
              leading={
                <Icon
                  name="plus"
                  size={16}
                  color={theme.colors.button.primary.tint}
                />
              }
              onPress={() => openAdd()}
            />
            <RoundButton
              testID="skills.home.empty.write"
              display="secondary"
              title={t('capabilities.skills.home.writeOwn')}
              onPress={() => openAdd({ modeKey: 'write' })}
            />
          </View>
        ) : null}
        {/* Anticipation (P6 §4.2): what this device last saw on the machines, never a machine read. */}
        {empty && foundCount > 0 ? (
          <View style={styles.anticipation}>
            <Text variant="meta" style={styles.actsNote}>
              {t('capabilities.skillsFound.alreadyOnMachines', {
                count: foundCount,
              })}
            </Text>
            <TextLinkButton
              testID="skills.home.empty.reviewFound"
              label={t('capabilities.skills.home.review')}
              onPress={openFound}
            />
          </View>
        ) : null}
      </View>
      {/* P6 §4.2 order: what needs the person comes before the standing rule. */}
      {firstVisit || empty ? (
        <ItemGroup
          title={t('capabilities.skills.home.whereTitle')}
          description={t('capabilities.skills.home.whereBody')}
          surface="none"
        >
          {null}
        </ItemGroup>
      ) : null}
    </>
  );
});

function NeedsALookRow(
  props: Readonly<{
    entry: SkillNeedsALookEntry;
    names: ReturnType<typeof useWhereItsOnNames>['names'];
    installedPlugins: Parameters<typeof skillSource>[2];
    registrySourceName?: string;
    onOpen: () => void;
  }>,
) {
  const { entry } = props;
  if (entry.kind === 'unreadable') {
    // Identity is all that is known: no description, source or cost is invented for it.
    return (
      <CapabilityRow
        testID={`skills.home.needs.${entry.key}`}
        title={skillDisplayName(entry.unavailable.title, entry.key)}
        mark={<SkillMark />}
        // The description says what is wrong; the shared error chip ("Couldn't start") would say a second, wrong thing.
        description={t('capabilities.skills.home.unreadable')}
        action={
          <RoundButton
            size="small"
            display="secondary"
            title={t('common.retry')}
            onPress={props.onOpen}
          />
        }
      />
    );
  }
  const { item } = entry;
  const description =
    entry.kind === 'masked'
      ? t('capabilities.skills.home.maskedOn', { machine: entry.machineName })
      : entry.kind === 'removed'
        ? // The status word says "Removed from source"; the line goes on with what the skill is, as the column does.
          item.description
        : item.modified
          ? t('capabilities.skills.home.modifiedUpstream')
          : t('capabilities.skills.home.updateWaiting');
  const fix =
    entry.kind === 'masked'
      ? t('capabilities.skillsFound.compare')
      : entry.kind === 'removed'
        ? t('capabilities.skills.home.decide')
        : t('capabilities.skills.home.review');
  return (
    <CapabilityRow
      testID={`skills.home.needs.${item.skillId}`}
      title={item.name}
      // The same mark as the skill's column row (X3).
      mark={<SkillMark firstParty={item.provenance.kind === 'first_party'} />}
      description={description}
      whereSummary={shortWhereItsOn(item.rules, props.names)}
      facts={{
        presentation: 'row',
        source: skillSource(
          item,
          props.names.machineName,
          props.installedPlugins,
          props.registrySourceName,
        ),
        trust: item.trust,
      }}
      // A masked row says it once, in its description; the chip would repeat it.
      status={
        entry.kind === 'masked'
          ? undefined
          : pickMostBlockingCapabilityStatus(skillStatus(item), 'row')
      }
      action={
        <RoundButton
          size="small"
          display="secondary"
          title={fix}
          onPress={props.onOpen}
        />
      }
      onPress={props.onOpen}
    />
  );
}

/** The map and its legend: machines as moons, each skill a dot riding to every machine it reaches. */
const ReachBlock = React.memo(function ReachBlock(
  props: Readonly<{
    reach: SkillsReach;
    items: readonly SkillListItemV1[];
    loading: boolean;
    previewed: string | null;
    firstVisit: boolean;
    onMachinePress: (machineId: string) => void;
  }>,
) {
  const [width, setWidth] = React.useState(0);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) =>
      setWidth(Math.round(event.nativeEvent.layout.width)),
    [],
  );
  const { reach } = props;
  const sideBySide = width >= REACH_SIDE_BY_SIDE_MIN_PX;
  const mapWidth = sideBySide
    ? Math.min(MAP_BOX.width, width - REACH_GAP_PX - LEGEND_MIN_PX)
    : MAP_BOX.width;
  const mapHeight = MAP_BOX.height;
  const pr = MAP_BOX.planetRadius;
  const folded = React.useMemo(
    () => foldReachMachines(reach.machines, MAP_MACHINE_ROOM),
    [reach.machines],
  );
  // Off skills wait under the Home on a first visit: no dots for them (P6 §4.2).
  const bodies = React.useMemo(() => {
    const shown = reach.bodies.slice(0, folded.shown.length);
    return props.firstVisit
      ? shown.map((body) => ({ ...body, dots: [] }))
      : shown;
  }, [folded.shown.length, props.firstVisit, reach.bodies]);
  const scene = React.useMemo(
    () =>
      layoutHomeOrbitScene(mapWidth, mapHeight, bodies, {
        pr,
        px: MAP_BOX.planetX,
        radii: [1.7, 2.3, 2.9].map((k) => k * pr),
        angles: [-40, 32, 140],
        dotGap: 8.6,
      }),
    [bodies, mapHeight, mapWidth, pr],
  );
  const travel = useReachTravel(bodies, props.loading);
  const labels = React.useMemo(
    () =>
      Object.fromEntries(
        folded.shown.map((row) => [
          row.machine.machineId,
          row.machine.name ?? row.machine.machineId,
        ]),
      ),
    [folded.shown],
  );
  const previewItem = props.previewed
    ? (props.items.find((item) => item.skillId === props.previewed) ?? null)
    : null;
  const highlight = React.useMemo(
    () => (previewItem ? new Set([previewItem.skillId]) : null),
    [previewItem],
  );
  const preview = React.useMemo(() => {
    if (!previewItem) return null;
    const machines = folded.shown.map((row) => row.machine);
    const projection = buildSkillsReach([previewItem], machines);
    return Object.fromEntries(
      projection.machines.map((row) => [row.machine.machineId, row.agentIds]),
    );
  }, [previewItem, folded.shown]);
  const legendRows = React.useMemo(
    (): CapabilityReachLegendRow[] =>
      folded.shown.map((row) => ({
        machineId: row.machine.machineId,
        name: row.machine.name ?? row.machine.machineId,
        offline: row.machine.offline,
        lastSeenAt: row.machine.lastSeenAt,
        agentIds: row.machine.online === null ? [] : row.supportedAgentIds,
        noSkillAgents:
          row.machine.agentIds.length > 0 && row.supportedAgentIds.length === 0,
        inventoryUnknown:
          row.machine.online === null ||
          row.machine.agentInventoryComplete === false,
        count:
          row.machine.online === null
            ? null
            : skillsReachLegendCount(row, props.firstVisit),
      })),
    [props.firstVisit, folded.shown],
  );
  const label = t('capabilities.skills.home.mapLabel', {
    skills: props.items.length,
    machines: reach.machines.length,
  });
  return (
    <View
      testID="skills.home.reach"
      onLayout={onLayout}
      style={[styles.reach, sideBySide ? styles.reachRow : null]}
    >
      {width > 0 ? (
        <HomeOrbitMap
          testID="skills.home.map"
          scene={scene}
          labels={labels}
          highlightKeys={highlight}
          travel={travel}
          onBodyPress={props.onMachinePress}
          accessibilityLabel={label}
        />
      ) : (
        <View style={{ height: mapHeight }} />
      )}
      {reach.machines.length > 0 ? (
        <View style={sideBySide ? styles.legendSide : styles.legendBelow}>
          <CapabilityReachLegend
            testID="skills.home.legend"
            rows={legendRows}
            preview={preview}
            more={folded.more}
            onMachinePress={props.onMachinePress}
          />
        </View>
      ) : null}
    </View>
  );
});

/**
 * Skills that just started reaching a machine (Turn on, a where-it's-on change) travel out from the
 * planet once (P5 `travel`). The first drawn map is the baseline, so nothing moves on arrival.
 */
function useReachTravel(
  bodies: readonly Readonly<{ dots: readonly Readonly<{ key: string }>[] }>[],
  loading: boolean,
): Readonly<{ id: string; dotKeys: readonly string[] }> | null {
  const seen = React.useRef<ReadonlySet<string> | null>(null);
  const [travel, setTravel] = React.useState<Readonly<{
    id: string;
    dotKeys: readonly string[];
  }> | null>(null);
  React.useEffect(() => {
    if (loading) return;
    const next = arrivedReachDots(seen.current, bodies);
    seen.current = next.seen;
    if (next.arrived.length > 0)
      setTravel({
        id: `${Date.now()}:${next.arrived.join(',')}`,
        dotKeys: next.arrived,
      });
  }, [bodies, loading]);
  return travel;
}

/** One quiet line of the present: what reaches whom, what needs a look, who catches up later. */
function PresentSentence(
  props: Readonly<{
    present: SkillsPresent;
    agentNames: (agentIds: readonly string[]) => readonly string[];
  }>,
) {
  const { present, agentNames } = props;
  const named =
    present.kind === 'reach'
      ? present.agentIds
      : present.kind === 'unsupported'
        ? present.agentIds
        : NO_AGENTS;
  const unsupported =
    present.kind === 'reach' ? present.unsupportedAgentIds : NO_AGENTS;
  // The names the legend and Where it's on show, from the page's own places: an Agent instance reads by title, never by its runtime id.
  const agents = React.useMemo(() => agentNames(named), [named, agentNames]);
  const unsupportedNames = React.useMemo(
    () => agentNames(unsupported),
    [unsupported, agentNames],
  );
  // Names stay as written: a digit inside "NLDW4-5-40-40" or an Agent title is part of a name, not a count.
  const names = React.useMemo(
    () => [
      ...agents,
      ...unsupportedNames,
      ...(present.kind === 'reach' ? present.catchUp : NO_AGENTS),
    ],
    [agents, unsupportedNames, present],
  );
  let text: string;
  // The part of the sentence that needs the person (amber, as the lab's "2 need a look").
  let attention = '';
  let tail = '';
  switch (present.kind) {
    case 'new':
      text = t('capabilities.skills.home.emptySentence');
      break;
    case 'first':
      text = t('capabilities.skills.home.firstSentence', present);
      break;
    case 'noMachines':
      text = t('capabilities.skills.home.noMachines');
      break;
    case 'waiting':
      text = t('capabilities.skills.home.reachWaiting', { count: present.on });
      break;
    case 'unsupported':
      text = t('capabilities.skills.home.unsupported', {
        count: present.on,
        agents: formatAgentNameList(agents),
      });
      break;
    case 'none':
      text = t('capabilities.skills.home.reachNone');
      break;
    case 'reach': {
      text = t('capabilities.skills.home.reach', {
        count: present.count,
        agents: formatAgentNameList(agents),
        machines: present.machines,
      });
      if (present.needs > 0)
        attention = t('capabilities.skills.home.reachNeedLook', {
          count: present.needs,
        });
      tail = '.';
      if (present.catchUp.length === 1)
        tail += ` ${t('capabilities.skills.home.catchesUp', { machines: present.catchUp[0]! })}`;
      else if (present.catchUp.length > 1)
        tail += ` ${t('capabilities.skills.home.catchUpCount', { count: present.catchUp.length })}`;
      if (unsupportedNames.length > 0)
        tail += ` ${t('capabilities.skills.home.unsupportedNote', { agents: formatAgentNameList(unsupportedNames) })}`;
      break;
    }
  }
  return (
    <Text
      testID="skills.home.sentence"
      variant="reading"
      style={styles.sentence}
    >
      {withEmphasizedCounts(text, 'count', names)}
      {attention ? (
        <Text style={styles.attention}>
          {withEmphasizedCounts(attention, 'att', names)}
        </Text>
      ) : null}
      {withEmphasizedCounts(tail, 'tail', names)}
    </Text>
  );
}

const NO_AGENTS: readonly string[] = Object.freeze([]);

/**
 * The sentence's counts read as facts: the numbers in ink, a step heavier than the words (lab `hm-num`).
 * Digits inside an interpolated name (a Machine or Agent title) are not counts and stay as written.
 */
function withEmphasizedCounts(
  text: string,
  key: string,
  names: readonly string[],
): React.ReactNode[] {
  const named: [number, number][] = [];
  for (const name of names) {
    if (!name) continue;
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length))
      named.push([at, at + name.length]);
  }
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\d+/g)) {
    const start = match.index;
    if (named.some(([from, to]) => start >= from && start < to)) continue;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <Text
        key={`${key}${start}`}
        variant="reading"
        emphasis="semiBold"
        style={key === 'att' ? styles.attention : styles.count}
      >
        {match[0]}
      </Text>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const styles = StyleSheet.create((theme) => ({
  inset: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  reach: { gap: theme.space.s16, marginTop: theme.space.s8 },
  reachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s24,
  },
  legendSide: { flex: 1, minWidth: 0 },
  legendBelow: { alignSelf: 'stretch' },
  sentence: {
    color: theme.colors.text.secondary,
    marginTop: theme.space.s16,
    marginBottom: theme.space.s8,
  },
  count: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
  attention: { color: theme.colors.state.warning.textForeground },
  groupCount: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  acts: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s16,
    marginBottom: theme.space.s16,
  },
  actsNote: { color: theme.colors.text.secondary },
  anticipation: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s8,
    flexWrap: 'wrap',
    marginBottom: theme.space.s16,
  },
}));

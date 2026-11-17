import * as React from 'react';
import {
  useGlobalSearchParams,
  usePathname,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { pickMostBlockingCapabilityStatus, type CapabilityStatusKind } from '@/components/capabilities/status/capabilityStatusPresentation';
import { shortWhereItsOn } from '@/components/capabilities/where/whereItsOnPresentation';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SettingsCollectionPage } from '@/components/settings/shell/SettingsCollectionPage';
import { CollectionIndexRow } from '@/components/ui/lists/collection/CollectionIndexRow';
import { Icon } from '@/components/ui/icons/Icon';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { CollectionViewSwitch } from '@/components/ui/lists/collection/CollectionViewSwitch';
import {
  CollectionList,
  CollectionListGroupLabel,
  CollectionSkeletonRows,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { View } from 'react-native';
import {
  useReachMachines,
} from '@/sync/domains/capabilities/reach/useReachProjection';
import { useFoundSkillsCount } from '@/sync/domains/skills/useFoundSkills';
import {
  useSkillsLibrary,
  type SkillsLibrary,
} from '@/sync/domains/skills/useSkillsLibrary';
import { usePromptLibraryCatalogSelection } from '@/sync/store/usePromptLibraryCatalog';
import type { PromptLibraryCatalogValueSnapshot } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useOpenSkillAddModal } from './add/useOpenSkillAddModal';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';

import {
  SKILLS_COLLECTION_ROUTE,
  SKILLS_SEARCH_THRESHOLD,
  groupSkillsByFolder,
  groupSkillsByUse,
  skillHref,
  skillSource,
  skillReachesMachine,
  hasOwnSkills,
} from './skillsCollectionModel';
import { SKILLS_FOUND_ROUTE } from './found/foundSkillsModel';
import { useSkillsNeedsALook } from './status/useSkillsNeedsALook';
import { SKILLS_CHOOSE_ROUTE, useSkillsFirstRun } from './firstRun/useSkillsFirstRun';
import { SKILLS_UPDATES_ROUTE, countSkillUpdates } from './updates/skillsUpdatesModel';
import { setPreviewedSkill } from './skillsPreviewStore';
import { useSkillSourceNames } from './useSkillSourceNames';
import { skillStatus } from './status/skillStatus';
import { skillColumnFacts, skillsColumnAdapter } from './skillsColumnAdapter';
import { skillSourceId } from './skillSource';
import { SkillMark } from './SkillKindGlyph';
import { buildCapabilityHeaderMeta } from '@/components/capabilities/facts/CapabilityFacts';
import { useSettingsColumnFilter } from '@/components/settings/shell/useSettingsColumnFilter';
import { SkillsHomeOverviewView, type SkillsHomeReach } from './SkillsHomeOverview';
import { useSkillMakers } from './useSkillMakers';
import { skillMakerFilterLabel } from './skillMaker';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { areSessionBotFaceFactsEqual, type SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';

function readParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
const readFolders = (snapshot: PromptLibraryCatalogValueSnapshot<'folders'>) => snapshot.value;

function selectedSkillId(pathname: string): string | null {
  if (!pathname.startsWith(`${SKILLS_COLLECTION_ROUTE}/`)) return null;
  const rest = decodeURIComponent(
    pathname.slice(SKILLS_COLLECTION_ROUTE.length + 1),
  );
  return rest && !rest.includes('/') && rest !== 'new' ? rest : null;
}

/** The Machine a route link hands the column (`?machine=`), which the column filter takes as its Machine condition. */
function useSkillsRouteMachineId(): string | null {
  const params = useGlobalSearchParams<{ machine?: string | string[] }>();
  return readParam(params.machine);
}

/**
 * The Skills list: All skills, then In use and Off. `rail` is the column beside the open detail;
 * `page` is the same list as the phone's Skills page under its hero.
 */
export const SkillsRail = React.memo(function SkillsRail(
  props: Readonly<{ variant: 'rail' | 'page' }>,
) {
  const library = useSkillsLibrary();
  return <SkillsList variant={props.variant} library={library} />;
});

/** Derive row props only when this admitted item or its displayed context changes. */
const SkillListRow = React.memo(function SkillListRow(props: Readonly<{
  item: SkillListItemV1;
  names: ReturnType<typeof useWhereItsOnNames>['names'];
  rail: boolean;
  selected: boolean | undefined;
  statusKind: CapabilityStatusKind | null;
  makerFace: SessionBotFaceFacts | null;
  open: (href: string) => void;
}>) {
  const { item, names } = props;
  return (
    <CapabilityRow
      testID={`skills.rail.row.${item.skillId}`}
      title={item.name}
      description={item.description}
      whereSummary={shortWhereItsOn(item.rules, names)}
      mark={props.makerFace ? <SessionBotFace facts={props.makerFace} size={20} motion={false} /> : <SkillMark firstParty={item.provenance.kind === 'first_party'} />}
      // Source and cost live in the skill's detail; scripts stay on the row as a safety signal (lab k:home).
      lead={item.trust === 'runs_scripts' ? t('capabilities.facts.runsScripts') : null}
      status={props.statusKind ? { kind: props.statusKind } : null}
      density={props.rail ? 'rail' : 'page'}
      selected={props.selected}
      onPress={() => props.open(skillHref(item.skillId))}
      onPreviewChange={(active) => setPreviewedSkill(active ? item.skillId : null)}
    />
  );
}, (previous, next) => previous.item === next.item && previous.names === next.names && previous.rail === next.rail
  && previous.selected === next.selected && previous.statusKind === next.statusKind && previous.open === next.open
  && areSessionBotFaceFactsEqual(previous.makerFace, next.makerFace));

export const SkillsList = React.memo(function SkillsList(
  props: Readonly<{ variant: 'rail' | 'page'; library: SkillsLibrary }>,
) {
  const reach = useReachMachines();
  return <SkillsListView {...props} reach={reach} />;
});

/** The collection's presentation over the Machine facts admitted by its read owner. */
export const SkillsListView = React.memo(function SkillsListView(
  props: Readonly<{ variant: 'rail' | 'page'; library: SkillsLibrary; reach: SkillsHomeReach }>,
) {
  const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
  const { theme } = useUnistyles();
  const sourceNameFor = useSkillSourceNames();
  const router = useRouter();
  const pathname = usePathname().replace(/\/+$/, '');
  const { library } = props;
  const makerFor = useSkillMakers(library.items, library.scope);
  const { machines, placeMachines, agentIds } = props.reach;
  const routeMachineId = useSkillsRouteMachineId();
  const foundCount = useFoundSkillsCount(
    React.useMemo(() => machines.map((machine) => machine.machineId), [machines]),
  );
  const [query, setQuery] = React.useState('');
  const { names } = useWhereItsOnNames({
    agentIds,
    machines: placeMachines,
  });
  const searchable = library.items.length > SKILLS_SEARCH_THRESHOLD || query.length > 0;
  const visible = React.useMemo(() => {
    const needle = searchable ? query.trim().toLowerCase() : '';
    return needle
      ? library.items.filter((item) => `${item.name} ${item.description ?? ''}`.toLowerCase().includes(needle))
      : library.items;
  }, [library.items, query, searchable]);
  // Source and Machine (P8): held facts of the listed skills, read through the Skills adapter's registry.
  const installedPlugins = pluginUiProjection?.installedPackagesById;
  const columnFacts = React.useMemo(() => {
    const sourceWords = new Map<string, string>();
    const makerWords = new Map<string, string>();
    const facts = library.items.map((item) => {
      const maker = makerFor(item);
      if (maker.kind === 'bot') for (const token of maker.filterValues)
        if (token.startsWith('session:')) makerWords.set(token, maker.label);
      const sourceId = skillSourceId(item);
      if (!sourceWords.has(sourceId)) {
        const source = skillSource(item, names.machineName, installedPlugins, sourceNameFor(item));
        const words = source ? buildCapabilityHeaderMeta({ source }).find((fact) => fact.key === 'source')?.text : undefined;
        if (words) sourceWords.set(sourceId, words);
      }
      return skillColumnFacts(item, {
        sourceIds: [sourceId],
        makerIds: maker.filterValues,
        machineIds: machines.filter((machine) => skillReachesMachine(item, machine)).map((machine) => machine.machineId),
        statuses: [],
      });
    });
    return { facts, sourceWords, makerWords };
  }, [installedPlugins, library.items, machines, makerFor, names, sourceNameFor]);
  const filterFields = React.useMemo(() => ({
    source: { label: t('sessionsList.filtersSource'), icon: 'cloud' as const, valueLabel: (id: string) => columnFacts.sourceWords.get(id) ?? t('common.unavailable') },
    machine: { label: t('sessionsList.filtersMachine'), icon: 'desktop' as const, valueLabel: names.machineName },
    maker: { label: t('capabilities.skills.maker.title'), icon: 'user-circle' as const, valueLabel: (id: string) => columnFacts.makerWords.get(id) ?? skillMakerFilterLabel(id) },
  }), [columnFacts.sourceWords, columnFacts.makerWords, names]);
  const columnFilter = useSettingsColumnFilter({
    column: 'skills',
    search: { value: query, set: setQuery },
    testIDPrefix: 'skills.rail',
    adapter: skillsColumnAdapter,
    fields: filterFields,
    facts: columnFacts.facts,
    seed: {
      key: routeMachineId,
      filter: { machine: { include: routeMachineId ? [routeMachineId] : [], exclude: [] } },
    },
  });
  const matchesFilter = columnFilter.matches;
  const shown = React.useMemo(() => visible.filter((item) => matchesFilter(item.skillId)), [matchesFilter, visible]);
  const groups = React.useMemo(() => groupSkillsByUse(shown), [shown]);
  const folders = usePromptLibraryCatalogSelection('folders', readFolders);
  // Folder groups replace In use / Off once the person files a skill in a folder (IR-83).
  const folderGroups = React.useMemo(
    () => groupSkillsByFolder(shown, folders),
    [folders, shown],
  );
  const sections: readonly Readonly<{
    key: string;
    title: string;
    rows: readonly SkillListItemV1[];
  }>[] = React.useMemo(
    () =>
      folderGroups
        ? folderGroups.map((group) => ({
            key: `folder.${group.id ?? 'none'}`,
            title: group.title ?? t('promptLibrary.surface.noFolder'),
            rows: group.rows,
          }))
        : [
            { key: 'inUse', title: t('capabilities.skills.inUse'), rows: groups.inUse },
            { key: 'off', title: t('capabilities.skills.off'), rows: groups.off },
          ].filter((section) => section.rows.length > 0),
    [folderGroups, groups],
  );
  const needLook = useSkillsNeedsALook(library, machines).length;
  const selectedId = selectedSkillId(pathname);
  const atRoot = pathname === SKILLS_COLLECTION_ROUTE;
  const atFound = pathname === SKILLS_FOUND_ROUTE;
  const atUpdates = pathname === SKILLS_UPDATES_ROUTE;
  const atChoose = pathname === SKILLS_CHOOSE_ROUTE;
  // Pinned destinations (P6 §4.1): Choose what's on only during first run, Updates only when one waits.
  const { firstVisit } = useSkillsFirstRun(library.items);
  const updateCount = React.useMemo(() => countSkillUpdates(library.items), [library.items]);
  const rail = props.variant === 'rail';

  const openAdd = useOpenSkillAddModal();
  const open = React.useCallback(
    (href: string) => {
      // Beside a detail, switching skills replaces the shown detail instead of stacking history.
      const result = runGuardedNavigation(() =>
        rail && !atRoot
          ? router.replace(href as never)
          : router.push(href as never),
      );
      if (result !== true) fireAndForget(result, { tag: 'SkillsRail.open' });
    },
    [atRoot, rail, router],
  );
  const renderRow = (item: SkillListItemV1) => (
    <SkillListRow
      key={item.skillId}
      item={item}
      names={names}
      makerFace={makerFor(item).face}
      statusKind={pickMostBlockingCapabilityStatus(skillStatus(item, { nowMs: Date.now(), usageObservedSince: library.usageObservedSince }), 'row')?.kind ?? null}
      rail={rail}
      selected={rail ? selectedId === item.skillId : undefined}
      open={open}
    />
  );

  const loading = library.status === 'loading' && library.items.length === 0;
  const unavailable = library.status === 'unavailable';
  const noMatch = !loading && shown.length === 0 && library.items.length > 0;
  // The built-in skill stays listed under In use; the line says none of the person's own exist yet (P6 §4.1).
  const empty = !loading && !unavailable && !hasOwnSkills(library.items);

  // Pinned destinations (P6 §4.1): rail index rows beside a detail; on a standalone page, Settings navigation rows.
  const pinned: React.ReactElement[] = [];
  if (firstVisit) {
    const choose = {
      testID: 'skills.rail.choose',
      title: t('capabilities.skills.home.choose'),
      detail: t('capabilities.skills.home.chooseOff', { count: firstVisit.off }),
      onPress: () => open(SKILLS_CHOOSE_ROUTE),
    };
    pinned.push(rail
      ? <CollectionIndexRow key="choose" {...choose} icon="sparkle" selected={atChoose} />
      : <Item key="choose" {...choose} icon={<Icon name="sparkle" size={HAPPIER_PAGE_METRICS.rowIconGlyphPx} color={theme.colors.text.secondary} />} />);
  }
  // Pinned while it has something, and while it is the open page so the rail always marks where you are.
  if (updateCount > 0 || atUpdates) {
    const updates = {
      testID: 'skills.rail.updates',
      title: t('capabilities.skills.updates'),
      ...(updateCount > 0 ? { detail: String(updateCount) } : {}),
      onPress: () => open(SKILLS_UPDATES_ROUTE),
    };
    pinned.push(rail
      ? <CollectionIndexRow key="updates" {...updates} icon="arrow-up" selected={atUpdates} />
      : <Item key="updates" {...updates} icon={<Icon name="arrow-up" size={HAPPIER_PAGE_METRICS.rowIconGlyphPx} color={theme.colors.text.secondary} />} />);
  }

  // Two views of one column (P8): what you added, and what other agents already run on your machines.
  const viewSwitch = machines.length > 0 ? (
    <CollectionViewSwitch
      view={atFound ? 'found' : 'all'}
      foundCount={foundCount}
      foundLabel={t('capabilities.skillsFound.destination')}
      onChange={(view) => open(view === 'found' ? SKILLS_FOUND_ROUTE : SKILLS_COLLECTION_ROUTE)}
      testIDPrefix={rail ? 'skills.rail.view' : 'skills.page.view'}
    />
  ) : null;
  const body = (
    <>
      {!rail ? null : (
        <CollectionIndexRow
          testID="skills.rail.all"
          detail={
            needLook > 0
              ? t('capabilities.skills.needLook', { count: needLook })
              : undefined
          }
          selected={atRoot}
          onPress={() => open(SKILLS_COLLECTION_ROUTE)}
        />
      )}
      {rail ? pinned : pinned.length > 0 ? <ItemGroup testID="skills.page.pinned">{pinned}</ItemGroup> : null}
      {unavailable && (rail || library.items.length > 0) ? (
        <View style={collectionListStyles.stateLine}>
          <SurfaceStateCard
            testID="skills.rail.error"
            size="line"
            kind="error"
            title={t('capabilities.skills.loadFailed')}
            diagnosticCode={library.errorCode ?? undefined}
            action={{ label: t('common.retry'), onPress: library.retry }}
          />
        </View>
      ) : null}
      {loading ? <CollectionSkeletonRows count={6} rowRole="catalogRow" /> : null}
      {empty ? (
        <View style={collectionListStyles.stateLine}>
          <SurfaceStateCard
            testID="skills.rail.empty"
            size="line"
            kind="empty"
            title={t('capabilities.skills.noOwnSkills')}
          />
        </View>
      ) : null}
      {noMatch ? (
        <View style={collectionListStyles.stateLine}>
          <SurfaceStateCard
            testID="skills.rail.noMatch"
            size="line"
            kind="empty"
            title={t('capabilities.skills.noMatch', {
              query: query.trim() || columnFilter.conditionWords,
            })}
          />
        </View>
      ) : null}
      {/* Standalone, each group is a Settings section (R6); beside a detail the rail keeps its light labels. */}
      {/* Sections are keyed by place: a regrouping (folder names lost and recovered) keeps each row mounted, as the
          rail's flat list does. */}
      {!rail ? sections.map((section, index) => (
        <ItemGroup key={`section.${index}`} testID={`skills.rail.group.${section.key}`} title={section.title}>
          {section.rows.map(renderRow)}
        </ItemGroup>
      )) : sections.flatMap((section, index) => [
          <CollectionListGroupLabel
            key={`group.${section.key}`}
            testID={`skills.rail.group.${section.key}`}
            title={section.title}
            count={section.rows.length}
            // The first group closes the header block (search, the index rows): the shared first-group air.
            first={index === 0}
          />,
          ...section.rows.map(renderRow),
      ])}
    </>
  );

  const addButton = (
    <IconButton
      testID="skills.rail.add"
      iconName="plus"
      variant="plain"
      accessibilityLabel={t('capabilities.skills.addSkill')}
      tooltip={t('capabilities.skills.addSkill')}
      onPress={() => openAdd()}
    />
  );
  const filterInHeader = library.items.length > 0 && !searchable ? columnFilter.filterButton : null;
  const search = searchable
    ? {
        value: query,
        onChangeText: setQuery,
        placeholder: t('capabilities.skills.searchPlaceholder'),
        testID: 'skills.rail.search',
        trailing: columnFilter.filterButton,
        anchorRef: columnFilter.searchAnchorRef,
      }
    : null;
  const filters = viewSwitch ? { targetCount: Math.max(library.items.length, 1), content: viewSwitch } : null;
  const count = library.itemCount;

  if (rail) {
    return (
      <CollectionList
        testID="skills.rail"
        title={t('capabilities.skills.title')}
        count={count}
        strip={columnFilter.tokenRow}
        headerAction={<>{filterInHeader}{addButton}</>}
        search={search}
        filters={filters}
      >
        {body}
        {columnFilter.editorOverlay}
      </CollectionList>
    );
  }

  // A phone's page is the rail's own list under a large title with its count and Add (lab sfcols:skillsP).
  // Every capability home recomposes in one order (lab kp:home, np:home): the overview and Needs a look,
  // then the list's search, view switch and rows, as MCP's phone page does.
  return (
    <SettingsCollectionPage
      testID="skills.list"
      headerTestID="skills.page.header"
      count={count}
      actions={<>{filterInHeader}{addButton}</>}
    >
      <SkillsHomeOverviewView library={library} showHeader={false} reach={props.reach} />
      <CollectionList
        testID="skills.page.list"
        strip={columnFilter.tokenRow}
        search={search}
        filters={filters}
        scrollContent={<>{body}{columnFilter.editorOverlay}</>}
      />
    </SettingsCollectionPage>
  );
});

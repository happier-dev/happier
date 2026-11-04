import * as React from 'react';
import {
  useGlobalSearchParams,
  usePathname,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { pickMostBlockingCapabilityStatus, type CapabilityStatusKind } from '@/components/capabilities/status/capabilityStatusPresentation';
import { shortWhereItsOn } from '@/components/capabilities/where/whereItsOnPresentation';
import { useWhereItsOnNames } from '@/components/capabilities/where/useWhereItsOnNames';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionIndexRow } from '@/components/ui/lists/collection/CollectionIndexRow';
import {
  CollectionList,
  CollectionListGroupLabel,
  CollectionSkeletonRows,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { Text } from '@/components/ui/text/Text';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  useReachMachines,
  type ReachMachine,
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
  filterSkills,
  groupSkillsByFolder,
  groupSkillsByUse,
  skillHref,
  skillSource,
  hasOwnSkills,
} from './skillsCollectionModel';
import { SKILLS_FOUND_ROUTE } from './found/foundSkillsModel';
import { useSkillsNeedsALook } from './status/useSkillsNeedsALook';
import { SKILLS_CHOOSE_ROUTE, useSkillsFirstRun } from './firstRun/useSkillsFirstRun';
import { SKILLS_UPDATES_ROUTE, countSkillUpdates } from './updates/skillsUpdatesModel';
import { setPreviewedSkill } from './skillsPreviewStore';
import { skillStatus } from './status/skillStatus';

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

/** The machine named by `?machine=`, when it is one of the Account's machines. */
export function useSkillsMachineFilter(
  machines: readonly ReachMachine[],
): ReachMachine | null {
  const params = useGlobalSearchParams<{ machine?: string | string[] }>();
  const machineId = readParam(params.machine);
  return machineId
    ? (machines.find((machine) => machine.machineId === machineId) ?? null)
    : null;
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
  installedPlugins: Parameters<typeof skillSource>[2];
  rail: boolean;
  selected: boolean | undefined;
  statusKind: CapabilityStatusKind | null;
  open: (href: string) => void;
}>) {
  const { item, names } = props;
  return (
    <CapabilityRow
      testID={`skills.rail.row.${item.skillId}`}
      title={item.name}
      description={item.description}
      whereSummary={shortWhereItsOn(item.rules, names)}
      facts={{
        presentation: 'row',
        source: skillSource(item, names.machineName, props.installedPlugins),
        trust: item.trust,
        cost: { tokensWhenUsed: item.cost.bodyTokens },
      }}
      status={props.statusKind ? { kind: props.statusKind } : null}
      density={props.rail ? 'rail' : 'page'}
      selected={props.selected}
      onPress={() => props.open(skillHref(item.skillId))}
      onPreviewChange={(active) => setPreviewedSkill(active ? item.skillId : null)}
    />
  );
});

export const SkillsList = React.memo(function SkillsList(
  props: Readonly<{ variant: 'rail' | 'page'; library: SkillsLibrary }>,
) {
  const { theme } = useUnistyles();
  const pluginUiProjection = useAppShellPluginUiDeclarationProjection();
  const router = useRouter();
  const pathname = usePathname().replace(/\/+$/, '');
  const { library } = props;
  const { machines } = useReachMachines();
  const machineFilter = useSkillsMachineFilter(machines);
  const foundCount = useFoundSkillsCount(
    React.useMemo(() => machines.map((machine) => machine.machineId), [machines]),
  );
  const [query, setQuery] = React.useState('');
  const agentIds = React.useMemo(
    () => [...new Set(machines.flatMap((machine) => machine.agentIds))],
    [machines],
  );
  const placeMachines = React.useMemo(
    () =>
      machines.map((machine) => ({
        machineId: machine.machineId,
        name: machine.name ?? machine.machineId,
      })),
    [machines],
  );
  const { names } = useWhereItsOnNames({
    agentIds,
    machines: placeMachines,
  });
  const searchable = library.items.length > SKILLS_SEARCH_THRESHOLD;
  const visible = React.useMemo(
    () =>
      filterSkills(library.items, {
        query: searchable ? query : '',
        machine: machineFilter,
      }),
    [library.items, machineFilter, query, searchable],
  );
  const groups = React.useMemo(() => groupSkillsByUse(visible), [visible]);
  const folders = usePromptLibraryCatalogSelection('folders', readFolders);
  // Folder groups replace In use / Off once the person files a skill in a folder (IR-83).
  const folderGroups = React.useMemo(
    () => groupSkillsByFolder(visible, folders),
    [folders, visible],
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
  const clearFilter = React.useCallback(() => {
    const result = runGuardedNavigation(() =>
      router.replace(pathname as never),
    );
    if (result !== true)
      fireAndForget(result, { tag: 'SkillsRail.clearFilter' });
  }, [pathname, router]);

  const renderRow = (item: SkillListItemV1) => (
    <SkillListRow
      key={item.skillId}
      item={item}
      names={names}
      installedPlugins={pluginUiProjection?.installedPackagesById}
      statusKind={pickMostBlockingCapabilityStatus(skillStatus(item, { nowMs: Date.now(), usageObservedSince: library.usageObservedSince }), 'row')?.kind ?? null}
      rail={rail}
      selected={rail ? selectedId === item.skillId : undefined}
      open={open}
    />
  );

  const loading = library.status === 'loading' && library.items.length === 0;
  const unavailable = library.status === 'unavailable';
  const noMatch = !loading && visible.length === 0 && library.items.length > 0;
  // The built-in skill stays listed under In use; the line says none of the person's own exist yet (P6 §4.1).
  const empty = !loading && !unavailable && !hasOwnSkills(library.items);

  if (!rail) {
    // The phone's Skills page: the same list as grouped inset sheets under the hero (lab hs A2p), each
    // group a page section with its count, so rows read as one sheet rather than a rail's column.
    const group = (section: (typeof sections)[number]) => (
      <ItemGroup
        key={section.key}
        testID={`skills.list.group.${section.key}`}
        title={section.title}
        titleAccessory={
          <Text variant="meta" style={pageStyles.count}>
            {String(section.rows.length)}
          </Text>
        }
      >
        {section.rows.map(renderRow)}
      </ItemGroup>
    );
    const stateCard = (
      testID: string,
      kind: 'error' | 'empty',
      title: string,
      action?: Readonly<{ label: string; onPress: () => void }>,
    ) => (
      <View style={pageStyles.state}>
        <SurfaceStateCard
          testID={testID}
          size="line"
          kind={kind}
          title={title}
          {...(kind === 'error'
            ? { diagnosticCode: library.errorCode ?? undefined }
            : {})}
          {...(action ? { action } : {})}
        />
      </View>
    );
    return (
      <View testID="skills.list">
        {searchable ? (
          <View style={pageStyles.search}>
            <CompactSearchField
              testID="skills.rail.search"
              value={query}
              onChangeText={setQuery}
              placeholder={t('capabilities.skills.searchPlaceholder')}
            />
          </View>
        ) : null}
        {machineFilter ? (
          <ItemGroup>
            <Item
              testID="skills.rail.machineFilter"
              title={t('capabilities.skills.filterOn', {
                machine: machineFilter.name ?? machineFilter.machineId,
              })}
              icon={
                <Icon
                  name="desktop"
                  size={20}
                  color={theme.colors.text.secondary}
                />
              }
              showChevron={false}
              rightElement={
                <IconButton
                  testID="skills.rail.machineFilter.clear"
                  iconName="x"
                  variant="plain"
                  accessibilityLabel={t('capabilities.skills.clearFilter')}
                  tooltip={t('capabilities.skills.clearFilter')}
                  onPress={clearFilter}
                />
              }
            />
          </ItemGroup>
        ) : null}
        {firstVisit || updateCount > 0 ? (
          <ItemGroup>
            {firstVisit ? (
              <Item
                testID="skills.page.choose"
                title={t('capabilities.skills.home.choose')}
                detail={t('capabilities.skills.home.chooseOff', { count: firstVisit.off })}
                icon={<Icon name="sparkle" size={20} color={theme.colors.text.secondary} />}
                onPress={() => open(SKILLS_CHOOSE_ROUTE)}
              />
            ) : null}
            {updateCount > 0 ? (
              <Item
                testID="skills.page.updates"
                title={t('capabilities.skills.updates')}
                detail={String(updateCount)}
                icon={<Icon name="arrow-up" size={20} color={theme.colors.text.secondary} />}
                onPress={() => open(SKILLS_UPDATES_ROUTE)}
              />
            ) : null}
          </ItemGroup>
        ) : null}
        {machines.length > 0 ? (
          <ItemGroup>
            <Item
              testID="skills.page.found"
              title={t('capabilities.skillsFound.destination')}
              detail={foundCount > 0 ? String(foundCount) : undefined}
              icon={
                <Icon
                  name="desktop"
                  size={20}
                  color={theme.colors.text.secondary}
                />
              }
              onPress={() => open(SKILLS_FOUND_ROUTE)}
            />
          </ItemGroup>
        ) : null}
        {unavailable
          ? stateCard('skills.rail.error', 'error', t('capabilities.skills.loadFailed'), {
              label: t('common.retry'),
              onPress: library.retry,
            })
          : null}
        {loading ? <CollectionSkeletonRows count={6} /> : null}
        {noMatch
          ? stateCard(
              'skills.rail.noMatch',
              'empty',
              t('capabilities.skills.noMatch', {
                query: query.trim() || (machineFilter?.name ?? ''),
              }),
            )
          : null}
        {sections.map(group)}
      </View>
    );
  }

  const body = (
    <>
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
      {firstVisit ? (
        <CollectionIndexRow
          testID="skills.rail.choose"
          icon="sparkle"
          title={t('capabilities.skills.home.choose')}
          detail={t('capabilities.skills.home.chooseOff', { count: firstVisit.off })}
          selected={atChoose}
          onPress={() => open(SKILLS_CHOOSE_ROUTE)}
        />
      ) : null}
      {/* Pinned while it has something, and while it is the open page so the rail always marks where you are. */}
      {updateCount > 0 || atUpdates ? (
        <CollectionIndexRow
          testID="skills.rail.updates"
          icon="arrow-up"
          title={t('capabilities.skills.updates')}
          detail={updateCount > 0 ? String(updateCount) : undefined}
          selected={atUpdates}
          onPress={() => open(SKILLS_UPDATES_ROUTE)}
        />
      ) : null}
      {machines.length > 0 ? (
        <CollectionIndexRow
          testID="skills.rail.found"
          icon="desktop"
          title={t('capabilities.skillsFound.destination')}
          detail={foundCount > 0 ? String(foundCount) : undefined}
          selected={atFound}
          onPress={() => open(SKILLS_FOUND_ROUTE)}
        />
      ) : null}
      {machineFilter ? (
        <Item
          testID="skills.rail.machineFilter"
          title={t('capabilities.skills.filterOn', {
            machine: machineFilter.name ?? machineFilter.machineId,
          })}
          icon={
            <HappierCollectionListMark>
              <Icon
                name="desktop"
                size={20}
                color={theme.colors.text.secondary}
              />
            </HappierCollectionListMark>
          }
          density="compact"
          showChevron={false}
          pressableStyle={collectionListStyles.row}
          rightElement={
            <IconButton
              testID="skills.rail.machineFilter.clear"
              iconName="x"
              variant="plain"
              accessibilityLabel={t('capabilities.skills.clearFilter')}
              tooltip={t('capabilities.skills.clearFilter')}
              onPress={clearFilter}
            />
          }
        />
      ) : null}
      {unavailable ? (
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
      {loading ? <CollectionSkeletonRows count={6} /> : null}
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
              query: query.trim() || (machineFilter?.name ?? ''),
            })}
          />
        </View>
      ) : null}
      {sections.map((section) => (
        <React.Fragment key={section.key}>
          <CollectionListGroupLabel
            testID={`skills.rail.group.${section.key}`}
            title={section.title}
            count={section.rows.length}
          />
          {section.rows.map(renderRow)}
        </React.Fragment>
      ))}
    </>
  );

  return (
    <CollectionList
      testID="skills.rail"
      title={t('capabilities.skills.title')}
      count={loading ? null : library.items.length}
      headerAction={
        <IconButton
          testID="skills.rail.add"
          iconName="plus"
          variant="plain"
          accessibilityLabel={t('capabilities.skills.addSkill')}
          tooltip={t('capabilities.skills.addSkill')}
          onPress={() => openAdd()}
        />
      }
      search={
        searchable
          ? {
              value: query,
              onChangeText: setQuery,
              placeholder: t('capabilities.skills.searchPlaceholder'),
              testID: 'skills.rail.search',
            }
          : null
      }
    >
      {body}
    </CollectionList>
  );
});


const pageStyles = StyleSheet.create((theme) => ({
  // The search field lines up with the sheets below it (the grouped list's content edge).
  search: { marginTop: theme.space.s8, paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  state: { paddingVertical: theme.space.s8, paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  count: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
}));

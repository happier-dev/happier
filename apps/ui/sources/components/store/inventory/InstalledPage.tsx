import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  useGlobalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { capabilityStatusLabels } from '@/components/capabilities/status/capabilityStatusPresentation';
import { buildPluginsHomeRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useStoreDirectoryState } from '@/components/settings/plugins/model/usePluginsOpenItem';
import type { SettingsColumnFilterField } from '@/components/settings/shell/useSettingsColumnFilter';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PROVIDER_CONNECTION_STATUS_KEY } from '@/providers/connection/presentation';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useDeviceType } from '@/utils/platform/responsive';

import { storeKinds } from '../catalog/storeKinds';
import type { StoreInstalledInput } from '../catalog/storeKinds';
import { InstalledScreen } from './InstalledScreen';
import { StoreProjectScopeChip } from '../StoreProjectScopeChip';
import { StoreDirectoryUnavailable } from '../StoreDirectoryUnavailable';
import { ContributedStoreKindSections, useContributedStoreKinds } from '../StoreKindSurface';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useStoreMachineScope } from '@/components/settings/plugins/model/useStoreMachineScope';
import { useStoreProjectScope } from '@/components/settings/plugins/model/useStoreProjectScope';
import {
  inventoryMachineKey,
  inventoryKindWord,
  type ManagedInventoryField,
} from './inventoryRows';
import {
  ManagedInventoryDirectory,
  MANAGED_INVENTORY_PREVIEW_ROWS,
} from './ManagedInventoryDirectory';
import type {
  ManagedInventoryGroupBy,
  ManagedInventorySectionsState,
} from './ManagedInventorySections';
import { ManagedInventoryCoverage } from './ManagedInventoryCoverage';
import type { ManagedInventoryRow } from './useManagedInventory';
import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';

const GROUPS: readonly ManagedInventoryGroupBy[] = [
  'kind',
  'machine',
  'project',
];
const KINDS = new Set<string>([...Object.keys(storeKinds), 'watchedService']);
const NO_FILTERS = {};

function readGroupBy(value: unknown): ManagedInventoryGroupBy {
  return value === 'machine' || value === 'project' ? value : 'kind';
}

/** Status words come from their owners: provider connection words, else the shared capability table. */
function statusWords(value: string): string {
  if (value in PROVIDER_CONNECTION_STATUS_KEY)
    return t(
      PROVIDER_CONNECTION_STATUS_KEY[
        value as keyof typeof PROVIDER_CONNECTION_STATUS_KEY
      ],
    );
  return capabilityStatusLabels.status(value as never, undefined) || value;
}

/**
 * Store → Installed (S50 lab `i:all` / `ip:all`): everything Happier manages, across Machines and
 * projects. One header and present-tense line, one search with the shared condition filter, a
 * Kind / Machine / Project grouping, then Needs you and the sections. Query, filters and grouping live
 * in the route; nothing here writes a preference.
 */
export function InstalledPage(props: Readonly<{ projectKey?: string | null }>): React.ReactNode {
  const scope = useAccountSettingsScope();
  const focused = useOptionalScreenIsFocused() !== false;
  const layoutPresented = useLayoutPresentationActive();
  const presented = focused && layoutPresented;
  const directory = useStoreDirectoryState();
  const params = useGlobalSearchParams<{ group?: string }>();
  const router = useRouter();
  const groupBy = readGroupBy(params.group);
  const route = directory.state;
  const draft = React.useMemo(
    () => ({
      query: route?.query ?? '',
      setQuery: directory.setQuery,
      filters: route?.filters ?? NO_FILTERS,
      setFilters: directory.setFilters,
    }),
    [route, directory.setQuery, directory.setFilters],
  );
  const reach = useReachMachines();
  const contributedKinds = useContributedStoreKinds(draft.filters);
  const localize = useProjectedPluginLocalizedTextResolver();
  const fields = React.useMemo<
    Readonly<Record<ManagedInventoryField, SettingsColumnFilterField>>
  >(() => {
    const names = new Map<string, string>();
    const serverIdentityId = reach.scope
      ? getServerProfileById(reach.scope.serverId)?.serverIdentityId
      : undefined;
    if (reach.scope && serverIdentityId)
      for (const machine of reach.machines) {
        names.set(
          inventoryMachineKey(reach.scope, {
            serverIdentityId,
            machineId: machine.machineId,
          }),
          machine.name ?? t('storeInstalled.machineFallback'),
        );
      }
    return {
      kind: {
        label: t('storeInstalled.groupKind'),
        valueLabel: (value) => {
          if (KINDS.has(value)) return inventoryKindWord(value as ManagedInventoryRow['kind']);
          const contribution = contributedKinds.find(kind => kind.key === value);
          return contribution ? localize(contribution.pluginId, contribution.definition.title) : value;
        },
      },
      status: { label: t('storeInstalled.status'), valueLabel: statusWords },
      machine: {
        label: t('storeInstalled.groupMachine'),
        valueLabel: (value) =>
          names.get(value) ?? t('storeInstalled.machineFallback'),
      },
      project: {
        label: t('storeInstalled.groupProject'),
        valueLabel: (value) => value,
      },
    };
  }, [reach.machines, reach.scope, contributedKinds, localize]);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const projectKey = props.projectKey ?? null;
  const exactMachineKey = route?.filters.machine?.include.length === 1 && route.filters.machine.exclude.length === 0
    ? route.filters.machine.include[0]! : null;
  const machine = React.useMemo(() => {
    const serverIdentityId = reach.scope ? getServerProfileById(reach.scope.serverId)?.serverIdentityId : undefined;
    if (!exactMachineKey || !scope || !serverIdentityId) return null;
    const held = reach.machines.find(candidate => inventoryMachineKey(scope, { serverIdentityId, machineId: candidate.machineId }) === exactMachineKey);
    return held ? { serverIdentityId, machineId: held.machineId } : null;
  }, [exactMachineKey, reach.machines, reach.scope, scope]);
  const admittedScope = route && (!exactMachineKey || machine) ? scope : null;
  const query = React.useMemo(
    () => ({ scope: admittedScope, machine, projectKey, presented: presented && route !== null }),
    [admittedScope, machine, projectKey, presented, route !== null],
  );
  const setGroupBy = React.useCallback(
    (group: ManagedInventoryGroupBy) =>
      router.setParams({ group: group === 'kind' ? undefined : group }),
    [router],
  );

  if (!route) return <StoreDirectoryUnavailable view="installed" />;

  return (
    <ItemList pageColumn="wide">
      <PageContentColumn>
        <PageHeader
          testID="store.installed.header"
          title={t('storeInstalled.title')}
          alwaysShowTitle
          description={t('storeInstalled.purpose')}
          actions={<StoreProjectScopeChip />}
          actionsPlacement="page"
        />
        {scope ? (
          <InstalledScreen
            query={query}
            draft={draft}
            fields={fields}
            groupBy={groupBy}
            openKey={openKey}
            onOpenChange={setOpenKey}
          >
            {(state) => (
              <InstalledBody
                state={state}
                groupBy={groupBy}
                onGroupBy={setGroupBy}
                draft={draft}
                input={query}
                hasContributedKinds={contributedKinds.length > 0}
              />
            )}
          </InstalledScreen>
        ) : (
          <View style={styles.inset}>
            <SurfaceStateCard
              testID="store.installed.unavailable"
              size="page"
              kind="unavailable"
              title={t('storeInstalled.unavailable')}
            />
          </View>
        )}
        {scope ? <ContributedStoreKindSections kinds={contributedKinds} mode="installed" presented={presented} query={draft.query} filters={draft.filters} /> : null}
      </PageContentColumn>
    </ItemList>
  );
}

type BodyState = ManagedInventorySectionsState &
  Readonly<{
    filter: Readonly<{
      active: boolean;
      filterButton: React.ReactNode;
      searchAnchorRef: unknown;
      tokenRow: React.ReactNode;
      editorOverlay: React.ReactNode;
      clearFilters: () => void;
      conditionWords: string;
    }>;
  }>;

function InstalledBody(
  props: Readonly<{
    state: BodyState;
    groupBy: ManagedInventoryGroupBy;
    onGroupBy: (group: ManagedInventoryGroupBy) => void;
    draft: Readonly<{ query: string; setQuery: (query: string) => void }>;
    input: StoreInstalledInput;
    hasContributedKinds?: boolean;
  }>,
) {
  const { state, draft } = props;
  const { project } = useStoreProjectScope();
  const machine = useStoreMachineScope();
  const phone = useDeviceType() === 'phone';
  const router = useRouter();
  const families = state.families.map((family) => family.result);
  const loading = families.some((family) => family.coverage === 'loading');
  const partial = families.some(
    (family) => typeof family.coverage === 'object',
  );
  const allLoaded = state.families.every(
    (family) => family.result.coverage !== 'loading',
  );
  const total = state.collection.sections.reduce(
    (count, section) => count + section.items.length,
    0,
  );
  const unfiltered = state.presentations.size;
  const filtering = draft.query.trim().length > 0 || state.filter.active;
  // Added and included-with-Happier are counted apart, never as one total.
  let included = 0;
  const machines = new Set<string>();
  for (const presentation of state.presentations.values()) {
    if (presentation.included) {
      included += 1;
      continue;
    }
    for (const machine of presentation.machines ?? [])
      machines.add(machine.machineId);
  }
  const added = unfiltered - included;
  const browse = React.useCallback(() => {
    const result = runGuardedNavigation(() =>
      router.push(buildPluginsHomeRoute('app', { view: 'discover', project, machine }) as never),
    );
    if (result !== true) fireAndForget(result, { tag: 'InstalledPage.browse' });
  }, [router, project, machine]);
  const clear = React.useCallback(() => {
    draft.setQuery('');
    state.filter.clearFilters();
  }, [draft, state.filter]);

  const columnVisible = useAppShellColumn().columnVisible;
  const present =
    added === 0
      ? null
      : [
          machines.size > 0
            ? t('storeInstalled.presentAcross', {
                count: added,
                machines: machines.size,
              })
            : t('storeInstalled.present', { count: added }),
          included > 0 ? t('storeInstalled.includedMore', { count: included }) : null,
          // A partial or failed kind is named once by the coverage line under Needs you; the header only says a
          // first load is still arriving (LV-JUDGE-1102 STORE-UI-R2 (2)).
          loading && !partial ? t('storeInstalled.partial') : null,
        ]
          .filter(Boolean)
          .join(' ');
  const empty =
    allLoaded && !partial && added === 0 && state.attention.length === 0;

  const group = (
    <SegmentedTabBar<ManagedInventoryGroupBy>
      role="radiogroup"
      segmentSizing="content"
      accessibilityLabel={t('storeInstalled.groupBy')}
      activeTabId={props.groupBy}
      tabs={GROUPS.map((id) => ({
        id,
        label: t(
          id === 'kind'
            ? 'storeInstalled.groupKind'
            : id === 'machine'
              ? 'storeInstalled.groupMachine'
              : 'storeInstalled.groupProject',
        ),
        testID: `store.installed.group.${id}`,
      }))}
      onSelectTab={(id) => props.onGroupBy(id)}
    />
  );
  return (
    <>
      {/* The phone keeps its screen for the rows; Needs you already says what's wrong. */}
      {present && columnVisible ? (
        <View style={styles.inset}>
          <Text
            testID="store.installed.present"
            variant="reading"
            style={styles.present}
          >
            {present}
          </Text>
        </View>
      ) : null}
      {empty ? null : (
        <>
          <View
            style={[
              styles.inset,
              styles.controls,
              phone ? styles.controlsPhone : null,
            ]}
          >
            <View
              style={styles.search}
              ref={state.filter.searchAnchorRef as never}
            >
              <CompactSearchField
                testID="store.installed.search"
                value={draft.query}
                onChangeText={draft.setQuery}
                placeholder={t('storeInstalled.searchPlaceholder')}
                trailing={state.filter.filterButton}
              />
            </View>
            {group}
          </View>
          {state.filter.tokenRow ? (
            <View style={styles.inset}>{state.filter.tokenRow}</View>
          ) : null}
        </>
      )}
      {empty ? (
        <>
          {props.hasContributedKinds ? null : <EmptyState
            testID="store.installed.empty"
            title={t('storeInstalled.emptyTitle')}
            subtitle={t('storeInstalled.emptyBody')}
            primaryAction={{ label: t('storeInstalled.browse'), onPress: browse }}
          />}
          {included > 0 ? (
            <ManagedInventoryDirectory
              state={state}
              input={props.input}
              groupBy={props.groupBy}
              columns={phone ? 1 : 2}
              preview={MANAGED_INVENTORY_PREVIEW_ROWS}
              testIDPrefix="store.installed"
            />
          ) : null}
        </>
      ) : filtering && total === 0 && state.attention.length === 0 ? (
        <>{props.hasContributedKinds ? null : <EmptyState
          testID="store.installed.noMatch"
          layout="inline"
          iconName="magnifying-glass"
          title={
            draft.query.trim()
              ? t('storeInstalled.noMatch', { query: draft.query.trim() })
              : t('storeInstalled.noMatchFilters')
          }
          primaryAction={{ label: t('storeInstalled.clear'), onPress: clear }}
        />}<ManagedInventoryCoverage families={state.families} testIDPrefix="store.installed" /></>
      ) : unfiltered === 0 && loading ? (
        <ItemGroup
          title={t('capabilities.store.kinds.mcpServer.title')}
          surface="none"
        >
          <SkeletonRows rows={3} testID="store.installed.loading" />
        </ItemGroup>
      ) : (
        <ManagedInventoryDirectory
          state={state}
          input={props.input}
          groupBy={props.groupBy}
          columns={phone ? 1 : 2}
          preview={MANAGED_INVENTORY_PREVIEW_ROWS}
          testIDPrefix="store.installed"
        />
      )}
      {state.filter.editorOverlay}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  inset: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  // On the header's text edge (its optical inset), not the rows' edge.
  present: { color: theme.colors.text.secondary, marginBottom: theme.space.s8, marginLeft: PAGE_LIST_METRICS.headingOpticalInsetPx },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    marginTop: theme.space.s8,
    marginBottom: theme.space.s8,
  },
  controlsPhone: { flexDirection: 'column', alignItems: 'stretch' },
  search: { flex: 1, minWidth: 0 },
}));

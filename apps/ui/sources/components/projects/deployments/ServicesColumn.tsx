import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DeploymentReadControllerV1, DeploymentReadDemandV1 } from '@happier-dev/deployments';

import {
  usePathname,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { useCurrentRouteParamsSelector } from '@/components/appShell/workspace/currentRouteLocation';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import {
  CollectionList,
  CollectionListGroupLabel,
  CollectionNavigationRow,
  CollectionRows,
  CollectionSkeletonRows,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { useCollectionTreeKeyboard, type CollectionTreeRow } from '@/components/ui/lists/collection/useCollectionTreeKeyboard';
import { resolveHappierCollectionTreeChildIndentPx } from '@happier-dev/plugin-ui/presentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

import { useOpenNewApp } from '../starters/newAppPresentation';
import { ProjectsTreeEnvironmentRead, useProjectsTreeEnvironmentChildren } from '../ProjectsTreeEnvironmentReads';
import type { ProjectsTreeEnvironmentChild } from '../projectsTreeRows';
import type { AllDeploymentsRead } from './AllDeploymentsScreen';
import {
  isSameDeploymentName,
  useDeploymentEnvironmentRowParts,
} from './DeploymentEnvironmentCollection';
import { groupDeploymentRowsByProject } from './deploymentProjectGroups';
import { buildDeploymentEnvironmentHref, buildDeploymentProjectHref, SERVICES_ROUTE } from './deploymentNavigation';
import { useDeploymentInventory } from './useDeploymentProject';
import { useServicesListView, useServicesSpaceHeader } from './useServicesListView';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { DeploymentEnvironmentRowMenu, DeploymentEnvironmentStateMark, DeploymentTreeRow } from './rows/DeploymentEnvironmentRow';
import { usePinnedEnvironmentIds } from '@/sync/domains/workspaces/projectAccountRows';
import { setServicesColumnGrouping, useServicesColumnGrouping, type ServicesColumnGrouping } from '@/sync/domains/state/servicesColumnUiState';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { ServicesColumnTypeSections } from './ServicesColumnTypeSections';
import { pinProjectService } from '@/sync/ops/actions/projectWorkspaceActions';
import { deploymentEnvironmentRowFact, deploymentEnvironmentRunsOnMachine } from './rows/deploymentEnvironmentRowFact';

/** What the open route has selected in the Services column. */
export type ServicesColumnSelection =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'project'; projectSourceId: string }>
  | Readonly<{
      kind: 'environment';
      projectSourceId: string;
      environmentId: string;
    }>
  | null;

/** The Services column's selection from the route the page beside it has open. */
export function readServicesColumnSelection(
  pathname: string,
  deploymentEnvironment: string | null,
): ServicesColumnSelection {
  const path = pathname.split(/[?#]/, 1)[0]!.replace(/\/+$/, '');
  if (path === SERVICES_ROUTE) return { kind: 'all' };
  const match = /^\/deployments\/([^/]+)$/.exec(path);
  if (!match) return null;
  let projectSourceId: string;
  try {
    projectSourceId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return deploymentEnvironment
    ? {
        kind: 'environment',
        projectSourceId,
        environmentId: deploymentEnvironment,
      }
    : { kind: 'project', projectSourceId };
}

const selectDeploymentEnvironmentParam = (
  params: Readonly<Record<string, string | string[] | undefined>>,
) => {
  const value = params.deploymentEnvironment;
  return typeof value === 'string' && value ? value : null;
};

// The column is mounted only while Services is open, so it demands its read for exactly that long.
const COLUMN_DEMAND: DeploymentReadDemandV1 = Object.freeze({
  mounted: true,
  visible: true,
  focused: true,
});
const NO_KEYS: ReadonlySet<string> = new Set();

/** A Services column row as the tree reads it, with what a press (or Enter) opens and the Project it discloses. */
type ServicesTreeRow = CollectionTreeRow & Readonly<{ href: string | null; groupKey?: string; environmentId?: string }>;

/**
 * The Services destination's column (lab pfc-redesign `sideSvc`, variant A): the page's views stay its tab bar, and the
 * column is the map: All services, then every Project with its Environments, folded until opened. It reads the same
 * first page of the Account-wide Environment list the Services page reads, so the two never disagree.
 */
export const ServicesColumn = React.memo(function ServicesColumn() {
  const lifetime = useActiveServerAccountScopeLifetime();
  const read = useDeploymentInventory(lifetime, COLUMN_DEMAND);
  const pathname = usePathname();
  const deploymentEnvironment = useCurrentRouteParamsSelector(
    selectDeploymentEnvironmentParam,
  );
  const selection = React.useMemo(
    () => readServicesColumnSelection(pathname, deploymentEnvironment),
    [deploymentEnvironment, pathname],
  );
  const router = useRouter();
  const openNewApp = useOpenNewApp();
  const create = React.useMemo(
    () => ({
      label: t('newApp.title'),
      testID: 'services-column:deploy',
      onPress: () => openNewApp(),
    }),
    [openNewApp],
  );
  const navigate = React.useCallback(
    (href: string) => router.push(href as never),
    [router],
  );
  const serverId = lifetime?.scope.serverId ?? null;
  // The person's pinned services: their private Services organization row on this Home (projects.services.pin).
  const pinnedEnvironmentIds = usePinnedEnvironmentIds(serverId);
  // How the column groups what you run, kept on this device (owner 2026-11-16 10:20Z).
  const grouping = useServicesColumnGrouping();
  const togglePinned = React.useCallback((environmentId: string, pinned: boolean) => {
    if (serverId) void pinProjectService({ serverId, environmentId, pinned });
  }, [serverId]);
  // Saved views and filters (owner D5, agreed with PFC-SERVICES 11:15Z): the column header places the one Services
  // header (title menu, funnel, strip); the Apps page beside it adds none, and both narrow through the same draft.
  const presented = useLayoutPresentationActive();
  const servicesView = useServicesListView(read.snapshot.value?.items, presented);
  const spaceHeader = useServicesSpaceHeader(servicesView, 'services-column-space');
  const space: ServicesColumnSpace = {
    isVisible: servicesView.isVisible,
    narrowing: servicesView.narrowing,
    matchedCount: servicesView.filterResult.matchedCount,
    titleControl: spaceHeader.titleControl,
    filterButton: spaceHeader.filterButton,
    band: <>{spaceHeader.strip}{spaceHeader.overlays}</>,
    conditions: spaceHeader.conditionRow,
  };
  return (
    <ServicesColumnView
      space={space}
      read={read}
      serverId={lifetime?.scope.serverId ?? null}
      lifetime={lifetime}
      selection={selection}
      onNavigate={navigate}
      create={create}
      pinnedEnvironmentIds={pinnedEnvironmentIds}
      onTogglePinned={togglePinned}
      controller={read.controller}
      grouping={grouping}
      onGroupingChange={setServicesColumnGrouping}
    />
  );
});

/** The column over one read; tests and the dev specimen render it over a fixture transport. */
export const ServicesColumnView = React.memo(function ServicesColumnView(
  props: Readonly<{
    read: AllDeploymentsRead;
    serverId: string | null;
    lifetime: ServerAccountScopeLifetime | null;
    selection: ServicesColumnSelection;
    onNavigate: (href: string) => void;
    create: Readonly<{
      label: string;
      testID: string;
      onPress: () => void;
    }> | null;
    /** Pinned services, newest first (the Services organization row); an id this read does not hold draws nothing. */
    pinnedEnvironmentIds: readonly string[];
    onTogglePinned: (environmentId: string, pinned: boolean) => void;
    /** The read's controller, for the By type sections' own reads (mounted only while By type shows). */
    controller: DeploymentReadControllerV1 | null;
    grouping: ServicesColumnGrouping;
    onGroupingChange: (grouping: ServicesColumnGrouping) => void;
    /** The Services saved view (owner D5): which Environments it keeps, and the header pieces the column places. */
    space?: ServicesColumnSpace;
  }>,
) {
  const { read, serverId, selection, onNavigate } = props;
  const items = read.snapshot.value?.items ?? NO_ITEMS;
  const rows = useDeploymentEnvironmentRowParts(
    items,
    'services-column.environment',
    props.lifetime,
    'rail',
  );
  const [query, setQuery] = React.useState('');
  const needle = query.trim().toLocaleLowerCase();
  // The column lists Projects that have something deployed (OWNER-UI-1115B E1, ruling 16:29Z): a Project with at least
  // one deployed Environment, whatever its state, keeps all its Environments; one with only drafts stays on All services
  // (still shown while the route has one of its Environments open).
  const routeEnvironmentId = selection?.kind === 'environment' ? selection.environmentId : null;
  const listed = React.useMemo(() => {
    const deployed = new Set(items.flatMap((item) => item.currentDeployment ? [item.environment.projectSourceId] : []));
    const kept = props.space?.isVisible;
    return rows.filter((row) => (deployed.has(row.projectSourceId) || row.environmentId === routeEnvironmentId)
      && (kept === undefined || kept(row.environmentId)));
  }, [items, rows, routeEnvironmentId, props.space?.isVisible]);
  const groups = React.useMemo(() => {
    const shown = needle
      ? listed.filter((row) =>
          `${row.projectName ?? ''} ${row.title}`
            .toLocaleLowerCase()
            .includes(needle),
        )
      : listed;
    const { named, unnamed } = groupDeploymentRowsByProject(shown);
    return unnamed.length
      ? [
          ...named,
          {
            key: 'unnamed',
            title: t('projects.deployments.allOtherProject'),
            rows: unnamed,
          },
        ]
      : named;
  }, [needle, listed]);
  // Pinned (lab sideSvc): the pinned Environments the tree shows, in pin order; a search narrows them as it does the tree.
  const pinnedSet = React.useMemo(() => new Set(props.pinnedEnvironmentIds), [props.pinnedEnvironmentIds]);
  const pinnedRows = React.useMemo(() => {
    const shown = new Map(groups.flatMap((group) => group.rows.map((row) => [row.environmentId, row] as const)));
    return props.pinnedEnvironmentIds.flatMap((id) => {
      const row = shown.get(id);
      return row ? [row] : [];
    });
  }, [groups, props.pinnedEnvironmentIds]);
  // Folded by default (lab: the tree loads collapsed); the Project the open route is in stays open.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(NO_KEYS);
  const [collapsed, setCollapsed] =
    React.useState<ReadonlySet<string>>(NO_KEYS);
  const routeProject =
    selection && selection.kind !== 'all' ? selection.projectSourceId : null;
  const isOpen = (key: string) =>
    !collapsed.has(key) &&
    (expanded.has(key) || key === routeProject || needle.length > 0);
  const toggle = (key: string, open: boolean) => {
    const without = (set: ReadonlySet<string>) => {
      const next = new Set(set);
      next.delete(key);
      return next;
    };
    setExpanded((current) =>
      open ? without(current) : new Set([...current, key]),
    );
    setCollapsed((current) =>
      open ? new Set([...current, key]) : without(current),
    );
  };
  // An Environment opens onto what it runs (lab sideSvc level 3), read only while it is open; folded by default.
  const [openEnvironments, setOpenEnvironments] = React.useState<ReadonlySet<string>>(NO_KEYS);
  const toggleEnvironment = (environmentId: string) => setOpenEnvironments((current) => {
    const next = new Set(current);
    if (next.has(environmentId)) next.delete(environmentId); else next.add(environmentId);
    return next;
  });
  const [children, publishChildren] = useProjectsTreeEnvironmentChildren();
  const itemById = React.useMemo(() => new Map(items.map((item) => [item.environment.id, item] as const)), [items]);
  const machineOf = (environmentId: string) => deploymentEnvironmentRunsOnMachine(itemById.get(environmentId));
  const environmentOpen = (environmentId: string) => openEnvironments.has(environmentId) && machineOf(environmentId) !== null;
  const environmentHref = (projectSourceId: string, environmentId: string) =>
    serverId
      ? buildDeploymentEnvironmentHref({
          serverId,
          projectSourceId,
          environmentId,
        })
      : null;
  const projectHref = (projectSourceId: string) =>
    serverId ? buildDeploymentProjectHref({ serverId, projectSourceId }) : null;
  const complete =
    read.snapshot.value !== undefined &&
    read.snapshot.value !== null &&
    !read.hasNextPage &&
    !read.hasPreviousPage;
  const searchable = items.length > 0;
  const status = read.snapshot;
  // Where a service or database under an opened Environment goes (the tree below reads it while it builds).
  const childHref = (row: (typeof rows)[number], child: ProjectsTreeEnvironmentChild) => child.opens.kind === 'href'
    ? child.opens.href
    : serverId ? buildDeploymentEnvironmentHref({ serverId, projectSourceId: row.projectSourceId, environmentId: row.environmentId,
      database: child.opens.database }) : null;
  // The column's rows in drawing order, as the shared tree reads them: one roving tab stop, arrows move, Right/Left
  // disclose a Project, Enter opens what a press opens (`useCollectionTreeKeyboard`, as the Projects tree).
  const tree = React.useMemo(() => {
    const presented = groups.map((group) => {
      const only =
        group.rows.length === 1 &&
        group.key !== 'unnamed' &&
        isSameDeploymentName(group.rows[0]!.title, group.title)
          ? group.rows[0]!
          : null;
      return { group, only, open: only === null && isOpen(group.key) };
    });
    const environmentRow = (row: (typeof rows)[number], level: number): ServicesTreeRow[] => {
      const open = environmentOpen(row.environmentId);
      const own: ServicesTreeRow = {
        key: `environment:${row.environmentId}`,
        level,
        expandable: machineOf(row.environmentId) !== null,
        expanded: open,
        href: environmentHref(row.projectSourceId, row.environmentId),
        environmentId: row.environmentId,
      };
      const under = open ? children.get(row.environmentId) ?? [] : [];
      return [own, ...under.map((child): ServicesTreeRow => ({
        key: `environment:${row.environmentId}/${child.key}`,
        level: level + 1,
        expandable: false,
        expanded: false,
        href: childHref(row, child),
      }))];
    };
    // All (owner 2026-11-16): every listed Environment in one flat run, each named by its Project.
    const flat = props.grouping === 'all' ? groups.flatMap((group) => group.rows) : null;
    const treeRows: ServicesTreeRow[] = [
      { key: 'all', level: 0, expandable: false, expanded: false, href: SERVICES_ROUTE },
      ...pinnedRows.map((row): ServicesTreeRow => ({ key: `pinned:${row.environmentId}`, level: 0, expandable: false,
        expanded: false, href: environmentHref(row.projectSourceId, row.environmentId) })),
      ...(flat ? flat.flatMap((row) => environmentRow(row, 0)) : []),
      ...(flat ? [] : presented).flatMap(({ group, only, open }) =>
        only
          ? environmentRow(only, 0)
          : [
              {
                key: `project:${group.key}`,
                level: 0,
                expandable: true,
                expanded: open,
                href: group.key === 'unnamed' ? null : projectHref(group.key),
                groupKey: group.key,
              },
              ...(open ? group.rows.flatMap((row) => environmentRow(row, 1)) : []),
            ],
      ),
    ];
    return { presented, rows: treeRows, byKey: new Map(treeRows.map((row) => [row.key, row])) };
    // isOpen, environmentHref and projectHref read exactly these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, expanded, collapsed, routeProject, needle, serverId, openEnvironments, children, itemById, pinnedRows, props.grouping]);
  const keyboard = useCollectionTreeKeyboard(tree.rows, {
    onToggle: (key) => {
      const row = tree.byKey.get(key);
      if (row?.groupKey !== undefined) toggle(row.groupKey, isOpen(row.groupKey));
      else if (row?.environmentId !== undefined) toggleEnvironment(row.environmentId);
    },
    onOpenRow: (row) => {
      if (row.href) onNavigate(row.href);
      else if (row.groupKey !== undefined) toggle(row.groupKey, isOpen(row.groupKey));
    },
  });
  const treeItemOf = (key: string) => {
    const row = tree.byKey.get(key);
    return row ? keyboard.getRowProps(row) : undefined;
  };

  // The one Environment row (UI refinements ruling 2026-11-15 08:57Z): the Projects tree's row, one line, its end the
  // shared state mark or its one quiet fact; opened, the services and databases it runs under it.
  const renderEnvironment = (row: (typeof rows)[number], child: boolean, title?: string, named = false) => {
    const name = named ? namedByProject(row) : { title: row.title, titleQualifier: row.titleQualifier };
    const href = environmentHref(row.projectSourceId, row.environmentId);
    const testID = `services-column:environment:${row.environmentId}`;
    const expandable = machineOf(row.environmentId) !== null;
    const open = environmentOpen(row.environmentId);
    const under = open ? children.get(row.environmentId) ?? [] : [];
    return (
      <React.Fragment key={row.environmentId}>
        <DeploymentTreeRow
          testID={testID}
          // A folded Project keeps its Project mark, so every top-level row starts on one edge (lab `sideSvc`).
          row={{ kind: title ? 'project' : 'environment', title: title ?? name.title, titleQualifier: title ? null : name.titleQualifier,
            platform: row.platform, state: row.state, fact: deploymentEnvironmentRowFact(row, itemById.get(row.environmentId)) }}
          href={href}
          treeItem={treeItemOf(`environment:${row.environmentId}`)}
          child={child}
          disclosure={expandable ? { expanded: open, onToggle: () => toggleEnvironment(row.environmentId) } : null}
          selected={selection?.kind === 'environment' && selection.environmentId === row.environmentId}
          rowMenu={<DeploymentEnvironmentRowMenu testID={`${testID}:menu`} pinned={pinnedSet.has(row.environmentId)}
            onSelectPin={() => props.onTogglePinned(row.environmentId, !pinnedSet.has(row.environmentId))} />}
          onPress={() => { if (href) onNavigate(href); }}
        />
        {under.map((item) => {
          const key = `environment:${row.environmentId}/${item.key}`;
          const target = childHref(row, item);
          return (
            <DeploymentTreeRow
              key={key}
              testID={`services-column:${key}`}
              row={{ kind: item.kind, title: item.title, fact: item.subtitle }}
              href={target}
              treeItem={treeItemOf(key)}
              child
              indentPx={resolveHappierCollectionTreeChildIndentPx()}
              selected={false}
              onPress={() => { if (target) onNavigate(target); }}
            />
          );
        })}
      </React.Fragment>
    );
  };

  return (
    <View testID="services-column" style={styles.column}>
      <CollectionList
        testID="services-column:list"
        surface="plane"
        title={t('projects.deployments.services.title')}
        // The grouping switch (owner 2026-11-16 10:20Z): the Session list's own control (SegmentedTabBar) in the title row.
        titleAccessory={<ServicesColumnGroupingSwitch grouping={props.grouping} onChange={props.onGroupingChange} />}
        {...(props.space ? { titleControl: props.space.titleControl, strip: props.space.band, conditions: props.space.conditions } : {})}
        // A count speaks only once the whole list is known (no "0", no count of one page); a saved view counts what it keeps.
        count={complete && items.length > 0 ? (props.space?.narrowing ? props.space.matchedCount : items.length) : undefined}
        create={props.create}
        search={
          searchable
            ? {
                testID: 'services-column:search',
                value: query,
                onChangeText: setQuery,
                ...(props.space ? { trailing: props.space.filterButton } : {}),
                placeholder: t(
                  'projects.deployments.services.searchPlaceholder',
                ),
              }
            : null
        }
      >
        <CollectionNavigationRow
          testID="services-column:all"
          href={SERVICES_ROUTE}
          treeItem={treeItemOf('all')}
          title={t('projects.deployments.services.allServices')}
          icon={<Icon name="rocket-launch" />}
          selected={selection?.kind === 'all'}
          onPress={() => onNavigate(SERVICES_ROUTE)}
        />
        {pinnedRows.length > 0 ? <CollectionListGroupLabel title={t('projects.groups.pinned')} /> : null}
        <CollectionRows>
        {pinnedRows.map((row) => {
          const href = environmentHref(row.projectSourceId, row.environmentId);
          const testID = `services-column:pinned:${row.environmentId}`;
          const name = namedByProject(row);
          return (
            <DeploymentTreeRow
              key={testID}
              testID={testID}
              row={{ kind: 'environment', title: name.title, titleQualifier: name.titleQualifier,
                platform: row.platform, state: row.state, fact: deploymentEnvironmentRowFact(row, itemById.get(row.environmentId)) }}
              href={href}
              treeItem={treeItemOf(`pinned:${row.environmentId}`)}
              selected={selection?.kind === 'environment' && selection.environmentId === row.environmentId}
              rowMenu={<DeploymentEnvironmentRowMenu testID={`${testID}:menu`} pinned
                onSelectPin={() => props.onTogglePinned(row.environmentId, false)} />}
              onPress={() => { if (href) onNavigate(href); }}
            />
          );
        })}
        </CollectionRows>
        {!status.value && status.status !== 'unavailable' ? (
          <CollectionSkeletonRows count={3} />
        ) : !status.value && selection?.kind !== 'all' ? (
          // Beside the Services page the page says the failure with its Retry; beside an Environment the column says it.
          <View style={collectionListStyles.stateLine}>
            <SurfaceStateCard
              testID="services-column:error"
              kind="error"
              size="line"
              title={t('projects.deployments.allLoadErrorTitle')}
              action={{
                label: t('common.retry'),
                onPress: () => {
                  void read.refresh();
                },
              }}
            />
          </View>
        ) : null}
        {needle && groups.length === 0 ? (
          <EmptyState
            testID="services-column:no-matches"
            layout="line"
            title={t('common.noMatches')}
          />
        ) : null}
        {groups.length > 0 && props.grouping !== 'all' ? (
          <CollectionListGroupLabel title={props.grouping === 'type' ? t('projects.deployments.services.apps') : t('tabs.projects')} />
        ) : null}
        {[...openEnvironments].flatMap((environmentId) => {
          const machineId = machineOf(environmentId);
          return machineId && serverId ? [<ProjectsTreeEnvironmentRead key={environmentId} onChildren={publishChildren}
            environment={{ environmentId, serverId, machineId }} />] : [];
        })}
        {/* The tree's rows in drawn order, disclosed children included: the one list-row rule runs between them. */}
        <CollectionRows>
        {props.grouping === 'all' ? groups.flatMap((group) => group.rows).map((row) => renderEnvironment(row, false, undefined, true)) : null}
        {props.grouping === 'all' ? null : tree.presented.map(({ group, only, open }) => {
          // A Project whose one Environment carries its name folds into that Environment's row.
          if (only) return renderEnvironment(only, false, group.title);
          // Folded, the Project says the first state that needs the person, with the one Environment state mark.
          const trouble = open ? null : group.rows.find((row) => row.state && row.state.tone !== null)?.state ?? null;
          const href = group.key === 'unnamed' ? null : projectHref(group.key);
          return (
            <React.Fragment key={group.key}>
              <CollectionNavigationRow
                testID={`services-column:project:${group.key}`}
                href={href}
                title={group.title}
                icon={<Icon name="folder" />}
                status={trouble ? <DeploymentEnvironmentStateMark state={trouble}
                  testID={`services-column:project:${group.key}:end`} /> : undefined}
                treeItem={treeItemOf(`project:${group.key}`)}
                count={open ? null : group.rows.length}
                disclosure={{
                  expanded: open,
                  onToggle: () => toggle(group.key, open),
                }}
                selected={
                  selection?.kind === 'project' &&
                  selection.projectSourceId === group.key
                }
                onPress={() => {
                  if (href) onNavigate(href);
                  else toggle(group.key, open);
                }}
              />
              {open
                ? group.rows.map((row) => renderEnvironment(row, true))
                : null}
            </React.Fragment>
          );
        })}
        </CollectionRows>
        {props.grouping === 'type' ? (
          <ServicesColumnTypeSections controller={props.controller} demand={COLUMN_DEMAND} scope={props.lifetime?.scope ?? null}
            serverId={serverId} needle={needle} onNavigate={onNavigate} />
        ) : null}
      </CollectionList>
    </View>
  );
});

export type { ServicesColumnGrouping };

/** The Services saved view the column header carries (owner D5): `useServicesListView` + `useServicesSpaceHeader`. */
type ServicesColumnSpace = Readonly<{
  isVisible: (environmentId: string) => boolean;
  narrowing: boolean;
  matchedCount: number;
  titleControl: React.ReactNode;
  filterButton: React.ReactNode;
  band: React.ReactNode;
  /** The saved view's condition tokens, on a line of their own under the band. */
  conditions: React.ReactNode;
}>;

/**
 * Named by its Project, the Environment beside it (lab "billing-api  Production"): the All and Pinned rows. An
 * Environment named after its Project ("sweep-a1-preview" in "sweep-a1-starter") already says which Project it is in,
 * so its own name takes the row: beside the Project each got half, and like-named rows read alike (SERVICES-ACCEPT-1116 F6).
 */
function namedByProject(row: Readonly<{ title: string; titleQualifier?: string | null; projectName?: string | null }>) {
  const project = row.projectName && !namesItsProject(row.title, row.projectName) ? row.projectName : null;
  return { title: project ?? row.title, titleQualifier: project ? row.title : row.titleQualifier ?? null };
}

const NAME_WORD = /[\s._-]+/;
function namesItsProject(environment: string, project: string): boolean {
  if (isSameDeploymentName(environment, project)) return true;
  const [first] = project.trim().toLocaleLowerCase().split(NAME_WORD);
  return first !== undefined && first.length > 1 && environment.trim().toLocaleLowerCase().split(NAME_WORD)[0] === first;
}

/**
 * All · By project · By type (owner 2026-11-16 10:20Z): the Session list's icon segmented control (`SegmentedTabBar`,
 * compact, a radiogroup) in the column's title row, before Search and "+".
 */
const ServicesColumnGroupingSwitch = React.memo(function ServicesColumnGroupingSwitch(props: Readonly<{
  grouping: ServicesColumnGrouping;
  onChange: (grouping: ServicesColumnGrouping) => void;
}>) {
  const { theme } = useUnistyles();
  const color = theme.colors.text.secondary;
  return (
    <SegmentedTabBar<ServicesColumnGrouping>
      testIDPrefix="services-column:grouping"
      accessibilityLabel={t('projects.deployments.services.groupingTitle')}
      role="radiogroup"
      compact
      segmentSizing="content"
      tabs={[
        { id: 'all', label: t('projects.deployments.services.groupingAll'), icon: <Icon name="list-bullets" size={15} color={color} /> },
        { id: 'project', label: t('projects.deployments.services.groupingByProject'), icon: <Icon name="folder" size={15} color={color} /> },
        { id: 'type', label: t('projects.deployments.services.groupingByType'), icon: <Icon name="squares-four" size={15} color={color} /> },
      ]}
      activeTabId={props.grouping}
      onSelectTab={props.onChange}
    />
  );
});

const NO_ITEMS: readonly NonNullable<
  AllDeploymentsRead['snapshot']['value']
>['items'][number][] = Object.freeze([]);

const styles = StyleSheet.create(() => ({
  column: {
    flex: 1,
    minHeight: 0,
  },
}));

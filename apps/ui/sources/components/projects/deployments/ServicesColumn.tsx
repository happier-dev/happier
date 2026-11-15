import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentReadDemandV1 } from '@happier-dev/deployments';

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
import { DeploymentEnvironmentStateMark, DeploymentTreeRow } from './rows/DeploymentEnvironmentRow';
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
  return (
    <ServicesColumnView
      read={read}
      serverId={lifetime?.scope.serverId ?? null}
      lifetime={lifetime}
      selection={selection}
      onNavigate={navigate}
      create={create}
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
  const groups = React.useMemo(() => {
    const shown = needle
      ? rows.filter((row) =>
          `${row.projectName ?? ''} ${row.title}`
            .toLocaleLowerCase()
            .includes(needle),
        )
      : rows;
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
  }, [needle, rows]);
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
    const treeRows: ServicesTreeRow[] = [
      { key: 'all', level: 0, expandable: false, expanded: false, href: SERVICES_ROUTE },
      ...presented.flatMap(({ group, only, open }) =>
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
  }, [groups, expanded, collapsed, routeProject, needle, serverId, openEnvironments, children, itemById]);
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
  const renderEnvironment = (row: (typeof rows)[number], child: boolean, title?: string) => {
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
          row={{ kind: title ? 'project' : 'environment', title: title ?? row.title, titleQualifier: title ? null : row.titleQualifier,
            platform: row.platform, state: row.state, fact: deploymentEnvironmentRowFact(row, itemById.get(row.environmentId)) }}
          href={href}
          treeItem={treeItemOf(`environment:${row.environmentId}`)}
          child={child}
          disclosure={expandable ? { expanded: open, onToggle: () => toggleEnvironment(row.environmentId) } : null}
          selected={selection?.kind === 'environment' && selection.environmentId === row.environmentId}
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
        // A count speaks only once the whole list is known (no "0", no count of one page).
        count={complete && items.length > 0 ? items.length : undefined}
        create={props.create}
        search={
          searchable
            ? {
                testID: 'services-column:search',
                collapsible: true,
                value: query,
                onChangeText: setQuery,
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
        {groups.length > 0 ? (
          <CollectionListGroupLabel title={t('tabs.projects')} />
        ) : null}
        {[...openEnvironments].flatMap((environmentId) => {
          const machineId = machineOf(environmentId);
          return machineId && serverId ? [<ProjectsTreeEnvironmentRead key={environmentId} onChildren={publishChildren}
            environment={{ environmentId, serverId, machineId }} />] : [];
        })}
        {tree.presented.map(({ group, only, open }) => {
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
      </CollectionList>
    </View>
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

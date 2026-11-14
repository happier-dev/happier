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
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

import { useOpenNewApp } from '../starters/newAppPresentation';
import type { AllDeploymentsRead } from './AllDeploymentsScreen';
import {
  isSameDeploymentName,
  useDeploymentEnvironmentRowParts,
} from './DeploymentEnvironmentCollection';
import { groupDeploymentRowsByProject } from './deploymentProjectGroups';
import { buildDeploymentEnvironmentHref, SERVICES_ROUTE } from './deploymentNavigation';
import { useDeploymentInventory } from './useDeploymentProject';

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
  const environmentHref = (projectSourceId: string, environmentId: string) =>
    serverId
      ? buildDeploymentEnvironmentHref({
          serverId,
          projectSourceId,
          environmentId,
        })
      : null;
  const projectHref = (projectSourceId: string) =>
    serverId
      ? `/deployments/${encodeURIComponent(projectSourceId)}?serverId=${encodeURIComponent(serverId)}`
      : null;
  const complete =
    read.snapshot.value !== undefined &&
    read.snapshot.value !== null &&
    !read.hasNextPage &&
    !read.hasPreviousPage;
  const searchable = items.length > 0;
  const status = read.snapshot;

  const renderEnvironment = (
    row: (typeof rows)[number],
    child: boolean,
    title?: string,
  ) => {
    const href = environmentHref(row.projectSourceId, row.environmentId);
    return (
      <CollectionNavigationRow
        key={row.environmentId}
        testID={`services-column:environment:${row.environmentId}`}
        href={href}
        title={title ?? row.title}
        titleQualifier={title ? null : row.titleQualifier}
        // A folded Project keeps its Project mark, so every top-level row starts on one edge (lab `sideSvc`).
        icon={title ? <Icon name="folder" /> : undefined}
        // Quiet when healthy: the row speaks only while a deploy works or something needs the person; where it runs and
        // what is live are the Environment page's (the row owner's `rail` reading).
        subtitle={row.subtitleLeading ? row.subtitle : undefined}
        subtitleLeading={row.subtitleLeading}
        needsYouStatus={row.needsYouStatus}
        child={child}
        disclosure={null}
        selected={
          selection?.kind === 'environment' &&
          selection.environmentId === row.environmentId
        }
        onPress={() => {
          if (href) onNavigate(href);
        }}
      />
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
        {groups.map((group) => {
          // A Project whose one Environment carries its name folds into that Environment's row.
          const only =
            group.rows.length === 1 &&
            group.key !== 'unnamed' &&
            isSameDeploymentName(group.rows[0]!.title, group.title)
              ? group.rows[0]!
              : null;
          if (only) return renderEnvironment(only, false, group.title);
          const open = isOpen(group.key);
          const trouble = open
            ? null
            : (group.rows.find((row) => row.needsYouStatus)?.needsYouStatus ??
              null);
          const href = group.key === 'unnamed' ? null : projectHref(group.key);
          return (
            <React.Fragment key={group.key}>
              <CollectionNavigationRow
                testID={`services-column:project:${group.key}`}
                href={href}
                title={group.title}
                icon={<Icon name="folder" />}
                needsYouStatus={trouble}
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

import * as React from 'react';
import type {
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';
import type { DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { formatHappierDataBytesParts } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Status, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import { databaseEngineTitle, describeDatabaseSize } from './databasePresentation';
import { DeploymentDomainsList } from './DeploymentDomainRow';
import { deploymentDomainNeedKind } from './deploymentDomainAttention';
import { groupDeploymentRowsByProject } from './deploymentProjectGroups';
import { SERVICES_ONE_SHEET, ServicesPageList } from './DeploymentEnvironmentRows';
import { useVisibleBackupCoverage } from './useVisibleBackupCoverage';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import {
  useDeploymentDataServicePage,
  useDeploymentDomainPage,
} from './useDeploymentReads';

/**
 * The Services page's views (pfc-redesign svcApps · svcDb · svcDom): one collection seen three ways, so a tab bar.
 * Checks and Watched join when their Account-wide reads exist; a view never computes a fact its owner doesn't report.
 */
export type ServicesView = 'apps' | 'databases' | 'domains' | 'checks' | 'watched';
const VIEWS: readonly ServicesView[] = ['apps', 'databases', 'domains', 'checks', 'watched'];
/** A view's count line, from its own read's reported rows (the page's head draws it, MainScreenHeader `count`). */
export type ServicesViewCount = Readonly<{ view: ServicesView; parts: readonly (string | null)[]; needYou?: number }>;

/** The route's `view`, read once: anything else is the Apps view. */
export function readServicesView(
  value: string | null | undefined,
): ServicesView {
  return VIEWS.find((view) => view === value) ?? 'apps';
}

export function ServicesViewTabs(
  props: Readonly<{
    active: ServicesView;
    onSelect: (view: ServicesView) => void;
    /** How many rows need the person in each view, as its owner reported them: the tab's needs-you count. */
    needYou?: Partial<Record<ServicesView, number>>;
  }>,
) {
  const overflow = React.useMemo(() => ({ label: t('common.more'), testID: 'services.view.more' }), []);
  const tabs = React.useMemo(
    () => [
      { id: 'apps' as const, label: t('projects.deployments.services.apps') },
      {
        id: 'databases' as const,
        label: t('projects.deployments.services.databases'),
      },
      {
        id: 'domains' as const,
        label: t('projects.deployments.services.domains'),
      },
      { id: 'checks' as const, label: t('projects.deployments.services.checks') },
      { id: 'watched' as const, label: t('projects.deployments.services.watched') },
    ].map((tab) => {
      const count = props.needYou?.[tab.id] ?? 0;
      return count > 0 ? { ...tab, count: String(count), countTone: 'danger' as const } : tab;
    }),
    [props.needYou],
  );
  return (
    // The page head's band places it on the sheets' edge (MainScreenHeader).
    <View testID="services.views">
      <SegmentedTabBar<ServicesView>
        role="tablist"
        segmentSizing="content"
        testIDPrefix="services.view"
        // Views that don't fit (a phone) move into More, measured by the bar itself (Machine page pattern).
        overflow={overflow}
        tabs={tabs}
        activeTabId={props.active}
        onSelectTab={props.onSelect}
      />
    </View>
  );
}

const NO_ITEMS: readonly never[] = Object.freeze([]);

function describeDatabaseGrowth(
  growth: DeploymentDatabaseSizeV1['growth'],
): string | null {
  if (growth.status !== 'available' || growth.bytes === 0) return null;
  const parts = formatHappierDataBytesParts(Math.abs(growth.bytes), {
    kind: 'storage',
  });
  return t('projects.deployments.services.growth', {
    amount: `${growth.bytes > 0 ? '+' : '−'}${parts.value} ${parts.unit}`,
  });
}

type DatabaseRow = Readonly<{
  key: string;
  environmentId: string;
  projectSourceId: string;
  service: string;
  engine: string | null;
  growth: string | null;
  size: string;
}>;
const keyOfDatabase = (row: DatabaseRow) => row.key;
const groupOfDatabase = (row: DatabaseRow) => row.environmentId;
const NO_DATABASES: readonly DatabaseRow[] = Object.freeze([]);

/**
 * Databases (lab svcDb): every Environment's data services with the size DB-SIZE-1113's read reports and the
 * Environment's backup coverage from its owner, banded by Environment on one sheet; a row opens its database page.
 */
export function ServicesDatabasesView(
  props: Readonly<{
    controller: DeploymentReadControllerV1 | null;
    demand: DeploymentReadDemandV1;
    serverId: string;
    lifetime: ServerAccountScopeLifetime | null;
    onCount: (count: ServicesViewCount) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const read = useDeploymentDataServicePage(props.controller, props.demand);
  const items = read.snapshot.value?.items ?? NO_ITEMS;
  const withData = React.useMemo(() => items.filter((item) => (item.databaseSizes?.length ?? 0) > 0), [items]);
  const environments = React.useMemo(() => withData.map((item) => item.environment), [withData]);
  const backups = useVisibleBackupCoverage(props.lifetime, environments, props.demand.visible);
  const coverage = React.useMemo(() => new Map(backups.coverage?.rows.map((row) => [row.environment.id, row.status])),
    [backups.coverage]);
  const rows = React.useMemo<readonly DatabaseRow[]>(() => withData.length === 0 ? NO_DATABASES : withData.flatMap((item) =>
    item.databaseSizes!.map((database) => {
      const declared = item.content.template?.data?.find((data) => data.service === database.service);
      return {
        key: `${item.environment.id}:${database.service}`,
        environmentId: item.environment.id,
        projectSourceId: item.environment.projectSourceId,
        service: database.service,
        engine: declared ? databaseEngineTitle(declared) : null,
        growth: describeDatabaseGrowth(database.growth),
        size: describeDatabaseSize(database.size),
      };
    })), [withData]);
  const groups = React.useMemo(() => ({
    axis: withData.map((item) => ({ key: item.environment.id, title: item.title, section: SERVICES_ONE_SHEET })),
    groupOf: groupOfDatabase,
  }), [withData]);
  const { serverId } = props;
  const open = React.useCallback((key: string | number | null) => {
    const row = key === null ? undefined : rows.find((candidate) => candidate.key === String(key));
    if (!row) return;
    router.push(deploymentEnvironmentRoute({ serverId, projectSourceId: row.projectSourceId,
      environmentId: row.environmentId, database: row.service }));
  }, [router, rows, serverId]);
  const model = useHappierCollection<DatabaseRow>({ items: rows, keyOf: keyOfDatabase, groups, openKey: null, onOpenChange: open });
  const anatomy = React.useMemo<CollectionAnatomy<DatabaseRow>>(() => {
    const meta = { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1 } as const;
    const backupWord = (row: DatabaseRow) => {
      const status = coverage.get(row.environmentId);
      return status === 'uncovered' ? <Status tone="warning" label={t('projects.deployments.notBackedUp')} presentation="inline" />
        : status === 'covered' ? t('projects.deployments.services.backupCovered')
        : status === 'notNeeded' ? t('projects.deployments.services.backupNotNeeded')
        // Said as the coverage owner reports it: still reading, or its read failed (never a bare dash for either).
        : status === 'unavailable' ? <Status tone="muted" label={t('projects.deployments.services.backupUnchecked')} presentation="inline" />
        : status === 'loading' ? t('projects.deployments.services.backupChecking') : null;
    };
    return {
      glyph: () => <Icon name="stack" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
      title: (row) => row.service,
      // Line 2: the engine and how it grew; a phone also says its size.
      byline: (row, layout) => {
        const line = [row.engine, row.growth, layout?.fieldColumns === true ? null : row.size].filter(Boolean).join(' · ');
        return line ? <Text style={meta} numberOfLines={1}>{line}</Text> : null;
      },
      titleMeta: (row) => coverage.get(row.environmentId) === 'uncovered' ? backupWord(row) : null,
      titleMetaAlign: 'row',
      fields: [
        { key: 'size', title: t('projects.deployments.services.sizeLabel'), minWidth: 216, priority: 2, listColumn: true,
          render: (row) => row.size },
        { key: 'backups', title: t('projects.deployments.services.columnBackups'), minWidth: 140, priority: 1, align: 'end',
          listColumn: true, render: backupWord },
      ],
      accessibilityLabel: (row) => [row.service, row.engine, row.size].filter(Boolean).join(', '),
      testID: (row) => `services.databases.row.${row.environmentId}.${row.service}`,
      columnTitles: { title: t('projects.deployments.services.columnDatabase') },
    };
  }, [coverage, theme.colors.text.secondary]);
  const uncovered = backups.coverage?.rows.filter((row) => row.status === 'uncovered').length ?? 0;
  const countParts = React.useMemo(() => read.snapshot.value ? [
    rows.length > 0 ? t('projects.deployments.services.countDatabases', { count: rows.length }) : null,
    uncovered > 0 ? t('projects.deployments.notBackedUpCount', { count: uncovered }) : null,
  ] : null, [read.snapshot.value, rows.length, uncovered]);
  useReportViewCount('databases', countParts, props.onCount, uncovered);
  if (!read.snapshot.value) {
    return read.snapshot.status === 'unavailable' ? (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="services.databases.error"
          kind="error"
          size="line"
          title={t('projects.deployments.unavailableTitle')}
          diagnosticCode={read.snapshot.failure?.code ?? null}
          action={{ label: t('common.retry'), onPress: () => { void read.refresh(); } }}
        />
      </ItemGroup>
    ) : (
      <ItemGroup surface="none" testID="services.databases.loading">
        <SkeletonRows rows={3} />
      </ItemGroup>
    );
  }
  if (rows.length === 0 && !read.snapshot.value.hasNextPage && !read.snapshot.value.hasPreviousPage) {
    return (
      <EmptyState
        testID="services.databases.empty"
        layout="page"
        scene="shipped"
        title={t('projects.deployments.services.noDatabases')}
        subtitle={t('projects.deployments.services.noDatabasesBody')}
      />
    );
  }
  return (
    <>
      {backups.readers}
      {rows.length === 0 ? (
        // A page whose Environments hold no databases still leads on to the next one.
        <ItemGroup surface="none">
          <SurfaceStateCard testID="services.databases.pageEmpty" kind="empty" size="line"
            title={t('projects.deployments.services.pageEmpty')} />
        </ItemGroup>
      ) : (
        <ServicesPageList<DatabaseRow> testID="services.databases" model={model} anatomy={anatomy}
          accessibilityLabel={t('projects.deployments.services.databases')} />
      )}
      <ServicesPaging testID="services.databases.paging" page={read.snapshot.value}
        onNewer={read.previousPage} onOlder={read.nextPage} />
    </>
  );
}

/** A view publishes its count line to the page head when its words change (MainScreenHeader `count`). */
export function useReportViewCount(view: ServicesView, parts: readonly (string | null)[] | null,
  onCount: (count: ServicesViewCount) => void, needYou = 0) {
  const signature = parts ? parts.join('\u0000') : null;
  const latest = React.useRef(parts);
  latest.current = parts;
  React.useEffect(() => {
    if (latest.current) onCount({ view, parts: latest.current, needYou });
  }, [needYou, onCount, signature, view]);
}

type AccountDomainItem = Readonly<{ environment: Readonly<{ projectSourceId: string }>; environmentTitle: string;
  projectSourceName: string | null }>;
const OTHER_DOMAIN_PROJECT = 'other';
const domainEnvironmentTitle = (item: AccountDomainItem) => item.environmentTitle;
const domainProjectOf = (item: AccountDomainItem) => item.projectSourceName ? item.environment.projectSourceId : OTHER_DOMAIN_PROJECT;

/**
 * Domains banded by Project (lab svcDom), through the one Project grouping the Apps view and the Services column
 * share; addresses whose Project name the read could not carry stand in the same last band the Apps view uses.
 */
function domainProjectBands<Item extends AccountDomainItem>(items: readonly Item[]) {
  const { named, unnamed } = groupDeploymentRowsByProject(items.map((item) => ({
    projectSourceId: item.environment.projectSourceId, projectName: item.projectSourceName })));
  const band = (key: string, title: string, count: number) => ({ key, title, section: SERVICES_ONE_SHEET,
    description: t('projects.deployments.editors.domainsCount', { count }) });
  return {
    axis: [
      ...named.map((group) => band(group.key, group.title, group.rows.length)),
      ...(unnamed.length > 0 ? [band(OTHER_DOMAIN_PROJECT, t('projects.deployments.allOtherProject'), unnamed.length)] : []),
    ],
    groupOf: domainProjectOf,
  };
}

/** Newer / Older under a paged view's sheet (the Apps paging pattern): only the way that exists is offered. */
export function ServicesPaging(props: Readonly<{
  testID: string;
  page: Readonly<{ hasNextPage: boolean; hasPreviousPage: boolean }>;
  onNewer: () => void;
  onOlder: () => void;
}>) {
  const { theme } = useUnistyles();
  if (!props.page.hasNextPage && !props.page.hasPreviousPage) return null;
  return (
    <ItemGroup surface="none" testID={props.testID}>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: theme.space.s8 }}>
        {props.page.hasPreviousPage ? (
          <SectionActionButton testID={`${props.testID}.newer`} title={t('projects.deployments.pageNewer')}
            icon="caret-left" onPress={props.onNewer} />
        ) : null}
        {props.page.hasNextPage ? (
          <SectionActionButton testID={`${props.testID}.older`} title={t('projects.deployments.pageOlder')}
            icon="caret-right" onPress={props.onOlder} />
        ) : null}
      </View>
    </ItemGroup>
  );
}

/** Domains: every address with its own state and checks, the Environment's one Domain row (DeploymentDomainRow). */
export function ServicesDomainsView(
  props: Readonly<{
    controller: DeploymentReadControllerV1 | null;
    demand: DeploymentReadDemandV1;
    serverId: string;
    accountId: string;
    phone: boolean;
    onCount: (count: ServicesViewCount) => void;
  }>,
) {
  const read = useDeploymentDomainPage(props.controller, props.demand);
  const items = read.snapshot.value?.items ?? NO_ITEMS;
  // The page head's count line (lab svcDom): how many addresses, then the ones that need the person, by their need.
  const countParts = React.useMemo(() => {
    if (!read.snapshot.value) return null;
    const needs = items.map(deploymentDomainNeedKind);
    const waiting = needs.filter((need) => need === 'waitingForDns').length;
    const unreachable = needs.filter((need) => need === 'notReachable').length;
    return [
      items.length > 0 ? t('projects.deployments.editors.domainsCount', { count: items.length }) : null,
      waiting > 0 ? t('projects.deployments.editors.domainsWaitingForDns', { count: waiting }) : null,
      unreachable > 0 ? t('projects.deployments.editors.domainsNotReachable', { count: unreachable }) : null,
    ];
  }, [items, read.snapshot.value]);
  // The Domains tab's needs-you count: the addresses its count line says need the person.
  const domainsNeedYou = React.useMemo(() => items.filter((item) => {
    const need = deploymentDomainNeedKind(item);
    return need === 'waitingForDns' || need === 'notReachable';
  }).length, [items]);
  useReportViewCount('domains', countParts, props.onCount, domainsNeedYou);
  const bands = React.useMemo(() => domainProjectBands(items), [items]);
  if (!read.snapshot.value) {
    return read.snapshot.status === 'unavailable' ? (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="services.domains.error"
          kind="error"
          size="line"
          title={t('projects.deployments.unavailableTitle')}
          diagnosticCode={read.snapshot.failure?.code ?? null}
          action={{
            label: t('common.retry'),
            onPress: () => {
              void read.refresh();
            },
          }}
        />
      </ItemGroup>
    ) : (
      <ItemGroup surface="none" testID="services.domains.loading">
        <SkeletonRows rows={3} />
      </ItemGroup>
    );
  }
  const page = read.snapshot.value;
  // An empty page that continues is not an empty Account: it leads on (the Apps paging pattern).
  if (items.length === 0 && !page.hasNextPage && !page.hasPreviousPage) {
    return (
      <ItemGroup surface="none">
        <SurfaceStateCard
          testID="services.domains.empty"
          scene="nothingListening"
          kind="empty"
          size="page"
          title={t('projects.deployments.services.noDomains')}
          reason={t('projects.deployments.services.noDomainsBody')}
        />
      </ItemGroup>
    );
  }
  return (
    <>
      {items.length === 0 ? (
        <ItemGroup surface="none">
          <SurfaceStateCard testID="services.domains.pageEmpty" kind="empty" size="line"
            title={t('projects.deployments.services.pageEmpty')} />
        </ItemGroup>
      ) : (
        <ItemGroup surface="none">
          <DeploymentDomainsList
            testID="services.domains"
            items={items}
            groups={bands}
            environmentTitle={domainEnvironmentTitle}
            accountId={props.accountId}
            serverId={props.serverId}
            demand={props.demand}
            disabled={false}
          />
        </ItemGroup>
      )}
      <ServicesPaging testID="services.domains.paging" page={page} onNewer={read.previousPage} onOlder={read.nextPage} />
    </>
  );
}

import * as React from 'react';
import { isDeploymentDomainAttachedV1 } from '@happier-dev/deployments';
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
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
export const SERVICES_VIEWS = [
  { id: 'apps', labelKey: 'projects.deployments.services.apps' },
  { id: 'databases', labelKey: 'projects.deployments.services.databases' },
  { id: 'domains', labelKey: 'projects.deployments.services.domains' },
  { id: 'checks', labelKey: 'projects.deployments.services.checks' },
  { id: 'watched', labelKey: 'projects.deployments.services.watched' },
] as const;
export type ServicesView = typeof SERVICES_VIEWS[number]['id'];
/** A view's count line, from its own read's reported rows (the page's head draws it, MainScreenHeader `count`). */
export type ServicesViewCount = Readonly<{ view: ServicesView; parts: readonly (string | null)[]; needYou?: number }>;

/** The route's `view`, read once: anything else is the Apps view. */
export function readServicesView(
  value: string | null | undefined,
): ServicesView {
  return SERVICES_VIEWS.find((view) => view.id === value)?.id ?? 'apps';
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
    () => SERVICES_VIEWS.map(({ id, labelKey }) => ({ id, label: t(labelKey) })).map((tab) => {
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
  /** Under the Size column's head. */
  size: string;
  /** On line 2 of a phone row, which has no head to name it. */
  sizeInline: string;
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
  const environments = React.useMemo(() => items.map((item) => item.environment), [items]);
  const backups = useVisibleBackupCoverage(props.lifetime, environments, props.demand.visible);
  const coverage = React.useMemo(() => new Map(backups.coverage?.rows.map((row) => [row.environment.id, row.status])),
    [backups.coverage]);
  const lastBackups = React.useMemo(() => new Map(backups.coverage?.rows.map((row) => [row.environment.id, row.lastBackupAt])),
    [backups.coverage]);
  const rows = React.useMemo<readonly DatabaseRow[]>(() => items.length === 0 ? NO_DATABASES : items.flatMap((item) =>
    (item.databaseSizes ?? []).map((database) => {
      const declared = item.content.template?.data?.find((data) => data.service === database.service);
      return {
        key: `${item.environment.id}:${database.service}`,
        environmentId: item.environment.id,
        projectSourceId: item.environment.projectSourceId,
        service: database.service,
        engine: declared ? databaseEngineTitle(declared) : null,
        growth: describeDatabaseGrowth(database.growth),
        size: describeDatabaseSize(database.size, 'labelled'),
        sizeInline: describeDatabaseSize(database.size, 'inline'),
      };
    })), [items]);
  const groups = React.useMemo(() => ({
    axis: items.map((item) => ({ key: item.environment.id, title: item.title, section: SERVICES_ONE_SHEET })),
    groupOf: groupOfDatabase,
  }), [items]);
  const { serverId } = props;
  const open = React.useCallback((key: string | number | null) => {
    const row = key === null ? undefined : rows.find((candidate) => candidate.key === String(key));
    if (!row) return;
    router.push(deploymentEnvironmentRoute({ serverId, projectSourceId: row.projectSourceId,
      environmentId: row.environmentId, database: row.service }));
  }, [router, rows, serverId]);
  const model = useHappierCollection<DatabaseRow>({ items: rows, keyOf: keyOfDatabase, groups, openKey: null, onOpenChange: open });
  const anatomy = React.useMemo<CollectionAnatomy<DatabaseRow>>(() => {
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
      // A phone row (no columns) leads line 2 with "Not backed up" when it speaks; the name keeps line 1 whole.
      byline: (row, layout) => [row.engine, row.growth, layout?.fieldColumns === true ? null : row.sizeInline].filter(Boolean).join(' · ') || null,
      bylineLead: (row, layout) => layout?.fieldColumns !== true && coverage.get(row.environmentId) === 'uncovered' ? backupWord(row) : null,
      fields: [
        { key: 'size', title: t('projects.deployments.services.sizeLabel'), minWidth: 216, priority: 2, listColumn: true,
          render: (row) => row.size },
        // Lab svcDb "Last backup": when the Environment's last backup completed, from the same coverage read.
        { key: 'lastBackup', title: t('projects.deployments.databaseLastBackup'), minWidth: 136, priority: 0, listColumn: true,
          render: (row) => { const at = lastBackups.get(row.environmentId); return at ? formatRelativeTimeShort(at, Date.now()) : null; } },
        { key: 'backups', title: t('projects.deployments.services.columnBackups'), minWidth: 140, priority: 1, align: 'end',
          listColumn: true, render: backupWord },
      ],
      accessibilityLabel: (row) => [row.service, row.engine, row.sizeInline].filter(Boolean).join(', '),
      testID: (row) => `services.databases.row.${row.environmentId}.${row.service}`,
      columnTitles: { title: t('projects.deployments.services.columnDatabase') },
    };
  }, [coverage, lastBackups, theme.colors.text.secondary]);
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
  // An empty first page means no Environment holds a database: the read pages past the ones without (owner D3).
  if (rows.length === 0 && !read.snapshot.value.hasPreviousPage) {
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
        // Past the last page that held one (the Environments after it hold none): Newer leads back.
        <ItemGroup surface="none">
          <EmptyState testID="services.databases.pageEmpty" layout="line" title={t('projects.deployments.services.pageEmpty')} />
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
  // The list draws each group's count beside its title (F3), so a band says nothing more.
  const band = (key: string, title: string) => ({ key, title, section: SERVICES_ONE_SHEET });
  return {
    axis: [
      ...named.map((group) => band(group.key, group.title)),
      ...(unnamed.length > 0 ? [band(OTHER_DOMAIN_PROJECT, t('projects.deployments.allOtherProject'))] : []),
    ],
    groupOf: domainProjectOf,
  };
}

/**
 * Newer / Older under a paged view's sheet (the Apps paging pattern): only the way that exists is offered. A family read
 * that continues in place (the managed inventory's continuation) offers Show more instead, on intent, never on open.
 */
export function ServicesPaging(props: Readonly<{ testID: string } & (
  | { page: Readonly<{ hasNextPage: boolean; hasPreviousPage: boolean }>; onNewer: () => void; onOlder: () => void; more?: never }
  | { more: (() => unknown) | null; page?: never }
)>) {
  const { theme } = useUnistyles();
  if (props.page === undefined) {
    const more = props.more;
    return more ? (
      <ItemGroup surface="none" testID={props.testID}>
        <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
          <SectionActionButton testID={`${props.testID}.more`} title={t('projects.deployments.services.showMore')} icon="caret-down"
            onPress={() => fireAndForget(Promise.resolve(more()), { tag: 'ServicesPaging.more' })} />
        </View>
      </ItemGroup>
    ) : null;
  }
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
  const domainItems = read.snapshot.value?.items ?? NO_ITEMS;
  const items = React.useMemo(() => domainItems.map(item => ({ ...item,
    attached: isDeploymentDomainAttachedV1(item.domain, item.environment) })), [domainItems]);
  // The page head's count line (lab svcDom): how many addresses, then the ones that need the person, by their need.
  const countParts = React.useMemo(() => {
    if (!read.snapshot.value) return null;
    const needs = items.map(item => deploymentDomainNeedKind(item, item.attached));
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
    const need = deploymentDomainNeedKind(item, item.attached);
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
      <EmptyState
        testID="services.domains.empty"
        layout="page"
        scene="nothingListening"
        title={t('projects.deployments.services.noDomains')}
        subtitle={t('projects.deployments.services.noDomainsBody')}
      />
    );
  }
  return (
    <>
      {items.length === 0 ? (
        <ItemGroup surface="none">
          <EmptyState testID="services.domains.pageEmpty" layout="line" title={t('projects.deployments.services.pageEmpty')} />
        </ItemGroup>
      ) : (
        // The page's flat list (ServicesPageList), like Databases: inside an ItemGroup it would keep a section's sheet.
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
      )}
      <ServicesPaging testID="services.domains.paging" page={page} onNewer={read.previousPage} onOlder={read.nextPage} />
    </>
  );
}

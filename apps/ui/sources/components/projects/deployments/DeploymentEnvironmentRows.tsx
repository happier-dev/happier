import * as React from 'react';
import { View } from 'react-native';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
  type CollectionGroupAction,
  type CollectionRowActions,
  type HappierCollectionModel,
} from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS, HappierColumnEdgeContext } from '@happier-dev/plugin-ui/presentation';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ItemGroup, ItemGroupDefaultSurfaceProvider } from '@/components/ui/lists/ItemGroup';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { MiddleEllipsisText } from '@/components/ui/text/MiddleEllipsisText';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { isSameDeploymentName, useDeploymentEnvironmentRowParts } from './DeploymentEnvironmentCollection';
import { DeploymentStepStrip } from './DeploymentStepStrip';
import { deploymentActorIsViewer, deploymentActorLabel } from './deploymentPresentation';
import { useDeploymentActorPresentations, type DeploymentActorPresentation } from './useDeploymentActorPresentations';
import { formatDeploymentLiveAddress } from './deploymentLiveAddressFacts';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { groupDeploymentRowsByProject } from './deploymentProjectGroups';
import { DeploymentEnvironmentMark, DeploymentEnvironmentStateMark } from './rows/DeploymentEnvironmentRow';

import { deploymentEnvironmentColumns, type DeploymentEnvironmentBuiltinColumn } from './deploymentEnvironmentColumns';
import { useAppShellPluginUiDeclarationSources, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ServiceColumnResources } from './ServiceColumnResources';
import { ServiceColumnCell } from './ServiceColumnCell';
export { deploymentEnvironmentColumns } from './deploymentEnvironmentColumns';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
type RowParts = ReturnType<typeof useDeploymentEnvironmentRowParts>[number];
/** Row-local presentation facts keep the collection anatomy stable when one Environment changes. */
type Row = RowParts & Readonly<{ author: string | null; collectorMachineId: string | null; bylineProjectName: string | null }>;

const OTHER_PROJECT = 'other';
const SINGLE_PROJECTS = 'single';
const keyOfRow = (row: Row) => row.environmentId;

/** Whether a row needs the person: a failed or unconfirmed deploy (the readiness owner's tone), never one at work. */
export function deploymentEnvironmentRowNeedsYou(
  row: Pick<Row, 'state'>,
): boolean {
  return row.state?.tone === 'danger' || row.state?.tone === 'warning';
}

type BandRow = Pick<Row, 'projectSourceId' | 'projectName' | 'title' | 'state'>;

/**
 * The Apps list's bands (lab envList): Projects in the page's own order (the one Project grouping the Services column
 * shares), each a band on the list's one sheet that says how many of its Environments need the person. A Project whose
 * only Environment carries its name needs no band to say it again: those share one unbanded group that leads the sheet.
 * Projects whose name is unavailable share one last band.
 */
export function deploymentEnvironmentBands<T extends BandRow>(rows: readonly T[]) {
  const { named, unnamed } = groupDeploymentRowsByProject(rows);
  const single = new Set<string>();
  const banded: { key: string; title: string; rows: readonly T[] }[] = [];
  for (const group of named) {
    // One rule (UI refinements 11-16): a Project with one Environment stands in the lead group without a heading; the
    // row names its Project when the two names differ (deploymentEnvironmentRowLine `project`).
    if (group.rows.length === 1) single.add(group.key);
    else banded.push(group);
  }
  if (unnamed.length > 0) banded.push({ key: OTHER_PROJECT, title: t('projects.deployments.allOtherProject'), rows: unnamed });
  const axis = [
    ...(single.size > 0 ? [{ key: SINGLE_PROJECTS, title: '', section: SERVICES_ONE_SHEET }] : []),
    ...banded.map((group) => {
      const speaking = group.rows.filter(deploymentEnvironmentRowNeedsYou);
      // The band's line (lab "Staging deploy failed"): the one Environment that needs the person and its state, or how many.
      const only = speaking.length === 1 ? speaking[0]! : null;
      return {
        key: group.key,
        title: group.title,
        section: SERVICES_ONE_SHEET,
        ...(speaking.length > 0
          ? { description: only && only.state
              ? t('projects.deployments.services.bandOne', { environment: only.title, state: only.state.text })
              : t('projects.deployments.services.needYou', { count: speaking.length }),
            tone: 'danger' as const }
          : {}),
      };
    }),
  ];
  return {
    axis,
    groupOf: (row: T) => single.has(row.projectSourceId) ? SINGLE_PROJECTS : row.projectName ? row.projectSourceId : OTHER_PROJECT,
  };
}

/**
 * The one Environment row (pfc-redesign `rd-row.js` envRow): a page list of Environments banded by Project, each row
 * its name and what was deployed last, then Last deploy (age, or the steps of a deploy at work or stopped), Runs on and
 * the state word that needs the person, in columns that line up down the page. A phone row says the same in its
 * second line with the state at its end. Services → Apps and a Machine's What runs here draw it; a row opens the
 * Environment.
 */
export function DeploymentEnvironmentRows(
  props: Readonly<{
    items: readonly EnvironmentItem[];
    serverId: string;
    lifetime: ServerAccountScopeLifetime | null;
    testID: string;
    accessibilityLabel: string;
    /** Rows shown for "Not backed up" open where that Environment's backups are set up. */
    openBackups?: boolean;
    /** On a Machine's own page: rows leave out the Machine they all run on (lab hereMachine). */
    hereMachine?: boolean;
    /** Services → Apps offers its Columns choice (`SERVICES_APPS_COLLECTION_ID`) and hears which columns fit. */
    columns?: DeploymentEnvironmentColumnsBinding;
  }>,
) {
  const { theme } = useUnistyles();
  const declarations = useAppShellPluginUiDeclarationSources();
  const localize = useProjectedPluginLocalizedTextResolver();
  const contributedColumns = React.useMemo(() => deploymentEnvironmentColumns(props.hereMachine === true,
    props.columns ? declarations.projection : null, localize), [props.hereMachine, props.columns, declarations.projection, localize]);
  const router = useRouter();
  const parts = useDeploymentEnvironmentRowParts(
    props.items,
    `${props.testID}.row`,
    props.lifetime,
    'row',
  );
  // Who did each latest deploy: its captured actor through the one actor display owner ("by you", a name, an agent
  // and whose session, a workflow). The requester is an audit fact and never names the row.
  const accountId = props.lifetime?.scope.accountId ?? null;
  const actors = React.useMemo(() => parts.map((row) => row.actor), [parts]);
  const presentations = useDeploymentActorPresentations({ actors, scope: props.lifetime?.scope ?? NO_SCOPE,
    accountLifetime: props.lifetime, active: props.lifetime !== null });
  const groups = React.useMemo(() => deploymentEnvironmentBands(parts), [parts]);
  const rows = useAuthoredRows(props.items, parts, presentations, accountId, groups.groupOf);
  const { serverId } = props;
  const openBackups = props.openBackups === true;
  const byId = React.useMemo(
    () => new Map(rows.map((row) => [row.environmentId, row])),
    [rows],
  );
  const open = React.useCallback(
    (key: string | number | null) => {
      const row = key === null ? undefined : byId.get(String(key));
      if (!row) return;
      router.push(
        deploymentEnvironmentRoute({
          serverId,
          projectSourceId: row.projectSourceId,
          environmentId: row.environmentId,
          ...(openBackups
            ? {
                tab: 'settings' as const,
                section: 'backups' as const,
                setup: 'backups' as const,
              }
            : {}),
        }),
      );
    },
    [byId, openBackups, router, serverId],
  );
  const openTab = React.useCallback((row: Row, tab: EnvironmentRowMenuTab) => {
    router.push(deploymentEnvironmentRoute({ serverId, projectSourceId: row.projectSourceId, environmentId: row.environmentId, tab }));
  }, [router, serverId]);
  const model = useHappierCollection<Row>({
    items: rows,
    keyOf: keyOfRow,
    groups,
    openKey: null,
    onOpenChange: open,
  });
  const hereMachine = props.hereMachine === true;
  const anatomy = React.useMemo<CollectionAnatomy<Row>>(() => {
    const meta = {
      ...Typography.variant('meta'),
      color: theme.colors.text.secondary,
      flexShrink: 1,
    } as const;
    const renders: Record<DeploymentEnvironmentBuiltinColumn['key'], CollectionField<Row>['render']> = {
      lastDeploy: (row) =>
          row.steps ? (
            <View style={{ gap: theme.space.s2 }}>
              <DeploymentStepStrip
                steps={row.steps}
                variant="compact"
                testID={`${props.testID}.row.${row.environmentId}.steps`}
              />
              {row.stepCaption ? (
                <Text style={meta} numberOfLines={1}>
                  {row.stepCaption}
                </Text>
              ) : null}
            </View>
          ) : (
            row.lastDeploy
          ),
      // A long Machine name keeps its end, the short id that tells same-named Machines apart.
      runsOn: (row) => row.runsOn ? <MiddleEllipsisText value={row.runsOn} style={meta} /> : null,
      state: (row) => row.stateWord ? <DeploymentEnvironmentStateMark state={row.stateWord} /> : null,
    };
    const fields: CollectionField<Row>[] = contributedColumns.map(column => ({ ...column, render: 'field' in column
      ? row => <ServiceColumnCell column={column} environmentId={row.environmentId} collectorMachineId={row.collectorMachineId} />
      : renders[column.key] }));
    return {
      glyph: (row) => <DeploymentEnvironmentMark platform={row.platformMark} />,
      title: (row) =>
        row.titleQualifier ? `${row.title} · ${row.titleQualifier}` : row.title,
      // Line 2 (lab envRow): what was deployed and who asked; a phone folds the columns in (deploymentEnvironmentRowLine).
      // A phone row (no columns) leads line 2 with the state that speaks, so the name keeps line 1 whole (DESIGN
      // "Phones recompose"); wide, the State column says it.
      byline: (row, layout) => deploymentEnvironmentRowLine(row, row.author, { columns: layout?.fieldColumns === true, hereMachine,
        project: row.bylineProjectName }),
      bylineLead: (row, layout) =>
        deploymentEnvironmentRowLeadState(row, { columns: layout?.fieldColumns === true }) ? <EnvironmentStateWord row={row} /> : null,
      fields,
      accessibilityLabel: (row) =>
        [
          row.projectName,
          row.title,
          row.titleQualifier,
          row.state?.text,
          row.runsOn,
        ]
          .filter(Boolean)
          .join(', '),
      testID: (row) => `${props.testID}.row.${row.environmentId}`,
      columnTitles: {
        title: t('projects.deployments.services.columnEnvironment'),
      },
      // The name (then its reason, ellipsized) narrows to this floor before a chosen column gives way (UI refinements 11-17).
      titleMinWidth: DEPLOYMENT_ENVIRONMENT_TITLE_MIN_WIDTH,
    };
  }, [hereMachine, contributedColumns, props.testID, theme.colors.text.secondary, theme.space.s2]);
  const list = <ServicesPageList<Row>
        testID={props.testID}
        model={model}
        anatomy={anatomy}
        accessibilityLabel={props.accessibilityLabel}
        useRowActions={useEnvironmentRowActions}
        columns={props.columns ?? SERVICES_APPS_COLUMNS_BINDING}
      />;
  return (
    <EnvironmentRowMenuContext.Provider value={openTab}>
      {props.columns ? <ServiceColumnResources projection={declarations.projection} lifetime={declarations.accountLifetime}>
        {list}
      </ServiceColumnResources> : list}
    </EnvironmentRowMenuContext.Provider>
  );
}

type EnvironmentRowMenuTab = 'variables' | 'settings';
const EnvironmentRowMenuContext = React.createContext<((row: Row, tab: EnvironmentRowMenuTab) => void) | null>(null);

/** A row's ⋯ (Collection row actions): the Environment's Variables and settings, the page's own ways in (lab Reach). */
function useEnvironmentRowActions(row: Row): CollectionRowActions {
  const openTab = React.useContext(EnvironmentRowMenuContext);
  return React.useMemo(() => openTab === null ? {} : {
    secondaryActions: [
      { id: 'variables', label: t('projects.deployments.tabVariables') },
      { id: 'settings', label: t('projects.deployments.menuEdit') },
    ],
    onSecondaryAction: (id: string) => openTab(row, id === 'variables' ? 'variables' : 'settings'),
  }, [openTab, row]);
}

const NO_SCOPE: ServerAccountScope = Object.freeze({ serverId: '', accountId: '' });

/**
 * Each row with its author, keeping the row's identity while its parts and author are unchanged: a name that resolves
 * (a Session's Agent, a Workflow's title, a person) redraws only the rows it names.
 */
function useAuthoredRows(items: readonly EnvironmentItem[], parts: readonly RowParts[],
  presentations: readonly DeploymentActorPresentation[], accountId: string | null, groupOf: (part: RowParts) => string): readonly Row[] {
  const authored = React.useRef(new WeakMap<RowParts, Row>());
  const previous = React.useRef<readonly Row[]>([]);
  return React.useMemo(() => {
    const rows = parts.map((part, index) => {
      const presentation = presentations[index];
      const author = deploymentActorIsViewer(part.actor, accountId) ? t('projects.deployments.byYou')
        : presentation ? deploymentActorLabel(presentation, part.actor, accountId) : null;
      const collectorMachineId = items[index]!.environment.telemetryMachineId ?? null;
      const bylineProjectName = groupOf(part) === SINGLE_PROJECTS && part.projectName && !isSameDeploymentName(part.title, part.projectName)
        ? part.projectName : null;
      const known = authored.current.get(part);
      if (known && known.author === author && known.collectorMachineId === collectorMachineId && known.bylineProjectName === bylineProjectName) return known;
      const row = { ...part, author, collectorMachineId, bylineProjectName };
      authored.current.set(part, row);
      return row;
    });
    const same = rows.length === previous.current.length && rows.every((row, index) => row === previous.current[index]);
    if (!same) previous.current = rows;
    return previous.current;
  }, [accountId, groupOf, items, parts, presentations]);
}

type LineRow = Pick<Row, 'deploymentTitle' | 'runsOn' | 'lastDeploy' | 'steps' | 'stepCaption' | 'liveAddress'>;

/**
 * An Environment row's second line (lab envRow): what was deployed and who asked for it. Where the columns are not
 * drawn (a phone) it folds them in, most important first: the step at work, what, who, where, when. How it runs
 * ("Compose") is never the line; nothing known draws no line.
 */
export function deploymentEnvironmentRowLine(row: LineRow, author: string | null,
  layout: Readonly<{ columns: boolean; hereMachine: boolean; project?: string | null }>): string | null {
  // A one-Environment Project's row (no heading) names its Project first when the names differ; where it answers
  // (its live address's host) follows: no Address column is drawn for the few rows that have one (UI refinements 11-16).
  const address = row.liveAddress ? formatDeploymentLiveAddress(row.liveAddress) : null;
  const facts = layout.columns
    ? [layout.project, address, row.deploymentTitle, author]
    : [row.steps ? row.stepCaption : null, layout.project, address, row.deploymentTitle, author,
        layout.hereMachine ? null : row.runsOn, row.steps ? null : row.lastDeploy];
  const line = facts.filter(Boolean).join(' · ');
  return line === '' ? null : line;
}

/** The state that leads a phone row's line 2 (it speaks: a failure, an unconfirmed or running deploy); none beside columns. */
export function deploymentEnvironmentRowLeadState<T extends Pick<Row, 'state'>>(row: T, layout: Readonly<{ columns: boolean }>): T['state'] {
  return layout.columns ? null : row.state;
}

/** Services → Apps's table kind for the Columns choice: one id on every client, never a Project or Environment. */
export const SERVICES_APPS_COLLECTION_ID = 'happier.services.apps';

export type DeploymentEnvironmentColumnsBinding = Readonly<{
  collectionId: string;
  /** The columns the width admits now, for the Columns menu's "too narrow". */
  onColumnsFit?: (fieldKeys: readonly string[] | null) => void;
}>;

const SERVICES_APPS_COLUMNS_BINDING: DeploymentEnvironmentColumnsBinding = { collectionId: SERVICES_APPS_COLLECTION_ID };

/** The Environment name's floor before a chosen column gives way. */
const DEPLOYMENT_ENVIRONMENT_TITLE_MIN_WIDTH = 200;

/** Every band of a Services list stands on its one sheet, under the one bar that names the columns (lab envList). */
export const SERVICES_ONE_SHEET = { key: 'services', title: '' } as const;

/**
 * The Services page's list shell: a page-scrolling Collection list that lies flat on the page (DESIGN "browse flat";
 * owner rule 11-15 "no card chrome on lists", lab monitoring-1115): the bar that names its columns, then each group's
 * title with its count over its rows, recomposing into two-line rows on a phone. Apps, Databases, Domains, Checks,
 * Watched and Monitoring draw their rows through it.
 */
export function ServicesPageList<Item>(props: Readonly<{
  testID: string;
  model: HappierCollectionModel<Item>;
  anatomy: CollectionAnatomy<Item>;
  accessibilityLabel: string;
  /** A band's one action (Watched: Retry a Machine whose services couldn't be read). */
  groupAction?: (groupKey: string) => CollectionGroupAction | null;
  /** A row's ⋯ (Collection `useRowActions`: one stable module-level hook). */
  useRowActions?: (item: Item) => CollectionRowActions;
  /** Rows by default; Monitoring can show its checks as the Collection's cards. */
  presentation?: 'list' | 'grid';
  /** The table's Columns choice and the columns its width admits (Services → Apps). */
  columns?: DeploymentEnvironmentColumnsBinding;
}>) {
  // Inside a page section's body (an Environment's Domains under "1 domain") the section already stands its content on
  // the sheet edge, so the list's sheet takes that edge; on the Services page the list is the page's own flat list.
  const inSection = useItemGroupRowPosition() !== null;
  const enclosingEdgePx = React.useContext(HappierColumnEdgeContext);
  const collection = (
    <CoreCollectionScope>
      <Collection<Item>
        testID={`${props.testID}.table`}
        model={props.model}
        anatomy={props.anatomy}
        accessibilityLabel={props.accessibilityLabel}
        presentation={props.presentation ?? 'list'}
        detail="none"
        scroll="page"
        minListWidth={0}
        minDetailWidth={0}
        preferredListRatio={1}
        {...(props.groupAction ? { groupAction: props.groupAction } : {})}
        {...(props.useRowActions ? { useRowActions: props.useRowActions } : {})}
        {...(props.columns ? { columns: { collectionId: props.columns.collectionId } } : {})}
        {...(props.columns?.onColumnsFit ? { onColumnsFit: props.columns.onColumnsFit } : {})}
      />
    </CoreCollectionScope>
  );
  return (
    <HappierColumnEdgeContext.Provider value={inSection ? HAPPIER_PAGE_METRICS.sheetInsetPx : enclosingEdgePx}>
    <ListPresentationProvider value="page" pageInsets="contained">
      {/* On the page the Collection is the flat page list itself in the page's column, so its marks, section titles and
          column bar stand on the header's edges (monitoring-1115 B1); inside a page section it takes that section's sheet. */}
      {inSection ? (
        <ItemGroupDefaultSurfaceProvider value="flat">
          <ItemGroup header="none" surface="none" testID={props.testID}>{collection}</ItemGroup>
        </ItemGroupDefaultSurfaceProvider>
      ) : <PageContentColumn testID={props.testID}>{collection}</PageContentColumn>}
    </ListPresentationProvider>
    </HappierColumnEdgeContext.Provider>
  );
}

/** The state word that needs the person (Failed, Running, not verified) or the work in progress; healthy says nothing. */
function EnvironmentStateWord(props: Readonly<{ row: Row }>) {
  return props.row.state ? <DeploymentEnvironmentStateMark state={props.row.state} /> : null;
}

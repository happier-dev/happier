import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  Status,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
  type CollectionGroupAction,
  type HappierCollectionModel,
} from '@happier-dev/plugin-ui';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { isSameDeploymentName, useDeploymentEnvironmentRowParts } from './DeploymentEnvironmentCollection';
import { DeploymentStepStrip } from './DeploymentStepStrip';
import { formatDeploymentLiveAddress } from './deploymentLiveAddressFacts';
import { deploymentEnvironmentRoute } from './deploymentNavigation';
import { groupDeploymentRowsByProject } from './deploymentProjectGroups';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
type Row = ReturnType<typeof useDeploymentEnvironmentRowParts>[number];

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
    if (group.rows.length === 1 && isSameDeploymentName(group.rows[0]!.title, group.title)) single.add(group.key);
    else banded.push(group);
  }
  if (unnamed.length > 0) banded.push({ key: OTHER_PROJECT, title: t('projects.deployments.allOtherProject'), rows: unnamed });
  const axis = [
    ...(single.size > 0 ? [{ key: SINGLE_PROJECTS, title: '', section: SERVICES_ONE_SHEET }] : []),
    ...banded.map((group) => {
      const needYou = group.rows.filter(deploymentEnvironmentRowNeedsYou).length;
      return {
        key: group.key,
        title: group.title,
        section: SERVICES_ONE_SHEET,
        ...(needYou > 0
          ? { description: t('projects.deployments.services.needYou', { count: needYou }), tone: 'danger' as const }
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
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const rows = useDeploymentEnvironmentRowParts(
    props.items,
    `${props.testID}.row`,
    props.lifetime,
    'row',
  );
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
  const groups = React.useMemo(() => deploymentEnvironmentBands(rows), [rows]);
  const model = useHappierCollection<Row>({
    items: rows,
    keyOf: keyOfRow,
    groups,
    openKey: null,
    onOpenChange: open,
  });
  const hereMachine = props.hereMachine === true;
  // Who asked for each latest deploy, through the people owner the Environment's timeline uses ("by you", a name).
  const accountId = props.lifetime?.scope.accountId ?? null;
  const otherIds = React.useMemo(() => [...new Set(rows.flatMap((row) => row.requestedByAccountId && row.requestedByAccountId !== accountId
    ? [row.requestedByAccountId] : []))], [accountId, rows]);
  const people = useDiscussionParticipantProfiles({ scope: props.lifetime?.scope ?? NO_SCOPE, roster: null, accountIds: otherIds,
    enabled: props.lifetime !== null && otherIds.length > 0, accountLifetime: props.lifetime });
  const authorOf = React.useCallback((row: Row): string | null => {
    if (!row.requestedByAccountId) return null;
    if (row.requestedByAccountId === accountId) return t('projects.deployments.byYou');
    const actor = people.accounts.get(row.requestedByAccountId);
    return actor && props.lifetime ? resolveAccountActorPresentation(actor, props.lifetime.scope).name : null;
  }, [accountId, people.accounts, props.lifetime]);
  // Runs on keeps its longest name whole (it never truncates at a desktop width); Address gives way first.
  const runsOnWidth = React.useMemo(() => {
    const longest = Math.max(0, ...rows.map((row) => row.runsOn?.length ?? 0));
    return Math.min(RUNS_ON_MAX_PX, Math.max(RUNS_ON_MIN_PX, Math.round(longest * META_CHAR_PX)));
  }, [rows]);
  // The Address column stands only when an address is known on this page, sized to the longest one it shows.
  const addressWidth = React.useMemo(() => {
    const longest = Math.max(0, ...rows.map((row) => row.liveAddress ? formatDeploymentLiveAddress(row.liveAddress).length : 0));
    return longest === 0 ? null : Math.min(ADDRESS_MAX_PX, Math.max(ADDRESS_MIN_PX, Math.round(longest * MONO_META_CHAR_PX)));
  }, [rows]);
  const anatomy = React.useMemo<CollectionAnatomy<Row>>(() => {
    const meta = {
      ...Typography.variant('meta'),
      color: theme.colors.text.secondary,
      flexShrink: 1,
    } as const;
    const fields: CollectionField<Row>[] = [
      {
        key: 'lastDeploy',
        title: t('projects.deployments.services.columnLastDeploy'),
        minWidth: 112,
        priority: 4,
        listColumn: true,
        render: (row) =>
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
            row.detail
          ),
      },
      // Where it answers (the collection's resolved live address), drawn as its host; the first column to give way.
      ...(addressWidth === null ? [] : [{
        key: 'address',
        title: t('projects.deployments.services.columnAddress'),
        minWidth: addressWidth,
        priority: 2,
        listColumn: true,
        render: (row: Row) => row.liveAddress ? (
          <Text style={{ ...meta, ...Typography.mono() }} numberOfLines={1}>
            {formatDeploymentLiveAddress(row.liveAddress)}
          </Text>
        ) : null,
      }]),
      ...(hereMachine
        ? []
        : [
            {
              key: 'runsOn',
              title: t('projects.deployments.services.columnRunsOn'),
              minWidth: runsOnWidth,
              priority: 3,
              listColumn: true,
              render: (row: Row) => row.runsOn,
            },
          ]),
      {
        key: 'state',
        title: t('projects.deployments.services.columnState'),
        minWidth: 136,
        priority: 5,
        align: 'end',
        listColumn: true,
        render: (row) => <EnvironmentStateWord row={row} />,
      },
    ];
    return {
      glyph: (row) => (
        <Icon
          name={row.platform ? 'cloud' : 'hard-drives'}
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      ),
      title: (row) =>
        row.titleQualifier ? `${row.title} · ${row.titleQualifier}` : row.title,
      // Line 2 (lab envRow): what was deployed and who asked; a phone folds the columns in (deploymentEnvironmentRowLine).
      byline: (row, layout) => {
        const line = deploymentEnvironmentRowLine(row, authorOf(row), { columns: layout?.fieldColumns === true, hereMachine });
        return line ? (
          <Text style={meta} numberOfLines={1}>
            {line}
          </Text>
        ) : null;
      },
      // A phone row ends with its state word, centred on both lines (the State column on a wide page).
      titleMeta: (row) => <EnvironmentStateWord row={row} />,
      titleMetaAlign: 'row',
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
    };
  }, [addressWidth, authorOf, hereMachine, props.testID, runsOnWidth, theme.colors.text.secondary, theme.space.s2]);
  return (
    <ServicesPageList<Row>
      testID={props.testID}
      model={model}
      anatomy={anatomy}
      accessibilityLabel={props.accessibilityLabel}
    />
  );
}

const NO_SCOPE: ServerAccountScope = Object.freeze({ serverId: '', accountId: '' });
/** Column bounds from their text at meta size: Address (mono) gives way first, Runs on keeps its longest name whole. */
const ADDRESS_MIN_PX = 96;
const ADDRESS_MAX_PX = 128;
const RUNS_ON_MIN_PX = 96;
const RUNS_ON_MAX_PX = 184;
const META_CHAR_PX = 7;
const MONO_META_CHAR_PX = 7.4;

type LineRow = Pick<Row, 'deploymentTitle' | 'runsOn' | 'detail' | 'steps' | 'stepCaption'>;

/**
 * An Environment row's second line (lab envRow): what was deployed and who asked for it. Where the columns are not
 * drawn (a phone) it folds them in, most important first: the step at work, what, who, where, when. How it runs
 * ("Compose") is never the line; nothing known draws no line.
 */
export function deploymentEnvironmentRowLine(row: LineRow, author: string | null,
  layout: Readonly<{ columns: boolean; hereMachine: boolean }>): string | null {
  const facts = layout.columns
    ? [row.deploymentTitle, author]
    : [row.steps ? row.stepCaption : null, row.deploymentTitle, author, layout.hereMachine ? null : row.runsOn,
        row.steps ? null : row.detail];
  const line = facts.filter(Boolean).join(' · ');
  return line === '' ? null : line;
}

/** Every band of a Services list stands on its one sheet, under the one bar that names the columns (lab envList). */
export const SERVICES_ONE_SHEET = { key: 'services', title: '' } as const;

/**
 * The Services page's list shell (lab `rd-erl`): a page-scrolling Collection list whose groups are bands on one sheet
 * under the bar that names its columns, recomposing into two-line rows on a phone. Apps, Databases, Checks and
 * Watched draw their rows through it.
 */
export function ServicesPageList<Item>(props: Readonly<{
  testID: string;
  model: HappierCollectionModel<Item>;
  anatomy: CollectionAnatomy<Item>;
  accessibilityLabel: string;
  /** A band's one action (Watched: Retry a Machine whose services couldn't be read). */
  groupAction?: (groupKey: string) => CollectionGroupAction | null;
}>) {
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <ItemGroup header="none" surface="none" testID={props.testID}>
        <CoreCollectionScope>
          <Collection<Item>
            testID={`${props.testID}.table`}
            model={props.model}
            anatomy={props.anatomy}
            accessibilityLabel={props.accessibilityLabel}
            presentation="list"
            detail="none"
            scroll="page"
            minListWidth={0}
            minDetailWidth={0}
            preferredListRatio={1}
            {...(props.groupAction ? { groupAction: props.groupAction } : {})}
          />
        </CoreCollectionScope>
      </ItemGroup>
    </ListPresentationProvider>
  );
}

/** The state word that needs the person (Failed, Running, not verified) or the work in progress; healthy says nothing. */
function EnvironmentStateWord(props: Readonly<{ row: Row }>) {
  const state = props.row.state;
  if (!state) return null;
  return (
    <Status
      tone={state.tone ?? 'neutral'}
      label={state.text}
      presentation="inline"
      pulsing={state.tone === null}
    />
  );
}

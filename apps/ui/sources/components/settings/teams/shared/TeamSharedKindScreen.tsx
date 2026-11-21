import * as React from 'react';

import type { ResourceTeamShareScopeV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import type { ArtifactTeamResourceKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { PluginCollectionContractRefV1 } from '@happier-dev/protocol/plugins/data/collectionContractRefV1';
import {
  TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1,
  type TeamSharedResourceCollectionRefV1,
  type TeamSharedResourceSummaryRowV1,
} from '@happier-dev/protocol/teams/teamShareableResourceKindV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { artifactViewRoute } from '@/components/artifacts/artifactBrowserModel';
import { useTeamSharedArtifacts } from '@/components/artifacts/useTeamSharedArtifacts';
import { reviewRowFact, ReviewRowFactText } from '@/components/reviews/list/reviewRowFact';
import { useReviewList } from '@/components/reviews/useReviewList';
import { workflowReferenceHeaderTitle } from '@/components/workflows/presentation/workflowReferenceHeaderTitles';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';
import { useTeamSharedDiscussions } from '@/components/discussions/useTeamSharedDiscussions';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { projectSourceRoute } from '@/components/projects/sources/projectSourceNavigation';
import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import {
  machinePoolCollectionHref,
  machinePresetCollectionHref,
} from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useTeamSharedCollectionRowOpener, useTeamSharedCollections } from '@/hooks/teams/useTeamSharedCollections';
import { useTeamSharedMachinePools } from '@/hooks/teams/useTeamSharedMachinePools';
import { useTeamSharedMachines } from '@/hooks/teams/useTeamSharedMachines';
import { useTeamSharedSavedSecrets } from '@/hooks/teams/useTeamSharedSavedSecrets';
import { useTeamSharedResourcesSummary } from '@/hooks/teams/useTeamSharedResourcesSummary';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

import { TeamSection, TeamSectionPageHeader } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamReadFailureLabel } from '../teamMutationPresentation';
import {
  TEAM_SHARED_KIND_PRESENTATION,
  type TeamSharedListKind,
} from './teamSharedKindPresentation';

/** One page of a kind's own list (the owners page; this page only asks for the next one). */
const PAGE_SIZE = 50;

type KindRow = Readonly<{
  key: string;
  title: string;
  subtitle?: React.ReactNode;
  detail?: string;
  href: string | null;
  /** Opens a record whose owner is not a route (a plugin's declared reader). */
  onOpen?: () => void;
}>;
type KindListState = Readonly<{
  rows: readonly KindRow[];
  loading: boolean;
  failure: string | null;
  hasMore: boolean;
  loadMore?: () => unknown;
  reload?: () => unknown;
}>;

/** Shared through a Group is the one scope worth saying; a direct share is what this page already says. */
function scopeLine(
  scope: ResourceTeamShareScopeV1 | undefined,
): string | undefined {
  return scope === 'group'
    ? t('teams.overview.shared.throughGroup')
    : undefined;
}

/**
 * One kind of thing shared with a Team (plan F §5, lab L12-machines/credentials/documents): the kind's own
 * list Action with the Team filter, one row per record, each opening at its owner, where sharing is managed.
 */
export const TeamSharedKindScreen = React.memo(function TeamSharedKindScreen(
  props: Readonly<{
    serverId: string;
    teamId: string;
  }> & (
    | Readonly<{ kind: TeamSharedListKind }>
    | Readonly<{ kind: typeof TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1; collection: TeamSharedResourceCollectionRefV1 }>
  ),
) {
  const presentation = TEAM_SHARED_KIND_PRESENTATION[props.kind];
  const collection = props.kind === TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1 ? props.collection : null;
  const title = collection?.collectionId ?? t(presentation.title);
  return (
    <TeamSection
      serverId={props.serverId}
      teamId={props.teamId}
      title={title}
      description={t('teams.overview.shared.kindDescription')}
      renderHeader={(context) => <TeamSharedKindHeader context={context} title={title} kind={props.kind} collection={collection} />}
    >
      {(context) => <TeamSharedKindBody context={context} kind={props.kind} collection={collection} />}
    </TeamSection>
  );
});

/**
 * The pushed kind page's head, as the overview pane's (lab L12-machinesp): the kind, "N shared with this Team" from the
 * summary owner, and the kind's existing share flow when it has one. Until the count is known it says what the page is.
 */
function TeamSharedKindHeader(props: Readonly<{
  context: TeamSectionContext;
  title: string;
  kind: TeamSharedListKind | typeof TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1;
  collection: TeamSharedResourceCollectionRefV1 | null;
}>) {
  const { context, kind, collection } = props;
  const router = useRouter();
  const summary = useTeamSharedResourcesSummary({ scope: context.scope, address: context.address, enabled: true });
  const row = summary.kinds.find((candidate) => candidate.kind === TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1
    ? collection !== null && candidate.collection.pluginId === collection.pluginId
      && candidate.collection.collectionId === collection.collectionId
    : candidate.kind === kind);
  return (
    <TeamSectionPageHeader
      title={props.title}
      description={row?.status === 'available'
        ? t('teams.overview.summary.credentialsShared', { count: row.count })
        : t('teams.overview.shared.kindDescription')}
      actions={<TeamSharedKindShareAction kind={kind} teamName={context.team.name} testID="team-shared-kind-share"
        onOpen={(href) => router.push(href as never)} />}
      teamName={context.team.name}
      homeName={context.homeName}
    />
  );
}

/** The kind's existing share flow ("Share a source with Acme"), from the kind presentation owner; none when it has none. */
export function TeamSharedKindShareAction(props: Readonly<{
  kind: TeamSharedListKind | typeof TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1 | TeamSharedResourceSummaryRowV1['kind'];
  teamName: string;
  testID: string;
  onOpen: (href: string) => void;
}>) {
  const share = TEAM_SHARED_KIND_PRESENTATION[props.kind].share;
  if (!share) return null;
  return (
    <SectionActionButton
      testID={props.testID}
      icon="plus"
      title={t(share.title, { team: props.teamName })}
      onPress={() => props.onOpen(share.href)}
    />
  );
}

/**
 * The list of one shared kind, without its page: the kind's own page above draws it, and on a wide layout the Team
 * overview shows it in its details pane beside the overview (plan F §6, lab L12-documents).
 */
export function TeamSharedKindBody(props: Readonly<{
  context: TeamSectionContext;
  kind: TeamSharedListKind | typeof TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1;
  collection: TeamSharedResourceCollectionRefV1 | null;
}>) {
  const { icon } = TEAM_SHARED_KIND_PRESENTATION[props.kind];
  if (props.kind === TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1) {
    return props.collection ? <CollectionList context={props.context} icon={icon} collection={props.collection} /> : null;
  }
  return <TeamSharedKindList context={props.context} kind={props.kind} icon={icon} />;
}

function TeamSharedKindList(
  props: Readonly<{
    context: TeamSectionContext;
    kind: TeamSharedListKind;
    icon: IconName;
  }>,
) {
  const { context, kind } = props;
  switch (kind) {
    case 'machines':
      return <MachinesList context={context} icon={props.icon} />;
    case 'machinePools':
      return <MachinePoolsList context={context} icon={props.icon} />;
    case 'machinePresets':
      return <MachinePresetsList context={context} icon={props.icon} />;
    case 'projectSources':
      return <ProjectSourcesList context={context} icon={props.icon} />;
    case 'discussions':
      return <DiscussionsList context={context} icon={props.icon} />;
    case 'savedSecrets':
      return <SavedSecretsList context={context} icon={props.icon} />;
    default:
      return <ArtifactsList context={context} icon={props.icon} kind={kind} />;
  }
}

type ListProps = Readonly<{ context: TeamSectionContext; icon: IconName }>;

function CollectionList({ context, icon, collection }: ListProps & Readonly<{ collection: TeamSharedResourceCollectionRefV1 }>) {
  const reader = usePluginAccountAvailabilityReader(context.scope, collection.pluginId);
  const contract = reader?.readCurrentCollectionContract(collection);
  if (contract?.kind === 'available') {
    return <CollectionRows context={context} icon={icon} collectionRef={contract.ref} sharedRowDestination={contract.sharedRowDestination} />;
  }
  if (!contract || contract.code === 'account_availability_not_loaded') {
    return <KindList icon={icon} state={{ rows: [], loading: true, failure: null, hasMore: false }} />;
  }
  return <SurfaceStateCard testID="team-shared-collection-unavailable" kind="unavailable" size="line" title={t('common.unavailable')} />;
}

/**
 * A contributed Collection's rows. Each opens at the reader its plugin declares for shared rows; a row says
 * Unavailable when there is no such reader here, or the reader refused it.
 */
function CollectionRows({ context, icon, collectionRef, sharedRowDestination }: ListProps & Readonly<{
  collectionRef: PluginCollectionContractRefV1;
  sharedRowDestination: string | undefined;
}>) {
  const list = useTeamSharedCollections({
    scope: context.scope,
    address: context.address,
    collectionRef,
    enabled: true,
    pageSize: PAGE_SIZE,
  });
  const open = useTeamSharedCollectionRowOpener({ scope: context.scope, collection: collectionRef, sharedRowDestination });
  const [refused, setRefused] = React.useState<ReadonlySet<string>>(() => new Set());
  const rows = React.useMemo(() => list.rows.map((row): KindRow => {
    const key = JSON.stringify([row.ownerAccountId, row.rowId]);
    const refuse = () => setRefused(current => new Set(current).add(key));
    const unavailable = open === null || refused.has(key);
    return {
      key,
      title: row.rowId,
      subtitle: scopeLine(row.sharedWithTeamScope),
      href: null,
      ...(unavailable ? { detail: t('common.unavailable') } : {
        onOpen: () => { void open(row).then(outcome => { if (!outcome.ok) refuse(); }, refuse); },
      }),
    };
  }), [list.rows, open, refused]);
  return <KindList icon={icon} state={pagedState(list, rows)} />;
}

function MachinesList({ context, icon }: ListProps) {
  const list = useTeamSharedMachines({
    scope: context.scope,
    address: context.address,
    enabled: true,
  });
  const rows = React.useMemo(
    () =>
      list.rows.map((row): KindRow => ({
        key: row.machineId,
        title: row.label,
        subtitle: scopeLine(row.sharedWithTeamScope),
        href: machinePageHref({
          door: 'settings',
          target: { machineId: row.machineId, serverId: row.serverId },
        }),
      })),
    [list.rows],
  );
  return <KindList icon={icon} state={pagedState(list, rows)} />;
}

function MachinePoolsList({ context, icon }: ListProps) {
  const list = useTeamSharedMachinePools({
    scope: context.scope,
    address: context.address,
    enabled: true,
  });
  const serverId = context.address.serverId;
  const rows = React.useMemo(
    () =>
      list.rows.map((row): KindRow => ({
        key: row.pool.id,
        title: row.pool.name,
        subtitle: scopeLine(row.sharedWithTeamScope),
        href: machinePoolCollectionHref({ poolId: row.pool.id, serverId }),
      })),
    [list.rows, serverId],
  );
  return <KindList icon={icon} state={pagedState(list, rows)} />;
}

function MachinePresetsList({ context, icon }: ListProps) {
  const serverId = context.address.serverId;
  const serverIds = React.useMemo(() => [serverId], [serverId]);
  const filter = React.useMemo(
    () => ({ sharedWithTeamId: context.address.teamId }),
    [context.address.teamId],
  );
  const presets = useMachinePresets(serverIds, undefined, filter);
  const presetState = presets.statesByServerId[serverId];
  const value = presets.presetsByServerId[serverId];
  const rows = React.useMemo(
    () =>
      (value ?? []).map((preset): KindRow => ({
        key: preset.id,
        title: preset.name,
        href: machinePresetCollectionHref({ serverId, presetId: preset.id }),
      })),
    [serverId, value],
  );
  return (
    <KindList
      icon={icon}
      state={{
        rows,
        loading: value === undefined && !presetState?.error,
        hasMore: false,
        failure: presetState?.error ? t('machinePresets.loadFailed') : null,
        reload: presets.refresh,
      }}
    />
  );
}

function ProjectSourcesList({ context, icon }: ListProps) {
  const { state, controller } = useProjectSources(context.scope, {
    sharedWithTeamId: context.address.teamId,
    repositoryFacts: false,
  });
  const rows = React.useMemo(
    () =>
      state.rows.map((source): KindRow => ({
        key: source.id,
        title: source.name,
        subtitle: scopeLine(source.sharedWithTeamScope),
        href: projectSourceRoute(source.id),
      })),
    [state.rows],
  );
  return (
    <KindList
      icon={icon}
      state={{
        rows,
        loading: state.status === 'initial' || state.status === 'loading',
        failure:
          state.status === 'refused' || state.status === 'offline'
            ? t('teams.overview.shared.failed')
            : null,
        hasMore: state.coverage.nextCursor !== null,
        loadMore: () => state.coverage.nextCursor ? controller.load(state.query, state.coverage.nextCursor) : undefined,
        reload: () => controller.load(),
      }}
    />
  );
}

function DiscussionsList({ context, icon }: ListProps) {
  const list = useTeamSharedDiscussions({
    scope: context.scope,
    address: context.address,
    enabled: true,
  });
  const serverId = context.address.serverId;
  const rows = React.useMemo(
    () =>
      list.rows.map((row): KindRow => ({
        key: row.id,
        title: row.title ?? t('teams.overview.shared.untitled'),
        subtitle: scopeLine(row.sharedWithTeamScope),
        href: buildDiscussionRouteHref({
          target: {
            kind: 'discussion',
            address: { serverId },
            discussionId: row.id,
          },
        }),
      })),
    [list.rows, serverId],
  );
  return <KindList icon={icon} state={pagedState(list, rows)} />;
}

function SavedSecretsList({ context, icon }: ListProps) {
  const list = useTeamSharedSavedSecrets({
    scope: context.scope,
    address: context.address,
    enabled: true,
    pageSize: PAGE_SIZE,
  });
  const rows = React.useMemo(
    () =>
      list.rows.map((row, index): KindRow => ({
        key: 'ref' in row ? row.ref : `corrupt:${index}`,
        title:
          ('name' in row ? row.name : null) ??
          t('teams.overview.shared.untitled'),
        subtitle:
          'sharedWithTeamScope' in row
            ? scopeLine(row.sharedWithTeamScope)
            : undefined,
        href: null,
      })),
    [list.rows],
  );
  return <KindList icon={icon} state={pagedState(list, rows)} />;
}

function ArtifactsList({
  context,
  icon,
  kind,
}: ListProps & Readonly<{ kind: ArtifactTeamResourceKindV1 }>) {
  const list = useTeamSharedArtifacts({
    scope: context.scope,
    address: context.address,
    teamResourceKind: kind,
    enabled: true,
    pageSize: PAGE_SIZE,
  });
  // A shared Review reads as it does in Reviews: its fact from the Review list owner, the same Team filter.
  const reviews = useReviewList(
    { sharedWithTeamId: context.address.teamId, limit: PAGE_SIZE },
    { scope: context.scope, enabled: kind === 'reviews' },
  );
  const reviewItems = reviews.items;
  const serverId = context.address.serverId;
  const rows = React.useMemo(() => {
    const reviewById = new Map(reviewItems?.map((item) => [item.reviewId, item]) ?? []);
    const now = Date.now();
    return list.rows.map((row): KindRow => {
      // A workflow's name is authored in its definition metadata; other kinds carry a header title.
      const authored = kind === 'workflows'
        ? workflowReferenceHeaderTitle(row.header)
        : typeof row.header.title === 'string' ? row.header.title : null;
      const title = authored?.trim() ? authored : t('teams.overview.shared.untitled');
      const scope = scopeLine(row.sharedWithTeamScope);
      const review = kind === 'reviews' ? reviewById.get(row.artifactId) : undefined;
      return {
        key: row.artifactId,
        title,
        subtitle: review && reviewRowFact(review)
          ? <ReviewRowFactText item={review} suffix={scope} />
          : scope,
        ...(kind === 'reviews' ? { detail: formatShortRelativeTimeAt(row.createdAt, now) } : {}),
        href:
          kind === 'workflows'
            ? createWorkflowDefinitionRoute(row.artifactId, serverId)
            : artifactViewRoute(row.artifactId),
      };
    });
  }, [kind, list.rows, reviewItems, serverId]);
  return <KindList icon={icon} state={pagedState(list, rows)} />;
}

function pagedState(
  list: Readonly<{
    status: string;
    error: Parameters<typeof teamReadFailureLabel>[0] | null;
    hasMore: boolean;
    loadMore: () => Promise<void>;
    reload: () => Promise<void>;
  }>,
  rows: readonly KindRow[],
): KindListState {
  return {
    rows,
    loading: list.status === 'loading' && rows.length === 0,
    failure: list.error ? teamReadFailureLabel(list.error) : null,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    reload: list.reload,
  };
}

const LOADING_ROWS = 4;

/** The rows of one kind, each opening the record at its owner; loading, empty and failed states said once. */
function KindList(props: Readonly<{ icon: IconName; state: KindListState }>) {
  const router = useRouter();
  const { state } = props;
  return (
    <ItemGroup testID="team-shared-kind-list">
      {state.loading ? (
        <ItemLoadStateRows
          testID="team-shared-kind-loading"
          state={{ kind: 'loading' }}
          rows={LOADING_ROWS}
        />
      ) : null}
      {state.failure && state.rows.length === 0 ? (
        <ItemLoadStateRows
          testID="team-shared-kind-failed"
          state={{
            kind: 'failed',
            reason: state.failure,
            onRetry: state.reload,
          }}
        />
      ) : null}
      {!state.loading && !state.failure && state.rows.length === 0 ? (
        <SurfaceStateCard
          testID="team-shared-kind-empty"
          kind="empty"
          size="line"
          title={t('teams.overview.shared.kindEmpty')}
        />
      ) : null}
      {state.rows.map((row) => (
        <Item
          key={row.key}
          testID={`team-shared-kind-row:${row.key}`}
          icon={<Icon name={props.icon} />}
          title={row.title}
          subtitle={row.subtitle}
          detail={row.detail}
          mode={row.href || row.onOpen ? 'interactive' : 'info'}
          showChevron={row.href !== null || row.onOpen !== undefined}
          onPress={row.href ? () => router.push(row.href as never) : row.onOpen}
        />
      ))}
      {state.hasMore && state.loadMore ? (
        <Item
          testID="team-shared-kind-more"
          title={t('teams.overview.shared.loadMore')}
          onPress={() => {
            void state.loadMore?.();
          }}
        />
      ) : null}
    </ItemGroup>
  );
}

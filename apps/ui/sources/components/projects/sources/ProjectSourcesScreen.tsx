import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { COLLECTION_RAIL_MIN_WIDTH_PX, HappierListDetailLayout } from '@happier-dev/plugin-ui/presentation';
import { HAPPIER_COLLECTION_RAIL_WIDTH_PX } from '@happier-dev/plugin-ui/advanced';

import {
  useLocalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CollectionDraftTitleScope } from '@/components/ui/lists/collection/CollectionDraftTitle';
import { useCollectionRailWidth } from '@/components/ui/lists/collection/useCollectionRailWidth';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { AuthRouteStepFrame } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import { openAddHome } from '@/components/homes/add/openAddHome';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { usePageBackControl } from '@/components/ui/layout/usePageBackControl';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useOpenProject } from '../useOpenProject';
import { ProjectSourceDetail } from './ProjectSourceDetail';
import { ProjectSourcesBackHeader } from './ProjectSourcesBackHeader';
import { ProjectSourcesRail, groupProjectSources } from './ProjectSourcesRail';
import { useProjectSources } from './useProjectSources';
import { buildProjectSourceOpenRoute, readProjectOpenRouteDraft } from '../activation/projectOpenRoute.mjs';
import { seedAndOpenProjectDraft } from '../activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from '../activation/projectOpenPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ProjectAttachedDashboardSelection } from '../detail/projectRouteState';
import { PROJECT_SOURCES_ROUTE, projectSourceRoute } from './projectSourceNavigation';
import { useProjectSourceSetupTarget } from './useProjectSourceSetupTarget';
import { buildHomeRecoveryHref } from '@/components/settings/server/navigation/serverSettingsRouteParams';
export { PROJECT_SOURCES_ROUTE, projectSourceRoute } from './projectSourceNavigation';

/** Projects › Sources: one Collection list beside the selected Source (lab `p-sources`). */
const NEW_SOURCE = 'new';
/** The narrowest detail that keeps the address field beside its label. */
const SOURCES_DETAIL_MIN_WIDTH_PX = 480;

function readParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first : null;
}

export const ProjectSourcesScreen = React.memo(function ProjectSourcesScreen(props: Readonly<{ setupLink?: boolean }>) {
  const params = useLocalSearchParams<{ source?: string | string[]; target?: string | string[] }>();
  const scope = useActiveServerAccountScope();
  if (props.setupLink) return <ProjectSourceSetupEntry params={params} />;
  if (!scope) {
    return (
      <ItemList testID="projects.sources.signedOut">
        <SurfaceStateCard
          kind="loading"
          title={t('projects.sources.loading')}
        />
      </ItemList>
    );
  }
  return <CollectionDraftTitleScope><ProjectSourcesCollection scope={scope} /></CollectionDraftTitleScope>;
});

/** Admission/navigation adapter only: existing Source details keep their presentation. */
function ProjectSourceSetupEntry(props: Readonly<{
  params: Parameters<typeof useProjectSourceSetupTarget>[0];
}>) {
  const router = useRouter();
  const { selection, target, credentials, returnTo } = useProjectSourceSetupTarget(props.params);
  const recovery = target.kind === 'resolved' && credentials.resolution.kind === 'signed_out' && returnTo
    ? buildHomeRecoveryHref({ profileRef: target.serverId, returnTo }) : null;
  React.useEffect(() => {
    if (recovery) router.replace(recovery);
  }, [recovery?.params.recoveryProfile, recovery?.params.recoveryReturnTo, router]);
  const binding = credentials.binding;
  if (selection && binding) return <CollectionDraftTitleScope><ProjectSourcesCollection scope={binding.scope} lifetime={binding} selectedSourceId={selection.sourceId} /></CollectionDraftTitleScope>;
  const resolution = credentials.resolution;
  // A setup link opened without its Source in reach is one honest signed-out step (lab direction A "/projects/setup"),
  // the same states the Team link uses for its Home: not on this device, its saved sign-in unreadable, loading, gone.
  const leave = () => router.replace('/');
  if (target.kind === 'unknown_home' || (target.kind === 'resolved' && resolution.kind === 'unknown_home')) {
    return <AuthRouteStepFrame testID="project-source-setup-unknown-home" status onBack={leave}
      mark={<StepMark iconName="folder" />} title={t('teams.join.unknownHomeTitle')} subtitle={t('teams.join.unknownHomeBody')}
      primary={{ testID: 'project-source-setup-add-home', label: t('server.addServerTitle'), onPress: () => openAddHome(router) }}>{null}</AuthRouteStepFrame>;
  }
  if (target.kind === 'resolved' && resolution.kind === 'unavailable') {
    const serverId = target.serverId;
    return <AuthRouteStepFrame testID="project-source-setup-unreadable" status onBack={leave}
      mark={<StepMark iconName="device-mobile" />} title={t('homeGovernance.credentialUnreadableTitle')}
      subtitle={t('homeGovernance.credentialUnreadableBody')}
      primary={{ testID: 'project-source-setup-retry', label: t('homeGovernance.retry'), onPress: () => retryServerCredentialAccountScope(serverId), iconName: null }}>{null}</AuthRouteStepFrame>;
  }
  if (target.kind === 'acquisition_failed') {
    return <AuthRouteStepFrame testID="project-source-setup-unreachable-home" status onBack={leave}
      mark={<StepMark iconName="folder" />} title={t('teams.join.unknownHomeTitle')} subtitle={t('teams.join.unknownHomeBody')}
      primary={{ testID: 'project-source-setup-retry-home', label: t('common.retry'), onPress: target.retry, iconName: null }}
      secondary={{ testID: 'project-source-setup-add-home', label: t('server.addServerTitle'), onPress: () => openAddHome(router) }}>{null}</AuthRouteStepFrame>;
  }
  if (target.kind === 'acquiring' || (target.kind === 'resolved' && (resolution.kind === 'resolving' || recovery !== null))) {
    return <AuthRouteStepFrame testID="projects.sources.setup.target" onBack={leave} mark={<StepMark iconName="folder" />}
      title={t('projects.sources.loading')}>
      <SurfaceStateCard size="line" lineLayout="notice" kind="loading" title={t('projects.sources.loading')} />
    </AuthRouteStepFrame>;
  }
  return <AuthRouteStepFrame testID="projects.sources.setup.target" status onBack={leave} mark={<StepMark iconName="folder" />}
    title={t('projects.sources.unavailable')} subtitle={t('projects.sources.unavailableBody')}>{null}</AuthRouteStepFrame>;
}

const ProjectSourcesCollection = React.memo(function ProjectSourcesCollection(
  props: Readonly<{ scope: ServerAccountScope; lifetime?: ServerAccountScopeLifetime; selectedSourceId?: string }>,
) {
  const router = useRouter();
  const navigateToOpen = useNavigateToProjectOpen();
  const { theme } = useUnistyles();
  const { fontScale } = useWindowDimensions();
  const railWidth = useCollectionRailWidth('project-sources');
  const params = useLocalSearchParams<{ source?: string | string[] }>();
  const requested = props.selectedSourceId ?? readParam(params.source);
  const creating = requested === NEW_SOURCE;
  const selectedId = creating ? null : requested;
  const { state, controller } = useProjectSources(props.scope, { lifetime: props.lifetime, catalog: props.selectedSourceId === undefined });
  const [query, setQuery] = React.useState('');
  const openProject = useOpenProject();
  const openSource = React.useCallback((source: ProjectSourceV1, attachedDashboard?: ProjectAttachedDashboardSelection) => {
    const lifetime = props.lifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent() || lifetime.scope.serverId !== props.scope.serverId) return;
    const route = buildProjectSourceOpenRoute(props.scope.serverId, source);
    const selection = route ? readProjectOpenRouteDraft(route.params) : null;
    if (!selection) return;
    fireAndForget(seedAndOpenProjectDraft({ lifetime, selection, navigate: retained => navigateToOpen({ ...retained,
      params: { ...retained.params, ...(attachedDashboard ? {
        dashboardSourceId: attachedDashboard.sourceId, dashboardArtifactId: attachedDashboard.artifactId,
        ...(attachedDashboard.serverId === undefined ? {} : { dashboardServerId: attachedDashboard.serverId }),
      } : {}) } }) }), { tag: 'ProjectSources.open' });
  }, [navigateToOpen, props.scope.serverId, props.lifetime]);
  const teamsDirectory = useTeamsDirectory({
    serverIds: [props.scope.serverId],
  });
  const teams = React.useMemo(
    () =>
      teamsDirectory.rows
        .filter((row) => row.address.serverId === props.scope.serverId)
        .map((row) => ({ id: row.team.id, name: row.team.name })),
    [props.scope.serverId, teamsDirectory.rows],
  );
  const teamName = React.useCallback(
    (teamId: string) => teams.find((team) => team.id === teamId)?.name ?? null,
    [teams],
  );
  const homeName = resolveHomeDisplayLabel(
    getServerProfileById(props.scope.serverId),
    props.scope.serverId,
  );

  // The route owns selection; the controller reads the selected Source when the route names one.
  React.useEffect(() => {
    if (selectedId && selectedId !== state.selectedId)
      void controller.select(selectedId);
  }, [controller, selectedId, state.selectedId]);

  const navigate = React.useCallback(
    (href: string, replace: boolean) => {
      const result = runGuardedNavigation(() =>
        replace ? router.replace(href as never) : router.push(href as never),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'ProjectSourcesScreen.navigate' });
    },
    [router],
  );

  const changeQuery = React.useCallback(
    (next: string) => {
      setQuery(next);
      void controller.load(next);
    },
    [controller],
  );

  const groups = React.useMemo(
    () =>
      groupProjectSources({
        sources: state.rows,
        accountId: props.scope.accountId,
        teamName,
      }),
    [props.scope.accountId, state.rows, teamName],
  );
  const retained = state.rows.length > 0;
  const firstLoad = !state.hasLoaded && (state.status === 'loading' || state.status === 'initial');
  const stale =
    state.status === 'offline' && retained
      ? {
          reason: t('projects.sources.offlineReason', { home: homeName }),
          onRetry: () => {
            void controller.load(query);
          },
        }
      : null;
  const emptyCatalog =
    state.hasLoaded && (state.status === 'ready' || state.status === 'loading') && !retained && !query.trim() && !creating && selectedId === null;
  // The empty page has no list beside it: on a phone it stands alone, so it carries the page Back like its other states.
  const emptyStandsAlone = useViewportClass() === 'compact';
  const leaveEmpty = usePageBackControl('projects.sources.back', () =>
    safeRouterBack({ router, fallbackHref: '/projects' }),
  );

  if (emptyCatalog) {
    return (
      <ItemList testID="projects.sources.empty">
        {emptyStandsAlone ? <ProjectSourcesBackHeader testID="projects.sources.header" control={leaveEmpty} /> : null}
        <EmptyState
          layout="page"
          iconName="git-branch"
          title={t('projects.sources.emptyTitle')}
          subtitle={t('projects.sources.emptyBody')}
          primaryAction={{
            label: t('projects.sources.add'),
            onPress: () => navigate(projectSourceRoute(NEW_SOURCE), false),
            testID: 'projects.sources.empty.add',
          }}
        />
      </ItemList>
    );
  }

  const detailActive = creating || selectedId !== null;
  const rail = (
    <ProjectSourcesRail
      groups={groups}
      total={state.rows.length}
      loading={firstLoad}
      query={query}
      onChangeQuery={changeQuery}
      selectedId={selectedId}
      drafting={creating}
      teamName={teamName}
      stale={stale}
      onSelect={(sourceId) =>
        navigate(projectSourceRoute(sourceId), detailActive)
      }
      onAdd={() => navigate(projectSourceRoute(NEW_SOURCE), detailActive)}
    />
  );
  const detail = detailActive ? (
    <ProjectSourceDetail
      state={state}
      controller={controller}
      accountId={props.scope.accountId}
      homeName={homeName}
      teamName={teamName}
      creating={creating}
      onCreated={(sourceId) => navigate(projectSourceRoute(sourceId), true)}
      onDiscardCreate={() =>
        navigate(projectSourceRoute(state.rows[0]?.id ?? null), true)
      }
      onOpen={openSource}
      onOpenCheckout={(workspaceRefId) => {
        fireAndForget(openProject(workspaceRefId, { serverId: props.scope.serverId }), { tag: 'ProjectSources.openCheckout' });
      }}
      onOpenDashboard={(source, reference, workspaceAddress) => {
        const attachedDashboard = { sourceId: source.id, artifactId: reference.artifactId,
          ...(reference.serverId === undefined ? {} : { serverId: reference.serverId }) };
        if (!workspaceAddress) { openSource(source, attachedDashboard); return; }
        fireAndForget(openProject(workspaceAddress.workspaceId, { serverId: props.scope.serverId, workspaceAddress,
          attachedDashboard }), { tag: 'ProjectSources.openDashboard' });
      }}
      onDeleted={() => navigate(projectSourceRoute(null), true)}
      onBack={() => safeRouterBack({ router, fallbackHref: PROJECT_SOURCES_ROUTE })}
    />
  ) : null;
  const scale = Math.max(1, fontScale);

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
      }}
    >
      <HappierListDetailLayout
        testID="projects.sources.layout"
        listTestID="projects.sources.list-pane"
        detailTestID="projects.sources.detail-pane"
        minListWidth={COLLECTION_RAIL_MIN_WIDTH_PX * scale}
        minDetailWidth={SOURCES_DETAIL_MIN_WIDTH_PX * scale}
        listWidthPx={railWidth.widthPx ?? HAPPIER_COLLECTION_RAIL_WIDTH_PX.detailed * scale}
        onListWidthCommit={railWidth.commit}
        onListWidthReset={railWidth.reset}
        preferredListRatio={0.5}
        labels={{
          resize: t('ui.resizableDockedPane.resizeA11y'),
          resizeHint: t('ui.resizableDockedPane.resizeHint'),
          resizeValue: (px) => t('ui.resizableDockedPane.resizeValue', { px }),
        }}
        listStyle={{
          borderRightWidth: 1,
          borderRightColor: theme.colors.border.default,
        }}
        list={(layout) => (
          <>
            <LandOnFirstSource
              split={layout?.mode === 'split'}
              selected={detailActive}
              firstId={state.rows[0]?.id ?? null}
              onLand={(sourceId) =>
                navigate(projectSourceRoute(sourceId), true)
              }
            />
            {rail}
          </>
        )}
        detail={detail}
        detailActive={detailActive}
        idleDetail={
          firstLoad ? (
            <ItemList>
              <SurfaceStateCard
                kind="loading"
                title={t('projects.sources.loading')}
              />
            </ItemList>
          ) : state.status === 'offline' && !retained ? (
            <ItemList>
              <SurfaceStateCard
                kind="unavailable"
                title={t('projects.sources.offline', { home: homeName })}
                action={{
                  label: t('common.retry'),
                  onPress: () => {
                    void controller.load(query);
                  },
                }}
              />
            </ItemList>
          ) : null
        }
        stackedPane="detail"
      />
    </View>
  );
});

/** A wide collection always has a selection: beside the rail, the first Source opens on arrival. */
function LandOnFirstSource(
  props: Readonly<{
    split: boolean;
    selected: boolean;
    firstId: string | null;
    onLand: (sourceId: string) => void;
  }>,
): null {
  const { split, selected, firstId, onLand } = props;
  React.useEffect(() => {
    if (split && !selected && firstId) onLand(firstId);
  }, [firstId, onLand, selected, split]);
  return null;
}

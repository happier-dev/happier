import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierListDetailLayout } from '@happier-dev/plugin-ui/presentation';

import {
  useLocalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useOpenProject } from '../useOpenProject';
import { ProjectSourceDetail } from './ProjectSourceDetail';
import { ProjectSourcesRail, groupProjectSources } from './ProjectSourcesRail';
import { useProjectSources } from './useProjectSources';
import { buildProjectSourceOpenRoute, readProjectOpenRouteDraft } from '../activation/projectOpenRoute';
import { seedAndOpenProjectDraft } from '../activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from '../activation/projectOpenPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/** Projects › Sources: one Collection list beside the selected Source (lab `p-sources`). */
export const PROJECT_SOURCES_ROUTE = '/projects/sources';
const NEW_SOURCE = 'new';
/** Rail width at normal text scale: a mark, a repository name and its owner/name · branch line. */
const SOURCES_RAIL_WIDTH_PX = 300;
/** The narrowest detail that keeps the address field beside its label. */
const SOURCES_DETAIL_MIN_WIDTH_PX = 480;

export function projectSourceRoute(sourceId: string | null): string {
  return sourceId
    ? `${PROJECT_SOURCES_ROUTE}?source=${encodeURIComponent(sourceId)}`
    : PROJECT_SOURCES_ROUTE;
}

function readParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first : null;
}

export const ProjectSourcesScreen = React.memo(function ProjectSourcesScreen() {
  const scope = useActiveServerAccountScope();
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
  return <ProjectSourcesCollection scope={scope} />;
});

const ProjectSourcesCollection = React.memo(function ProjectSourcesCollection(
  props: Readonly<{ scope: ServerAccountScope }>,
) {
  const router = useRouter();
  const navigateToOpen = useNavigateToProjectOpen();
  const { theme } = useUnistyles();
  const { fontScale } = useWindowDimensions();
  const params = useLocalSearchParams<{ source?: string | string[] }>();
  const requested = readParam(params.source);
  const creating = requested === NEW_SOURCE;
  const selectedId = creating ? null : requested;
  const { state, controller } = useProjectSources(props.scope);
  const [query, setQuery] = React.useState('');
  const openProject = useOpenProject();
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
    state.status === 'ready' && !retained && !query.trim() && !creating;

  if (emptyCatalog) {
    return (
      <ItemList testID="projects.sources.empty">
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
      onOpen={(source) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || lifetime.scope.serverId !== props.scope.serverId) return;
        const selection = readProjectOpenRouteDraft(buildProjectSourceOpenRoute(props.scope.serverId, source).params);
        if (!selection) return;
        fireAndForget(seedAndOpenProjectDraft({ lifetime, selection, navigate: navigateToOpen }), { tag: 'ProjectSources.open' });
      }}
      onOpenCheckout={(workspaceRefId) => {
        openProject(workspaceRefId, { serverId: props.scope.serverId });
      }}
      onOpenDashboard={(sourceId, reference, workspaceAddress) => {
        openProject(workspaceAddress.workspaceId, { serverId: props.scope.serverId, workspaceAddress,
          attachedDashboard: { sourceId, artifactId: reference.artifactId } });
      }}
      onDeleted={() => navigate(projectSourceRoute(null), true)}
    />
  ) : null;
  const scale = Math.max(1, fontScale);

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
      }}
    >
      <HappierListDetailLayout
        testID="projects.sources.layout"
        listTestID="projects.sources.list-pane"
        detailTestID="projects.sources.detail-pane"
        minListWidth={SOURCES_RAIL_WIDTH_PX * scale}
        minDetailWidth={SOURCES_DETAIL_MIN_WIDTH_PX * scale}
        preferredListRatio={0}
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
          state.status === 'loading' || state.status === 'initial' ? (
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

import * as React from 'react';

import type {
  TeamShareableResourceKindV1,
  TeamSharedResourceSummaryRowV1,
} from '@happier-dev/protocol/teams/teamShareableResourceKindV1';
import { teamSharedResourceSummaryRowKeyV1 } from '@happier-dev/protocol/teams/teamShareableResourceKindV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { useTeamSharedResourcesSummary } from '@/hooks/teams/useTeamSharedResourcesSummary';
import { t } from '@/text';

import type { TeamSectionContext } from './teamSectionContext';
import { teamReadFailureLabel } from './teamMutationPresentation';
import { TEAM_SHARED_KIND_PRESENTATION, readTeamSharedListKind } from './shared/teamSharedKindPresentation';
import { teamCredentialsPath, teamSessionsPath, teamSharedKindPath } from './teamsRoutes';

/** The rows the section reserves while its one summary read runs (lab L12-loading). */
const LOADING_ROWS = 8;

/** Sessions and Credentials keep their shipped Team pages; every other listed kind opens its own Team list. */
function kindDestination(
  kind: TeamShareableResourceKindV1,
  context: TeamSectionContext,
): string | null {
  if (kind === 'sessions') return teamSessionsPath(context.address);
  if (kind === 'credentials') return teamCredentialsPath(context.address);
  const listKind = readTeamSharedListKind(kind);
  return listKind ? teamSharedKindPath(context.address, listKind) : null;
}

/** A kind is listed when someone shared one, or when its owner could not count it (unknown is never 0). */
function isListed(row: TeamSharedResourceSummaryRowV1): boolean {
  return row.status === 'unavailable' || row.count > 0;
}

/**
 * "Shared with this Team" (plan F §5, lab L12-overview): one row per resource kind with its count, from the one
 * summary read. It replaces the overview's Shared sessions and Workflows inventories and the Shared credentials
 * row, so nothing is listed twice. A kind opens its own list; sharing is managed at each record's owner.
 */
export const TeamSharedResourcesSection = React.memo(
  function TeamSharedResourcesSection(
    props: Readonly<{ context: TeamSectionContext }>,
  ) {
    const { context } = props;
    const router = useRouter();
    const summary = useTeamSharedResourcesSummary({
      scope: context.scope,
      address: context.address,
      enabled: true,
    });
    const destinationOf = React.useCallback((kind: TeamSharedResourceSummaryRowV1['kind']) => kindDestination(kind, context), [context]);
    const open = React.useCallback((destination: NonNullable<ReturnType<typeof kindDestination>>) => router.push(destination), [router]);
    return (
      <TeamSharedResourcesView teamName={context.team.name} serverId={context.address.serverId} summary={summary}
        destinationOf={destinationOf} onOpen={open} />
    );
  },
);

type TeamSharedSummaryState = Pick<ReturnType<typeof useTeamSharedResourcesSummary>, 'status' | 'kinds' | 'error' | 'reload'>;
type KindDestination = NonNullable<ReturnType<typeof kindDestination>>;

/** "Shared with this Team" for one summary state; the specimen mounts it with fixture summaries. */
export const TeamSharedResourcesView = React.memo(function TeamSharedResourcesView(
  props: Readonly<{
    teamName: string;
    serverId: string;
    summary: TeamSharedSummaryState;
    destinationOf: (kind: TeamSharedResourceSummaryRowV1['kind']) => KindDestination | null;
    onOpen: (destination: KindDestination) => void;
  }>,
) {
    const rows = React.useMemo(
      () =>
        props.summary.kinds
          .filter(isListed)
          .slice()
          .sort(
            (a, b) =>
              TEAM_SHARED_KIND_PRESENTATION[a.kind].order - TEAM_SHARED_KIND_PRESENTATION[b.kind].order,
          ),
      [props.summary.kinds],
    );
    const settled = props.summary.status === 'ready';
    const failedWithNothing =
      props.summary.status === 'error' && props.summary.kinds.length === 0;
    const loadingWithNothing =
      !settled && !failedWithNothing && props.summary.kinds.length === 0;
    // Last-known kinds stay in place while a refresh runs, including "nothing shared yet".
    const empty = (settled || props.summary.kinds.length > 0) && rows.length === 0;

    return (
      <ItemGroup
        testID="team-overview-shared"
        title={t('teams.overview.shared.title')}
        description={t('teams.overview.shared.description', {
          team: props.teamName,
        })}
      >
        {loadingWithNothing ? (
          <ItemLoadStateRows
            testID="team-overview-shared-loading"
            state={{ kind: 'loading' }}
            rows={LOADING_ROWS}
          />
        ) : null}
        {failedWithNothing ? (
          <ItemLoadStateRows
            testID="team-overview-shared-failed"
            state={{
              kind: 'failed',
              reason: props.summary.error
                ? teamReadFailureLabel(props.summary.error)
                : t('teams.overview.shared.failed'),
              onRetry: props.summary.reload,
              homeServerIds: [props.serverId],
            }}
          />
        ) : null}
        {empty ? (
          // The lab's empty row (L12 empty): what isn't here yet and where sharing starts, as a row of the group.
          <Item
            testID="team-overview-shared-empty"
            icon={<Icon name="users" />}
            title={t('teams.overview.shared.emptyTitle', {
              team: props.teamName,
            })}
            subtitle={t('teams.overview.shared.emptyBody')}
            mode="info"
            showChevron={false}
          />
        ) : null}
        {rows.map((row) => {
          const presentation = TEAM_SHARED_KIND_PRESENTATION[row.kind];
          const title = t(presentation.title);
          const destination = props.destinationOf(row.kind);
          const key = teamSharedResourceSummaryRowKeyV1(row);
          if (row.status === 'unavailable') {
            return (
              <Item
                key={key}
                testID={`team-overview-shared:${key}`}
                icon={<Icon name={presentation.icon} />}
                title={title}
                accessibilityLabel={t('teams.overview.shared.unknownA11y', {
                  kind: title,
                })}
                detail={t('teams.overview.shared.unknown')}
                rightElement={
                  <TextLinkButton
                    testID={`team-overview-shared-retry:${key}`}
                    label={t('common.retry')}
                    onPress={props.summary.reload}
                  />
                }
                mode="info"
                showChevron={false}
              />
            );
          }
          return (
            <Item
              key={key}
              testID={`team-overview-shared:${key}`}
              icon={<Icon name={presentation.icon} />}
              title={title}
              accessibilityLabel={t('teams.overview.shared.countA11y', {
                kind: title,
                count: row.count,
              })}
              detail={String(row.count)}
              mode={destination ? 'interactive' : 'info'}
              showChevron={destination !== null}
              onPress={destination ? () => props.onOpen(destination) : undefined}
            />
          );
        })}
      </ItemGroup>
    );
});

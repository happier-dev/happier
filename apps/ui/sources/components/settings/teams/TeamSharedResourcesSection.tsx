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
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
    const rows = React.useMemo(
      () =>
        summary.kinds
          .filter(isListed)
          .slice()
          .sort(
            (a, b) =>
              TEAM_SHARED_KIND_PRESENTATION[a.kind].order - TEAM_SHARED_KIND_PRESENTATION[b.kind].order,
          ),
      [summary.kinds],
    );
    const settled = summary.status === 'ready';
    const failedWithNothing =
      summary.status === 'error' && summary.kinds.length === 0;
    const loadingWithNothing =
      !settled && !failedWithNothing && summary.kinds.length === 0;
    const empty = settled && rows.length === 0;

    return (
      <ItemGroup
        testID="team-overview-shared"
        title={t('teams.overview.shared.title')}
        description={t('teams.overview.shared.description', {
          team: context.team.name,
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
              reason: summary.error
                ? teamReadFailureLabel(summary.error)
                : t('teams.overview.shared.failed'),
              onRetry: summary.reload,
              homeServerIds: [context.address.serverId],
            }}
          />
        ) : null}
        {empty ? (
          <SurfaceStateCard
            testID="team-overview-shared-empty"
            kind="empty"
            size="line"
            title={t('teams.overview.shared.emptyTitle', {
              team: context.team.name,
            })}
            reason={t('teams.overview.shared.emptyBody')}
          />
        ) : null}
        {rows.map((row) => {
          const presentation = TEAM_SHARED_KIND_PRESENTATION[row.kind];
          const title = t(presentation.title);
          const destination = kindDestination(row.kind, context);
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
                    onPress={summary.reload}
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
              onPress={destination ? () => router.push(destination) : undefined}
            />
          );
        })}
      </ItemGroup>
    );
  },
);

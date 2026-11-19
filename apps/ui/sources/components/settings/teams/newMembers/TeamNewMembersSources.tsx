import * as React from 'react';

import { describeProjectSourceRow } from '@/components/projects/sources/projectSourceAddress';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readCurrentServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { useTeamSetupAuthoringReferences } from './useTeamSetupAuthoringReferences';

export type TeamNewMembersSourceRows = ReturnType<typeof useTeamSetupAuthoringReferences>['rows'];

/**
 * L5's Source-backed sections: the repositories shared with this Team and the first task attached
 * to one of them. Both read the one Source owner through `useTeamSetupAuthoringReferences`; prompt
 * bodies are never read here, only the attached reference.
 */
export function TeamNewMembersSources(
  props: Readonly<{ context: TeamSectionContext }>,
) {
  const { scope, team } = props.context;
  const { binding, resolution } = useServerCredentialAccountScopeBinding(
    scope.serverId,
  );
  const owner = binding ?? (resolution.kind === 'resolving'
    ? readCurrentServerCredentialAccountScopeLifetime(scope.serverId) : null);
  const lifetime =
    owner?.isCurrent() && areServerAccountScopesEqual(owner.scope, scope)
      ? owner
      : null;
  const references = useTeamSetupAuthoringReferences(scope, team.id, {
    enabled: lifetime !== null && lifetime === binding,
    lifetime,
  });
  const { rows, controller } = references;
  const status = references.state.status;
  const retry = React.useCallback(() => controller.load(), [controller]);
  const settled = references.state.hasLoaded || rows.length > 0;
  const loading =
    !settled &&
    (resolution.kind === 'resolving' ||
      status === 'initial' ||
      status === 'loading');
  const failed = !settled && !loading;

  return (
    <TeamNewMembersSourcesView
      teamName={team.name}
      rows={rows}
      loading={loading}
      failed={failed}
      onRetry={status === 'offline' ? retry : undefined}
      homeServerId={scope.serverId}
    />
  );
}

/** The two sections as drawn from an already-read Source list; `TeamNewMembersSources` owns the read. */
export function TeamNewMembersSourcesView(
  props: Readonly<{
    teamName: string;
    rows: TeamNewMembersSourceRows;
    loading: boolean;
    failed: boolean;
    /** Offered only when the Home was unreachable; a refusal has nothing to retry. */
    onRetry?: () => void;
    homeServerId: string;
  }>,
) {
  const { rows, loading, failed, onRetry } = props;
  const settled = !loading && !failed;
  return (
    <>
      <ItemGroup
        testID="team-new-members-repositories"
        title={t('teams.newMembers.repositories.title')}
        description={t('teams.newMembers.repositories.description', {
          team: props.teamName,
        })}
      >
        {loading ? (
          <ItemLoadStateRows
            testID="team-new-members-repositories-loading"
            state={{ kind: 'loading' }}
            rows={3}
            lines={2}
          />
        ) : null}
        {failed ? (
          <ItemLoadStateRows
            testID="team-new-members-repositories-failed"
            state={{
              kind: 'failed',
              reason: t('teams.newMembers.repositories.loadFailed'),
              ...(onRetry
                ? { onRetry, homeServerIds: [props.homeServerId] }
                : {}),
            }}
          />
        ) : null}
        {settled && rows.length === 0 ? (
          <SurfaceStateCard
            testID="team-new-members-repositories-empty"
            kind="empty"
            size="line"
            // The section description already names the Team; the empty state does not repeat it.
            title={t('teams.newMembers.repositories.emptyTitle')}
            reason={t('teams.newMembers.repositories.emptyBody')}
          />
        ) : null}
        {rows.map((row) => (
          <RepositoryRow key={row.source.id} row={row} />
        ))}
      </ItemGroup>
      {/* The task comes from the same Source read; when that read failed, the notice above says so once. */}
      {failed ? null : (
        <ItemGroup
          testID="team-new-members-first-task"
          title={t('teams.newMembers.firstTask.title')}
          description={t('teams.newMembers.firstTask.description')}
        >
          {settled ? <FirstTaskRows rows={rows} /> : null}
          {loading ? (
            <ItemLoadStateRows state={{ kind: 'loading' }} rows={1} lines={1} />
          ) : null}
        </ItemGroup>
      )}
    </>
  );
}

const RepositoryRow = React.memo(function RepositoryRow(
  props: Readonly<{ row: TeamNewMembersSourceRows[number] }>,
) {
  const { source, taskReference } = props.row;
  const subtitle = [
    describeProjectSourceRow(source),
    taskReference ? t('teams.newMembers.repositories.hasFirstTask') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Item
      testID={`team-new-members-repository:${source.id}`}
      icon={<Icon name="git-branch" />}
      title={source.name}
      subtitle={subtitle}
      showChevron={false}
    />
  );
});

function FirstTaskRows(props: Readonly<{ rows: TeamNewMembersSourceRows }>) {
  const attached = props.rows.filter((row) => row.taskReference !== null);
  if (attached.length === 0) {
    return (
      <SurfaceStateCard
        testID="team-new-members-first-task-empty"
        kind="empty"
        size="line"
        title={t('teams.newMembers.firstTask.emptyTitle')}
        reason={t('teams.newMembers.firstTask.emptyBody')}
      />
    );
  }
  return (
    <>
      {attached.map((row) => (
        <Item
          key={row.source.id}
          testID={`team-new-members-first-task:${row.source.id}`}
          title={t('teams.newMembers.firstTask.attachedTo', {
            source: row.source.name,
          })}
          showChevron={false}
        />
      ))}
    </>
  );
}

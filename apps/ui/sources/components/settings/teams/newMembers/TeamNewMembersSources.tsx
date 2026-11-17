import * as React from 'react';

import { describeProjectSourceRow } from '@/components/projects/sources/projectSourceAddress';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { useTeamSetupAuthoringReferences } from './useTeamSetupAuthoringReferences';

type SourceRows = ReturnType<typeof useTeamSetupAuthoringReferences>['rows'];

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
  // Only the exact Account this page was opened for may read; another Account on the Home waits.
  const lifetime =
    binding && areServerAccountScopesEqual(binding.scope, scope)
      ? binding
      : null;
  const references = useTeamSetupAuthoringReferences(scope, team.id, {
    enabled: lifetime !== null,
    lifetime,
  });
  const { rows, controller } = references;
  const status = references.state.status;
  const retry = React.useCallback(() => controller.load(), [controller]);
  const settled = status === 'ready' || rows.length > 0;
  const loading =
    !settled &&
    (resolution.kind === 'resolving' ||
      status === 'initial' ||
      status === 'loading');
  const failed = !settled && !loading;

  return (
    <>
      <ItemGroup
        testID="team-new-members-repositories"
        title={t('teams.newMembers.repositories.title')}
        description={t('teams.newMembers.repositories.description', {
          team: team.name,
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
              ...(status === 'offline'
                ? { onRetry: retry, homeServerIds: [scope.serverId] }
                : {}),
            }}
          />
        ) : null}
        {settled && rows.length === 0 ? (
          <SurfaceStateCard
            testID="team-new-members-repositories-empty"
            kind="empty"
            size="line"
            title={t('teams.newMembers.repositories.emptyTitle', {
              team: team.name,
            })}
            reason={t('teams.newMembers.repositories.emptyBody', {
              team: team.name,
            })}
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
  props: Readonly<{ row: SourceRows[number] }>,
) {
  const { source, taskReference } = props.row;
  const address = source.repository ? describeProjectSourceRow(source) : null;
  const subtitle = [
    address,
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

function FirstTaskRows(props: Readonly<{ rows: SourceRows }>) {
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

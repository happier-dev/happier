import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamPagedList } from '@/hooks/teams/useTeamPagedList';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { TeamDirectoryPeoplePageV1 } from '@happier-dev/protocol/teams';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import { t } from '@/text';

import { teamMemberDetailPath } from '../teamsRoutes';
import { teamReadFailureLabel } from '../teamMutationPresentation';
import { createIdentityAdministrationClient, executeIdentityAdministrationRead } from './identityAdministrationClient';

export function useDirectoryPeopleList(props: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    sourceId: string;
    enabled?: boolean;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
}>) {
    const client = React.useMemo(
        () => createIdentityAdministrationClient(props.scope, { onApprovalPending: props.requestApproval }),
        [props.requestApproval, props.scope.accountId, props.scope.serverId],
    );
    const loadPage = React.useCallback(async (cursor: string | null, signal: AbortSignal) => {
        const result = await executeIdentityAdministrationRead<TeamDirectoryPeoplePageV1>((options) => client.executeDirectory('teams.directory.people.list', {
            v: 1,
            teamId: props.address.teamId,
            sourceId: props.sourceId,
            limit: 50,
            cursor,
        }, options), signal);
        return result.ok
            ? { kind: 'succeeded' as const, value: result.value }
            : {
                kind: 'failed' as const,
                failure: result.failure.domainFailure ?? { kind: 'unknown' as const, retryable: result.failure.retryable, code: null },
            };
    }, [client, props.address.teamId, props.sourceId]);
    return useTeamPagedList({
        key: `${props.scope.serverId} ${props.scope.accountId} ${props.address.teamId} ${props.sourceId}`,
        enabled: props.enabled ?? true,
        loadPage,
        // Directory projection changes are published as the Team change.
        accountChange: { serverId: props.address.serverId, entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 },
    });
}

export function DirectoryListFailure(props: Readonly<{
    testID: string;
    failure: HomeDomainFailure;
    retry: () => Promise<void>;
}>) {
    return <>
        <Item testID={`${props.testID}-error`} title={teamReadFailureLabel(props.failure)} accessibilityLiveRegion="polite" showChevron={false} />
        {props.failure.retryable ? <Item testID={`${props.testID}-retry`} title={t('common.retry')} onPress={() => void props.retry()} showChevron={false} /> : null}
    </>;
}

export const DirectoryPeopleList = React.memo(function DirectoryPeopleList(props: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    sourceId: string;
    requestApproval?: (registration: ActionApprovalRegistration) => void;
}>) {
    const router = useRouter();
    const people = useDirectoryPeopleList(props);

    return (
        <>
            <ItemGroup title={t('teams.authentication.directory.people.section')}>
                {people.status === 'loading' && people.rows.length === 0 ? (
                    <Item title={t('common.loading')} loading showChevron={false} />
                ) : people.rows.length === 0 && !people.error ? (
                    <Item testID="directory-people-empty" title={t('teams.authentication.directory.people.empty')} showChevron={false} />
                ) : people.rows.map((person) => {
                    const membershipId = person.accountBinding.state === 'bound'
                        ? person.accountBinding.teamMembershipId
                        : null;
                    const stateLabel = person.state === 'active'
                        ? null
                        : t(`teams.authentication.directory.people.state.${person.state}`);
                    const identityLabel = person.email ?? person.externalLogin;
                    return (
                        <Item
                            key={person.id}
                            testID={`directory-person:${person.id}`}
                            title={person.displayName ?? identityLabel ?? t('teams.authentication.directory.people.unknown')}
                            subtitle={[identityLabel, stateLabel].filter((value): value is string => value !== null).join(' · ') || undefined}
                            detail={person.accountBinding.state === 'unbound'
                                ? t('teams.authentication.directory.people.provisioned')
                                : t('teams.authentication.directory.people.member')}
                            onPress={membershipId === null
                                ? undefined
                                : () => router.push(teamMemberDetailPath(props.address, membershipId))}
                            showChevron={membershipId !== null}
                        />
                    );
                })}
            </ItemGroup>
            {people.error ? (
                <ItemGroup>
                    <DirectoryListFailure testID="directory-people" failure={people.error} retry={people.reload} />
                </ItemGroup>
            ) : null}
            {people.hasMore && people.status !== 'loading' && !people.error ? (
                <ItemGroup>
                    <Item
                        testID="directory-people-load-more"
                        title={t('teams.authentication.directory.people.loadMore')}
                        loading={people.status === 'loading_more'}
                        disabled={people.status === 'loading_more'}
                        onPress={() => void people.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

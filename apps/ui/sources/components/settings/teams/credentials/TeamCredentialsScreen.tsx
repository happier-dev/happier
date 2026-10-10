import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type {
    TeamCredentialResourceListFilterV1,
    TeamCredentialResourceSummaryV1,
} from '@happier-dev/protocol/teams';

import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamCredentialResources } from '@/hooks/teams/useTeamCredentialResources';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamCredentialCreatePath, teamCredentialDetailPath } from '../teamsRoutes';
import {
    orderTeamCredentialResources,
    resourceAdministrationSummaryLines,
    resourceAccessibilityLabel,
} from './teamCredentialPresentation';
import { TeamCredentialResourceFilterPicker } from './TeamCredentialResourceFilterPicker';

/**
 * One shared credential row.
 *
 * The row is what the plan asks for and nothing more: name, then one subdued
 * line for source and delivery, then audience and actionable state. It carries
 * no source identifier, endpoint, fingerprint or revision — none of which is the
 * administrator's task and all of which would be a disclosure.
 */
const CredentialRow = React.memo(function CredentialRow(props: Readonly<{
    context: TeamSectionContext;
    resource: TeamCredentialResourceSummaryV1;
}>) {
    const router = useRouter();
    const { context, resource } = props;
    // Whether the Home disclosed this resource's audience and policy to this
    // viewer is the resource's own `capabilities`, which the presentation owner
    // reads: a member is shown empty grant lists and masked policy defaults
    // because they are not theirs to see, and the Team-wide management flag
    // does not answer that question for one resource.
    const summaryLines = resourceAdministrationSummaryLines(resource);
    return (
        <Item
            testID={`team-credentials-row:${resource.id}`}
            title={resource.displayName}
            subtitle={summaryLines.join('\n')}
            accessibilityLabel={resourceAccessibilityLabel(resource)}
            onPress={() => router.push(teamCredentialDetailPath(context.address, resource.id))}
        />
    );
});

/**
 * The one way into offering a source.
 *
 * It appears only once the Home has said this viewer may offer their own
 * credential: `offerOwnCredential` is a separate decision from administering the
 * Team's resources, so a manager who owns nothing shareable and an ordinary
 * member who does are each told the truth. While the answer is still open the
 * entry is absent rather than present-then-gone.
 */
const ShareCredentialEntry = React.memo(function ShareCredentialEntry(props: Readonly<{
    context: TeamSectionContext;
    testID: string;
}>) {
    const router = useRouter();
    const { context, testID } = props;
    return (
        <Item
            testID={testID}
            title={t('teams.credentials.create.action')}
            onPress={() => router.push(teamCredentialCreatePath(context.address))}
        />
    );
});

const CredentialsList = React.memo(function CredentialsList(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const { context } = props;
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState<TeamCredentialResourceListFilterV1>('all');
    // The Home's own decision about this exact Home, not the Home set the person
    // happens to be looking at: a Team screen is bound to one Home for its whole
    // lifetime, and the destination must answer for that one.
    const featureEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: context.scope.serverId,
    });
    const projection = useTeamCredentialResources({
        scope: context.scope,
        address: context.address,
        enabled: featureEnabled,
        search: search.trim() || undefined,
        filter,
    });
    const showSearch = projection.rows.length >= 10 || projection.hasMore || search.length > 0;

    if (!featureEnabled) {
        return (
            <ItemGroup description={t('teams.credentials.unavailable')}>
                <Item
                    testID="team-credentials-unavailable"
                    title={t('teams.credentials.title')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const mayOffer = projection.viewer?.offerOwnCredential === true && context.canMutate;

    // The Home answered that this viewer neither administers this Team's
    // resources nor may offer one of their own. That is a settled answer, not a
    // transient one, so it replaces the list rather than rendering an empty one
    // that implies there is nothing to see.
    if (projection.viewer !== null
        && !projection.viewer.manageCredentials
        && !projection.viewer.offerOwnCredential
        && projection.rows.length === 0) {
        return (
            <ItemGroup description={t('teams.credentials.forbidden')}>
                <Item
                    testID="team-credentials-forbidden"
                    title={t('teams.denied.title')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const rows = orderTeamCredentialResources(projection.rows);
    const hasActiveFilter = filter !== 'all' || search.trim().length > 0;

    return (
        <>
            {showSearch ? (
                <SearchHeader
                    testID="team-credentials-search"
                    value={search}
                    onChangeText={setSearch}
                    placeholder={t('teams.directory.searchPlaceholder')}
                />
            ) : null}
            {projection.viewer?.manageCredentials === true ? (
                <ItemGroup>
                    <TeamCredentialResourceFilterPicker
                        value={filter}
                        disabled={projection.status === 'loading'}
                        onChange={setFilter}
                    />
                </ItemGroup>
            ) : null}
            {projection.status === 'loading' && rows.length === 0 ? (
                <ItemGroup>
                    <Item
                        testID="team-credentials-loading"
                        title={t('teams.credentials.title')}
                        loading
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {rows.length === 0 && projection.status === 'ready' ? (
                <ItemGroup description={hasActiveFilter
                    ? t('common.noMatches')
                    : t('teams.credentials.emptyBody')}>
                    <Item
                        testID="team-credentials-empty"
                        title={hasActiveFilter ? t('common.noMatches') : t('teams.credentials.emptyTitle')}
                        showChevron={false}
                    />
                    {hasActiveFilter ? (
                        <Item
                            testID="team-credentials-clear-filters"
                            title={t('common.reset')}
                            accessibilityLabel={`${t('common.reset')}: ${t('teams.credentials.title')}`}
                            onPress={() => {
                                setSearch('');
                                setFilter('all');
                            }}
                            showChevron={false}
                        />
                    ) : null}
                    {mayOffer ? (
                        <ShareCredentialEntry context={context} testID="team-credentials-empty-share" />
                    ) : null}
                </ItemGroup>
            ) : null}

            {rows.length > 0 ? (
                <ItemGroup title={t('teams.credentials.title')} description={t('teams.credentials.subtitle')}>
                    {rows.map((resource) => (
                        <CredentialRow
                            key={resource.id}
                            context={context}
                            resource={resource}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            {mayOffer && rows.length > 0 ? (
                <ItemGroup>
                    <ShareCredentialEntry context={context} testID="team-credentials-share" />
                </ItemGroup>
            ) : null}

            {projection.hasMore && !projection.error ? (
                <ItemGroup>
                    <Item
                        testID="team-credentials-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={projection.status === 'refreshing'}
                        onPress={() => void projection.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {/* Rows already read stay on screen through a failure. */}
            {projection.error ? (
                <ItemGroup description={t('teams.unavailable.offline')}>
                    <Item
                        testID="team-credentials-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void projection.retry()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

export const TeamCredentialsScreen = React.memo(function TeamCredentialsScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.credentials.title')} description={t('teams.pages.credentials')}>
            {(context) => <CredentialsList context={context} />}
        </TeamSection>
    );
});

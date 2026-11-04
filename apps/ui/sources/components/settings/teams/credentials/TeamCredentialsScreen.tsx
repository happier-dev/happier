import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type {
    TeamCredentialResourceListFilterV1,
    TeamCredentialResourceSummaryV1,
} from '@happier-dev/protocol/teams';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useTeamCredentialResources } from '@/hooks/teams/useTeamCredentialResources';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { getPreferredLanguage, t } from '@/text';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ConnectedServiceMark } from '@/components/settings/connectedServices/ConnectedServiceMark';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamCredentialCreatePath, teamCredentialDetailPath } from '../teamsRoutes';
import {
    orderTeamCredentialResources,
    resourceAdministrationSummaryLines,
    resourceAccessibilityLabel,
    resourceConnectedServiceMarkId,
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
    address: TeamAddress;
    resource: TeamCredentialResourceSummaryV1;
    language: string;
}>) {
    const router = useRouter();
    const { address, resource } = props;
    const registry = useProjectedConnectedServicesRegistry();
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
            icon={<ConnectedServiceMark legacyServiceId={resourceConnectedServiceMarkId(resource, registry)} size="row" />}
            subtitle={summaryLines.join('\n')}
            accessibilityLabel={resourceAccessibilityLabel(resource)}
            onPress={() => router.push(teamCredentialDetailPath(address, resource.id))}
        />
    );
});

/**
 * The Home's own decision about this exact Home, not the Home set the person happens to be looking
 * at: a Team screen is bound to one Home for its whole lifetime, and the destination must answer
 * for that one. The list and the header's action read one shared observation.
 */
function useTeamCredentialsProjection(
    context: TeamSectionContext,
    search?: string,
    filter?: TeamCredentialResourceListFilterV1,
) {
    const featureEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: context.scope.serverId,
    });
    const projection = useTeamCredentialResources({
        scope: context.scope,
        address: context.address,
        enabled: featureEnabled,
        search,
        filter,
    });
    return { featureEnabled, projection };
}

/**
 * Offering your own source is the Home's separate decision from administering the Team's resources:
 * it appears only once the Home has said this viewer may, never present-then-gone.
 */
function mayOfferCredential(
    viewer: ReturnType<typeof useTeamCredentialResources>['viewer'],
    context: TeamSectionContext,
): boolean {
    return viewer?.offerOwnCredential === true && context.canMutate;
}

/**
 * Sharing a source starts at the head of the page, like adding a Group or inviting someone. With
 * nothing shared yet the empty state's own action is the one way to start, so it is not offered twice.
 */
const ShareCredentialAction = React.memo(function ShareCredentialAction(props: Readonly<{ context: TeamSectionContext }>) {
    const router = useRouter();
    const { featureEnabled, projection } = useTeamCredentialsProjection(props.context);
    if (!featureEnabled || projection.rows.length === 0 || !mayOfferCredential(projection.viewer, props.context)) return null;
    return (
        <SectionActionButton
            testID="team-credentials-share"
            icon="plus"
            title={t('teams.credentials.create.action')}
            onPress={() => router.push(teamCredentialCreatePath(props.context.address))}
        />
    );
});

const CredentialsList = React.memo(function CredentialsList(props: Readonly<{
    context: TeamSectionContext;
}>) {
    const { context } = props;
    const router = useRouter();
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState<TeamCredentialResourceListFilterV1>('all');
    const { featureEnabled, projection } = useTeamCredentialsProjection(context, search.trim() || undefined, filter);
    const showSearch = projection.rows.length >= 10 || projection.hasMore || search.length > 0;

    if (!featureEnabled) {
        return (
            <SurfaceStateCard
                testID="team-credentials-unavailable"
                kind="unavailable"
                size="pane"
                iconName="key"
                title={t('teams.credentials.unavailable')}
                reason={t('teams.credentials.subtitle')}
            />
        );
    }

    const mayOffer = mayOfferCredential(projection.viewer, context);
    const share = () => router.push(teamCredentialCreatePath(context.address));

    // The Home answered that this viewer neither administers this Team's
    // resources nor may offer one of their own. That is a settled answer, not a
    // transient one, so it replaces the list rather than rendering an empty one
    // that implies there is nothing to see.
    if (projection.viewer !== null
        && !projection.viewer.manageCredentials
        && !projection.viewer.offerOwnCredential
        && projection.rows.length === 0) {
        return (
            <SurfaceStateCard
                testID="team-credentials-forbidden"
                kind="denied"
                size="pane"
                title={t('teams.denied.title')}
                reason={t('teams.credentials.forbidden')}
            />
        );
    }

    const rows = orderTeamCredentialResources(projection.rows);
    const hasActiveFilter = filter !== 'all' || search.trim().length > 0;
    const retryLine = projection.error ? (
        // Rows already read stay on screen through a failure; the failure is one line beside them.
        <SurfaceStateCard
            testID="team-credentials-error"
            kind="error"
            size="line"
            title={t('teams.unavailable.offline')}
            action={{ label: t('common.retry'), onPress: () => void projection.retry(), testID: 'team-credentials-retry' }}
            accessibilitySemantics="alert"
        />
    ) : null;

    // Nothing shared yet, and no search or filter narrowing it: the page itself becomes the invitation
    // (what sharing does, and the one way to start). Search and the filter would act on an empty set.
    if (rows.length === 0 && projection.status === 'ready' && !hasActiveFilter) {
        return (
            <>
                <SurfaceStateCard
                    testID="team-credentials-empty"
                    kind="empty"
                    size="pane"
                    iconName="key"
                    // The Team's other first-run pages (Groups, Invitations) draw their scene; this one too.
                    scene="connectAccount"
                    title={t('teams.credentials.emptyTitle')}
                    reason={t('teams.credentials.subtitle')}
                    action={mayOffer
                        ? { label: t('teams.credentials.create.action'), onPress: share, testID: 'team-credentials-empty-share' }
                        : undefined}
                />
                {retryLine ? <ItemGroup>{retryLine}</ItemGroup> : null}
            </>
        );
    }

    return (
        <>
            {showSearch ? (
                <CompactSearchField
                    testID="team-credentials-search"
                    placement="page"
                    value={search}
                    onChangeText={setSearch}
                    placeholder={t('teams.directory.searchPlaceholder')}
                />
            ) : null}
            {/* Narrowing earns its place only once the list is too long to read at a glance (the same
                threshold as search), or while a narrowing is in force and needs its way back. */}
            {projection.viewer?.manageCredentials === true && (showSearch || filter !== 'all') ? (
                <ItemGroup>
                    <TeamCredentialResourceFilterPicker
                        value={filter}
                        disabled={projection.status === 'loading'}
                        onChange={setFilter}
                    />
                </ItemGroup>
            ) : null}
            <ItemGroup>
                {projection.status === 'loading' && rows.length === 0 ? (
                    <ItemLoadStateRows
                        testID="team-credentials-loading"
                        state={{ kind: 'loading' }}
                        rows={3}
                        accessibilityLabel={t('common.loading')}
                    />
                ) : rows.length === 0 && projection.status === 'ready' ? (
                    // Only a real search or filter reaches here: say so, with the way back.
                    <SurfaceStateCard
                        testID="team-credentials-empty"
                        kind="empty"
                        size="line"
                        title={t('common.noMatches')}
                        action={{
                            label: t('common.reset'),
                            testID: 'team-credentials-clear-filters',
                            onPress: () => {
                                setSearch('');
                                setFilter('all');
                            },
                        }}
                    />
                ) : rows.map((resource) => (
                    <CredentialRow
                        key={resource.id}
                        address={context.address}
                        resource={resource}
                        language={getPreferredLanguage()}
                    />
                ))}
                {projection.hasMore && !projection.error ? (
                    <Item
                        testID="team-credentials-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={projection.status === 'refreshing'}
                        onPress={() => void projection.loadMore()}
                        showChevron={false}
                    />
                ) : null}
                {retryLine}
            </ItemGroup>
        </>
    );
});

export const TeamCredentialsScreen = React.memo(function TeamCredentialsScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.credentials.title')}
            description={t('teams.pages.credentials')}
            renderHeaderActions={(context) => <ShareCredentialAction context={context} />}
        >
            {(context) => <CredentialsList context={context} />}
        </TeamSection>
    );
});

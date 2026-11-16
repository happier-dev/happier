import * as React from 'react';
import type { TeamCredentialActivityKindV1 } from '@happier-dev/protocol/teams';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CollectionRows } from '@/components/ui/lists/collection/CollectionList';
import { useTeamCredentialActivity } from '@/hooks/teams/useTeamCredentialResources';
import { useOpenedPrivateLabels } from '@/sync/ops/privateLabels/useOpenedPrivateLabels';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { useTeamCredentialResourceView } from './useTeamCredentialResourceView';
import {
    teamCredentialDisplayNameBinding,
    teamCredentialExternalApiKeyLabelBinding,
} from '@/sync/ops/teams/teamCredentialLabels';

/**
 * What one administrative event says.
 *
 * Activity is metadata only: who changed what, and when. It is deliberately not
 * a request log, so there is no branch here that could ever render a prompt, a
 * response, a bearer prefix or a source identifier.
 */
function activityKindLabel(kind: TeamCredentialActivityKindV1): string {
    switch (kind) {
        case 'resource_created':
            return t('teams.credentials.activity.kind.resourceCreated');
        case 'resource_updated':
            return t('teams.credentials.activity.kind.resourceUpdated');
        case 'resource_deleted':
            return t('teams.credentials.activity.kind.resourceDeleted');
        case 'audience_changed':
            return t('teams.credentials.activity.kind.audienceChanged');
        case 'direct_delivered':
            return t('teams.credentials.activity.kind.directDelivered');
        case 'external_key_created':
            return t('teams.credentials.activity.kind.externalKeyCreated');
        case 'external_key_revoked':
            return t('teams.credentials.activity.kind.externalKeyRevoked');
        case 'limits_changed':
            return t('teams.credentials.activity.kind.limitsChanged');
    }
}

function isExternalKeyActivity(event: Readonly<{ kind: string }>): boolean {
    return event.kind === 'external_key_created' || event.kind === 'external_key_revoked';
}

const CredentialActivity = React.memo(function CredentialActivity(props: Readonly<{
    context: TeamSectionContext;
    resourceId: string;
}>) {
    const { context, resourceId } = props;
    const view = useTeamCredentialResourceView({ context, resourceId });
    // The Home admits the administrative history only to a viewer who
    // administers resources, so a member's screen asks for nothing at all
    // rather than opening a request it knows will be refused.
    const managesResources = view.viewer?.manageCredentials === true;
    const activity = useTeamCredentialActivity({
        scope: context.scope,
        resourceId,
        enabled: view.featureEnabled && view.resource !== null && managesResources,
    });
    const activityLabelRequests = React.useMemo(() => activity.rows.map((event, index) => (
        {
            key: `${event.createdAt}:${index}`,
            // Historical resource snapshots remain resource-bound; an external
            // key snapshot deliberately carries its own immutable AAD id.
            binding: isExternalKeyActivity(event) && 'externalApiKeyId' in event
                ? teamCredentialExternalApiKeyLabelBinding(event.externalApiKeyId)
                : teamCredentialDisplayNameBinding(resourceId),
            label: event.subjectDisplayName,
            readPolicy: { kind: 'team-resource' as const },
        }
    )), [activity.rows, resourceId]);
    const openedActivityDisplayNames = useOpenedPrivateLabels({
        scope: context.scope,
        requests: activityLabelRequests,
        enabled: view.featureEnabled && managesResources,
    });

    const newestCredentialEvent = activity.rows.findIndex((event) => !isExternalKeyActivity(event));
    const credentialName = newestCredentialEvent >= 0
        ? openedActivityDisplayNames[`${activity.rows[newestCredentialEvent]!.createdAt}:${newestCredentialEvent}`] ?? null
        : null;

    if (!view.featureEnabled || (view.resolved && view.resource === null)) {
        return (
            <ItemGroup description={view.featureEnabled
                ? t('teams.credentials.detail.notFound')
                : t('teams.credentials.unavailable')}>
                <Item
                    testID="team-credential-activity-unavailable"
                    title={t('teams.errors.notFound')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (view.resolved && !managesResources) {
        return (
            <ItemGroup description={t('teams.credentials.forbidden')}>
                <Item
                    testID="team-credential-activity-forbidden"
                    title={t('teams.denied.title')}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    if (view.resource === null) {
        if (view.error) {
            return (
                <ItemGroup description={t('teams.unavailable.offline')}>
                    <Item
                        testID="team-credential-activity-resource-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void view.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item
                    testID="team-credential-activity-loading"
                    title={t('teams.credentials.activity.title')}
                    loading
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    return (
        <>
            {activity.status === 'loading' && activity.rows.length === 0 ? (
                <ItemGroup>
                    <Item
                        testID="team-credential-activity-loading"
                        title={t('teams.credentials.activity.title')}
                        loading
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {activity.rows.length === 0 && activity.status === 'ready' ? (
                <ItemGroup description={t('teams.credentials.activity.empty')}>
                    <Item
                        testID="team-credential-activity-empty"
                        title={t('teams.credentials.activity.title')}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {activity.rows.length > 0 ? (
                // The page is titled Activity; the list is titled by the credential it is about (its newest
                // name), so a row names its subject only when that is something else: an external key, or
                // the credential under a name it had before.
                <ItemGroup surface="none" title={credentialName ?? undefined}>
                    <CollectionRows>
                    {activity.rows.map((event, index) => {
                        const key = `${event.createdAt}:${index}`;
                        const opened = openedActivityDisplayNames[key] ?? t('common.unavailable');
                        const subjectDisplayName = isExternalKeyActivity(event) || opened !== credentialName ? opened : null;
                        return <Item
                            // The history has no event identity of its own, so the
                            // position in the sequence is the only stable key; the
                            // sequence is append-only and never reordered.
                            key={key}
                            testID={`team-credential-activity-row:${index}`}
                            title={activityKindLabel(event.kind)}
                            subtitle={[
                                event.actorDisplayName ?? t('teams.credentials.activity.unknownActor'),
                                subjectDisplayName,
                            ].filter((part): part is string => part !== null).join(' · ')}
                            detail={formatShortRelativeTime(Date.parse(event.createdAt))}
                            showChevron={false}
                        />;
                    })}
                    </CollectionRows>
                </ItemGroup>
            ) : null}

            {/* Pages already read stay on screen through a failure. */}
            {activity.error ? (
                <ItemGroup description={t('teams.unavailable.offline')}>
                    <Item
                        testID="team-credential-activity-retry"
                        title={t('teams.unavailable.retry')}
                        // A failed continuation retains its exact cursor and
                        // rows; retry that page rather than resetting the
                        // administrative history to page one.
                        onPress={() => void (activity.rows.length > 0
                            ? activity.loadMore()
                            : activity.reload())}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : activity.hasMore && activity.rows.length > 0 ? (
                <ItemGroup>
                    <Item
                        testID="team-credential-activity-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={activity.status === 'loading_more'}
                        disabled={activity.status === 'loading_more'}
                        onPress={() => void activity.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {view.error ? (
                <ItemGroup description={t('teams.unavailable.offline')}>
                    <Item
                        testID="team-credential-activity-resource-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void view.reload()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

export const TeamCredentialActivityScreen = React.memo(function TeamCredentialActivityScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    resourceId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.credentials.activity.title')}
            description={t('teams.pages.credentialActivity')}
        >
            {(context) => <CredentialActivity context={context} resourceId={props.resourceId} />}
        </TeamSection>
    );
});

import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { getPreferredLanguage, t } from '@/text';

import { CredentialRow, mayOfferCredential } from '../credentials/TeamCredentialsScreen';
import { useTeamCredentialsProjection } from '../credentials/useTeamCredentialsProjection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamCredentialsPath } from '../teamsRoutes';

/**
 * L5 Keys: the keys this Team shares, read through the Team credentials owner and drawn with its own row, each
 * opening that key's page. Names only: no value passes through this page.
 */
export function TeamNewMembersKeys(props: Readonly<{ context: TeamSectionContext }>) {
    const { context } = props;
    const router = useRouter();
    const { featureEnabled, projection, rows, displayNames, recipientPending, settled, retry } = useTeamCredentialsProjection(context);
    if (!featureEnabled) return null;
    const loading = (projection.status === 'loading' || recipientPending) && rows.length === 0;
    const offer = mayOfferCredential(projection.viewer, context);
    return (
        <ItemGroup
            testID="team-new-members-keys"
            title={t('teams.newMembers.keys.title')}
            description={t('teams.newMembers.keys.description', { team: context.team.name })}
            action={offer ? (
                <SectionActionButton
                    testID="team-new-members-keys-share"
                    icon="plus"
                    title={t('teams.newMembers.keys.share')}
                    onPress={() => router.push(teamCredentialsPath(context.address) as never)}
                />
            ) : undefined}
        >
            {loading ? (
                <ItemLoadStateRows testID="team-new-members-keys-loading" state={{ kind: 'loading' }} rows={2} lines={2} />
            ) : projection.error && rows.length === 0 ? (
                <ItemLoadStateRows
                    testID="team-new-members-keys-failed"
                    state={{ kind: 'failed', reason: t('teams.unavailable.offline'), onRetry: () => void retry() }}
                />
            ) : rows.length === 0 && settled ? (
                <SurfaceStateCard
                    testID="team-new-members-keys-empty"
                    kind="empty"
                    size="line"
                    title={t('teams.newMembers.keys.emptyTitle')}
                    reason={t('teams.newMembers.keys.emptyBody', { team: context.team.name })}
                />
            ) : rows.map((resource) => (
                <CredentialRow
                    key={resource.id}
                    address={context.address}
                    resource={resource}
                    displayName={displayNames[resource.id] ?? null}
                    language={getPreferredLanguage()}
                    sharedState={null}
                />
            ))}
        </ItemGroup>
    );
}

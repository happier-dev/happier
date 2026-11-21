import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ProjectSourceListItemV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { getPreferredLanguage, t } from '@/text';

import { CredentialRow, mayOfferCredential } from '../credentials/TeamCredentialsScreen';
import { useTeamCredentialsProjection } from '../credentials/useTeamCredentialsProjection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamCredentialsPath } from '../teamsRoutes';
import { useSourceSetupRequirementNames } from './useSourceSetupRequirementNames';

type KeySource = Pick<ProjectSourceListItemV1, 'id' | 'revision' | 'name'>;
const NO_SOURCES: readonly KeySource[] = Object.freeze([]);

/**
 * L5 Keys: the key names the listed repositories' published setup needs, then the keys this Team shares. Names come
 * from the Source owner's setup-requirements read, one per Source shown; shared keys come from the Team credentials
 * owner and open their own page. Names only: no value passes through this page.
 */
export function TeamNewMembersKeys(props: Readonly<{ context: TeamSectionContext; sources?: readonly KeySource[] }>) {
    const { context } = props;
    const sources = props.sources ?? NO_SOURCES;
    const router = useRouter();
    const { theme } = useUnistyles();
    const { featureEnabled, projection, rows, displayNames, recipientPending, settled, retry } = useTeamCredentialsProjection(context);
    const requirements = useSourceSetupRequirementNames(context.scope, sources, true);
    const needed = React.useMemo(() => {
        const byName = new Map<string, string[]>();
        const failed: string[] = [];
        let pending = false;
        for (const source of sources) {
            const entry = requirements.entries.get(source.id);
            const read = entry?.revision === source.revision ? entry.read : null;
            if (!read || read.status === 'loading') { pending = true; continue; }
            if (read.status === 'failed') { failed.push(source.name); continue; }
            for (const name of read.names) byName.set(name, [...(byName.get(name) ?? []), source.name]);
        }
        return { rows: [...byName].map(([name, usedBy]) => ({ name, usedBy })), failed, pending };
    }, [requirements.entries, sources]);

    const credentialRows = featureEnabled ? rows : [];
    const credentialsLoading = featureEnabled && (projection.status === 'loading' || recipientPending);
    const nothingShown = credentialRows.length === 0 && needed.rows.length === 0;
    if (!featureEnabled && nothingShown && !needed.pending && needed.failed.length === 0) return null;
    const loading = nothingShown && (credentialsLoading || needed.pending);
    const credentialsFailed = featureEnabled && projection.error && credentialRows.length === 0;
    const offer = featureEnabled && mayOfferCredential(projection.viewer, context);
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
            {needed.rows.map((requirement) => (
                <Item
                    key={`requirement:${requirement.name}`}
                    testID={`team-new-members-key-requirement:${requirement.name}`}
                    icon={<Icon name="key" size={20} color={theme.colors.text.secondary} />}
                    title={requirement.name}
                    subtitle={t('teams.newMembers.keys.usedBy', { sources: requirement.usedBy.join(', ') })}
                    showChevron={false}
                />
            ))}
            {needed.failed.length > 0 ? (
                <ItemLoadStateRows
                    testID="team-new-members-keys-requirements-failed"
                    state={{
                        kind: 'failed',
                        reason: t('teams.newMembers.keys.requirementsFailed', { sources: needed.failed.join(', ') }),
                        onRetry: requirements.retry,
                    }}
                />
            ) : null}
            {loading ? (
                <ItemLoadStateRows testID="team-new-members-keys-loading" state={{ kind: 'loading' }} rows={2} lines={2} />
            ) : credentialsFailed ? (
                <ItemLoadStateRows
                    testID="team-new-members-keys-failed"
                    state={{ kind: 'failed', reason: t('teams.unavailable.offline'), onRetry: () => void retry() }}
                />
            ) : nothingShown && needed.failed.length === 0 && (settled || !featureEnabled) ? (
                <SurfaceStateCard
                    testID="team-new-members-keys-empty"
                    kind="empty"
                    size="line"
                    title={t('teams.newMembers.keys.emptyTitle')}
                    reason={t('teams.newMembers.keys.emptyBody', { team: context.team.name })}
                />
            ) : credentialRows.map((resource) => (
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

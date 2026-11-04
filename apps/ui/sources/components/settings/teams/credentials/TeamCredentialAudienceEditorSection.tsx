import * as React from 'react';
import type { TeamCredentialRouteV1, TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { deliveryModeLabel } from './teamCredentialPresentation';
import { TeamCredentialAudiencePicker } from './TeamCredentialAudiencePicker';
import {
    offeredDeliveryModes,
    TeamCredentialDeliveryModeChooser,
    withAudienceEntry,
    type TeamCredentialResourceDraft,
} from './teamCredentialEditorDraft';

const PRINCIPAL_AVATAR_SIZE = 32;

export const TeamCredentialAudienceEditorSection = React.memo(function TeamCredentialAudienceEditorSection(props: Readonly<{
    context: TeamSectionContext;
    resource: TeamCredentialResourceSummaryV1;
    draft: TeamCredentialResourceDraft;
    busy: boolean;
    onRequestDraftChange: (nextDraft: TeamCredentialResourceDraft) => void;
}>) {
    const { context, resource, draft, busy, onRequestDraftChange } = props;
    const [expanded, setExpanded] = React.useState<string | null>(null);
    const [pickedNames, setPickedNames] = React.useState<ReadonlyMap<string, string>>(() => new Map());
    const targetKey = `${context.scope.serverId}:${context.scope.accountId}:${context.address.teamId}:${resource.id}`;

    React.useEffect(() => {
        setExpanded(null);
        setPickedNames(new Map());
    }, [targetKey]);

    const groups = useTeamGroups({
        scope: context.scope,
        address: context.address,
        archived: 'active',
        enabled: true,
    });
    const members = useTeamMembersRoster({
        scope: context.scope,
        address: context.address,
        filter: 'all',
        enabled: true,
    });
    const modes = offeredDeliveryModes({
        deliveryPolicy: draft.deliveryPolicy,
        directExportSupport: resource.directExportSupport,
    });
    const savedGroupIds = React.useMemo(
        () => resource.groupGrants.map((grant) => grant.teamGroupId),
        [resource.groupGrants],
    );
    const savedMemberIds = React.useMemo(
        () => resource.memberGrants.map((grant) => grant.teamMembershipId),
        [resource.memberGrants],
    );
    const selectedGroupIds = React.useMemo(
        () => [...new Set([...savedGroupIds, ...draft.audience.groups.keys()])],
        [draft.audience.groups, savedGroupIds],
    );
    const selectedMemberIds = React.useMemo(
        () => [...new Set([...savedMemberIds, ...draft.audience.members.keys()])],
        [draft.audience.members, savedMemberIds],
    );

    // A saved grant can point past the roster's first page. Continue the same
    // canonical paged directory until every selected subject has a display row,
    // preserving the grant while the next page is loading.
    React.useEffect(() => {
        if (groups.status !== 'loading_more'
            && groups.hasMore
            && selectedGroupIds.some((groupId) => !groups.rows.some((row) => row.id === groupId))) {
            void groups.loadMore();
        }
    }, [groups.hasMore, groups.loadMore, groups.rows, groups.status, selectedGroupIds]);
    React.useEffect(() => {
        if (members.status !== 'loading_more'
            && members.hasMore
            && selectedMemberIds.some((membershipId) => !members.rows.some((row) => row.id === membershipId))) {
            void members.loadMore();
        }
    }, [members.hasMore, members.loadMore, members.rows, members.status, selectedMemberIds]);
    const groupPrincipals = selectedGroupIds;
    const memberPrincipals = selectedMemberIds;

    const requestAudienceChange = (audience: TeamCredentialResourceDraft['audience']) => {
        onRequestDraftChange({ ...draft, audience });
    };
    const renderChooser = (
        principalKey: string,
        principalName: string,
        currentMode: readonly TeamCredentialRouteV1[] | null,
        apply: (mode: readonly TeamCredentialRouteV1[] | null) => void,
    ) => expanded !== principalKey ? null : (
        <TeamCredentialDeliveryModeChooser
            principalKey={principalKey}
            principalName={principalName}
            modes={modes}
            current={currentMode}
            disabled={busy}
            onChoose={(mode) => {
                setExpanded(null);
                if (mode !== currentMode) apply(mode);
            }}
        />
    );

    return (
        <>
            <ItemGroup
                title={t('teams.credentials.audience.title')}
                description={draft.deliveryPolicy.preferredAllowedModes.length === 1 && draft.deliveryPolicy.preferredAllowedModes[0] === 'brokered'
                    ? t('teams.credentials.audience.ceilingBlocked')
                    : t('teams.credentials.audience.limitsNote')}
            >
                <Item
                    testID="team-credential-audience-everyone"
                    title={t('teams.credentials.audience.everyone')}
                    detail={draft.audience.allMembers === null
                        ? t('teams.credentials.audience.everyoneOff')
                        : deliveryModeLabel(draft.audience.allMembers)}
                    disabled={busy}
                    onPress={() => setExpanded((current) => current === 'everyone' ? null : 'everyone')}
                    showChevron={false}
                />
                {renderChooser(
                    'everyone',
                    t('teams.credentials.audience.everyone'),
                    draft.audience.allMembers,
                    (allMembers) => requestAudienceChange({ ...draft.audience, allMembers }),
                )}
            </ItemGroup>

            {groupPrincipals.length > 0 ? (
                <ItemGroup title={t('teams.credentials.audience.groupsSection')}>
                    {groupPrincipals.map((groupId) => {
                        const mode = draft.audience.groups.get(groupId) ?? null;
                        const group = groups.rows.find((row) => row.id === groupId);
                        const name = group?.name
                            ?? pickedNames.get(`group:${groupId}`)
                            ?? t('teams.credentials.limits.unknownSubject');
                        const key = `group:${groupId}`;
                        return (
                            <React.Fragment key={groupId}>
                                <Item
                                    testID={`team-credential-audience-group:${groupId}`}
                                    title={name}
                                    subtitle={group ? t('teams.groups.memberCount', { count: group.memberCount }) : undefined}
                                    detail={mode === null ? t('teams.credentials.audience.none') : deliveryModeLabel(mode)}
                                    accessibilityLabel={[name, mode === null ? t('teams.credentials.audience.none') : deliveryModeLabel(mode)].join(', ')}
                                    disabled={busy}
                                    onPress={() => setExpanded((current) => current === key ? null : key)}
                                    showChevron={false}
                                />
                                {renderChooser(key, name, mode, (next) => requestAudienceChange({
                                    ...draft.audience,
                                    groups: withAudienceEntry(draft.audience.groups, groupId, next),
                                }))}
                            </React.Fragment>
                        );
                    })}
                </ItemGroup>
            ) : null}

            {memberPrincipals.length > 0 ? (
                <ItemGroup title={t('teams.credentials.audience.membersSection')}>
                    {memberPrincipals.map((membershipId) => {
                        const mode = draft.audience.members.get(membershipId) ?? null;
                        const membership = members.rows.find((row) => row.id === membershipId);
                        const name = membership
                            ? formatAccountDisplayName(membership.account) ?? t('teams.credentials.limits.unknownSubject')
                            : pickedNames.get(`member:${membershipId}`) ?? t('teams.credentials.limits.unknownSubject');
                        const key = `member:${membershipId}`;
                        return (
                            <React.Fragment key={membershipId}>
                                <Item
                                    testID={`team-credential-audience-member:${membershipId}`}
                                    title={name}
                                    leftElement={membership ? (
                                        <Avatar id={membership.accountId} size={PRINCIPAL_AVATAR_SIZE} imageUrl={membership.account.avatarUrl} />
                                    ) : undefined}
                                    detail={mode === null ? t('teams.credentials.audience.none') : deliveryModeLabel(mode)}
                                    accessibilityLabel={[name, mode === null ? t('teams.credentials.audience.none') : deliveryModeLabel(mode)].join(', ')}
                                    disabled={busy}
                                    onPress={() => setExpanded((current) => current === key ? null : key)}
                                    showChevron={false}
                                />
                                {renderChooser(key, name, mode, (next) => requestAudienceChange({
                                    ...draft.audience,
                                    members: withAudienceEntry(draft.audience.members, membershipId, next),
                                }))}
                            </React.Fragment>
                        );
                    })}
                </ItemGroup>
            ) : null}

            <ItemGroup>
                <TeamCredentialAudiencePicker
                    testID="team-credential-audience-add"
                    scope={context.scope}
                    address={context.address}
                    excludedGroupIds={groupPrincipals}
                    excludedMemberIds={memberPrincipals}
                    disabled={busy || modes.length === 0 || draft.deliveryPolicy.preferredAllowedModes.includes('vendor-native')}
                    onChoose={(principal) => {
                        setPickedNames((names) => new Map(names).set(`${principal.kind}:${principal.id}`, principal.name));
                        requestAudienceChange(principal.kind === 'group'
                            ? { ...draft.audience, groups: withAudienceEntry(draft.audience.groups, principal.id, [...draft.deliveryPolicy.preferredAllowedModes]) }
                            : { ...draft.audience, members: withAudienceEntry(draft.audience.members, principal.id, [...draft.deliveryPolicy.preferredAllowedModes]) });
                        setExpanded(`${principal.kind}:${principal.id}`);
                    }}
                />
            </ItemGroup>
        </>
    );
});

import * as React from 'react';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { t, usePreferredLanguage } from '@/text';

import { teamViewerStandingLabel } from './teamLabels';
import type { TeamsDirectoryRow } from './teamsDirectoryViewState';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HAPPIER_COLLECTION_LIST_METRICS, HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

/** Fits the rail's mark box, so Team names align with the rest of the rail. */
const TEAM_RAIL_AVATAR_SIZE = 28;

/**
 * One Team in the directory.
 *
 * Identity is the Team's logo when it has one and the deterministic accent the
 * shared avatar owner derives from the immutable Team id otherwise — never from
 * the name, which is presentation and may legitimately be shared by two Teams.
 * The Home is shown only when more than one Home contributes, so a single-Home
 * user is not asked to read a qualifier that cannot disambiguate anything.
 */
export const TeamRow = React.memo(function TeamRow(props: Readonly<{
    row: TeamsDirectoryRow;
    showHome: boolean;
    onPress: (address: TeamAddress) => void;
    /** `rail`: the compact row of the Teams collection rail, selected while its Team is open. */
    variant?: 'page' | 'rail';
    selected?: boolean;
}>) {
    usePreferredLanguage();
    const { row } = props;
    const onPress = React.useCallback(() => props.onPress(row.address), [props.onPress, row.address]);
    const rail = props.variant === 'rail';
    const roleLabel = teamViewerStandingLabel(row.team) ?? '';
    // Active members, when the Home shares the count (a Home administrator gets totals without a
    // roster). The compact rail stays one fact: the viewer's role.
    const counts = row.team.counts;
    const memberCount = !rail && counts
        ? t('teams.groups.memberCount', { count: counts.members - counts.suspendedMembers })
        : '';
    const subtitle = [roleLabel, memberCount, props.showHome ? row.homeName : '']
        .filter((part) => part.length > 0)
        .join(' · ');

    return (
        <Item
            rowRole="catalogRow"
            testID={`teams-row:${row.address.serverId}:${row.address.teamId}`}
            title={row.team.name}
            subtitle={subtitle.length > 0 ? subtitle : undefined}
            accessibilityLabel={t('teams.directory.rowAccessibilityLabel', {
                name: row.team.name,
                role: roleLabel,
                home: row.homeName,
            })}
            {...(rail ? {
                icon: (
                    <HappierCollectionListMark rowRole="catalogRow">
                        <Avatar
                            id={row.address.teamId}
                            monogram={row.team.name}
                            square
                            size={TEAM_RAIL_AVATAR_SIZE}
                            imageUrl={row.team.logo?.url ?? null}
                            thumbhash={row.team.logo?.thumbhash ?? null}
                        />
                    </HappierCollectionListMark>
                ),
                selected: props.selected === true,
                density: 'compact' as const,
                showChevron: false,
                pressableStyle: collectionListStyles.row,
            } : {
                leftElement: (
                    <Avatar
                        id={row.address.teamId}
                        monogram={row.team.name}
                        square
                        size={HAPPIER_COLLECTION_LIST_METRICS.catalogRow.identityMarkPx}
                        imageUrl={row.team.logo?.url ?? null}
                        thumbhash={row.team.logo?.thumbhash ?? null}
                    />
                ),
            })}
            // An archived Team is listed under the collection's "Archived" heading, rail and page alike,
            // so the row repeats nothing: a pill beside the name only squeezed it.
            onPress={onPress}
        />
    );
});

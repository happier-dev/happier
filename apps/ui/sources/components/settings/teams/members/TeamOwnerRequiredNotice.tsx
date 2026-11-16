import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';

/**
 * The one governance notice for a Team left without an active owner.
 *
 * `recovery.kind === 'owner_required'` is the Home's own condition, published on the Team
 * projection, so no surface counts owners for itself. The notice is a statement
 * of that condition and is therefore shown to every viewer the Home answers;
 * who may begin recovery stays with `recovery.canAppointOwner`. The roster's
 * per-membership `setRole` capability independently decides which existing
 * member is an eligible candidate; neither projection stands in for the other.
 *
 * It deliberately promises nothing about content: a Home administrator
 * restoring an owner gains no access to the Team's sessions, and the copy says
 * only what the Team needs.
 *
 * The notice lives in one component and mounts on both the Team overview and
 * the roster: the overview routes to the roster where candidates actually are,
 * and the roster explains, once it has read the whole sequence, when there is
 * no eligible candidate at all.
 */
export const TeamOwnerRequiredNotice = React.memo(function TeamOwnerRequiredNotice(props: Readonly<{
    context: TeamSectionContext;
    /** Routes to the roster. Absent once the roster itself is what is open. */
    onChooseOwner?: () => void;
    /**
     * The open roster has read every page and none of its rows may be promoted.
     * Only that proof turns the notice into the "no candidate" explanation; a
     * partially read roster says nothing about the members it has not seen.
     */
    noCandidate?: boolean;
}>) {
    const { context } = props;

    if (context.team.recovery?.kind !== 'owner_required' || !context.team.capabilities.viewTeam) return null;

    return (
        <AttentionBanner
            testID="team-owner-required"
            title={t('teams.members.ownerRequiredTitle')}
            description={props.noCandidate === true
                ? t('teams.members.ownerRequiredNoCandidate')
                : t('teams.members.ownerRequiredBody')}
            accessibilityLiveRegion="polite"
            action={context.team.recovery.canAppointOwner && props.onChooseOwner && props.noCandidate !== true ? {
                label: t('teams.members.chooseOwner'),
                onPress: props.onChooseOwner,
                testID: 'team-owner-required-choose',
            } : null}
        />
    );
});

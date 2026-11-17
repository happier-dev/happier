import type {
    SessionHistoryAccessV1,
    TeamAdmissionModeV1,
    TeamExternalSharingPolicyV1,
    TeamPolicyV1,
    TeamSessionCreationPolicyV1,
} from '@happier-dev/protocol/teams';

import type { SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

/**
 * The words for a Team's sharing policy, shared by the Settings page that changes it and the
 * Overview row that summarizes it, so the two can never name the same choice differently.
 */
export type TeamPolicyField = Readonly<{
    sessionCreationPolicy: TeamSessionCreationPolicyV1;
    externalSharingPolicy: TeamExternalSharingPolicyV1;
    defaultSessionHistoryAccess: SessionHistoryAccessV1;
}>;

/** Short segment labels; the row's line beneath says what the chosen one means. */
export function sessionCreationLabel(policy: TeamSessionCreationPolicyV1): string {
    switch (policy) {
        case 'private_default':
            return t('teams.settings.option.private');
        case 'team_default':
            return t('teams.settings.option.shared');
        case 'team_required':
            return t('teams.settings.option.alwaysShared');
    }
}

export function externalSharingLabel(policy: TeamExternalSharingPolicyV1): string {
    switch (policy) {
        case 'allowed':
            return t('teams.settings.option.anyone');
        case 'team_admins_only':
            return t('teams.settings.option.admins');
        case 'disabled':
            return t('teams.settings.option.nobody');
    }
}

export function historyLabel(access: SessionHistoryAccessV1): string {
    return access === 'all_existing'
        ? t('teams.settings.option.earlierToo')
        : t('teams.settings.option.fromJoining');
}

export function sessionCreationConsequence(policy: TeamSessionCreationPolicyV1): string {
    switch (policy) {
        case 'private_default':
            return t('teams.settings.consequence.sessionsPrivate');
        case 'team_default':
            return t('teams.settings.consequence.sessionsShared');
        case 'team_required':
            return t('teams.settings.consequence.sessionsAlwaysShared');
    }
}

export function externalSharingConsequence(policy: TeamExternalSharingPolicyV1): string {
    switch (policy) {
        case 'allowed':
            return t('teams.settings.consequence.outsideAnyone');
        case 'team_admins_only':
            return t('teams.settings.consequence.outsideAdmins');
        case 'disabled':
            return t('teams.settings.consequence.outsideNobody');
    }
}

/** Whose shared sessions the history choice opens: the Team's, or one Group's within it. */
export type SessionHistoryAudience = 'team' | 'group';

export function historyConsequence(access: SessionHistoryAccessV1, audience: SessionHistoryAudience = 'team'): string {
    if (audience === 'group') {
        return access === 'all_existing'
            ? t('teams.settings.consequence.groupHistoryEarlier')
            : t('teams.settings.consequence.groupHistoryFromJoining');
    }
    return access === 'all_existing'
        ? t('teams.settings.consequence.historyEarlier')
        : t('teams.settings.consequence.historyFromJoining');
}

const SESSION_HISTORY_ACCESS_ORDER: readonly SessionHistoryAccessV1[] = Object.freeze(['from_membership', 'all_existing']);

/**
 * The one Session-history choice: "From joining | Earlier too" with what the chosen one means
 * beneath it. Team Settings (the default for new members), Add member, Invitation create and a
 * Group's add all decide this same fact, so they draw it from here through `SegmentedChoiceItem`.
 */
export function sessionHistoryChoiceOptions(audience: SessionHistoryAudience = 'team'): ReadonlyArray<SegmentedChoiceOption<SessionHistoryAccessV1>> {
    return SESSION_HISTORY_ACCESS_ORDER.map((access) => ({
        id: access,
        label: historyLabel(access),
        description: historyConsequence(access, audience),
    }));
}

/** How people become members, in words: the one label for an admission mode wherever it is named. */
export function teamAdmissionModeLabel(mode: TeamAdmissionModeV1): string {
    switch (mode) {
        case 'invite_only':
            return t('teams.authentication.policy.admissionInviteOnly');
        case 'provisioned':
            return t('teams.authentication.policy.admissionProvisioned');
        case 'jit':
            return t('teams.authentication.policy.admissionJit');
    }
}

/**
 * The mode's name as a segment of the "New members" choice: short enough that the three options sit
 * on one line on a phone. Elsewhere the mode reads as a fact, through `teamAdmissionModeLabel`.
 */
export function teamAdmissionModeSegmentLabel(mode: TeamAdmissionModeV1): string {
    switch (mode) {
        case 'invite_only':
            return t('teams.authentication.policy.admissionSegment.inviteOnly');
        case 'provisioned':
            return t('teams.authentication.policy.admissionSegment.provisioned');
        case 'jit':
            return t('teams.authentication.policy.admissionSegment.jit');
    }
}

/** What the selected new-member mode does, shared wherever the admission choice is presented. */
export function teamAdmissionModeConsequence(mode: TeamAdmissionModeV1): string {
    switch (mode) {
        case 'invite_only': return t('teams.authentication.policy.admissionInviteOnlyDescription');
        case 'provisioned': return t('teams.authentication.policy.admissionProvisionedDescription');
        case 'jit': return t('teams.authentication.policy.admissionJitDescription');
    }
}

/** What sign-in the Team accepts, as one fact: the Home's, its own chosen set, or a rule that needs repair. The page already names the Home. */
export function teamAcceptedSignInSummary(policy: TeamPolicyV1): string {
    if (policy.authenticationPolicyStatus === 'repair_required') return t('teams.overview.summary.signInNeedsRepair');
    return policy.authenticationPolicy?.mode === 'restricted'
        ? t('teams.overview.summary.chosenSignIn')
        : t('teams.overview.summary.homeSignIn');
}

import type {
    SessionHistoryAccessV1,
    TeamAdmissionModeV1,
    TeamExternalSharingPolicyV1,
    TeamPolicyV1,
    TeamSessionCreationPolicyV1,
} from '@happier-dev/protocol/teams';

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

export function sessionCreationConsequence(policy: TeamSessionCreationPolicyV1, team: string): string {
    switch (policy) {
        case 'private_default':
            return t('teams.settings.consequence.sessionsPrivate', { team });
        case 'team_default':
            return t('teams.settings.consequence.sessionsShared', { team });
        case 'team_required':
            return t('teams.settings.consequence.sessionsAlwaysShared', { team });
    }
}

export function externalSharingConsequence(policy: TeamExternalSharingPolicyV1, team: string): string {
    switch (policy) {
        case 'allowed':
            return t('teams.settings.consequence.outsideAnyone', { team });
        case 'team_admins_only':
            return t('teams.settings.consequence.outsideAdmins', { team });
        case 'disabled':
            return t('teams.settings.consequence.outsideNobody', { team });
    }
}

export function historyConsequence(access: SessionHistoryAccessV1, team: string): string {
    return access === 'all_existing'
        ? t('teams.settings.consequence.historyEarlier', { team })
        : t('teams.settings.consequence.historyFromJoining', { team });
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

/** What sign-in the Team accepts, as one fact: the Home's, its own chosen set, or a rule that needs repair. */
export function teamAcceptedSignInSummary(policy: TeamPolicyV1, homeName: string): string {
    if (policy.authenticationPolicyStatus === 'repair_required') return t('teams.overview.summary.signInNeedsRepair');
    return policy.authenticationPolicy?.mode === 'restricted'
        ? t('teams.overview.summary.chosenSignIn')
        : t('teams.overview.summary.homeSignIn', { home: homeName });
}

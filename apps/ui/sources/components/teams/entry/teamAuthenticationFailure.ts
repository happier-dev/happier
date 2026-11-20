import type { TeamEntryUnavailableReasonV1 } from '@happier-dev/protocol/auth/entry';

import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * The typed Team outcomes an OAuth finalize can answer with instead of a
 * credential. They are decided by the Home's admission and provider owners;
 * this module only owns the child 02 §10 presentation for them, so the OAuth
 * return route never collapses a Team answer into a generic Home alert.
 */
const TEAM_AUTHENTICATION_FAILURE_CODES = [
    'team_authentication_required',
    'team_authentication_unavailable',
    'auth_provider_configuration_changed',
] as const;

export type TeamAuthenticationFailureCode = typeof TEAM_AUTHENTICATION_FAILURE_CODES[number];

export function isTeamAuthenticationFailureCode(value: unknown): value is TeamAuthenticationFailureCode {
    return typeof value === 'string'
        && (TEAM_AUTHENTICATION_FAILURE_CODES as readonly string[]).includes(value);
}

export type TeamAuthenticationFailurePresentation = Readonly<{
    kind: 'unavailable' | 'warning';
    title: string;
    body: string;
    /** The mark the answer stands under when it is a page of its own: which dead end it is, at a glance. */
    glyph: IconName;
}>;

export function presentTeamAuthenticationFailure(
    code: TeamAuthenticationFailureCode,
): TeamAuthenticationFailurePresentation {
    switch (code) {
        case 'team_authentication_required':
            // The identity was proven but the Team's admission rules did not
            // admit it; only its administrator can change that answer.
            return {
                kind: 'unavailable',
                title: t('teams.entry.notProvisionedTitle'),
                body: t('teams.entry.notProvisionedBody'),
                glyph: 'users',
            };
        case 'team_authentication_unavailable':
            return {
                kind: 'unavailable',
                title: t('teams.entry.accessRemovedTitle'),
                body: t('teams.entry.accessRemovedBody'),
                glyph: 'x-circle',
            };
        case 'auth_provider_configuration_changed':
            // The provider binding moved under the attempt; the Team page
            // re-reads the projection and offers whatever is valid now.
            return {
                kind: 'warning',
                title: t('teams.entry.providerChangedTitle'),
                body: t('teams.entry.providerChangedBody'),
                glyph: 'arrows-clockwise',
            };
    }
}

/**
 * The presentation for a reachable, current Home that has Teams turned off.
 *
 * The Home's entry projection deliberately does not enumerate this (its
 * `entry_not_available` reveals nothing), while its own invitation preview
 * declares `feature_unavailable` outright. One owner states that fact so the
 * join surface and the preview details cannot describe it differently, and so
 * an operator-disabled Home never reads as "this Team does not exist".
 */
export function presentTeamsDisabledOnHome(): TeamAuthenticationFailurePresentation {
    return {
        kind: 'unavailable',
        title: t('teams.unavailable.title'),
        body: t('teams.unavailable.disabled'),
        glyph: 'users',
    };
}

/**
 * The §10 presentation for a Team or invitation destination the Home answered
 * `unavailable`. `entry_not_available` is the Home's deliberate non-enumerating
 * answer and returns `null` so the destination keeps its opaque "not found"
 * card; every other reason is only sent to a request that may already see the
 * destination, so it names what to do next.
 */
export function presentTeamEntryUnavailableReason(
    reason: TeamEntryUnavailableReasonV1,
): TeamAuthenticationFailurePresentation | null {
    switch (reason) {
        case 'entry_not_available':
            return null;
        case 'sso_required':
            return {
                kind: 'unavailable',
                title: t('teams.entry.ssoRequiredTitle'),
                body: t('teams.entry.ssoRequiredBody'),
                glyph: 'key',
            };
        case 'wrong_account':
            return {
                kind: 'unavailable',
                title: t('teams.entry.wrongAccountTitle'),
                body: t('teams.entry.wrongAccountBody'),
                glyph: 'users',
            };
        case 'directory_delayed':
            // Access is expected to arrive from an upstream directory, so this
            // is a wait-and-retry state rather than a refusal.
            return {
                kind: 'warning',
                title: t('teams.entry.directoryDelayedTitle'),
                body: t('teams.entry.directoryDelayedBody'),
                glyph: 'clock',
            };
        case 'invitation_unavailable':
            return {
                kind: 'unavailable',
                title: t('teams.entry.invitationUnavailableTitle'),
                body: t('teams.entry.invitationUnavailableBody'),
                glyph: 'link',
            };
    }
}

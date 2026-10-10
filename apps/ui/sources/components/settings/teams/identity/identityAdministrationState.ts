import type {
    TeamAdmissionModeApplicabilityV1,
    TeamIdentityEligibleProviderV1,
} from '@happier-dev/protocol/teams';

import { sortIdentityConnectionsForAdministration } from './identityAdministrationPresentation';
import type { ScopedIdentityConnectionV1 } from './identityAdministrationClient';

export type IdentityAdministrationFailure = Readonly<{
    code: string;
    retryable: boolean;
}>;

export type IdentityAdministrationState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; failure: IdentityAdministrationFailure }>
    | Readonly<{
        kind: 'ready';
        items: readonly ScopedIdentityConnectionV1[];
        eligibleProviders: readonly TeamIdentityEligibleProviderV1[];
        admissionModeApplicability: TeamAdmissionModeApplicabilityV1 | null;
        /** The Home's rendered member sign-in link, or null when it publishes none. */
        memberSignInUrl: string | null;
        refreshing: boolean;
        stale: boolean;
        failure: IdentityAdministrationFailure | null;
    }>;

export type IdentityAdministrationLoadResult =
    | Readonly<{
        ok: true;
        items: readonly ScopedIdentityConnectionV1[];
        eligibleProviders: readonly TeamIdentityEligibleProviderV1[];
        admissionModeApplicability: TeamAdmissionModeApplicabilityV1 | null;
        memberSignInUrl: string | null;
    }>
    | Readonly<{ ok: false; failure: IdentityAdministrationFailure }>;

export const INITIAL_IDENTITY_ADMINISTRATION_STATE: IdentityAdministrationState = Object.freeze({
    kind: 'loading' as const,
});

export function beginIdentityAdministrationRefresh(
    state: IdentityAdministrationState,
): IdentityAdministrationState {
    return state.kind === 'ready'
        ? Object.freeze({ ...state, refreshing: true })
        : INITIAL_IDENTITY_ADMINISTRATION_STATE;
}

export function settleIdentityAdministrationRefresh(
    state: IdentityAdministrationState,
    result: IdentityAdministrationLoadResult,
): IdentityAdministrationState {
    if (!result.ok) {
        if (state.kind === 'ready') {
            return Object.freeze({
                ...state,
                refreshing: false,
                stale: true,
                failure: result.failure,
            });
        }
        return Object.freeze({ kind: 'unavailable' as const, failure: result.failure });
    }
    return Object.freeze({
        kind: 'ready' as const,
        items: sortIdentityConnectionsForAdministration(result.items),
        eligibleProviders: Object.freeze([...result.eligibleProviders]),
        admissionModeApplicability: result.admissionModeApplicability,
        memberSignInUrl: result.memberSignInUrl,
        refreshing: false,
        stale: false,
        failure: null,
    });
}

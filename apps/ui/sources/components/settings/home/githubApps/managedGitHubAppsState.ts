import type {
    ManagedGitHubAppInstallationV1,
    ManagedGitHubAppRegistrationV1,
    ManagedGitHubAppsListOutputV1,
} from '@happier-dev/protocol/identity/githubApps';

import type { ManagedGitHubAppsActionResult } from './managedGitHubAppsClient';

export type ManagedGitHubAppsState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable'; failure: Readonly<{ code: string; retryable: boolean }> }>
    | Readonly<{
        kind: 'ready';
        registrations: readonly ManagedGitHubAppRegistrationV1[];
        installations: readonly ManagedGitHubAppInstallationV1[];
        refreshing: boolean;
        stale: boolean;
        failure: Readonly<{ code: string; retryable: boolean }> | null;
    }>;

export const INITIAL_MANAGED_GITHUB_APPS_STATE: ManagedGitHubAppsState = Object.freeze({ kind: 'loading' as const });

export function beginManagedGitHubAppsRefresh(state: ManagedGitHubAppsState): ManagedGitHubAppsState {
    return state.kind === 'ready' ? Object.freeze({ ...state, refreshing: true }) : INITIAL_MANAGED_GITHUB_APPS_STATE;
}

export function settleManagedGitHubAppsRefresh(
    state: ManagedGitHubAppsState,
    result: ManagedGitHubAppsActionResult<ManagedGitHubAppsListOutputV1>,
): ManagedGitHubAppsState {
    if (result.kind !== 'succeeded') {
        const failure = result.kind === 'failed'
            ? result.failure
            : { code: 'invalid_action_output', retryable: false };
        return state.kind === 'ready'
            ? Object.freeze({ ...state, refreshing: false, stale: true, failure })
            : Object.freeze({ kind: 'unavailable' as const, failure });
    }
    return Object.freeze({
        kind: 'ready' as const,
        registrations: Object.freeze([...result.value.registrations].sort((left, right) => (
            (left.githubAppSlug ?? left.githubOwnerLogin ?? left.githubHost).localeCompare(
                right.githubAppSlug ?? right.githubOwnerLogin ?? right.githubHost,
            ) || left.id.localeCompare(right.id)
        ))),
        installations: Object.freeze([...result.value.installations]),
        refreshing: false,
        stale: false,
        failure: null,
    });
}

import * as React from 'react';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import type { ManagedGitHubAppOwnerV1 } from '@happier-dev/protocol/identity/githubApps';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
    isHomeAdministrationAccountChange,
    subscribeHomeAccountChange,
} from '@/sync/runtime/orchestration/homeAccountChange';

import { createManagedGitHubAppsClient } from './managedGitHubAppsClient';
import {
    beginManagedGitHubAppsRefresh,
    INITIAL_MANAGED_GITHUB_APPS_STATE,
    settleManagedGitHubAppsRefresh,
    type ManagedGitHubAppsState,
} from './managedGitHubAppsState';

export const HOME_GITHUB_APP_OWNER: ManagedGitHubAppOwnerV1 = Object.freeze({ kind: 'home' });

export function useManagedGitHubAppsClient(scope: ServerAccountScope) {
    return React.useMemo(() => createManagedGitHubAppsClient(scope), [scope.accountId, scope.serverId]);
}

/**
 * The registrations one owner may administer on one Home.
 *
 * Owner is a parameter rather than a fixed Home because a Team-owned App is the
 * same record read through the same Action; giving the Team its own hook would
 * be a second reader of one list.
 */
export function useManagedGitHubApps(
    scope: ServerAccountScope,
    owner: ManagedGitHubAppOwnerV1 = HOME_GITHUB_APP_OWNER,
): Readonly<{
    state: ManagedGitHubAppsState;
    refresh: () => void;
}> {
    const client = useManagedGitHubAppsClient(scope);
    const [state, setState] = React.useState(INITIAL_MANAGED_GITHUB_APPS_STATE);
    const [generation, setGeneration] = React.useState(0);
    // The owner travels as a value; only its identity should restart the read.
    const ownerKey = owner.kind === 'home' ? 'home' : `team:${owner.teamId}`;
    const ownerRef = React.useRef(owner);
    ownerRef.current = owner;
    React.useEffect(() => {
        const controller = new AbortController();
        setState((current) => beginManagedGitHubAppsRefresh(current));
        void client.execute('identity.githubApps.list', { owner: ownerRef.current }, { signal: controller.signal })
            .then((result) => {
                if (!controller.signal.aborted) setState((current) => settleManagedGitHubAppsRefresh(current, result));
            });
        return () => controller.abort();
    }, [client, generation, ownerKey]);
    const refresh = React.useCallback(() => setGeneration((value) => value + 1), []);
    React.useEffect(() => subscribeHomeAccountChange((event) => {
        if (event.serverId !== scope.serverId) return;
        const shouldRefresh = ownerRef.current.kind === 'home'
            ? isHomeAdministrationAccountChange(event)
                || (event.entityIds?.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1) ?? false)
            : event.entityIds === undefined || event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1);
        if (shouldRefresh) refresh();
    }), [refresh, scope.serverId]);
    return React.useMemo(() => ({ state, refresh }), [refresh, state]);
}

import * as React from 'react';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/** One consumed preference key; a non-focused Home still reads its own Account owner. */
export function useDeploymentAccountDefaults(lifetime: ServerAccountScopeLifetime | null) {
    const [value, setValue] = React.useState<Readonly<{ lifetime: ServerAccountScopeLifetime; preferences: DeploymentCreationDefaultsV1 }> | null>(null);
    const [error, setError] = React.useState<unknown>(null);
    const [retry, setRetry] = React.useState(0);
    React.useEffect(() => {
        setError(null);
        if (!lifetime) return;
        const cancellation = new AbortController();
        const retired = lifetime.onRetire(() => cancellation.abort());
        const store = getStorage();
        const read = async () => {
            let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
            try {
                account = await captureLazyActionAccountContext(lifetime.scope.serverId, cancellation.signal);
                if (account.accountId !== lifetime.scope.accountId || !lifetime.isCurrent()) return;
                const preferences = (await account.readSettings()).deploymentDefaultsV1;
                if (!cancellation.signal.aborted) { setValue({ lifetime, preferences }); setError(null); }
            } catch (failure) { if (!cancellation.signal.aborted) setError(failure); }
            finally { account?.dispose(); }
        };
        const stopStore = store.subscribe(() => {
            const state = store.getState();
            if (areServerAccountScopesEqual(state.settingsScope, lifetime.scope)) {
                setValue({ lifetime, preferences: state.settings.deploymentDefaultsV1 });
            }
        }, { settings: ['deploymentDefaultsV1'], settingsScope: true });
        const stopHome = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)
                && event.accountSettingsAffects !== false) void read();
        }, { serverIds: [lifetime.scope.serverId], reconnect: 'refresh' });
        void read();
        return () => { cancellation.abort(); retired.dispose(); stopStore(); stopHome(); };
    }, [lifetime, retry]);
    const accept = React.useCallback((preferences: DeploymentCreationDefaultsV1) => {
        if (lifetime?.isCurrent()) setValue({ lifetime, preferences });
    }, [lifetime]);
    return { preferences: value?.lifetime === lifetime ? value.preferences : null, error, accept,
        retry: React.useCallback(() => setRetry(value => value + 1), []) };
}

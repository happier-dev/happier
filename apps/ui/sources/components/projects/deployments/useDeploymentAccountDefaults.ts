import * as React from 'react';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { subscribeScopedAccountSettings } from '@/sync/ops/account/scopedAccountSettings';

/** One consumed preference key; a non-focused Home still reads its own Account owner. */
export function useDeploymentAccountDefaults(lifetime: ServerAccountScopeLifetime | null) {
    const [value, setValue] = React.useState<Readonly<{ lifetime: ServerAccountScopeLifetime; preferences: DeploymentCreationDefaultsV1 }> | null>(null);
    const [error, setError] = React.useState(false);
    const [retry, setRetry] = React.useState(0);
    React.useEffect(() => {
        setError(false);
        if (!lifetime) return;
        return subscribeScopedAccountSettings(lifetime, ['deploymentDefaultsV1'], settings => {
            if (!lifetime.isCurrent()) return;
            if (settings) setValue({ lifetime, preferences: settings.deploymentDefaultsV1 });
            setError(settings === null);
        });
    }, [lifetime, retry]);
    const accept = React.useCallback((preferences: DeploymentCreationDefaultsV1) => {
        if (lifetime?.isCurrent()) setValue({ lifetime, preferences });
    }, [lifetime]);
    return { preferences: value?.lifetime === lifetime ? value.preferences : null, error, accept,
        retry: React.useCallback(() => setRetry(value => value + 1), []) };
}

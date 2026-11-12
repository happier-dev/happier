import * as React from 'react';
import { HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1 } from '@happier-dev/protocol/deployments/healthCheckV1';
import { HEALTH_RESULT_CHECKPOINT_PREFIX } from '@happier-dev/plugins-machine-services/health-results';
import { createActivePluginAccountKvClient } from '@/sync/api/plugins/data/activePluginAccountKvClient';
import { registerActivePluginCollectionChangeWatch } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { observeConfiguredHealthResults, type ConfiguredHealthResultsRead } from './configuredHealthResults';

type Result = Readonly<{ scope: ServerAccountScope; value: ConfiguredHealthResultsRead; loadNext?: () => void }>;
export function useConfiguredHealthResults(scope: ServerAccountScope | null, demanded: boolean) {
    const reader = usePluginAccountAvailabilityReader(scope, HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1, { enabled: demanded });
    const [result, setResult] = React.useState<Result | null>(null);
    React.useEffect(() => {
        if (!demanded || !scope || !reader) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, scope)) {
            setResult({ scope, value: { kind: 'unavailable', code: 'account_scope_unavailable' } });
            return;
        }
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const kv = createActivePluginAccountKvClient({ pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1,
            accountLifetime: lifetime, readAvailability: () => reader, signal: controller.signal });
        const observation = observeConfiguredHealthResults({ kv, signal: controller.signal,
            subscribe: listener => {
                const watch = registerActivePluginCollectionChangeWatch({ pluginId: HEALTH_CHECK_BUILTIN_PLUGIN_ID_V1,
                    kvPrefix: HEALTH_RESULT_CHECKPOINT_PREFIX, lifetime, onInvalidated: listener });
                return () => watch.dispose();
            }, publish: value => setResult({ scope, value, loadNext: () => observation.loadNext() }) });
        return () => { controller.abort(); observation.dispose(); retirement.dispose(); };
    }, [scope, demanded, reader]);
    return demanded && scope && result && areServerAccountScopesEqual(scope, result.scope) ? result : null;
}

import * as React from 'react';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

import { createScmContributionCatalog, type ScmContributionCatalog } from './scmContributionCatalog';

export function useDaemonScmContributionCatalog(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): ScmContributionCatalog {
    const daemonProjection = useDaemonMergedProjectionInputs(params);

    return React.useMemo(() => {
        const catalog = createScmContributionCatalog(
            daemonProjection.phase === 'unsupported'
                ? null
                : daemonProjection.inputs?.pluginProjectionV2 ?? null,
            { allowLegacyFallback: daemonProjection.phase === 'unsupported' },
        );
        if (
            catalog.source === 'daemon'
            && (daemonProjection.phase === 'loading' || daemonProjection.phase === 'error')
        ) {
            return Object.freeze({
                ...catalog,
                state: 'stale' as const,
            });
        }
        return catalog;
    }, [daemonProjection.inputs?.pluginProjectionV2, daemonProjection.phase]);
}

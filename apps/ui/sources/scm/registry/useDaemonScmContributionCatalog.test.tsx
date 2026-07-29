import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const daemonProjectionState = vi.hoisted(() => ({
    current: {
        phase: 'error' as const,
        inputs: null as null | Readonly<{ pluginProjectionV2: PluginProjectionV2 }>,
    },
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => daemonProjectionState.current,
}));

function projectionWithPackedBackend(): PluginProjectionV2 {
    return {
        v: 2,
        generation: 7,
        familiesById: {
            scmBackends: {
                family: 'scmBackends',
                entriesById: {
                    'acme.scm/stacked': {
                        id: 'acme.scm/stacked',
                        localId: 'stacked',
                        pluginId: 'acme.scm',
                        displayName: 'Acme Stacked SCM',
                    },
                },
            },
            scmHostingProviders: {
                family: 'scmHostingProviders',
                entriesById: {},
            },
        },
    } as unknown as PluginProjectionV2;
}

describe('useDaemonScmContributionCatalog', () => {
    it('retains cached packed metadata while the daemon projection is stale and unavailable', async () => {
        daemonProjectionState.current = {
            phase: 'error',
            inputs: { pluginProjectionV2: projectionWithPackedBackend() },
        };
        const { useDaemonScmContributionCatalog } = await import('./useDaemonScmContributionCatalog');
        const hook = await renderHook(() => useDaemonScmContributionCatalog({
            machineId: 'machine-1',
            serverId: 'server-1',
        }));

        expect(hook.getCurrent()).toMatchObject({
            source: 'daemon',
            state: 'stale',
            generation: 7,
            backends: [
                {
                    id: 'acme.scm/stacked',
                    title: 'Acme Stacked SCM',
                },
            ],
        });
    });
});

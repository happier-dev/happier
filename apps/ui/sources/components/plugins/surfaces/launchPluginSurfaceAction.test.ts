import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginContributionIdentityV1, PluginProjectedActionV2 } from '@happier-dev/protocol';

import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';

import { launchPluginSurfaceAction } from './launchPluginSurfaceAction';
import type { PluginSurfaceContributedActionTransport } from './pluginSurfaceActionDispatch';

vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => 'plugin-request-1' }));
vi.mock('@/components/inbox/actionOperations/actionOperationPresentationRuntime', () => ({
    actionOperationPresentationCoordinator: { register: vi.fn() },
}));

const identity = { pluginId: 'acme.publisher', localId: 'publish' } as const;

function action(): PluginProjectedActionV2 {
    return {
        id: identity.localId,
        pluginId: identity.pluginId,
        title: 'Publish',
        scopes: ['session'],
        surfaces: ['ui'],
        placementBindings: ['primary'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
        operation: {
            version: 1,
            visibility: 'activity',
            progress: 'reported',
            presentation: { onStart: 'activity' },
        },
    } as PluginProjectedActionV2;
}

function resolveExact(projected: PluginProjectedActionV2) {
    return (requested: PluginContributionIdentityV1) => requested.pluginId === projected.pluginId
        && requested.localId === projected.id
        ? projected
        : null;
}

beforeEach(() => {
    vi.mocked(actionOperationPresentationCoordinator.register).mockReset();
});

describe('launchPluginSurfaceAction', () => {
    it('uses the historical contributed transport exactly once with a stable request ID', async () => {
        const projected = action();
        const operationOrigin = { resolve: () => null, collapse: vi.fn() };
        const execute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { published: true } },
        }));

        await expect(launchPluginSurfaceAction({
            action: identity,
            input: { title: 'Ready' },
            resolveContributedAction: resolveExact(projected),
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: 'generation-7',
                execute,
            },
            operationOrigin,
        })).resolves.toEqual({ kind: 'settled', outcome: { ok: true, result: { published: true } } });

        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]?.[1]).toMatchObject({ requestId: 'plugin-request-1' });
        expect(actionOperationPresentationCoordinator.register).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'plugin-request-1',
            onStart: 'activity',
            origin: operationOrigin,
        }));
    });
});

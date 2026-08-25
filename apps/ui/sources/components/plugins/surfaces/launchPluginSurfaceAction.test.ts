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
        // The dispatcher's canonical executable projection requires this exact
        // fact; a fixture without it never reaches the daemon transport.
        available: true,
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
        expect(actionOperationPresentationCoordinator.register).toHaveBeenCalledTimes(1);
    });

    // The canonical dispatcher owns cancellation, currentness and exact
    // executable projection. A launch it refuses produces no daemon operation,
    // so a presentation registration for it is custody for something that can
    // never exist — and the coordinator has no per-registration removal.
    it.each([
        [
            'a pre-aborted signal',
            () => ({ signal: AbortSignal.abort() }),
        ],
        [
            'a retired mount generation',
            () => ({ isCurrent: () => false }),
        ],
    ])('registers no operation presentation when the dispatcher refuses %s', async (_label, refusal) => {
        const projected = action();
        const execute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { published: true } },
        }));

        const outcome = await launchPluginSurfaceAction({
            action: identity,
            resolveContributedAction: resolveExact(projected),
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: 'generation-7',
                execute,
            },
            operationOrigin: { resolve: () => null },
            ...refusal(),
        });

        expect(outcome.outcome.ok).toBe(false);
        expect(execute).not.toHaveBeenCalled();
        expect(actionOperationPresentationCoordinator.register).not.toHaveBeenCalled();
    });

    it('registers no operation presentation for an Action the projection does not mark executable', async () => {
        const projected = { ...action(), available: false } as PluginProjectedActionV2;
        const execute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { published: true } },
        }));

        const outcome = await launchPluginSurfaceAction({
            action: identity,
            resolveContributedAction: resolveExact(projected),
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: 'generation-7',
                execute,
            },
            operationOrigin: { resolve: () => null },
        });

        expect(outcome.outcome).toMatchObject({
            ok: false,
            reason: 'plugin_surface_action_projection_unavailable',
        });
        expect(execute).not.toHaveBeenCalled();
        expect(actionOperationPresentationCoordinator.register).not.toHaveBeenCalled();
    });

    it('sends no operation request id for an admitted Action that declares no operation', async () => {
        const { operation: _operation, ...withoutOperation } = action();
        const execute = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { published: true } },
        }));

        await launchPluginSurfaceAction({
            action: identity,
            resolveContributedAction: resolveExact(withoutOperation as PluginProjectedActionV2),
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: 'generation-7',
                execute,
            },
        });

        expect(execute).toHaveBeenCalledTimes(1);
        expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('requestId');
        expect(actionOperationPresentationCoordinator.register).not.toHaveBeenCalled();
    });
});

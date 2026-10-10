import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';

import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture, createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const { describeProviderModels, projectionRequests } = vi.hoisted(() => ({
    describeProviderModels: vi.fn(),
    projectionRequests: [] as Readonly<{ serverId: string | null; payload: unknown }>[],
}));
// Replace only network delivery; the real client parses the daemon's strict response.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: Readonly<{ serverId: string | null; payload: unknown }>) => {
        projectionRequests.push(request);
        return describeProviderModels(request.payload);
    },
}));
const account = createProviderSettingsAccountHarness();
let serverId = '';

function projection(connectionIds: readonly string[] = []) {
    return createProviderModelProjectionFixture({
        agentTargetKey: 'agent:happier.agent.codex/codex',
        groups: connectionIds.map((connectionId) => createProviderModelProjectionGroupFixture({ connectionId })),
    });
}

const { useProviderModelProjection } = await import('./useProviderModelProjection');
await loadSyncSingletonForTests();

afterEach(async () => {
    standardCleanup();
    await account.reset();
    describeProviderModels.mockReset();
    projectionRequests.length = 0;
});
beforeEach(async () => { serverId = (await account.restore({ waivedActions: ['providers.models.refresh'] })).serverId; });

describe('useProviderModelProjection', () => {
    it('changes source browsing without changing the exact selected tuple or favorite identity', async () => {
        describeProviderModels.mockResolvedValue(projection(['pc_a']));
        const currentSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_a', modelId: 'same' };
        const favorite = { ...currentSelection, providerConnectionId: 'pc_off' };
        const rendered = await renderHook((props: { sourceConnectionId?: string }) => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId, agentTargetKey: currentSelection.agentTargetKey,
            currentSelection, sourceConnectionId: props.sourceConnectionId, favoriteSelections: [favorite],
        }), { initialProps: { sourceConnectionId: 'pc_off' } });
        await flushHookEffects();
        expect(projectionRequests.at(-1)?.payload).toMatchObject({ sourceConnectionId: 'pc_off', currentSelection, favoriteSelections: [favorite] });
        await rendered.rerender({});
        await flushHookEffects();
        const payload = projectionRequests.at(-1)?.payload;
        expect(payload).toMatchObject({ currentSelection, favoriteSelections: [favorite] });
        expect(payload).not.toHaveProperty('sourceConnectionId');
    });
    it('requests models only on picker demand and retains its projection when the picker closes', async () => {
        describeProviderModels.mockResolvedValue(projection(['pc_a']));
        const rendered = await renderHook((props: { active: boolean }) => useProviderModelProjection({
            enabled: true, active: props.active, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }), { initialProps: { active: false } });
        await flushHookEffects();
        expect(describeProviderModels).toHaveBeenCalledTimes(0);
        await rendered.rerender({ active: true });
        await flushHookEffects();
        expect(describeProviderModels).toHaveBeenCalledTimes(1);
        const data = rendered.getCurrent().data;
        expect(data?.groups[0]?.connectionId).toBe('pc_a');
        const refresh = rendered.getCurrent().refresh;
        const refreshWithResult = rendered.getCurrent().refreshWithResult;
        await rendered.rerender({ active: false });
        await act(async () => { await refresh(); await refreshWithResult(); });
        expect(describeProviderModels).toHaveBeenCalledTimes(1);
        expect(rendered.getCurrent().data).toBe(data);
        expect(rendered.getCurrent().refresh).toBe(refresh);
        expect(rendered.getCurrent().refreshWithResult).toBe(refreshWithResult);
    });

    it('projects an API-token creation machine with an omitted Home through the applied Account and retires its old read', async () => {
        // ApiTokenGrantModelMachine omits the Home when the creation machine differs from the Administration target.
        const stagedServerId = await account.addHome({ name: 'Staged Provider Home',
            serverUrl: 'https://provider-settings-staged.test', accountId: 'account-staged', active: true });
        const [{ getAppliedActiveServerSnapshot }, { getActiveServerSnapshot }] = await Promise.all([
            import('@/sync/runtime/orchestration/connectionManager'),
            import('@/sync/domains/server/serverRuntime'),
        ]);
        expect(getActiveServerSnapshot().serverId).toBe(stagedServerId);
        expect(getAppliedActiveServerSnapshot().serverId).toBe(serverId);
        let resolveA!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
            .mockResolvedValueOnce(projection(['pc_account_b']));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId: null,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });
        expect(projectionRequests).toHaveLength(1);
        expect(projectionRequests[0]?.serverId).toBe(serverId);
        const refreshFromAccountA = rendered.getCurrent().refresh;

        await act(async () => {
            await account.restore({ accountId: 'account-b', waivedActions: ['providers.models.refresh'] });
            await rendered.rerender();
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().data?.groups).toMatchObject([
            { connectionId: 'pc_account_b' },
        ]));
        expect(projectionRequests).toHaveLength(2);
        expect(projectionRequests[1]?.serverId).toBe(serverId);

        await act(async () => { resolveA(projection(['pc_retired_a'])); await refreshFromAccountA(); });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_account_b' }]);
        expect(projectionRequests).toHaveLength(2);
    });

    it('clears Account A projection and starts one Account B read when routing ids stay equal', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        const refreshFromAccountA = rendered.getCurrent().refresh;
        expect(describeProviderModels).toHaveBeenCalledTimes(1);

        await act(async () => {
            await account.restore({ accountId: 'account-b' });
            await rendered.rerender();
        });

        expect(rendered.getCurrent().data).toBeNull();
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(describeProviderModels).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveA(projection(['pc_a']));
        });
        expect(rendered.getCurrent().data).toBeNull();

        await act(async () => {
            resolveB(projection(['pc_b']));
        });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_b' }]);

        await act(async () => { await refreshFromAccountA(); });
        expect(describeProviderModels).toHaveBeenCalledTimes(2);
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_b' }]);
    });

    it('clears a successful projection immediately when its machine scope changes', async () => {
        let resolveB!: (value: unknown) => void;
        const observed: Array<Readonly<{ machineId: string; connectionIds: readonly string[]; status?: string }>> = [];
        describeProviderModels
            .mockResolvedValueOnce(projection(['pc_a']))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const rendered = await renderHook((props: { machineId: string }) => {
            const projection = useProviderModelProjection({
                enabled: true, machineId: props.machineId, serverId, agentTargetKey: 'agent:happier.agent.codex/codex',
            });
            observed.push({
                machineId: props.machineId,
                connectionIds: (projection.data?.groups ?? []).map((group) => String(group.connectionId)),
                status: projection.status,
            });
            return projection;
        }, { initialProps: { machineId: 'machine-a' } });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().status).toBe('success');

        const scopeChangeRenderStart = observed.length;
        await rendered.rerender({ machineId: 'machine-b' });
        expect(rendered.getCurrent().data).toBeNull();
        expect(rendered.getCurrent().status).toBe('pending');
        expect(observed.slice(scopeChangeRenderStart).every((entry) => (
            entry.machineId !== 'machine-b' || !entry.connectionIds.includes('pc_a')
        ))).toBe(true);
        await act(async () => resolveB(projection()));
    });

    it('drops a delayed old-machine response after the target machine changes', async () => {
        let resolveA!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockResolvedValueOnce(projection());
        const rendered = await renderHook((props: { machineId: string }) => useProviderModelProjection({
            enabled: true, machineId: props.machineId, serverId, agentTargetKey: 'agent:happier.agent.codex/codex',
        }), { initialProps: { machineId: 'machine-a' } });

        await rendered.rerender({ machineId: 'machine-b' });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data).toEqual(projection());

        await act(async () => {
            resolveA(projection(['pc_stale_a']));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toEqual([]);
        expect(describeProviderModels).toHaveBeenNthCalledWith(2, expect.objectContaining({ machineId: 'machine-b' }));
    });

    it('does no RPC work when disabled or no target machine exists', async () => {
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: false, machineId: null, serverId: null, agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(describeProviderModels).not.toHaveBeenCalled();
        expect(rendered.getCurrent()).toMatchObject({ data: null, loading: false, status: 'disabled' });
    });

    it('exposes a first-load typed error without treating the projection as authoritative', async () => {
        describeProviderModels.mockResolvedValueOnce({
            status: 'error',
            error: {
                v: 1,
                code: 'provider_endpoint_unreachable',
                retryable: true,
                action: 'retry',
            },
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            data: null,
            loading: false,
            status: 'error',
            error: expect.objectContaining({ code: 'provider_endpoint_unreachable' }),
        });
    });

    it('requests the daemon-owned hidden-row management projection explicitly', async () => {
        describeProviderModels.mockResolvedValueOnce(projection());
        await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(describeProviderModels).toHaveBeenCalledWith(expect.objectContaining({ mode: 'management' }));
    });

    it('preserves the last successful same-scope projection and exposes an untyped transport failure', async () => {
        describeProviderModels.mockResolvedValueOnce(projection(['pc_a']));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);

        describeProviderModels.mockRejectedValueOnce(new Error('socket closed'));
        await act(async () => { await rendered.getCurrent().refresh(); });

        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().error).toMatchObject({
            v: 1,
            code: 'agent_error',
            retryable: false,
            action: 'review_connection',
        });
    });

    it('preserves the last successful same-scope projection when the daemon returns a typed error', async () => {
        describeProviderModels.mockResolvedValueOnce(projection(['pc_a']));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        describeProviderModels.mockResolvedValueOnce({
            status: 'error',
            error: {
                v: 1, code: 'provider_endpoint_rate_limited', retryable: true,
                action: 'retry', retryAfterMs: 500,
            },
        });
        await act(async () => { await rendered.getCurrent().refresh(); });

        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().error?.code).toBe('provider_endpoint_rate_limited');
    });

    it('keeps mixed cold-refresh groups authoritative while exposing their typed partial failure', async () => {
        describeProviderModels.mockResolvedValueOnce({
            ...projection(['pc_warm']),
            refreshFailures: [{
                connectionId: 'pc_cold',
                error: {
                    v: 1,
                    code: 'provider_endpoint_unavailable',
                    retryable: true,
                    action: 'retry',
                    connectionId: 'pc_cold',
                    machineId: 'machine-a',
                },
            }],
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            status: 'success',
            data: { groups: [{ connectionId: 'pc_warm' }] },
            error: null,
            refreshFailures: [{
                connectionId: 'pc_cold',
                error: { code: 'provider_endpoint_unavailable', connectionId: 'pc_cold' },
            }],
        });
    });

    it('keeps every per-connection refresh failure and forces only explicit retry reads', async () => {
        describeProviderModels.mockResolvedValue({
            ...projection(),
            refreshFailures: [
                {
                    connectionId: 'pc_secret',
                    error: createProviderErrorV1('provider_secret_missing', {
                        connectionId: 'pc_secret', machineId: 'machine-a',
                    }),
                },
                {
                    connectionId: 'pc_endpoint',
                    error: createProviderErrorV1('provider_endpoint_unavailable', {
                        connectionId: 'pc_endpoint', machineId: 'machine-a',
                    }),
                },
            ],
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(describeProviderModels).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ forceRefresh: true }));
        expect(rendered.getCurrent().refreshFailures.map((failure) => failure.connectionId))
            .toEqual(['pc_secret', 'pc_endpoint']);

        await act(async () => { await rendered.getCurrent().refresh(); });
        expect(describeProviderModels).toHaveBeenNthCalledWith(2, expect.objectContaining({ forceRefresh: true }));
    });
});

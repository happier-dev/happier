import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const { describeProviderModels } = vi.hoisted(() => ({ describeProviderModels: vi.fn() }));
vi.mock('@/providers/rpc/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/providers/rpc/client')>(),
    describeProviderModels,
}));

import { useProviderModelProjection } from './useProviderModelProjection';

afterEach(() => {
    standardCleanup();
    describeProviderModels.mockReset();
});

describe('useProviderModelProjection', () => {
    it('clears a successful projection immediately when its machine scope changes', async () => {
        let resolveB!: (value: unknown) => void;
        const observed: Array<Readonly<{ machineId: string; connectionIds: readonly string[]; status?: string }>> = [];
        describeProviderModels
            .mockResolvedValueOnce({ status: 'success', agentTargetKey: 'backend:codex', groups: [{ connectionId: 'machine-a' }] })
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const rendered = await renderHook((props: { machineId: string }) => {
            const projection = useProviderModelProjection({
                enabled: true, machineId: props.machineId, serverId: 'server-a', agentTargetKey: 'backend:codex',
            });
            observed.push({
                machineId: props.machineId,
                connectionIds: (projection.data?.groups ?? []).map((group) => String(group.connectionId)),
                status: projection.status,
            });
            return projection;
        }, { initialProps: { machineId: 'machine-a' } });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toEqual([{ connectionId: 'machine-a' }]);
        expect(rendered.getCurrent().status).toBe('success');

        const scopeChangeRenderStart = observed.length;
        await rendered.rerender({ machineId: 'machine-b' });
        expect(rendered.getCurrent().data).toBeNull();
        expect(rendered.getCurrent().status).toBe('pending');
        expect(observed.slice(scopeChangeRenderStart).every((entry) => (
            entry.machineId !== 'machine-b' || !entry.connectionIds.includes('machine-a')
        ))).toBe(true);
        await act(async () => resolveB({ status: 'success', agentTargetKey: 'backend:codex', groups: [] }));
    });

    it('drops a delayed old-machine response after the target machine changes', async () => {
        let resolveA!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockResolvedValueOnce({ status: 'success', agentTargetKey: 'backend:codex', groups: [] });
        const rendered = await renderHook((props: { machineId: string }) => useProviderModelProjection({
            enabled: true, machineId: props.machineId, serverId: 'server-a', agentTargetKey: 'backend:codex',
        }), { initialProps: { machineId: 'machine-a' } });

        await rendered.rerender({ machineId: 'machine-b' });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data).toEqual({
            status: 'success', agentTargetKey: 'backend:codex', groups: [],
        });

        await act(async () => {
            resolveA({ status: 'success', agentTargetKey: 'backend:codex', groups: [{ connectionId: 'stale-a' }] });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toEqual([]);
        expect(describeProviderModels).toHaveBeenNthCalledWith(2, expect.objectContaining({ machineId: 'machine-b' }));
    });

    it('does no RPC work when disabled or no target machine exists', async () => {
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: false, machineId: null, serverId: null, agentTargetKey: 'backend:codex',
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
            serverId: 'server-a',
            agentTargetKey: 'backend:codex',
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
        describeProviderModels.mockResolvedValueOnce({ status: 'success', agentTargetKey: 'backend:codex', groups: [] });
        await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId: 'server-a',
            agentTargetKey: 'backend:codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(describeProviderModels).toHaveBeenCalledWith(expect.objectContaining({ mode: 'management' }));
    });

    it('preserves the last successful same-scope projection and exposes a typed retryable transport error', async () => {
        describeProviderModels.mockResolvedValueOnce({
            status: 'success', agentTargetKey: 'backend:codex', groups: [{ connectionId: 'pc_a' }],
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId: 'server-a',
            agentTargetKey: 'backend:codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toEqual([{ connectionId: 'pc_a' }]);

        describeProviderModels.mockRejectedValueOnce(new Error('socket closed'));
        await act(async () => { await rendered.getCurrent().refresh(); });

        expect(rendered.getCurrent().data?.groups).toEqual([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().error).toMatchObject({
            v: 1,
            code: 'provider_endpoint_unavailable',
            retryable: true,
            action: 'retry',
        });
    });

    it('preserves the last successful same-scope projection when the daemon returns a typed error', async () => {
        describeProviderModels.mockResolvedValueOnce({
            status: 'success', agentTargetKey: 'backend:codex', groups: [{ connectionId: 'pc_a' }],
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId: 'server-a',
            agentTargetKey: 'backend:codex', mode: 'management',
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

        expect(rendered.getCurrent().data?.groups).toEqual([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().error?.code).toBe('provider_endpoint_rate_limited');
    });
});

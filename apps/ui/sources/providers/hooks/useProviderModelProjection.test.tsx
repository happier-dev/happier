import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const { describeProviderModels } = vi.hoisted(() => ({ describeProviderModels: vi.fn() }));
type TestAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;
const activeAccountLifetime = vi.hoisted(() => {
    const current: { value: TestAccountLifetime | null } = { value: null };
    return {
        current,
        create() {
            let retired = false;
            const cancellations = new Set<() => void>();
            const lifetime: TestAccountLifetime = {
                isCurrent: () => !retired,
                onRetire(cancel) {
                    if (retired) {
                        cancel();
                        return { dispose() {} };
                    }
                    cancellations.add(cancel);
                    return { dispose: () => cancellations.delete(cancel) };
                },
            };
            return {
                lifetime,
                retire() {
                    if (retired) return;
                    retired = true;
                    for (const cancel of [...cancellations]) cancel();
                    cancellations.clear();
                },
            };
        },
    };
});
vi.mock('@/providers/rpc/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/providers/rpc/client')>(),
    describeProviderModels,
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.current.value,
}));

import { useProviderModelProjection } from './useProviderModelProjection';

afterEach(() => {
    activeAccountLifetime.current.value = null;
    standardCleanup();
    describeProviderModels.mockReset();
});

describe('useProviderModelProjection', () => {
    it('clears Account A projection and starts one Account B read when routing ids stay equal', async () => {
        const accountA = activeAccountLifetime.create();
        const accountB = activeAccountLifetime.create();
        activeAccountLifetime.current.value = accountA.lifetime;
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId: 'server-a',
            agentTargetKey: 'backend:codex',
        }));
        const refreshFromAccountA = rendered.getCurrent().refresh;
        expect(describeProviderModels).toHaveBeenCalledTimes(1);

        await act(async () => {
            activeAccountLifetime.current.value = accountB.lifetime;
            accountA.retire();
            await rendered.rerender();
        });

        expect(rendered.getCurrent().data).toBeNull();
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(describeProviderModels).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveA({ status: 'success', agentTargetKey: 'backend:codex', groups: [{ connectionId: 'pc_a' }] });
        });
        expect(rendered.getCurrent().data).toBeNull();

        await act(async () => {
            resolveB({
                status: 'success', agentTargetKey: 'backend:codex', groups: [{ connectionId: 'pc_b' }],
            });
        });
        expect(rendered.getCurrent().data?.groups).toEqual([{ connectionId: 'pc_b' }]);

        await act(async () => { await refreshFromAccountA(); });
        expect(describeProviderModels).toHaveBeenCalledTimes(2);
        expect(rendered.getCurrent().data?.groups).toEqual([{ connectionId: 'pc_b' }]);
    });

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
            code: 'provider_machine_unavailable',
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

    it('keeps mixed cold-refresh groups authoritative while exposing their typed partial failure', async () => {
        describeProviderModels.mockResolvedValueOnce({
            status: 'success',
            agentTargetKey: 'backend:codex',
            groups: [{ connectionId: 'pc_warm' }],
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
            serverId: 'server-a',
            agentTargetKey: 'backend:codex',
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
            status: 'success',
            agentTargetKey: 'backend:codex',
            groups: [],
            refreshFailures: [
                {
                    connectionId: 'pc_secret',
                    error: {
                        v: 1, code: 'provider_secret_missing', retryable: true,
                        action: 'add_secret', connectionId: 'pc_secret', machineId: 'machine-a',
                    },
                },
                {
                    connectionId: 'pc_endpoint',
                    error: {
                        v: 1, code: 'provider_endpoint_unavailable', retryable: true,
                        action: 'retry', connectionId: 'pc_endpoint', machineId: 'machine-a',
                    },
                },
            ],
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId: 'server-a',
            agentTargetKey: 'backend:codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(describeProviderModels).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ forceRefresh: true }));
        expect(rendered.getCurrent().refreshFailures.map((failure) => failure.connectionId))
            .toEqual(['pc_secret', 'pc_endpoint']);

        await act(async () => { await rendered.getCurrent().refresh(); });
        expect(describeProviderModels).toHaveBeenNthCalledWith(2, expect.objectContaining({ forceRefresh: true }));
    });
});

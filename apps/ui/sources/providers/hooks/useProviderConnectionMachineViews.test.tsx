import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    flushHookEffects,
    installProviderSettingsRpcBoundary,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import type { ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';

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
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetime.current.value,
}));

const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);

function row(
    serverIdentityId: string,
    machineId: string,
    serverId: string,
): ProviderSettingsMachineRowV1 {
    return { target: { serverIdentityId, machineId }, serverId, displayName: machineId, online: true };
}

describe('useProviderConnectionMachineViews', () => {
    afterEach(() => {
        activeAccountLifetime.current.value = null;
        providerHarness.reset();
        standardCleanup();
    });

    it('reads each machine through its own server profile when two profiles share a machine id', async () => {
        // The same machine id exists on two server profiles. Routing both rows
        // through one server would answer for the wrong daemon's Account.
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async (request) => (
            createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({
                    connectionId: 'pc_a',
                    displayName: `on ${request.serverId}`,
                })],
            })
        ));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = [
            row('srv_a', 'machine-shared', 'server-a'),
            row('srv_b', 'machine-shared', 'server-b'),
        ];
        const rendered = await renderHook(() => useProviderConnectionMachineViews({
            enabled: true,
            connectionId: 'pc_a',
            targets,
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });

        const requestedServerIds = providerHarness.state.requests
            .filter((request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE)
            .map((request) => request.serverId)
            .sort();
        expect(requestedServerIds).toEqual(['server-a', 'server-b']);

        const byTargetKey = rendered.getCurrent().byTargetKey;
        expect(Object.keys(byTargetKey).sort()).toEqual([
            'srv_a\u0000machine-shared',
            'srv_b\u0000machine-shared',
        ]);
        const first = byTargetKey['srv_a\u0000machine-shared'];
        const second = byTargetKey['srv_b\u0000machine-shared'];
        expect(first?.status === 'success' ? first.connection?.displayName : null).toBe('on server-a');
        expect(second?.status === 'success' ? second.connection?.displayName : null).toBe('on server-b');
    });

    it('issues no read and holds no rows when there is no addressable machine', async () => {
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const rendered = await renderHook(() => useProviderConnectionMachineViews({
            enabled: true,
            connectionId: 'pc_a',
            targets: [],
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });

        expect(providerHarness.state.requests).toEqual([]);
        expect(rendered.getCurrent().byTargetKey).toEqual({});
    });

    it('clears Account A rows, rejects its late read, and starts one Account B read when routing ids stay equal', async () => {
        const accountA = activeAccountLifetime.create();
        const accountB = activeAccountLifetime.create();
        activeAccountLifetime.current.value = accountA.lifetime;
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        let calls = 0;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            calls += 1;
            if (calls === 1) return await new Promise((resolve) => { resolveA = resolve; });
            if (calls === 2) return await new Promise((resolve) => { resolveB = resolve; });
            throw new Error('unexpected Provider connection read');
        });
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = [row('srv_a', 'machine-a', 'server-a')];
        const switchRendersAreEmpty: boolean[] = [];
        const rendered = await renderHook(() => {
            const views = useProviderConnectionMachineViews({
                enabled: true,
                connectionId: 'pc_a',
                targets,
            });
            switchRendersAreEmpty.push(Object.keys(views.byTargetKey).length === 0);
            return views;
        }, { flushOptions: { cycles: 0 } });
        await act(async () => {});
        expect(calls).toBe(1);

        const switchRenderStart = switchRendersAreEmpty.length;
        await act(async () => {
            activeAccountLifetime.current.value = accountB.lifetime;
            accountA.retire();
            await rendered.rerender();
        });

        expect(switchRendersAreEmpty.slice(switchRenderStart)).toContain(true);
        await act(async () => {});
        expect(calls).toBe(2);
        const key = 'srv_a\u0000machine-a';
        expect(rendered.getCurrent().byTargetKey[key]).toEqual({
            status: 'loading',
            connection: null,
        });

        await act(async () => {
            resolveA(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: 'Account A' })],
            }));
        });
        expect(rendered.getCurrent().byTargetKey[key]).toEqual({
            status: 'loading',
            connection: null,
        });

        await act(async () => {
            resolveB(createProviderConnectionsDescribeFixture({
                connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: 'Account B' })],
            }));
        });
        const current = rendered.getCurrent().byTargetKey[key];
        expect(current?.status === 'success' ? current.connection?.displayName : null).toBe('Account B');
        const afterLateA = rendered.getCurrent().byTargetKey[key];
        expect(afterLateA?.status === 'success' ? afterLateA.connection?.displayName : null).toBe('Account B');
    });
});

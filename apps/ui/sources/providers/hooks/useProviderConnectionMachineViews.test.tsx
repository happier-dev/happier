import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
    createProviderSettingsAccountHarness,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import type { ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';

const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
// Warm the real Sync module after the transport leaves are installed, not inside a test hook's budget.
await loadSyncSingletonForTests();

function row(
    serverIdentityId: string,
    machineId: string,
    serverId: string,
): ProviderSettingsMachineRowV1 {
    return { target: { serverIdentityId, machineId }, serverId, displayName: machineId, online: true };
}

describe('useProviderConnectionMachineViews', () => {
    beforeEach(async () => {
        serverId = (await account.restore()).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test', accountId: 'account-a', active: false });
    });
    afterEach(async () => {
        providerHarness.reset();
        standardCleanup();
        await account.reset();
    });

    it('follows each peer describe approval on its captured Home without replaying the read', async () => {
        await account.home.requireUiApproval(otherServerId, 'providers.connections.describe');
        // Keep Sync's live scopes on the active Home; the peer retains its own persisted policy.
        await account.home.requireUiApproval(serverId, 'providers.connections.describe');
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async request => (
            createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
                connectionId: 'pc_a', displayName: `approved on ${request.serverId}`,
            })] })
        ));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = [row('srv_a', 'machine-shared', serverId), row('srv_b', 'machine-shared', otherServerId)];
        const rendered = await renderHook(() => useProviderConnectionMachineViews({
            enabled: true, connectionId: 'pc_a', targets,
        }));
        await waitForHomeGovernance(() => {
            expect(account.home.artifacts(serverId).list()).toHaveLength(1);
            expect(account.home.artifacts(otherServerId).list()).toHaveLength(1);
        });
        await flushHookEffects();
        expect(rendered.getCurrent().loading).toBe(true);
        expect(Object.values(rendered.getCurrent().byTargetKey).every(value => value.status === 'loading')).toBe(true);
        const reads = () => providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        expect(reads()).toHaveLength(0);
        for (const homeId of [otherServerId, serverId]) {
            await expect(decideApprovalAsInbox(homeId, account.home.artifacts(homeId).list()[0]!.id, 'approve'))
                .resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        }
        await waitForHomeGovernance(() => expect(rendered.getCurrent().loading).toBe(false));
        for (const [key, homeId] of [['srv_a\u0000machine-shared', serverId], ['srv_b\u0000machine-shared', otherServerId]] as const) {
            const state = rendered.getCurrent().byTargetKey[key];
            expect(state?.status === 'success' ? state.connection?.displayName : null).toBe(`approved on ${homeId}`);
        }
        expect(reads()).toHaveLength(2);
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
            row('srv_a', 'machine-shared', serverId),
            row('srv_b', 'machine-shared', otherServerId),
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
        expect(requestedServerIds).toEqual([serverId, otherServerId].sort());

        const byTargetKey = rendered.getCurrent().byTargetKey;
        expect(Object.keys(byTargetKey).sort()).toEqual([
            'srv_a\u0000machine-shared',
            'srv_b\u0000machine-shared',
        ]);
        const first = byTargetKey['srv_a\u0000machine-shared'];
        const second = byTargetKey['srv_b\u0000machine-shared'];
        expect(first?.status === 'success' ? first.connection?.displayName : null).toBe(`on ${serverId}`);
        expect(second?.status === 'success' ? second.connection?.displayName : null).toBe(`on ${otherServerId}`);
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

    it('requests peers only while focused with a visible machine section, preserving rows on blur', async () => {
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = [row('srv_a', 'machine-a', serverId), row('srv_b', 'machine-b', otherServerId)];
        const rendered = await renderHook((props: { focused: boolean; hasMachineSection: boolean }) => useProviderConnectionMachineViews({
            enabled: true,
            active: props.focused && props.hasMachineSection,
            connectionId: 'pc_a', targets,
        }), { initialProps: { focused: false, hasMachineSection: true } });
        const requests = () => providerHarness.state.requests.filter((request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        await flushHookEffects();
        expect(requests()).toHaveLength(0);
        await rendered.rerender({ focused: true, hasMachineSection: false });
        await flushHookEffects();
        expect(requests()).toHaveLength(0);
        await rendered.rerender({ focused: true, hasMachineSection: true });
        await waitForHomeGovernance(() => expect(requests()).toHaveLength(2));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().loading).toBe(false));
        const rows = rendered.getCurrent().byTargetKey;
        const refresh = rendered.getCurrent().refresh;
        await rendered.rerender({ focused: false, hasMachineSection: true });
        await act(async () => { await refresh(); });
        expect(requests()).toHaveLength(2);
        expect(rendered.getCurrent().byTargetKey).toBe(rows);
        expect(rendered.getCurrent().refresh).toBe(refresh);
    });

    it('clears Account A rows, rejects its late read, and starts one Account B read when routing ids stay equal', async () => {
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
        const targets = [row('srv_a', 'machine-a', serverId)];
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
        await waitForHomeGovernance(() => expect(calls).toBe(1));

        const switchRenderStart = switchRendersAreEmpty.length;
        await act(async () => {
            await account.restore({ accountId: 'account-b' });
            await rendered.rerender();
        });

        expect(switchRendersAreEmpty.slice(switchRenderStart)).toContain(true);
        await waitForHomeGovernance(() => expect(calls).toBe(2));
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

import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpc/errors';

import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
    createProviderSettingsAccountHarness,
    installProviderConnectionsCatalogHttpBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { applyAcknowledgedProviderCatalog, isProviderConnectionCheckReadRequired, providerConnectionCheckQueryKey } from '@/sync/store/settings/providerCatalogSnapshot';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { ProviderSettingsMachineRowV1 } from '@/providers/hooks/targetMachine';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

const account = createProviderSettingsAccountHarness();
let serverId = '';
let otherServerId = '';
const machines = ['machine-a', 'machine-b', 'machine-shared'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
const providerHarness = createProviderSettingsHarness({ machines });
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
        const currentMachines = machines.map(machine => ({ ...machine, activeAt: Date.now() }));
        serverId = (await account.restore({ serverIdentityId: 'srv_a', currentAccount: true, machines: currentMachines })).serverId;
        otherServerId = await account.addHome({ name: 'Other Provider Home', serverUrl: 'https://provider-settings-other.test',
            serverIdentityId: 'srv_b', accountId: 'account-a', currentAccount: true, active: false });
        await account.publishMachines(otherServerId, currentMachines);
        installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: otherServerId,
            catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
    });
    afterEach(async () => {
        providerHarness.reset();
        standardCleanup();
        await account.reset();
    });

    it.each(['detail', 'peers'] as const)('starts one %s check on invalidated refocus and handles the next visible invalidation', async kind => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'acme.plugin/acme' },
                role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        serverId = (await account.restore({ catalog, machines, serverIdentityId: 'srv_a' })).serverId;
        const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
        await refreshProviderCatalog(captureActiveServerAccountScopeLifetime()!.scope);
        let reads = 0;
        const pending: Array<() => void> = [];
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            reads += 1;
            if (reads > 1) await new Promise<void>(resolve => { pending.push(resolve); });
            return createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
                connectionId: 'pc_a', displayName: `Observation ${reads}`,
                runtime: { health: 'available', modelCount: 1, checkedAt: reads, endpoints: [] },
            })] });
        });
        const { useProviderConnections } = await import('./useProviderConnections');
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const targets = [row('srv_a', 'machine-a', serverId)];
        const hook = await renderHook(({ active }: { active: boolean }) => ({
            query: kind === 'detail'
                ? useProviderConnections({ enabled: true, active, machineId: 'machine-a', serverId, connectionId: 'pc_a' })
                : useProviderConnectionMachineViews({ enabled: true, active, connectionId: 'pc_a', targets }),
            binding: useProviderActionClient(serverId).accountScope.binding,
        }),
        { initialProps: { active: true } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.loading).toBe(false));
        expect(reads).toBe(1);
        await hook.rerender({ active: false });
        const changeSource = async (revision: number) => {
            catalog = { ...catalog, connections: catalog.connections.map(connection => ({ ...connection,
                revision, source: { kind: 'contribution' as const, contributionKey: `acme.plugin/acme${revision}` } })) };
            await act(async () => { applyAcknowledgedProviderCatalog(captureActiveServerAccountScopeLifetime()!.scope, catalog, revision, true, null); });
        };
        await changeSource(2);
        expect(reads).toBe(1);
        const binding = hook.getCurrent().binding!;
        expect(isProviderConnectionCheckReadRequired(binding.scope, binding.credentialKey!,
            providerConnectionCheckQueryKey('machine-a', 'pc_a'))).toBe(true);
        await hook.rerender({ active: true });
        await waitForHomeGovernance(() => expect(pending.length).toBeGreaterThan(0));
        await flushHookEffects();
        expect(reads).toBe(2);
        await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.loading).toBe(false));
        const observation = () => {
            const query = hook.getCurrent().query;
            return 'data' in query ? query.data?.connections[0]?.runtime.checkedAt
                : query.byTargetKey['srv_a\u0000machine-a']?.connection?.runtime.checkedAt;
        };
        await waitForHomeGovernance(() => expect(observation()).toBe(2));
        await changeSource(3);
        await waitForHomeGovernance(() => expect(reads).toBe(3));
        await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.loading).toBe(false));
        expect(observation()).toBe(3);
        let refresh!: Promise<unknown>;
        await act(async () => { refresh = hook.getCurrent().query.refresh(); });
        await waitForHomeGovernance(() => expect(reads).toBe(4));
        await act(async () => { pending.splice(0).forEach(resolve => resolve()); await refresh; });
        expect(reads).toBe(4);
        expect(observation()).toBe(4);
    });

    it('settles each visible Machine independently and retries only the failed row', async () => {
        type Answer = ReturnType<typeof createProviderConnectionsDescribeFixture>;
        const pending = new Map<string, { resolve: (value: Answer) => void; reject: (error: Error) => void }>();
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, request => (
            new Promise<Answer>((resolve, reject) => { pending.set(request.machineId, { resolve, reject }); })
        ));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = machines.map(machine => row('srv_a', machine.id, serverId));
        const rendered = await renderHook((props: { visible: boolean }) => useProviderConnectionMachineViews({
            enabled: true, active: props.visible, connectionId: 'pc_a', targets,
        }), { initialProps: { visible: false } });
        const reads = () => providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        await flushHookEffects();
        expect(reads()).toHaveLength(0);
        await rendered.rerender({ visible: true });
        await waitForHomeGovernance(() => expect(pending.size).toBe(3));
        expect(reads().map(request => request.machineId).sort()).toEqual(machines.map(machine => machine.id).sort());
        const answer = createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({ connectionId: 'pc_a' })] });
        try {
            await act(async () => {
                pending.get('machine-a')!.resolve(answer);
                pending.get('machine-b')!.reject(new RpcError('RPC transport unavailable', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE));
            });
            await waitForHomeGovernance(() => {
                expect(rendered.getCurrent().byTargetKey['srv_a\u0000machine-a']).toMatchObject({ status: 'success' });
                expect(rendered.getCurrent().byTargetKey['srv_a\u0000machine-b']).toMatchObject({ status: 'error', error: { code: 'provider_machine_unavailable', action: 'retry' } });
                expect(rendered.getCurrent().byTargetKey['srv_a\u0000machine-shared']).toMatchObject({ status: 'loading' });
            });
            let retry!: Promise<void>;
            await act(async () => { retry = rendered.getCurrent().refresh(targets[1]!.target); });
            await waitForHomeGovernance(() => expect(reads()).toHaveLength(4));
            expect(reads().map(request => request.machineId)).toEqual(['machine-a', 'machine-b', 'machine-shared', 'machine-b']);
            expect(rendered.getCurrent().byTargetKey['srv_a\u0000machine-a']).toMatchObject({ status: 'success' });
            await act(async () => { pending.get('machine-b')!.resolve(answer); await retry; });
            expect(rendered.getCurrent().byTargetKey['srv_a\u0000machine-b']).toMatchObject({ status: 'success' });
        } finally {
            await act(async () => { for (const entry of pending.values()) entry.resolve(answer); });
        }
        await waitForHomeGovernance(() => expect(rendered.getCurrent().loading).toBe(false));
        expect(reads()).toHaveLength(4);
    });

    it('updates mounted peer rows when another reader publishes a newer canonical check', async () => {
        let checkedAt = 100;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () =>
            createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
                connectionId: 'pc_a', runtime: { health: 'needs_attention', modelCount: 466, checkedAt,
                    endpoints: [{ endpointTemplateId: 'chat', status: 'unauthorized', activity: 'idle',
                        observedAt: checkedAt, errorCode: 'provider_endpoint_unauthorized', retryAt: null }] },
            })] }));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const input = { enabled: true, connectionId: 'pc_a', targets: [row('srv_a', 'machine-a', serverId)] };
        const first = await renderHook(() => useProviderConnectionMachineViews(input));
        await waitForHomeGovernance(() => expect(first.getCurrent().loading).toBe(false));
        expect(first.getCurrent().byTargetKey['srv_a\u0000machine-a']).toMatchObject({
            connection: { runtime: { checkedAt: 100 } },
        });
        checkedAt = 200;
        const second = await renderHook(() => useProviderConnectionMachineViews(input));
        await waitForHomeGovernance(() => expect(second.getCurrent().loading).toBe(false));
        expect(first.getCurrent().byTargetKey['srv_a\u0000machine-a']).toMatchObject({
            connection: { runtime: { checkedAt: 200 } },
        });
    });

    it('shares the selected Machine check with its peer row and retains it on a new detail demand', async () => {
        const pending: Array<(value: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void> = [];
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            () => new Promise(resolve => { pending.push(resolve); }));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const { useProviderConnections } = await import('./useProviderConnections');
        const targets = [row('srv_a', 'machine-a', serverId)];
        const hook = await renderHook(() => ({
            query: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
            peers: useProviderConnectionMachineViews({ enabled: true, connectionId: 'pc_a', targets }),
        }));
        const result = createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
            connectionId: 'pc_a', displayName: 'Checked Machine source',
        })] });
        try {
            await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
            await flushHookEffects();
            expect(pending).toHaveLength(1);
        } finally { await act(async () => { pending.splice(0).forEach(resolve => resolve(result)); }); }
        await waitForHomeGovernance(() => expect(hook.getCurrent().peers.loading).toBe(false));
        await waitForHomeGovernance(() => expect(hook.getCurrent().query.loading).toBe(false));
        const revised = createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
            connectionId: 'pc_a', displayName: 'Background Machine check',
        })] });
        let refresh!: Promise<void>;
        await act(async () => { refresh = hook.getCurrent().peers.refresh(); });
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        await act(async () => { pending.splice(0).forEach(resolve => resolve(revised)); await refresh; });
        expect(hook.getCurrent().query.data?.connections[0]?.displayName).toBe('Checked Machine source');
        expect(hook.getCurrent().peers.byTargetKey['srv_a\u0000machine-a']).toMatchObject({
            status: 'success', connection: { displayName: 'Background Machine check' },
        });
        await hook.unmount();
        const reopening: Array<ReturnType<typeof useProviderConnections>> = [];
        const reopened = await renderHook(() => {
            const query = useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' });
            reopening.push(query);
            return query;
        });
        // Each hook resolves its credential asynchronously. A retained catalog is
        // exposed only once this hook's exact Account binding is current. Its first
        // admitted render must paint the cached check before the fresh Account answer.
        const admittedIndex = reopening.findIndex(query => query.catalog !== null);
        expect(admittedIndex).toBeGreaterThanOrEqual(0);
        expect(reopening.slice(0, admittedIndex).every(query => query.data === null)).toBe(true);
        expect(reopening[admittedIndex]?.data?.connections[0]?.displayName).toBe('Background Machine check');
        // Account content remains visible during optional Machine revalidation.
        expect(reopened.getCurrent().loading).toBe(false);
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().data?.connections).toEqual([]));
        await act(async () => { pending.splice(0).forEach(resolve => resolve(result)); });
    });

    it('refreshes only the selected keyed Machine check without crossing queries or Homes', async () => {
        let present = true;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async request => (
            createProviderConnectionsDescribeFixture({ connections: present || request.serverId === 'srv_b'
                ? [createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: present ? 'Initially observed' : 'Foreign refresh' })] : [] })
        ));
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const { useProviderConnections } = await import('./useProviderConnections');
        const targets = [row('srv_a', 'machine-a', serverId), row('srv_a', 'machine-b', serverId), row('srv_b', 'machine-b', otherServerId)];
        const hook = await renderHook(() => ({
            query: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
            peers: useProviderConnectionMachineViews({ enabled: true, connectionId: 'pc_a', targets }),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().peers.loading).toBe(false));
        present = false;
        await act(async () => { await hook.getCurrent().query.refresh('machine'); });
        await flushHookEffects();
        expect(hook.getCurrent().peers.byTargetKey['srv_a\u0000machine-a']).toMatchObject({ status: 'success', connection: null });
        const peer = hook.getCurrent().peers.byTargetKey['srv_a\u0000machine-b'];
        expect(peer, peer?.status === 'error' ? peer.error.code : undefined)
            .toMatchObject({ status: 'success', connection: { displayName: 'Initially observed' } });
        await act(async () => { await hook.getCurrent().query.refresh('account'); });
        await flushHookEffects();
        expect(hook.getCurrent().peers.byTargetKey['srv_a\u0000machine-b']).toMatchObject({
            status: 'success', connection: { displayName: 'Initially observed' },
        });
        expect(hook.getCurrent().peers.byTargetKey['srv_b\u0000machine-b']).toMatchObject({ status: 'success', connection: { connectionId: 'pc_a', displayName: 'Initially observed' } });
    });

    it('leaves unrelated checks and a pending foreign Home read alone when the selected query refreshes', async () => {
        let settleForeign!: (value: ReturnType<typeof createProviderConnectionsDescribeFixture>) => void;
        let label = 'Initial';
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async request => {
            if (request.serverId === 'srv_b') return await new Promise(resolve => { settleForeign = resolve; });
            return createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
                connectionId: 'pc_a', displayName: label,
            })] });
        });
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const { useProviderConnections } = await import('./useProviderConnections');
        const targets = [row('srv_a', 'machine-b', serverId), row('srv_b', 'machine-b', otherServerId)];
        const hook = await renderHook(() => ({
            query: useProviderConnections({ enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' }),
            peers: useProviderConnectionMachineViews({ enabled: true, connectionId: 'pc_a', targets }),
        }));
        await waitForHomeGovernance(() => expect(settleForeign).toBeTypeOf('function'));
        label = 'Refreshed';
        await act(async () => { await hook.getCurrent().query.refresh('account'); });
        expect(hook.getCurrent().peers.byTargetKey['srv_a\u0000machine-b'])
            .toMatchObject({ connection: { displayName: 'Initial' } });
        await act(async () => { settleForeign(createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', displayName: 'Foreign' }),
        ] })); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().peers.loading).toBe(false));
        expect(hook.getCurrent().peers.byTargetKey['srv_a\u0000machine-b'])
            .toMatchObject({ status: 'success', connection: { displayName: 'Initial' } });
        expect(hook.getCurrent().peers.byTargetKey['srv_b\u0000machine-b'])
            .toMatchObject({ status: 'success', connection: { displayName: 'Foreign' } });
    });

    it('settles passive peer checks with review-required errors without creating Inbox work', async () => {
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
        await waitForHomeGovernance(() => expect(rendered.getCurrent().loading).toBe(false));
        for (const key of ['srv_a\u0000machine-shared', 'srv_b\u0000machine-shared']) {
            expect(rendered.getCurrent().byTargetKey[key]).toMatchObject({ status: 'error', error: {
                code: 'agent_error', action: 'review_connection',
                failureCause: { errorCode: 'action_interactive_review_required' },
            } });
        }
        expect(account.home.artifacts(serverId).list()).toHaveLength(0);
        expect(account.home.artifacts(otherServerId).list()).toHaveLength(0);
        const reads = () => providerHarness.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        expect(reads()).toHaveLength(0);
        expect(rendered.getCurrent().pendingApproval).toBeNull();
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
        expect(requestedServerIds).toEqual(['srv_a', 'srv_b']);

        const byTargetKey = rendered.getCurrent().byTargetKey;
        expect(Object.keys(byTargetKey).sort()).toEqual([
            'srv_a\u0000machine-shared',
            'srv_b\u0000machine-shared',
        ]);
        const first = byTargetKey['srv_a\u0000machine-shared'];
        const second = byTargetKey['srv_b\u0000machine-shared'];
        expect(first?.status === 'success' ? first.connection?.displayName : null).toBe('on srv_a');
        expect(second?.status === 'success' ? second.connection?.displayName : null).toBe('on srv_b');
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

    it.each(['active', 'peer'] as const)('clears %s Home Account A rows, rejects its late read, and starts one Account B read when routing ids stay equal', async (home) => {
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
        const targets = [row('srv_a', 'machine-a', home === 'active' ? serverId : otherServerId)];
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
            if (home === 'active') await account.restore({ accountId: 'account-b', currentAccount: true });
            else await account.home.switchAccount(otherServerId, 'account-b', { currentAccount: true });
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
    it('does not publish a peer read acknowledged after that peer Account retires', async () => {
        let releaseB!: (value: unknown) => void;
        let retired = false;
        let calls = 0;
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            calls += 1;
            if (calls === 1) {
                await account.home.switchAccount(otherServerId, 'peer-account-b', { currentAccount: true });
                retired = true;
                return createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
                    connectionId: 'pc_a', displayName: 'Retired peer Account A',
                })] });
            }
            return await new Promise(resolve => { releaseB = resolve; });
        });
        const { useProviderConnectionMachineViews } = await import('./useProviderConnectionMachineViews');
        const targets = [row('srv_peer', 'machine-a', otherServerId)];
        const publishedAfterRetirement: Array<string | null> = [];
        const rendered = await renderHook(() => {
            const views = useProviderConnectionMachineViews({ enabled: true, connectionId: 'pc_a', targets });
            const peer = views.byTargetKey['srv_peer\u0000machine-a'];
            if (retired) publishedAfterRetirement.push(peer && peer.status !== 'error' ? peer.connection?.displayName ?? null : null);
            return views;
        });
        await waitForHomeGovernance(() => expect(calls).toBe(2));
        try {
            expect(publishedAfterRetirement).not.toContain('Retired peer Account A');
        } finally {
            await act(async () => {
                releaseB(createProviderConnectionsDescribeFixture({ connections: [createProviderConnectionViewFixture({
                    connectionId: 'pc_a', displayName: 'Current peer Account B',
                })] }));
            });
        }
        await waitForHomeGovernance(() => {
            const peer = rendered.getCurrent().byTargetKey['srv_peer\u0000machine-a'];
            expect(peer?.status === 'success' ? peer.connection?.displayName : null).toBe('Current peer Account B');
        });
    });

});

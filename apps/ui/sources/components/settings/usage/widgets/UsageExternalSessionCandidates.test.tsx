import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createDeferred, createMachineFixture, flushHookEffects, PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { UsageExternalSessionCandidates, UsageOutsideSessions } from './UsageExternalSessionCandidates';

const rpc = vi.hoisted(() => vi.fn());
const homes = createHomeGovernanceHarness();
let serverId: string;
let restoreExecutorModuleLoader: (() => void) | undefined;
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The transport is the boundary; projection admission, candidates and Account lifetimes remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
    installedPackagesById: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById,
        'acme.review': { id: 'acme.review', displayName: 'Archive', enabled: true, source: { kind: 'bundled', locator: 'acme.review' } } },
    agentsById: { 'acme.archive': { id: 'acme.archive', identity: { pluginId: 'acme.review', localId: 'archive' }, title: 'Archive Agent',
        externalSessions: { agent: { pluginId: 'acme.review', localId: 'archive' }, generation: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.generation,
            operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
            sources: [{ sourceKind: 'archive', schema: { fields: [{ name: 'kind', kind: 'literal', value: 'archive' }] },
                key: { segments: [{ kind: 'literal', value: 'archive' }] }, instances: [{ kind: 'default', constants: {} }] }] } } },
});

beforeEach(async () => {
    await homes.reset();
    serverId = resolveServerProfileScopeIdForIdentifier(await homes.addHome({ serverUrl: 'https://usage-outside.test',
        serverIdentityId: 'srv_usage_outside', name: 'Usage Home', accountId: 'usage-account' }));
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => {
        const token = homes.findByServerUrl(url)?.token;
        return token ? { token } : null;
    });
    const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
    const scope = { serverId, accountId: 'usage-account' };
    storage.setState(state => ({ isDataReady: true, settingsVersion: 1, profile: { ...state.profile, id: scope.accountId },
        profileScope: scope, settingsScope: scope, machines: { [machine.id]: machine },
        machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' }, settings: settingsDefaults }));
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://usage-outside.test', generation: 0 });
    setRuntimeFetch((url, init) => homes.request(url, init));
    clearDaemonMergedProjectionCacheForTests();
    rpc.mockReset();
    rpc.mockImplementation(async call => {
        if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
        if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) return { ok: true, candidates: [
            { remoteSessionId: 'outside', title: 'Native work', updatedAtMs: 100 },
            { remoteSessionId: 'already-linked', linkedSessionId: 'happy-session', updatedAtMs: 99 },
        ], nextCursor: null };
        throw new Error(`Unexpected outside transport ${call.method}`);
    });
});
afterEach(async () => { standardCleanup(); restoreExecutorModuleLoader?.(); restoreExecutorModuleLoader = undefined;
    resetRuntimeFetch(); publishAppliedActiveServerRuntimeAvailability(false); vi.restoreAllMocks(); await homes.reset(); });

describe('Usage shared outside-session candidates', () => {
    it('keeps every discovered Work source metadata-only until its own explicit browse, within the pinned Machine scope', async () => {
        restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
        const source = { serverId, machineId: 'machine-1', agent: { pluginId: 'acme.review', localId: 'archive' },
            externalSessionSource: { kind: 'archive' }, root: { kind: 'default' as const, path: '/root' },
            consent: 'disabled' as const, coverage: 'unknown' as const, pendingCount: 0, asOfMs: null };
        const metadataBoundary = rpc.getMockImplementation();
        rpc.mockImplementation(async call => call.method === RPC_METHODS.USAGE_SOURCES_DISCOVER
            ? { sources: [{ ...source, sourceId: 'found', status: 'found' }, { ...source, sourceId: 'stopped', status: 'stopped' }] }
            : metadataBoundary?.(call));
        const excluded = createMachineFixture({ id: 'machine-excluded', activeAt: Date.now() });
        storage.setState(state => ({ machines: { ...state.machines, [excluded.id]: excluded },
            machineListByServerId: { [serverId]: [...(state.machineListByServerId[serverId] ?? []), excluded] } }));
        const query = normalizeUsageQuery({ machines: ['machine-1'], agents: ['acme.archive'], sources: ['native'] });
        const screen = await renderScreen(<UsageOutsideSessions serverId={serverId} query={query} testID="work.outside" />);
        const found = 'work.outside.machine-1.found';
        const stopped = 'work.outside.machine-1.stopped';
        await flushHookEffects({ cycles: 20 });
        expect(rpc.mock.calls.map(([call]) => ({ method: call.method, machineId: call.machineId })))
            .toContainEqual({ method: RPC_METHODS.USAGE_SOURCES_DISCOVER, machineId: 'machine-1' });
        await waitForHomeGovernance(async () => { await flushHookEffects();
            expect(screen.findByTestId(`${found}.browse`)).toBeTruthy();
            expect(screen.findByTestId(`${stopped}.browse`)).toBeTruthy(); });
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(0);
        expect(rpc.mock.calls.every(([call]) => call.machineId !== excluded.id)).toBe(true);
        await screen.pressByTestIdAsync(`${found}.browse`);
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(screen.findByTestId(`${found}.continue.outside`)).toBeTruthy(); });
        expect(screen.findByTestId(`${stopped}.browse`)).toBeTruthy();
        expect(screen.findByTestId(`${stopped}.continue.outside`)).toBeNull();
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(1);
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)
            .map(([call]) => call.accountId)).toEqual(['usage-account']);
        await act(async () => {
            publishAppliedActiveServerRuntimeAvailability(false);
            storage.setState(state => ({ profile: { ...state.profile, id: 'next-account' },
                profileScope: { serverId, accountId: 'next-account' }, settingsScope: { serverId, accountId: 'next-account' } }));
            publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://usage-outside.test', generation: 1 });
        });
        await flushHookEffects();
        expect(screen.findByTestId(`${found}.continue.outside`) === null).toBe(true);
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(1);
        expect(rpc.mock.calls.every(([call]) => call.method !== RPC_METHODS.USAGE_SOURCES_CONSENT_SET)).toBe(true);
    });
    it('withdraws explicit browsing immediately when the root changes, requiring a new request for the new root', async () => {
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'usage-account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const source = { serverId, machineId: 'machine-1', sourceId: 'source', agent: { pluginId: 'acme.review', localId: 'archive' },
            externalSessionSource: { kind: 'archive' }, root: { kind: 'default' as const, path: '/root' },
            consent: 'disabled' as const, status: 'found' as const, coverage: 'unknown' as const, pendingCount: 0, asOfMs: null };
        const screen = await renderScreen(<UsageExternalSessionCandidates source={source} lifetime={lifetime} online testID="outside" />);
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(screen.findByTestId('outside.browse')).toBeTruthy(); });
        await screen.pressByTestIdAsync('outside.browse');
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(screen.findByTestId('outside.continue.outside')).toBeTruthy(); });
        const changed = { ...source, root: { kind: 'override' as const, path: '/other-root' } };
        await act(async () => screen.update(<UsageExternalSessionCandidates source={changed} lifetime={lifetime} online testID="outside" />));
        expect(screen.findByTestId('outside.continue.outside') === null).toBe(true);
        expect(screen.findByTestId('outside.browse')).toBeTruthy();
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(1);
        await screen.pressByTestIdAsync('outside.browse');
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(screen.findByTestId('outside.continue.outside')).toBeTruthy(); });
    });
    it('admits consented history reads but revocation aborts pending history and rejects its late rows until fresh explicit browsing', async () => {
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'usage-account' }, isCurrent: () => true,
            onRetire: () => ({ dispose() {} }) };
        const source = { serverId, machineId: 'machine-1', sourceId: 'source', agent: { pluginId: 'acme.review', localId: 'archive' },
            externalSessionSource: { kind: 'archive' }, root: { kind: 'default' as const, path: '/root' },
            consent: 'enabled' as const, status: 'ready' as const, coverage: 'unknown' as const, pendingCount: 0, asOfMs: null };
        const entered = createDeferred<{ signal: AbortSignal }>();
        const response = createDeferred<{ ok: true; candidates: { remoteSessionId: string; updatedAtMs: number }[]; nextCursor: null }>();
        const metadataBoundary = rpc.getMockImplementation();
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) {
                entered.resolve(call);
                return response.promise;
            }
            return metadataBoundary?.(call);
        });
        const screen = await renderScreen(<UsageExternalSessionCandidates source={source} lifetime={lifetime} online testID="outside" />);
        const request = await entered.promise;
        const stopped = { ...source, consent: 'disabled' as const, status: 'stopped' as const };
        await act(async () => screen.update(<UsageExternalSessionCandidates source={stopped} lifetime={lifetime} online testID="outside" />));
        expect(request.signal.aborted).toBe(true);
        await act(async () => response.resolve({ ok: true, candidates: [{ remoteSessionId: 'outside', updatedAtMs: 100 }], nextCursor: null }));
        await flushHookEffects();
        expect(screen.findByTestId('outside.continue.outside') === null).toBe(true);
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(1);
        await screen.pressByTestIdAsync('outside.browse');
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(screen.findByTestId('outside.continue.outside')).toBeTruthy(); });
        expect(rpc.mock.calls.every(([call]) => !String(call.method).includes('consent'))).toBe(true);
    });
    it.each(['found', 'stopped'] as const)('keeps %s discovery metadata-only until explicit browsing, with qualified Agent and Account fencing', async status => {
        let current = true;
        const retirements = new Set<() => void>();
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId, accountId: 'usage-account' }, isCurrent: () => current,
            onRetire: listener => { retirements.add(listener); return { dispose: () => retirements.delete(listener) }; } };
        const source = { serverId, machineId: 'machine-1', sourceId: 'source', agent: { pluginId: 'acme.review', localId: 'archive' },
            externalSessionSource: { kind: 'archive' }, root: { kind: 'default' as const, path: '/root' },
            consent: 'disabled' as const, status, coverage: 'unknown' as const, pendingCount: 0, asOfMs: null };
        const screen = await renderScreen(<UsageExternalSessionCandidates source={source} lifetime={lifetime} online testID="outside"
            agentIds={['acme.archive']} />);
        await waitForHomeGovernance(async () => { await flushHookEffects();
            expect(rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toBe(true); });
        await flushHookEffects();
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(0);
        expect(screen.findByTestId('outside.continue.outside') === null).toBe(true);
        await screen.pressByTestIdAsync('outside.browse');
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(screen.findByTestId('outside.continue.outside')).toBeTruthy(); });
        expect(screen.findByTestId('outside.continue.already-linked')).toBeNull();
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)
            .map(([call]) => call)).toMatchObject([{ serverId, accountId: 'usage-account', machineId: 'machine-1',
                payload: { agentId: 'acme.archive', source: { kind: 'archive' } } }]);
        await act(async () => screen.update(<UsageExternalSessionCandidates source={source} lifetime={lifetime} online testID="outside" agentIds={['archive']} />));
        expect(screen.findByTestId('outside.continue.outside') === null).toBe(true);
        await act(async () => screen.update(<UsageExternalSessionCandidates source={source} lifetime={lifetime} online testID="outside" agentIds={['acme.archive']} />));
        await screen.pressByTestIdAsync('outside.browse');
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(screen.findByTestId('outside.continue.outside')).toBeTruthy(); });
        await act(async () => { current = false; for (const listener of retirements) listener(); });
        expect(screen.findByTestId('outside.continue.outside') === null).toBe(true);
        expect(rpc.mock.calls.every(([call]) => !String(call.method).includes('consent'))).toBe(true);
    });
});

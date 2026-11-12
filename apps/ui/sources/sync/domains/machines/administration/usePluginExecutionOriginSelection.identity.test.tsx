import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';

import { getPluginMachineExecutionOriginRef} from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { createPackageAssetArchiveV1, normalizePluginReleaseFactsV1, PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';

import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { countStoreNotifications } from '@/dev/testkit/performance/counts';
import { installSessionOpsNetworkBoundary, type SessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { observeMachinePresenceForTest, publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { createRegistryNpmPackageFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { useIsMachineListSettled, useMachineListStatusForServer } from '@/sync/store/hooks';
import { clearMachineRequestReachabilityForScope, clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';

import { advancePluginExecutionOriginSelectionRevision, usePluginMachineExecutionOriginSelection } from './usePluginExecutionOriginSelection';
import { getPluginExecutionOriginCandidateOrigin } from './pluginExecutionOrigin';
import * as executionOrigin from './pluginExecutionOrigin';
import { resolveFreshMachineAdministrationExecutionTarget } from './useTargetSelection';
import { setPluginMachineExecutionOriginPreference, readPluginMachineExecutionLastUsedTarget } from './selectionPreferences';

const externalStoreReads = await vi.hoisted(async () => {
    // Zustand's CommonJS adapter reads React through require, outside Vitest's ESM spies.
    const { createRequire } = await import('node:module');
    const react = createRequire(import.meta.url)('react') as typeof import('react');
    const original = react.useSyncExternalStore;
    const reads: Array<() => unknown> = [];
    react.useSyncExternalStore = (subscribe, getSnapshot, getServerSnapshot) => {
        reads.push(getSnapshot);
        return original(subscribe, getSnapshot, getServerSnapshot);
    };
    return { reads, restore: () => { react.useSyncExternalStore = original; } };
});
afterAll(() => externalStoreReads.restore());

// React is the third-party SDK boundary. Spy-only instrumentation runs its real hooks.
vi.mock('react', { spy: true });
// Keep the SDK, Sync and Account owners real; this fixture opens no external socket.
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const FIXTURE_ACCOUNT_ID = 'account-machine-origin-fixture';
let network: SessionOpsNetworkBoundary;
let syncBridge: Awaited<ReturnType<typeof loadVitestModuleForNodeRequire>>;
const { URL: NodeURL } = getVitestNodeBuiltin<typeof import('node:url')>('node:url');

type FixtureState = ReturnType<typeof storage.getState>;
// These tests also control partial hydration/status projections directly. Publish
// their answered Machine activity through the real ingress before waking readers.
async function publishMachineSnapshot(update: Partial<FixtureState> | ((state: FixtureState) => Partial<FixtureState>)) {
    const snapshot = typeof update === 'function' ? update(storage.getState()) : update;
    for (const machines of Object.values(snapshot.machineListByServerId ?? {})) {
        publishMachineActivityForTest(machines ?? []);
    }
    storage.setState(snapshot);
}

function readOriginSnapshotCallback(): (() => unknown) | undefined {
    const readers = vi.mocked(React.useMemo).mock.results.flatMap(result => {
        const value: unknown = result.type === 'return' ? result.value : null;
        return value && typeof value === 'object' && 'get' in value && typeof value.get === 'function'
            && 'subscribe' in value ? [value.get as () => unknown] : [];
    });
    return [...externalStoreReads.reads, ...readers].reverse().find(read => {
        const value = read();
        return value !== null && typeof value === 'object' && 'key' in value && 'snapshots' in value;
    });
}

describe('execution-origin plugin identity with real Account and machine owners', () => {
    beforeEach(async () => {
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://inventory-readiness.example.test', FIXTURE_ACCOUNT_ID);
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        // Match the app entry: the public sync handle is registered by its real implementation.
        await import('@/sync/syncEngine');
        syncBridge = await loadVitestModuleForNodeRequire(new NodeURL('../../../sync.ts', import.meta.url), () => import('@/sync/sync'));
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        storage.setState({ ...storage.getInitialState(), profileScope: scope, settingsScope: scope }, true);
    });
    afterEach(async () => {
        await standardCleanup();
        syncBridge.dispose();
        clearPluginAccountAvailabilityProjection();
        clearMachineRequestReachabilityForTest();
        await network.dispose();
        publishAppliedActiveServerRuntimeAvailability(false);
        vi.restoreAllMocks();
        externalStoreReads.reads.length = 0;
        vi.useRealTimers();
    });

    it('keeps origin subscribers quiet across file open, switch and reopen, while publishing a real eligibility change', async () => {
        const serverIdentityId = 'srv_file_open_count';
        const url = 'https://file-open-count.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'file-open-machine', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, machines: {},
            machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        observeMachinePresenceForTest(scope, [machine.id]);
        const pluginId = 'acme.file-open';
        const sources = [{ source: { origin: { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'file-open-root' } } },
            version: '1.0.0', occurrenceId: 'file-open-occurrence', serverId: home.id },
            releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
        let renders = 0;
        let selection: ReturnType<typeof usePluginMachineExecutionOriginSelection> | undefined;
        let pane: AppPaneScopeApi | undefined;
        const Origin = React.memo(function Origin() {
            renders += 1;
            selection = usePluginMachineExecutionOriginSelection({ pluginId, sourceCandidates: sources,
                includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(pluginId) });
            return null;
        });
        function Commands() { pane = useAppPaneScope('project:file-open'); return null; }
        const screen = await renderScreen(<AppPaneProvider><Origin /><Commands /></AppPaneProvider>);
        try {
            expect(selection?.canExecute).toBe(true);
            const initial = selection;
            const settledRenders = renders;
            for (const path of ['a.ts', 'b.ts', 'a.ts']) {
                await act(async () => pane!.openDetailsTab({ key: `file:${path}`, kind: 'file', title: path,
                    resource: { kind: 'file', path } }));
                await act(async () => pane!.patchDetailsTabState(`file:${path}`, { scrollTop: 120 }));
            }
            console.info('file open/switch/reopen: origin renders =', renders - settledRenders);
            expect(renders - settledRenders).toBe(0);
            expect(selection?.candidates).toBe(initial?.candidates);
            expect(selection?.state).toBe(initial?.state);
            await act(async () => await publishMachineSnapshot({ machineListByServerId: { [home.id]: [{ ...machine, active: false }] } }));
            expect(renders).toBeGreaterThan(settledRenders);
            expect(selection?.state).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        } finally { await screen.unmount(); }
    });

    it('auto-picks qualified rows during hydration, remembers use locally and never replaces a pending pin', async () => {
        const serverIdentityId = 'srv_auto_inventory';
        const url = 'https://auto-inventory.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const pluginId = 'acme.auto';
        const a = createMachineFixture({ id: 'auto-a', active: true, activeAt: Date.now() - 1000 });
        const b = createMachineFixture({ id: 'auto-b', active: true, activeAt: Date.now() });
        const sources = [a, b].map(machine => ({ source: { origin: { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: machine.id } } }, version: '1.0.0',
            occurrenceId: machine.id, serverId: home.id }, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }));
        const pending = (machine: typeof a) => ({ ...machine, availability: undefined, metadata: null });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true, machines: {},
            machineListByServerId: { [home.id]: [pending(a), pending(b)] }, machineListStatusByServerId: { [home.id]: 'loading' } });
        let autoPick = true;
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId, sourceCandidates: sources,
            autoPick, renderedVersion: '1.0.0', classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier() }));
        expect(hook.getCurrent()).toMatchObject({ loading: true, selectedOrigin: null, canExecute: false });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['unknown'] });
        // List completion is not content completion for a socket-superseded row.
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(hook.getCurrent()).toMatchObject({ loading: true, selectedOrigin: null, canExecute: false });
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [a, pending(b)] } }); });
        expect(hook.getCurrent()).toMatchObject({ loading: false, selectedOrigin: sources[0]!.source.origin, canExecute: true });
        await act(async () => { await publishMachineSnapshot({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
            setPluginMachineExecutionOriginPreference({}, pluginId, sources[1]!.source.origin) } }); });
        expect(hook.getCurrent()).toMatchObject({ loading: true, selectedOrigin: null, canExecute: false,
            state: { kind: 'unavailable', storedTarget: { serverIdentityId, machineId: b.id }, reasons: ['unknown'] } });
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [a, { ...b, metadata: null,
            availability: { kind: 'locked', reason: 'decryption_failed' } }] } }); });
        expect(hook.getCurrent()).toMatchObject({ loading: false, selectedOrigin: null, canExecute: false });
        await act(async () => { await publishMachineSnapshot({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} },
            machineListByServerId: { [home.id]: [a, b] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'selected', selectionSource: 'auto', origin: sources[1]!.source.origin });
        expect(hook.getCurrent()).toMatchObject({ loading: false, canExecute: true });
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        // Recency ranks the initial choice. Heartbeats must leave the current
        // eligible Auto choice and invocation target in agreement.
        const admittedCandidates = hook.getCurrent().candidates;
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [{ ...a, activeAt: b.activeAt + 1 }, b] } }); });
        expect(hook.getCurrent().selectedOrigin).toEqual(sources[1]!.source.origin);
        expect(hook.getCurrent().resolveExecutionOrigin({ recordUse: false })?.origin).toEqual(sources[1]!.source.origin);
        // Admitted candidates are likewise unchanged by recency ordering.
        expect(hook.getCurrent().candidates).toBe(admittedCandidates);
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [a, b] } }); });
        expect(hook.getCurrent().candidates).toBe(admittedCandidates);
        // Machine RPC records its exact routing profile; Administration reads
        // the portable Home identity. Both must observe the same refusal.
        await act(async () => { recordMachineRequestFailed({ ...scope, machineId: b.id }); });
        expect(hook.getCurrent().selectedOrigin).toEqual(sources[0]!.source.origin);
        await act(async () => { clearMachineRequestReachabilityForScope({ ...scope, serverId: serverIdentityId }); });
        expect(hook.getCurrent().selectedOrigin).toEqual(sources[0]!.source.origin);
        const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
        const { publishLocalDaemonStatus, readLocalDaemonSharedState } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
        const runner = getSystemTasksRunner();
        const previousLocalStatus = readLocalDaemonSharedState(runner).status;
        try {
            await act(async () => { publishLocalDaemonStatus(runner, { serviceInstalled: true, daemonRunning: true, needsAuth: false,
                machineId: a.id, daemonServerUrl: url, daemonAccountId: FIXTURE_ACCOUNT_ID }); });
            expect(hook.getCurrent().state).toMatchObject({ kind: 'selected', origin: sources[0]!.source.origin });
        } finally {
            await act(async () => { publishLocalDaemonStatus(runner, previousLocalStatus); });
        }
        await act(async () => { expect(hook.getCurrent().resolveExecutionOrigin()?.origin).toEqual(sources[0]!.source.origin); });
        expect(readPluginMachineExecutionLastUsedTarget(scope, pluginId))
            .toEqual({ serverIdentityId, machineId: a.id });
        const offline = { ...b, active: false, activeAt: 0 };
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [a, offline] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'selected', selectionSource: 'auto', origin: sources[0]!.source.origin });
        await act(async () => { await publishMachineSnapshot({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
            setPluginMachineExecutionOriginPreference(storage.getState().settings.machineAdministrationTargetsLocalV1, pluginId, sources[1]!.source.origin) } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', storedTarget: { serverIdentityId, machineId: b.id } });
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        autoPick = false;
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [a, b] }, settings: { ...storage.getState().settings,
            machineAdministrationTargetsLocalV1: {} } }); });
        await hook.rerender();
        expect(hook.getCurrent().state).toMatchObject({ kind: 'selectionRequired' });
        await hook.unmount();
    });

    it('does not resolve unrelated Home credentials for a renderless plugin selection', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const foreignUrl = 'https://unrelated-origin.example.test';
        await network.addHome(foreignUrl, FIXTURE_ACCOUNT_ID);
        const foreignHome = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: 'srv_unrelated_origin',
            canonicalServerUrl: foreignUrl, revision: 1, endpoints: [{ kind: 'https', url: foreignUrl }] }, source: 'manual' });
        const serverIdentityId = 'srv_scoped_origin';
        const url = 'https://scoped-origin.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'scoped-origin-machine', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
            machineListStatusByServerId: { [home.id]: 'idle' } });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
        const pluginId = 'example.scoped-origin';
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'scoped-origin-root' } } };
        const sources = [{ source: { origin, version: '1.0.0', occurrenceId: 'scoped-occurrence',
            serverId: home.id }, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        let sourceCandidates = sources;
        let renders = 0;
        // Spy on the genuine device-storage boundary, forwarding every read.
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginMachineExecutionOriginSelection({ pluginId,
                includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(pluginId), sourceCandidates });
        });
        expect(hook.getCurrent().selectedOrigin).toEqual(origin);
        expect(credentials.mock.calls.filter(([readUrl, options]) => readUrl === foreignUrl
            && options?.storageReadFailure === 'surface')).toHaveLength(0);
        const settledRenders = renders;
        await act(async () => {
            replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                availabilityCursor: 2, intentReads: [], materializations: [], snapshots: [],
            } });
        });
        expect(renders).toBe(settledRenders);
        await act(async () => { recordMachineRequestFailed({ ...scope, machineId: 'unrelated-machine' }); });
        expect(renders).toBe(settledRenders);
        await act(async () => { recordMachineRequestFailed({ ...scope, machineId: machine.id }); });
        expect(hook.getCurrent().canExecute).toBe(false);
        // A previously unrelated Home becomes a real input as soon as it
        // supplies this plugin. Its credential and withdrawal must be observed.
        const foreignMachine = createMachineFixture({ id: 'foreign-origin-machine', active: true, activeAt: Date.now() });
        const foreignOrigin = { ...origin, serverIdentityId: 'srv_unrelated_origin',
            sourceRef: { ...origin.sourceRef, machineId: foreignMachine.id } };
        sourceCandidates = [{ ...sources[0]!, source: { ...sources[0]!.source,
            origin: foreignOrigin, serverId: foreignHome.id } }];
        await act(async () => { await publishMachineSnapshot(state => ({
            machineListByServerId: { ...state.machineListByServerId, [foreignHome.id]: [foreignMachine] },
            machineListStatusByServerId: { ...state.machineListStatusByServerId, [foreignHome.id]: 'idle' },
        })); });
        await hook.rerender();
        await vi.waitFor(() => expect(hook.getCurrent().candidates).toMatchObject([
            { source: { origin: foreignOrigin }, validation: { kind: 'admitted' } },
        ]));
        expect(credentials.mock.calls.some(([readUrl, options]) => readUrl === foreignUrl
            && options?.storageReadFailure === 'surface')).toBe(true);
        // Auto stays on this Home; the foreign candidate still observes withdrawal.
        await act(async () => { recordMachineRequestFailed({ serverId: foreignHome.id,
            accountId: FIXTURE_ACCOUNT_ID, machineId: foreignMachine.id }); });
        expect(hook.getCurrent().candidates).toMatchObject([
            { source: { origin: foreignOrigin }, validation: { kind: 'rejected', reason: 'home_unreachable' } },
        ]);
        await hook.unmount();
    });

    it('advances its local revision monotonically across A-to-B-to-A', () => {
        const originA = { serverIdentityId: 'srv_one', materializationRef: {
            machineId: 'machine-a', materializationId: 'mat-a', pluginId: 'acme.plugin',
        } };
        const originB = { serverIdentityId: 'srv_two', materializationRef: {
            machineId: 'machine-b', materializationId: 'mat-b', pluginId: 'acme.plugin',
        } };
        const initial = { pluginId: 'acme.plugin', origin: originA, revision: 0 };
        const selectedB = advancePluginExecutionOriginSelectionRevision(initial, 'acme.plugin', originB);
        const selectedAAgain = advancePluginExecutionOriginSelectionRevision(selectedB, 'acme.plugin', originA);
        expect(selectedB.revision).toBe(1);
        expect(selectedAAgain.revision).toBe(2);
    });

    it('does not let an older settled Home alias replace the canonical pending Machine read', async () => {
        const serverIdentityId = 'srv_pending_inventory_alias';
        const url = 'https://pending-inventory-alias.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        const machine = createMachineFixture({ id: 'pending-alias-machine' });
        const previous = storage.getState();
        try {
            await publishMachineSnapshot({ machineListByServerId: { [serverIdentityId]: [machine], [home.id]: [machine] },
                machineListStatusByServerId: { [serverIdentityId]: 'loading', [home.id]: 'idle' } });
            const hook = await renderHook(() => ({ settled: useIsMachineListSettled(home.id), status: useMachineListStatusForServer(home.id) }));
            expect(hook.getCurrent()).toEqual({ settled: false, status: 'loading' });
            await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: {
                [serverIdentityId]: 'error', [home.id]: 'idle',
            } }); });
            expect(hook.getCurrent()).toEqual({ settled: false, status: 'error' });
            await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: {
                [serverIdentityId]: 'idle', [home.id]: 'idle',
            } }); });
            expect(hook.getCurrent()).toEqual({ settled: true, status: 'idle' });
            await act(async () => { await publishMachineSnapshot({ machineListByServerId: {}, machineListStatusByServerId: {} }); });
            expect(hook.getCurrent()).toEqual({ settled: false, status: 'loading' });
            await hook.unmount();
        } finally { await publishMachineSnapshot(previous); }
    });

    it('admits active machine inventory from its own read status independently of core readiness', async () => {
        const serverIdentityId = 'srv_inventory_readiness';
        const url = 'https://inventory-readiness.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'inventory-readiness-machine', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
        const hook = await renderHook(() => useAllProfileMachineInventorySnapshots());
        const snapshot = () => hook.getCurrent().find(row => row.kind !== 'missingIdentity' && row.serverIdentityId === serverIdentityId);
        expect(snapshot()).toMatchObject({ kind: 'unknown', inventoryStatus: 'loading' });
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [] },
            machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(snapshot()).toMatchObject({ kind: 'resolved', settled: true, machines: [] });
        await act(async () => { await publishMachineSnapshot({ machines: { [machine.id]: machine },
            machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'loading' } }); });
        expect(snapshot()).toMatchObject({ inventoryStatus: 'loading', executionEligibleMachineIds: [machine.id] });
        expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: machine.id })?.machine).toBe(machine);
        for (const status of ['error', 'signedOut'] as const) {
            await act(async () => { await publishMachineSnapshot({ machines: { [machine.id]: machine },
                machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: status } }); });
            // A failed read keeps the admitted, presence-fresh row executable; a signed-out Home does not.
            expect(snapshot()).toMatchObject({ inventoryStatus: status,
                machines: [expect.objectContaining({ id: machine.id })],
                executionEligibleMachineIds: status === 'error' ? [machine.id] : [] });
            expect(snapshot()).not.toHaveProperty('settled');
            const fresh = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: machine.id });
            if (status === 'error') expect(fresh?.machine).toBe(machine); else expect(fresh).toBeNull();
        }
        await act(async () => { await publishMachineSnapshot({ isDataReady: false, machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(snapshot()).toMatchObject({ settled: true, executionEligibleMachineIds: [machine.id] });
        expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId, machineId: machine.id })?.machine).toBe(machine);
        await hook.unmount();
    });

    it('says it is loading until Account availability is admitted, then answers from it', async () => {
        const serverIdentityId = 'srv_availability_loading';
        const url = 'https://availability-loading.example.test';
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        let establishingTargets: readonly { serverIdentityId: string; machineId: string }[] = [];
        let contextualTarget: Parameters<typeof usePluginMachineExecutionOriginSelection>[0]['contextualTarget'];
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
            pluginId: 'acme.loading', classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), establishingTargets, contextualTarget,
        }));
        // Nothing is known yet: this is not the answer "no Machine can run it".
        expect(hook.getCurrent().loading).toBe(true);
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } }); });
        expect(hook.getCurrent().loading).toBe(false);
        expect(hook.getCurrent().state.kind).toBe('unavailable');
        // Nor is "none" an answer while the Home's Machine list is still being read.
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'loading' } }); });
        expect(hook.getCurrent().loading).toBe(true);
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(hook.getCurrent().loading).toBe(false);
        establishingTargets = [{ serverIdentityId, machineId: 'initial-describe-machine' }];
        await hook.rerender();
        expect(hook.getCurrent().loading).toBe(true);
        contextualTarget = { serverIdentityId, machineId: 'another-machine' };
        await hook.rerender();
        expect(hook.getCurrent().loading).toBe(false);
        contextualTarget = establishingTargets[0];
        await hook.rerender();
        expect(hook.getCurrent().loading).toBe(true);
        contextualTarget = null;
        await hook.rerender();
        expect(hook.getCurrent().loading).toBe(false);
        contextualTarget = undefined;
        establishingTargets = [{ serverIdentityId: 'srv_unrelated', machineId: 'initial-describe-machine' }];
        await hook.rerender();
        expect(hook.getCurrent().loading).toBe(false);
        await hook.unmount();
    });

    it('keeps a cold selector pending before its Account reader is bound', async () => {
        await publishMachineSnapshot({ profileScope: null, settingsScope: null });
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
            pluginId: 'acme.cold-account', includeMachineCandidates: false,
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(),
        }));
        expect(hook.getCurrent()).toMatchObject({ loading: true, canExecute: false, selectedOrigin: null });
        await hook.unmount();
    });

    it('keeps rows and ready selection after visiting another plugin while the picker credential read settles', async () => {
        const serverIdentityId = 'srv_return_to_plugin';
        const url = 'https://return-to-plugin.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'return-machine', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: { [machine.id]: machine }, machineListByServerId: { [home.id]: [machine] },
            machineListStatusByServerId: { [home.id]: 'idle' } });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
        const pluginId = 'acme.return';
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'return-root' } } };
        const candidates = [{ source: { origin, version: '1.0.0', occurrenceId: 'return-occurrence',
            serverId: home.id }, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        const { getPluginUiEphemeralSharedScope } = await import('@/components/plugins/surfaces/pluginUiEphemeralSharedScope');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { acquireTriageListWindow, readTriageListWindowSnapshot, refreshTriageListWindow } = await import(
            '../../../../../../../packages/plugins/triage/src/ui/window/mountedWindow');
        const { TriageListEntriesResultV1Schema } = await import('../../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol');
        const { resolveTriageListShellState } = await import('../../../../../../../packages/plugins/triage/src/ui/shell/windowState');
        const { testkitEntryRef, testkitObservation, TRIAGE_TESTKIT_SOURCE, TESTKIT_SOURCE_INSTANCE_ID } = await import(
            '../../../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const now = Date.now();
        const result = TriageListEntriesResultV1Schema.parse({ v: 1,
            configuredSources: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, configurationRowId: 'return-source-config', source: TRIAGE_TESTKIT_SOURCE, available: true }],
            configuredSourcesStatus: 'complete', window: { v: 1,
                rows: [{ entryRef: testkitEntryRef(), lane: '1-open', sortAtMs: now,
                    presence: { kind: 'present', observedAtMs: now },
                    selected: { kind: 'selected', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, reason: 'onlyPresent' },
                    observation: testkitObservation({ observedAtMs: now }), otherObservations: [], observedByCount: 1 }],
                lanes: [{ sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, source: TRIAGE_TESTKIT_SOURCE,
                    health: { kind: 'walkFinished' }, exhausted: true }], coverage: 'complete', assembledAtMs: now } });
        const host = { executeAction: async () => result };
        const scopeFor = (selection: ReturnType<typeof usePluginMachineExecutionOriginSelection>, id = pluginId) => {
            const selected = selection.state.kind === 'selected' ? selection.state.candidate : null;
            return getPluginUiEphemeralSharedScope({ accountLifetime, pluginId: id,
                occurrenceId: selected && 'source' in selected ? selected.source.occurrenceId : 'artifact:retained-view',
                executionOrigin: selection.selectedOrigin, isCurrent: () => accountLifetime?.isCurrent() === true });
        };
        // Compose the real selector, host sharing scope, aggregate acquisition
        // and shell presentation. Only the Action transport/device storage are boundaries.
        const first = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId,
            includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates }));
        expect(first.getCurrent().state.kind).toBe('selected');
        const firstScope = scopeFor(first.getCurrent());
        const firstLease = acquireTriageListWindow(host, firstScope);
        await refreshTriageListWindow('view', host, firstScope);
        const retainedWindow = readTriageListWindowSnapshot(host, firstScope).window;
        expect(retainedWindow?.rows).toHaveLength(1);
        firstLease.release();
        await first.unmount();
        const otherPluginId = 'acme.other-page';
        const otherCandidates = [{ ...candidates[0]!, source: { ...candidates[0]!.source,
            occurrenceId: 'other-occurrence', origin: { ...origin, sourceRef: { ...origin.sourceRef, pluginId: otherPluginId } } } }];
        const other = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: otherPluginId,
            includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: otherCandidates }));
        expect(other.getCurrent().state.kind).toBe('selected');
        acquireTriageListWindow(host, scopeFor(other.getCurrent(), otherPluginId)).release();
        await other.unmount();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const readCredentials = vi.mocked(TokenStorage.getCredentialsForServerUrl).getMockImplementation()
            ?? TokenStorage.getCredentialsForServerUrl;
        let releasePickerRead!: () => void;
        const pickerRead = new Promise<void>(resolve => { releasePickerRead = resolve; });
        let reads = 0;
        // Device credential storage is a real asynchronous boundary. Keep the
        // real reader and delay its picker-presentation result. Semantic
        // selection already has the active Account and does not reread it.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (serverUrl, options) => {
            const result = await readCredentials.call(TokenStorage, serverUrl, options);
            if (serverUrl === url && options?.storageReadFailure === 'surface' && ++reads === 1) await pickerRead;
            return result;
        });
        const returnPresentations: Array<{ loading: boolean; kind: string }> = [];
        const hook = await renderHook(() => {
            const selection = usePluginMachineExecutionOriginSelection({ pluginId,
                classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates });
            returnPresentations.push({ loading: selection.loading, kind: selection.state.kind });
            return selection;
        });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().canExecute).toBe(true));
            expect(reads).toBeGreaterThan(0);
            await act(async () => { releasePickerRead(); });
            expect(hook.getCurrent().loading).toBe(false);
            expect(hook.getCurrent().state.kind).toBe('selected');
            expect(hook.getCurrent().selectedOrigin).toEqual(origin);
            expect(returnPresentations.filter(state => !state.loading && state.kind !== 'selected')).toEqual([]);
            const returningScope = scopeFor(hook.getCurrent());
            const returningLease = acquireTriageListWindow(host, returningScope);
            try {
                const snapshot = readTriageListWindowSnapshot(host, returningScope);
                expect(snapshot.window).toBe(retainedWindow);
                expect(resolveTriageListShellState(snapshot)).toMatchObject({ kind: 'window', failure: null });
            } finally { returningLease.release(); }
        } finally {
            releasePickerRead();
            await hook.unmount();
        }
    });

    it('offers a daemon-selected source once without dropping a distinct portable installation', async () => {
        const serverIdentityId = 'srv_source_inventory';
        const url = 'https://source-inventory.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'machine-source', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const pluginId = 'acme.source';
        const report: PluginMachineMaterializationV1 = { serverIdentityId, machineId: machine.id,
            materializationId: `daemon-selected:${pluginId}`, pluginId, version: '0.0.0', sourceClass: 'localPath',
            portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] };
        const portable = { ...report, materializationId: 'portable-installation', portableRelease: true,
            sourceClass: 'registryPackage' as const };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [report, portable], snapshots: [],
        } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } } };
        const source = { origin, version: '0.0.0', occurrenceId: 'source-occurrence', serverId: home.id };
        const sources = [{ source, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        const classified: string[] = [];
        const classifiedDuringRender: boolean[] = [];
        let rendering = false;
        const hook = await renderHook(() => {
            rendering = true;
            try {
                const classify = useActivePluginAccountAvailabilityReleaseClassifier();
                const classifyRelease = React.useMemo(() => (materialization: PluginMachineMaterializationV1) => {
                    classified.push(materialization.materializationId);
                    classifiedDuringRender.push(rendering);
                    return classify(materialization);
                }, [classify]);
                return usePluginMachineExecutionOriginSelection({ pluginId, classifyRelease, sourceCandidates: sources });
            } finally { rendering = false; }
        });
        // The source publication classifies each emitted row once. Initial
        // pending presentation does not build a second candidate projection.
        // Availability reads retain their memo; explicit invocation stays fresh.
        for (const materialization of [report, portable]) {
            expect(classified.filter(id => id === materialization.materializationId)).toHaveLength(1);
        }
        expect(classifiedDuringRender).not.toContain(true);
        expect(hook.getCurrent().candidates.map(getPluginExecutionOriginCandidateOrigin)).toEqual([
            { serverIdentityId, materializationRef: { machineId: machine.id, materializationId: portable.materializationId, pluginId } },
            origin,
        ]);
        const beforeAvailabilityRead = classified.length;
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(classified).toHaveLength(beforeAvailabilityRead + 2);
        const beforeInvocation = classified.length;
        expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        expect(classified.length).toBeGreaterThan(beforeInvocation);
        await hook.unmount();
    });

    it('resolves a sole source afresh and withdraws execution on source retirement or Account change', async () => {
        const reactErrors = vi.spyOn(console, 'error');
        const serverIdentityId = 'srv_source_execution';
        const url = 'https://source-execution.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
        const machine = createMachineFixture({ id: 'machine-source', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId: 'acme.source',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } } };
        const source = { origin, version: '1.0.0', occurrenceId: 'source-occurrence', serverId: home.id };
        const candidates = [{ source, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        let currentSources: typeof candidates = candidates;
        let currentDefaults = [origin];
        const settingsBeforeMount = storage.getState().settings;
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.source',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            readSourceCandidates: () => currentSources, declaredDefaultOrigins: [origin],
            readDeclaredDefaultOrigins: () => currentDefaults, autoPick: false }));
        expect(hook.getCurrent().selectedOrigin).toEqual(origin);
        expect(hook.getCurrent().machineCandidates).toEqual(expect.arrayContaining([
            expect.objectContaining({ target: { serverIdentityId, machineId: machine.id }, availability: 'online' }),
        ]));
        expect(storage.getState().settings).toBe(settingsBeforeMount);
        const notifications = countStoreNotifications(storage);
        try {
            expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        } finally { notifications.stop(); }
        expect(notifications.read().filter(keys => keys.includes('settings'))).toHaveLength(0);
        const settingsAfterUse = storage.getState().settings;
        expect(settingsAfterUse).toBe(settingsBeforeMount);
        // An opened row stays executable while unrelated census work continues.
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'loading' } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(hook.getCurrent().selectedOrigin).toEqual(origin);
        expect(hook.getCurrent().loading).toBe(false);
        for (const status of ['error', 'signedOut'] as const) {
            await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: status } }); });
            // Only a signed-out Home withdraws execution; a failed list read proves nothing.
            expect(hook.getCurrent().canExecute).toBe(status === 'error');
            expect(hook.getCurrent().loading).toBe(false);
        }
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(hook.getCurrent().loading).toBe(false);
        await hook.rerender();
        expect(storage.getState().settings).toBe(settingsAfterUse);
        const alternate = { ...candidates[0]!, source: { ...source, origin: { ...origin,
            sourceRef: { ...origin.sourceRef, sourceCustody: { kind: 'development' as const, registeredRootId: 'alternate-source-root' } } } } };
        currentSources = [...candidates, alternate];
        currentDefaults = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        currentSources = [];
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        const resolveBeforePreferenceChange = hook.getCurrent().resolveExecutionOrigin;
        currentSources = [alternate];
        await act(async () => {
            await publishMachineSnapshot({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference({}, 'acme.source', alternate.source.origin) } });
            expect(resolveBeforePreferenceChange()?.origin).toEqual(alternate.source.origin);
        });
        currentSources = candidates;
        await act(async () => {
            await publishMachineSnapshot({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference({}, 'acme.source', origin) } });
        });
        const machineFree = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.source',
            enabled: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates }));
        expect(machineFree.getCurrent()).toMatchObject({ candidates: [], machineCandidates: [], selectedOrigin: null,
            canExecute: false, state: { kind: 'selectionRequired', candidates: [] } });
        expect(machineFree.getCurrent().resolveExecutionOrigin()).toBeNull();
        await expect(machineFree.getCurrent().selectOrigin(origin)).resolves.toEqual({ status: 'unavailable' });
        await expect(machineFree.getCurrent().clearOrigin()).resolves.toEqual({ status: 'unavailable' });
        await machineFree.unmount();
        const incumbentResolve = hook.getCurrent().resolveExecutionOrigin;
        currentSources = [];
        await act(async () => { await publishMachineSnapshot({ settingsScope: { ...scope, accountId: 'account-switched' } }); });
        expect(incumbentResolve()).toBeNull();
        expect(hook.getCurrent().resolveExecutionOrigin()).toBeNull();
        currentSources = candidates;
        await act(async () => { await publishMachineSnapshot({ profileScope: { ...scope, accountId: 'account-switched' } }); });
        await act(async () => {
            await publishMachineSnapshot({ profileScope: scope, settingsScope: scope });
            replacePluginAccountAvailabilityProjection({ scope, snapshot: {
                availabilityCursor: 2, intentReads: [], materializations: [], snapshots: [],
            } });
        });
        expect(hook.getCurrent().resolveExecutionOrigin()?.source).toEqual(source);
        expect(incumbentResolve()).toBeNull();
        expect(reactErrors.mock.calls.filter(([message]) => String(message).includes('Cannot update a component'))).toEqual([]);
        await hook.unmount();
    });

    it('admits the execution origin once for repeated host checks and re-resolves only on a real input change', async () => {
        const serverIdentityId = 'srv_origin_admission';
        const url = 'https://origin-admission.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'machine-origin-admission', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId: 'acme.admission',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'admission-root' } } };
        const candidates = [{ source: { origin, version: '1.0.0', occurrenceId: 'admission-occurrence', serverId: home.id },
            releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.admission',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            declaredDefaultOrigins: [origin], includeMachineCandidates: false }));
        // Observe the real election; its implementation is not replaced.
        const elections = vi.spyOn(executionOrigin, 'resolvePluginMachineExecutionOriginState');
        const resolve = hook.getCurrent().resolveExecutionOrigin;
        // One host operation's isCurrent/context reads: one admission, then cheap still-active checks.
        for (let check = 0; check < 50; check += 1) expect(resolve({ recordUse: false })?.machineTarget.machine).toBe(machine);
        expect(elections).toHaveBeenCalledTimes(1);
        // A real presence/inventory change re-admits, and still fails closed.
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [{ ...machine, revokedAt: Date.now() }] } }); });
        expect(resolve({ recordUse: false })).toBeNull();
        const refreshed = { ...machine, activeAt: Date.now() };
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [refreshed] } }); });
        const beforeReadmission = elections.mock.calls.length;
        for (let check = 0; check < 10; check += 1) expect(resolve({ recordUse: false })?.machineTarget.machine).toBe(refreshed);
        expect(elections.mock.calls.length - beforeReadmission).toBe(1);
        await hook.unmount();
    });

    it('holds the admitted origin across host reads with no per-read Machine check; a presence lapse arrives as a publication', async () => {
        // The presence owner publishes a lapse on its own timer; no reader polls the clock.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const serverIdentityId = 'srv_origin_held';
        const url = 'https://origin-held.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        // Count authority reads of the elected row: each Machine check reads its lock/revocation facts.
        let rowChecks = 0;
        const counted = <T extends object>(row: T): T => new Proxy(row, {
            get(target, key, receiver) { if (key === 'revokedAt') rowChecks += 1; return Reflect.get(target, key, receiver); },
        });
        // A Home without the presence fact: its presence expires on the client clock (online grace).
        const machine = counted(createMachineFixture({ id: 'machine-origin-held', active: true, activeAt: Date.now() }));
        const other = createMachineFixture({ id: 'machine-origin-other', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine, other] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId: 'acme.held',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'held-root' } } };
        const candidates = [{ source: { origin, version: '1.0.0', occurrenceId: 'held-occurrence', serverId: home.id },
            releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.held',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            declaredDefaultOrigins: [origin], includeMachineCandidates: false }));
        const elections = vi.spyOn(executionOrigin, 'resolvePluginMachineExecutionOriginState');
        const resolve = hook.getCurrent().resolveExecutionOrigin;
        expect(resolve({ recordUse: false })?.machineTarget.machine).toBe(machine);
        const admittedElections = elections.mock.calls.length;
        // One re-open's host isCurrent/context reads.
        rowChecks = 0;
        for (let check = 0; check < 50; check += 1) expect(resolve({ recordUse: false })?.machineTarget.machine).toBe(machine);
        const held = { rowChecks, elections: elections.mock.calls.length - admittedElections };
        // Another Machine's heartbeat changes nothing this decision reads.
        const { publishMachineActivity } = await import('@/sync/domains/machines/machineActivity');
        publishMachineActivity(other, { active: true, activeAt: Date.now() + 1 }, []);
        rowChecks = 0;
        const beforeHeartbeat = elections.mock.calls.length;
        expect(resolve({ recordUse: false })?.machineTarget.machine).toBe(machine);
        const heartbeat = { rowChecks, elections: elections.mock.calls.length - beforeHeartbeat };
        // The presence lapses with no store publication: the presence owner publishes it and the next read refuses.
        const beforeLapse = resolve({ recordUse: false })?.machineTarget.machine === machine;
        vi.advanceTimersByTime(61_000);
        const lapsed = resolve({ recordUse: false });
        expect({ held, heartbeat, beforeLapse, lapsed }).toEqual({ held: { rowChecks: 0, elections: 0 },
            heartbeat: { rowChecks: 0, elections: 0 }, beforeLapse: true, lapsed: null });
        await hook.unmount();
    });

    it('retains selection work across machine presentation updates while observing fresh eligibility and invocation data', async () => {
        // Observe the real expensive derivation; do not replace its implementation.
        const createFacts = vi.spyOn(executionOrigin, 'createPluginMachineExecutionOriginMachineFacts');
        const serverIdentityId = 'srv_origin_presence';
        const url = 'https://origin-presence.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'machine-origin-presence', active: true, activeAt: Date.now(), updatedAt: 10, presenceProtocolVersion: 1 });
        machine.metadata = { ...machine.metadata!, displayName: 'Before' };
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } } });
        const origin = { serverIdentityId, sourceRef: { machineId: machine.id, pluginId: 'acme.presence',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'presence-root' } } };
        const source = { origin, version: '1.0.0', occurrenceId: 'presence-occurrence', serverId: home.id };
        const candidates = [{ source, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
        const defaults = [origin];
        let renders = 0;
        // Own the clock before mount so its Machine deadline remains scheduled
        // while unrelated deadline wakes and the expiry are advanced below.
        vi.useFakeTimers();
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginMachineExecutionOriginSelection({ pluginId: 'acme.presence',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: candidates,
            declaredDefaultOrigins: defaults, includeMachineCandidates: false });
        });
        const initial = hook.getCurrent();
        expect(createFacts.mock.calls.length).toBeGreaterThan(0);
        expect(initial.canExecute).toBe(true);
        expect(initial.resolveExecutionOrigin()?.machineTarget.machine).toBe(machine);

        // Runtime/parent rerenders can replace store-selector closures without
        // replacing inventory facts. Observe serialization itself, forwarding JSON.
        const stringify = vi.spyOn(JSON, 'stringify');
        const machineFactsSerializations = () => stringify.mock.calls.filter(([value]) => Array.isArray(value)
            && (value[0] === serverIdentityId && value[1] === machine.id
                || value.some(row => Array.isArray(row) && row[0] === serverIdentityId && row[1] === machine.id))).length;
        // The shell reporter and open surface retain their own candidate
        // projections. Different declaration references need the same Machine facts.
        const detailedCandidates = candidates.map(candidate => ({ ...candidate, source: { ...candidate.source } }));
        const detailedHook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId: 'acme.presence',
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(), sourceCandidates: detailedCandidates,
            declaredDefaultOrigins: defaults }));
        expect(detailedHook.getCurrent().canExecute).toBe(true);
        expect(detailedHook.getCurrent().candidates).toBe(hook.getCurrent().candidates);
        await hook.rerender();
        const settledSerializations = machineFactsSerializations();
        const settledFactCalls = createFacts.mock.calls.length;
        for (let index = 0; index < 5; index++) {
            await hook.rerender();
            await detailedHook.rerender();
        }
        console.info('execution-origin equal targets: 5 rerenders of 2 consumers', {
            factProjectionCreations: createFacts.mock.calls.length - settledFactCalls,
            serializations: machineFactsSerializations() - settledSerializations,
        });
        expect(createFacts.mock.calls.length - settledFactCalls).toBe(0);
        expect(machineFactsSerializations()).toBe(settledSerializations);
        await detailedHook.unmount();

        const initialSerializations = createFacts.mock.calls.length;
        for (let version = 1; version <= 100; version += 1) {
            await act(async () => { await publishMachineSnapshot({ settingsVersion: version }); });
        }
        const redundantSerializations = createFacts.mock.calls.length - initialSerializations;
        console.info('execution-origin unchanged inventory: 100 settings-version updates, fact projection creations =', redundantSerializations);
        expect(redundantSerializations).toBe(0);
        expect(hook.getCurrent().candidates).toBe(initial.candidates);
        expect(hook.getCurrent().canExecute).toBe(true);
        const settledRenders = renders;
        const beforePresentationRefresh = machineFactsSerializations();

        // Another surface's relative-time wake is not a Machine eligibility change.
        const unrelatedWake = {};
        sessionListRuntimeClock.requestWake(unrelatedWake, Date.now() + 1);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        sessionListRuntimeClock.clearWake(unrelatedWake);
        expect(renders).toBe(settledRenders);
        expect(hook.getCurrent().state).toBe(initial.state);

        let refreshed = { ...machine, activeAt: Date.now(), updatedAt: 11,
            metadata: { ...machine.metadata!, displayName: 'After' } };
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [refreshed] } }); });
        expect(renders).toBe(settledRenders);
        expect(hook.getCurrent().machineCandidates).toEqual([]);
        expect(hook.getCurrent().candidates).toBe(initial.candidates);
        expect(hook.getCurrent().state).toBe(initial.state);
        expect(hook.getCurrent().canExecute).toBe(true);
        expect(initial.resolveExecutionOrigin()?.machineTarget.machine).toBe(refreshed);
        expect(machineFactsSerializations()).toBe(beforePresentationRefresh);

        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(hook.getCurrent().canExecute).toBe(true);
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [{ ...refreshed, active: false }] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        // Fresh Machine activity, not an unrelated preference write, restores eligibility.
        refreshed = { ...refreshed, activeAt: Date.now() };
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [refreshed] } }); });
        expect(hook.getCurrent().canExecute).toBe(true);

        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [{ ...refreshed,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['unknown'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        for (const [changed, reason] of [
            [{ ...refreshed, revokedAt: Date.now() }, 'revoked'],
            [{ ...refreshed, replacedByMachineId: 'replacement' }, 'replaced'],
        ] as const) {
            await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [changed] } }); });
            expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: [reason] });
            expect(hook.getCurrent().canExecute).toBe(false);
            expect(initial.resolveExecutionOrigin()).toBeNull();
        }
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [{ ...refreshed, active: false, activeAt: 0 }] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [refreshed] } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        // A failed list read never proves the admitted, presence-fresh Machine gone; a signed-out Home does.
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'error' } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'signedOut' } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['stale'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'idle' } }); });
        expect(hook.getCurrent().canExecute).toBe(true);
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['missing'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        await act(async () => { await publishMachineSnapshot({ machineListStatusByServerId: { [home.id]: 'loading' } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['unknown'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        expect(initial.resolveExecutionOrigin()).toBeNull();
        // Advancing wall time and heartbeat timestamps cannot change admission;
        // the server's next presence publication does.
        vi.useFakeTimers();
        const renewed = { ...refreshed, activeAt: Date.now() };
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [renewed] },
            machineListStatusByServerId: { [home.id]: 'idle' } }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        const heartbeat = { ...renewed, activeAt: Date.now() };
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [heartbeat] } }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(hook.getCurrent().canExecute).toBe(true);
        // A heartbeat preserves semantic eligibility, but a later Availability
        // publication must classify against the renewed census, not the
        // selector's retained presentation timestamp from before that heartbeat.
        await act(async () => { replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 2, intentReads: [], materializations: [], snapshots: [],
        } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'selected', origin });
        expect(hook.getCurrent().candidates.every(candidate => candidate.validation.kind === 'admitted')).toBe(true);
        await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: [{ ...heartbeat, active: false }] } }); });
        expect(hook.getCurrent().state).toMatchObject({ kind: 'unavailable', reasons: ['offline'] });
        expect(hook.getCurrent().canExecute).toBe(false);
        vi.useRealTimers();
        await hook.unmount();
    });

    it('shares Fleet classification across plugin selectors over one inventory projection', async () => {
        const { performance } = await import('node:perf_hooks');
        const serverIdentityId = 'srv_projection_probe';
        const url = 'https://projection-probe.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machines = Array.from({ length: 122 }, (_, index) => createMachineFixture({
            id: `probe-${index}`, active: true, activeAt: Date.now() + index,
        }));
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true, machines: {},
            machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [],
        } });
        const fleet = await import('./fleetUnion');
        // Instrument real classification, retaining Fleet's policy. Repeating it
        // per plugin is the measured CPU defect, rather than a render-count contract.
        const classify = vi.spyOn(fleet, 'resolveFleetMachineRejection');
        const classifySnapshot = vi.spyOn(fleet, 'resolveFleetSnapshotMachineRejection');
        const unmounts: Array<() => Promise<void>> = [];
        const start = performance.now();
        try {
            for (let plugin = 0; plugin < 12; plugin += 1) {
                const pluginId = `external.probe-${plugin}`;
                const sources = machines.map(machine => ({ source: { origin: { serverIdentityId,
                    sourceRef: { machineId: machine.id, pluginId, sourceCustody: {
                        kind: 'development' as const, registeredRootId: machine.id,
                    } } }, version: '1.0.0', occurrenceId: machine.id, serverId: home.id },
                    releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }));
                const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({
                    pluginId, sourceCandidates: sources, autoPick: true, renderedVersion: '1.0.0',
                    includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(),
                }));
                unmounts.push(hook.unmount);
                expect(hook.getCurrent().selectedOrigin).toEqual(sources.at(-1)!.source.origin);
                expect(hook.getCurrent().canExecute).toBe(true);
            }
            const mountMs = performance.now() - start;
            const classifications = classify.mock.calls.length;
            const policyClassifications = classifySnapshot.mock.calls.length;
            const updateStart = performance.now();
            await act(async () => { await publishMachineSnapshot({ machineListByServerId: { [home.id]: machines.map(machine => ({
                ...machine, activeAt: machine.activeAt + 1,
            })) } }); });
            console.info('execution-origin projection probe', JSON.stringify({ machines: machines.length, plugins: unmounts.length,
                mountMs, heartbeatMs: performance.now() - updateStart, classifications, policyClassifications }));
            // All plugin targets belong to the same inventory: target-by-target
            // snapshot scans must not be repeated for each plugin's candidates/facts.
            expect(classifications).toBeLessThanOrEqual(machines.length);
            expect(policyClassifications).toBe(machines.length);
        } finally {
            for (const unmount of unmounts) await unmount();
        }
    });

    // The shell holds one selector per plugin over the Account's whole materialization list. A plugin's
    // republished candidate facts must not make every selector rescan that list (plugins × installations).
    it('reads the Account materialization list once per publication, not once per plugin selector render', async () => {
        const serverIdentityId = 'srv_materialization_scan';
        const url = 'https://materialization-scan.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machines = Array.from({ length: 6 }, (_, index) => createMachineFixture({ id: `scan-${index}`, active: true, activeAt: Date.now() }));
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true, machines: {},
            machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
        const pluginIds = Array.from({ length: 10 }, (_, index) => `acme.scan-${index}`);
        const materializations = pluginIds.flatMap(pluginId => machines.map((machine): PluginMachineMaterializationV1 => ({
            serverIdentityId, machineId: machine.id, materializationId: `${pluginId}-${machine.id}`, pluginId, version: '1.0.0',
            sourceClass: 'bundledFirstParty', portableRelease: true, enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [] })));
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations, snapshots: [] } });
        const sourcesFor = (pluginId: string) => [{ source: { origin: { serverIdentityId, sourceRef: { machineId: machines[0]!.id, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'scan-root' } } }, version: '1.0.0', occurrenceId: `${pluginId}-occurrence`,
            serverId: home.id }, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        const Selector = React.memo(function Selector(props: Readonly<{ pluginId: string; sources: ReturnType<typeof sourcesFor> }>) {
            usePluginMachineExecutionOriginSelection({ pluginId: props.pluginId, sourceCandidates: props.sources, includeMachineCandidates: false,
                observeOriginsOnly: true, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(props.pluginId) });
            return null;
        });
        const shell = () => <>{pluginIds.map(pluginId => <Selector key={pluginId} pluginId={pluginId} sources={sourcesFor(pluginId)} />)}</>;
        const screen = await renderScreen(shell());
        // Work counter: rows visited by scans of a list as long as the Account's materialization list.
        const filter = Array.prototype.filter;
        let rowsScanned = 0;
        const scan = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], ...args) {
            if (this.length === materializations.length) rowsScanned += this.length;
            return filter.apply(this, args as Parameters<typeof filter>);
        });
        try {
            // Every plugin's candidate facts republish (equal content, new identity), as one Machine transition does.
            await screen.update(shell());
            expect(rowsScanned).toBeLessThanOrEqual(materializations.length);
        } finally {
            scan.mockRestore();
            await screen.unmount();
        }
    });

    it('recomputes candidates and reasons on A-to-B-to-A without refreshing stable inputs', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: FIXTURE_ACCOUNT_ID };
        await publishMachineSnapshot({ profileScope: scope });
        const materializationA: PluginMachineMaterializationV1 = {
            serverIdentityId: 'srv_one',
            machineId: 'machine-a',
            materializationId: 'mat-a',
            pluginId: 'acme.plugin-a',
            version: '1.0.0',
            sourceClass: 'registryPackage',
            portableRelease: true,
            uiArtifacts: [],
            enabled: false,
            trustState: 'trusted',
            observedAt: 100,
        };
        const materializationB: PluginMachineMaterializationV1 = {
            ...materializationA,
            pluginId: 'acme.plugin-b',
            materializationId: 'mat-b',
            enabled: true,
            trustState: 'revoked',
        };
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: {
                availabilityCursor: 1,
                intentReads: [],
                materializations: [materializationA, materializationB],
                snapshots: [],
            },
        });

        // No internal mocks: native persistence adapters come from the standard
        // Vitest harness; the projection, classifier, inventory and selection run real.
        const hook = await renderHook(({ pluginId }: { pluginId: string }) => {
            const reader = useActivePluginAccountAvailabilityReader();
            const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
            const machineSnapshots = useAllProfileMachineInventorySnapshots();
            return {
                reader,
                classifyRelease,
                machineSnapshots,
                selection: usePluginMachineExecutionOriginSelection({ pluginId, classifyRelease }),
            };
        }, { initialProps: { pluginId: materializationA.pluginId } });

        const initial = hook.getCurrent();
        expect(initial.reader).not.toBeNull();
        expect(initial.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationA.pluginId]);
        expect(initial.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['disabled'] });

        const next = await hook.rerender({ pluginId: materializationB.pluginId });
        expect(next.reader).toBe(initial.reader);
        expect(next.classifyRelease).toBe(initial.classifyRelease);
        expect(next.machineSnapshots).toBe(initial.machineSnapshots);
        expect(next.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationB.pluginId]);
        expect(next.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['revoked'] });

        const returned = await hook.rerender({ pluginId: materializationA.pluginId });
        expect(returned.selection.candidates.map((candidate) => getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).pluginId))
            .toEqual([materializationA.pluginId]);
        expect(returned.selection.state).toMatchObject({ kind: 'unavailable', reasons: ['disabled'] });
        await hook.unmount();
    });

    it('keeps retained external-store selectors stable when execution-origin inputs change', async () => {
        // Observe the callbacks passed to React without replacing any hook or store logic.
        vi.mocked(React.useMemo).mockClear();
        const serverIdentityId = 'srv_retained_origin';
        const url = 'https://retained-origin.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machines = Array.from({ length: 90 }, (_, index) => createMachineFixture({
            id: `retained-machine-${index}`, active: index === 0, activeAt: index === 0 ? Date.now() : 0,
        }));
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, isDataReady: true,
            machines: {}, machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
        const sourceFor = (pluginId: string, machineId: string) => [{
            source: { origin: { serverIdentityId, sourceRef: { machineId, pluginId,
                sourceCustody: { kind: 'development' as const, registeredRootId: 'retained-source-root' } } },
                version: '1.0.0', occurrenceId: `${pluginId}-occurrence`, serverId: home.id },
            releaseContent: 'matched' as const, validation: { kind: 'admitted' as const },
        }];
        const sourceA = sourceFor('acme.retained-a', machines[0]!.id);
        const sourceB = sourceFor('acme.retained-b', machines[1]!.id);
        const hook = await renderHook(({ pluginId, sources }: { pluginId: string; sources: typeof sourceA }) =>
            usePluginMachineExecutionOriginSelection({ pluginId, sourceCandidates: sources,
                includeMachineCandidates: false, classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier() }),
        { initialProps: { pluginId: 'acme.retained-a', sources: sourceA } });
        const readSelector = () => {
            const callback = readOriginSnapshotCallback();
            expect(callback).toBeTypeOf('function');
            return callback!;
        };
        const retained = readSelector();
        await hook.rerender({ pluginId: 'acme.retained-b', sources: sourceB });
        const current = readSelector();
        expect(current).not.toBe(retained);
        const before = retained();
        const currentBefore = current();
        expect(currentBefore).not.toEqual(before);
        expect(retained()).toBe(before);
        expect(current()).toBe(currentBefore);
        const adapter = vi.mocked(React.useMemo).mock.results.map(result => result.type === 'return' ? result.value : null)
            .filter((value): value is { get: () => unknown; subscribe: (listener: () => void) => () => void; publish: (inputs: null) => void } => {
            return Boolean(value && typeof value === 'object' && 'get' in value && value.get === current
                && 'subscribe' in value && typeof value.subscribe === 'function'
                && 'publish' in value && typeof value.publish === 'function');
        }).at(-1);
        expect(adapter).toBeDefined();
        if (!adapter) throw new Error('missing origin snapshot adapter');
        const notify = vi.fn();
        const stop = adapter.subscribe(notify);
        await act(async () => { adapter.publish(null); });
        expect(notify).toHaveBeenCalledTimes(1);
        const disabled = current();
        notify.mockClear();
        await act(async () => { adapter.publish(null); });
        expect(current()).toBe(disabled);
        expect(notify).not.toHaveBeenCalled();
        stop();
        await hook.unmount();
    });

    it('does not re-render a selection for Availability observation clocks or another plugin\'s machine rows', async () => {
        const serverIdentityId = 'srv_observation_clock';
        const url = 'https://observation-clock.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'observation-clock-machine', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, machines: {},
            machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        observeMachinePresenceForTest(scope, [machine.id]);
        const pluginId = 'acme.observation-clock';
        const registryPackage = createRegistryNpmPackageFixture({ packageName: 'acme-observation-clock', pluginId,
            title: 'Observation fixture', version: '1.0.0' });
        const manifest = registryPackage.happier.compatibilityProjection.manifest;
        const archive = createPackageAssetArchiveV1({ manifest, files: [] });
        if (!archive) throw new Error('Expected the registry fixture package archive');
        const release = normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version },
            archiveDigestSha256: `sha256:${'b'.repeat(64)}`, normalizedManifest: manifest,
            collectionContracts: [], uiSlots: [], packageAssetArchive: archive.descriptor });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: manifest.version,
                enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'observation-fixture-intent' },
            release, packageAssets: [], uiArtifacts: [] });
        const row = (id: string, rowPluginId: string, observedAt: number) => ({
            serverIdentityId, machineId: machine.id, materializationId: id, pluginId: rowPluginId, version: '1.0.0',
            sourceClass: 'registryPackage' as const, portableRelease: true, archiveDigestSha256: release.archiveDigestSha256,
            enabled: true, trustState: 'trusted' as const, observedAt, uiArtifacts: [] });
        const publish = (cursor: number, rows: readonly ReturnType<typeof row>[]) => replacePluginAccountAvailabilityProjection({
            scope, snapshot: { availabilityCursor: cursor, intentReads: [{ pluginId, response }],
                materializations: rows, snapshots: [{ serverIdentityId, machineId: machine.id, materializations: rows }] } });
        publish(1, [row('own', pluginId, 1), row('peer', 'acme.peer', 1)]);
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginMachineExecutionOriginSelection({ pluginId, includeMachineCandidates: false,
                classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(pluginId) });
        });
        const initial = hook.getCurrent();
        expect(initial.candidates).toHaveLength(1);
        const settledRenders = renders;
        for (let index = 1; index <= 20; index += 1) {
            // Clock-only republication of this plugin's row, then a real peer-plugin row change.
            await act(async () => { publish(1 + index * 2, [row('own', pluginId, 1 + index), row('peer', 'acme.peer', 1)]); });
            await act(async () => { publish(2 + index * 2, [row('own', pluginId, 1 + index), row('peer', 'acme.peer', 1 + index)]); });
        }
        console.info('execution-origin observation clocks: 40 publications, selection renders =', renders - settledRenders);
        expect(renders).toBe(settledRenders);
        expect(hook.getCurrent().candidates).toBe(initial.candidates);
        expect(hook.getCurrent().state).toBe(initial.state);
        // A real change to this plugin's own supply still re-renders.
        await act(async () => { publish(100, [{ ...row('own', pluginId, 50), enabled: false }, row('peer', 'acme.peer', 1)]); });
        expect(renders).toBeGreaterThan(settledRenders);
        await hook.unmount();
    });

    it('does not re-render a selection for machine-activity heartbeats that change nothing it presents', async () => {
        const serverIdentityId = 'srv_heartbeat_idle';
        const url = 'https://heartbeat-idle.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'heartbeat-machine', active: true, activeAt: Date.now() });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, machines: {},
            machineListByServerId: { [home.id]: [machine] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        observeMachinePresenceForTest(scope, [machine.id]);
        const pluginId = 'acme.heartbeat-idle';
        const registryPackage = createRegistryNpmPackageFixture({ packageName: 'acme-heartbeat-idle', pluginId,
            title: 'Observation fixture', version: '1.0.0' });
        const manifest = registryPackage.happier.compatibilityProjection.manifest;
        const archive = createPackageAssetArchiveV1({ manifest, files: [] });
        if (!archive) throw new Error('Expected the registry fixture package archive');
        const release = normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version },
            archiveDigestSha256: `sha256:${'b'.repeat(64)}`, normalizedManifest: manifest,
            collectionContracts: [], uiSlots: [], packageAssetArchive: archive.descriptor });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: manifest.version,
                enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'observation-fixture-intent' },
            release, packageAssets: [], uiArtifacts: [] });
        const row = (id: string, rowPluginId: string, observedAt: number) => ({
            serverIdentityId, machineId: machine.id, materializationId: id, pluginId: rowPluginId, version: '1.0.0',
            sourceClass: 'registryPackage' as const, portableRelease: true, archiveDigestSha256: release.archiveDigestSha256,
            enabled: true, trustState: 'trusted' as const, observedAt, uiArtifacts: [] });
        const publish = (cursor: number, rows: readonly ReturnType<typeof row>[]) => replacePluginAccountAvailabilityProjection({
            scope, snapshot: { availabilityCursor: cursor, intentReads: [{ pluginId, response }],
                materializations: rows, snapshots: [{ serverIdentityId, machineId: machine.id, materializations: rows }] } });
        publish(1, [row('own', pluginId, 1), row('peer', 'acme.peer', 1)]);
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginMachineExecutionOriginSelection({ pluginId, includeMachineCandidates: false,
                classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(pluginId) });
        });
        const initial = hook.getCurrent();
        expect(initial.candidates).toHaveLength(1);
        await act(async () => { storage.getState().applyMachineActivityUpdates([{ id: machine.id, active: true, activeAt: Date.now() }], { sourceServerId: home.id }); });
        const heartbeatBaseline = renders;
        for (let index = 1; index <= 20; index += 1) {
            await act(async () => {
                storage.getState().applyMachineActivityUpdates([machine].map(entry => ({ id: entry.id, active: true,
                    activeAt: Date.now() + index })), { sourceServerId: home.id });
            });
        }
        console.info('execution-origin heartbeats: 20 arrivals, selection renders =', renders - heartbeatBaseline);
        expect(renders).toBe(heartbeatBaseline);
        await hook.unmount();
    });

    it('wakes an origins-only observer for selectable-origin changes, not for another Machine\'s rejection reason', async () => {
        const serverIdentityId = 'srv_origins_only';
        const url = 'https://origins-only.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const live = createMachineFixture({ id: 'origins-only-live', active: true, activeAt: Date.now() });
        const other = createMachineFixture({ id: 'origins-only-other', active: false, activeAt: 1 });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope, machines: {},
            machineListByServerId: { [home.id]: [live, other] }, machineListStatusByServerId: { [home.id]: 'idle' } });
        observeMachinePresenceForTest(scope, [live.id, other.id]);
        const pluginId = 'acme.origins-only';
        const registryPackage = createRegistryNpmPackageFixture({ packageName: 'acme-origins-only', pluginId,
            title: 'Origins only fixture', version: '1.0.0' });
        const manifest = registryPackage.happier.compatibilityProjection.manifest;
        const archive = createPackageAssetArchiveV1({ manifest, files: [] });
        if (!archive) throw new Error('Expected the registry fixture package archive');
        const release = normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version },
            archiveDigestSha256: `sha256:${'b'.repeat(64)}`, normalizedManifest: manifest,
            collectionContracts: [], uiSlots: [], packageAssetArchive: archive.descriptor });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: manifest.version,
                enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'origins-only-intent' },
            release, packageAssets: [], uiArtifacts: [] });
        const row = (machineId: string) => ({ serverIdentityId, machineId, materializationId: `m-${machineId}`, pluginId,
            version: '1.0.0', sourceClass: 'registryPackage' as const, portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256, enabled: true, trustState: 'trusted' as const, observedAt: 1, uiArtifacts: [] });
        const rows = [row(live.id), row(other.id)];
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [{ pluginId, response }],
            materializations: rows, snapshots: [{ serverIdentityId, machineId: live.id, materializations: [rows[0]!] },
                { serverIdentityId, machineId: other.id, materializations: [rows[1]!] }] } });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return usePluginMachineExecutionOriginSelection({ pluginId, includeMachineCandidates: false, observeOriginsOnly: true,
                classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier(pluginId) });
        });
        const settledRenders = renders;
        expect(hook.getCurrent().candidates).toHaveLength(2);
        // offline -> revoked changes the unselectable Machine's rejection reason, not any selectable origin.
        await act(async () => await publishMachineSnapshot({ machineListByServerId: { [home.id]: [live, { ...other, revokedAt: Date.now() }] } }));
        console.info('origins-only observer: rejection-reason change renders =', renders - settledRenders);
        expect(renders).toBe(settledRenders);
        // The other Machine becoming selectable is a real change to what the observer reports.
        await act(async () => await publishMachineSnapshot({ machineListByServerId: { [home.id]: [live, { ...other, active: true, activeAt: Date.now(), revokedAt: null }] } }));
        expect(renders).toBeGreaterThan(settledRenders);
        await hook.unmount();
    });

    it('keeps React snapshots stable as time passes until authoritative activity changes', async () => {
        const serverIdentityId = 'srv_snapshot_expiry';
        const url = 'https://snapshot-expiry.example.test';
        await network.addHome(url, FIXTURE_ACCOUNT_ID);
        const home = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: serverIdentityId,
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        await setActiveServerId(home.id);
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const scope = { serverId: home.id, accountId: FIXTURE_ACCOUNT_ID };
        const machine = createMachineFixture({ id: 'snapshot-expiry-machine', active: true, activeAt: Date.now(), presenceProtocolVersion: 1 });
        await publishMachineSnapshot({ profileScope: scope, settingsScope: scope,
            machines: {}, machineListByServerId: { [home.id]: [machine] },
            machineListStatusByServerId: { [home.id]: 'idle' } });
        // The socket boundary may withdraw retained presence. Publishing raw
        // fixture rows does not itself observe fresh ingress for this Account.
        observeMachinePresenceForTest(scope, [machine.id]);
        // A non-bundled plugin supplies both a portable installation and a development source.
        const pluginId = 'acme.snapshot-expiry';
        const registryPackage = createRegistryNpmPackageFixture({ packageName: 'acme-snapshot-expiry', pluginId,
            title: 'Snapshot fixture', version: '1.0.0' });
        const manifest = registryPackage.happier.compatibilityProjection.manifest;
        const archive = createPackageAssetArchiveV1({ manifest, files: [] });
        if (!archive) throw new Error('Expected the registry fixture package archive');
        const release = normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
            collectionContracts: [], uiSlots: [], packageAssetArchive: archive.descriptor });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: manifest.version,
                enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'snapshot-fixture-intent' },
            release, packageAssets: [], uiArtifacts: [] });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 1, intentReads: [{ pluginId, response }], snapshots: [], materializations: [{
                serverIdentityId, machineId: machine.id, materializationId: 'installed-external-plugin',
                pluginId, version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                archiveDigestSha256: release.archiveDigestSha256,
                enabled: true, trustState: 'trusted', observedAt: 1, uiArtifacts: [],
            }],
        } });
        const sources = [{ source: {
            origin: { serverIdentityId, sourceRef: { machineId: machine.id, pluginId,
                sourceCustody: { kind: 'development' as const, registeredRootId: 'snapshot-expiry-root' } } },
            version: '1.0.0', occurrenceId: 'snapshot-expiry-occurrence', serverId: home.id,
        }, releaseContent: 'matched' as const, validation: { kind: 'admitted' as const } }];
        externalStoreReads.reads.length = 0;
        vi.mocked(React.useMemo).mockClear();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const readAtMs = Date.now();
        const hook = await renderHook(() => usePluginMachineExecutionOriginSelection({ pluginId,
            sourceCandidates: sources, includeMachineCandidates: false,
            classifyRelease: useActivePluginAccountAvailabilityReleaseClassifier() }));
        // Observe the real getSnapshot handed to React, including the store's selector adapter.
        const readSnapshot = readOriginSnapshotCallback();
        expect(readSnapshot).toBeTypeOf('function');
        const state = storage.getState();
        const before = readSnapshot!();
        expect(readSnapshot!()).toBe(before);
        const validations = () => hook.getCurrent().candidates.map(candidate => candidate.validation);
        expect(hook.getCurrent().candidates).toHaveLength(2);
        expect(validations(), JSON.stringify(validations())).toEqual([
            { kind: 'admitted' }, { kind: 'admitted' },
        ]);
        const expiresAtMs = readAtMs + 120_000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAtMs);
        try {
            expect(storage.getState()).toBe(state);
            expect(readSnapshot!()).toBe(before);
            await act(async () => { await vi.advanceTimersByTimeAsync(expiresAtMs - readAtMs); });
            expect(storage.getState()).toBe(state);
            expect(hook.getCurrent().candidates.every(candidate => candidate.validation.kind === 'admitted')).toBe(true);
            await act(async () => {
                // This fixture deliberately has only a retained inventory projection,
                // so publish on its admitted row rather than an absent opened-row index.
                publishMachineActivityForTest([machine], { active: false, activeAt: expiresAtMs });
                storage.setState({ machineListByServerId: { [home.id]: [machine] } });
            });
            expect(hook.getCurrent().candidates).toHaveLength(2);
            expect(hook.getCurrent().candidates.every(candidate =>
                candidate.validation.kind === 'rejected' && candidate.validation.reason === 'offline')).toBe(true);
        } finally {
            clock.mockRestore();
            await hook.unmount();
        }
    });
});

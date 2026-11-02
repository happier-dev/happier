import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { LocalServiceLauncherSnapshotClient } from './useLocalServiceLauncherState';
import type { LocalServiceLauncherSnapshot } from './types';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const machineRpc = await import('./machineRpc');
const inventoryMachineRpc = await import('../inventory/machineRpc');
const { getLocalServiceLauncherState, resetLocalServiceLauncherStoreForTests } = await import('./sharedStore');
const { resetLocalServiceInventoryStoreForTests } = await import('../inventory/sharedStore');
const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { useLocalServiceLauncherStateController } = await import('./useLocalServiceLauncherState');

const initialSnapshot = {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 1_000,
    targets: [{
        id: 'managed:preview',
        source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Preview',
        confidence: 'medium',
        state: 'available',
        actions: ['start'],
    }],
} satisfies LocalServiceLauncherSnapshot;

const startedSnapshot = {
    ...initialSnapshot,
    updatedAt: 2_000,
    targets: [{
        ...initialSnapshot.targets[0],
        state: 'starting',
        actions: [],
    }],
} satisfies LocalServiceLauncherSnapshot;

async function createHookHome() {
    const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
    const home = await createPlainArtifactHomeFixture('https://launcher-state.example.test', { accountId: 'account-a' });
    onTestFinished(() => home.dispose());
    return home.home.id;
}

describe('useLocalServiceLauncherState', () => {
    beforeEach(() => {
        // Launcher readiness follows genuine inventory transport, even with an injected launcher reader.
        vi.spyOn(inventoryMachineRpc, 'fetchLocalServiceInventorySnapshotViaMachineRpc').mockResolvedValue({
            ok: true,
            snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] },
        });
        vi.spyOn(inventoryMachineRpc, 'watchLocalServiceInventorySnapshotViaMachineRpc')
            .mockImplementation(async () => new Promise(() => {}));
    });
    afterEach(async () => {
        await standardCleanup();
        resetLocalServiceLauncherStoreForTests();
        resetLocalServiceInventoryStoreForTests();
        vi.restoreAllMocks();
    });

    it('lists the Project running Service in Browser through the Services scope without another inventory read', async () => {
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://project-browser-services.example.test', accountId: 'account-a' });
        onTestFinished(() => connection.dispose());
        const { useBrowserSurfaceHostProps } = await import('@/components/browser/surfaces/useBrowserSurfaceHostProps');
        const workspaceRoot = '/repo/project-browser';
        const snapshot = {
            ...initialSnapshot,
            sessionId: undefined,
            targets: [{ ...initialSnapshot.targets[0], title: 'l12fx-http', serviceState: 'running',
                cwd: workspaceRoot, endpointUrl: 'http://127.0.0.1:42879', actions: ['register_preview'] }],
        } satisfies LocalServiceLauncherSnapshot;
        // The daemon transport returns this Project's services only for its workspace query.
        const snapshotClient = vi.fn<LocalServiceLauncherSnapshotClient>(async input => ({ ok: true,
            snapshot: { ...snapshot, targets: input.scope === 'workspace' && input.workspaceRoot === workspaceRoot ? snapshot.targets : [] },
        }));
        const services = await renderHook(() => useLocalServiceLauncherStateController({
            machineId: 'machine-a', serverId: connection.serverId, scope: 'workspace', workspaceRoot, snapshotClient,
        }));
        await vi.waitFor(() => expect(services.getCurrent().state.targetsById.get('managed:preview')?.serviceState).toBe('running'));
        await flushHookEffects();
        const reads = snapshotClient.mock.calls.length;
        const inventoryReads = vi.mocked(inventoryMachineRpc.fetchLocalServiceInventorySnapshotViaMachineRpc).mock.calls.length;
        const inventoryWatches = vi.mocked(inventoryMachineRpc.watchLocalServiceInventorySnapshotViaMachineRpc).mock.calls.length;
        const browserInput = {
            scope: 'workspaceDetails' as const, workspaceRefId: 'project-browser', workspaceRoot,
            machineId: 'machine-a', serverId: connection.serverId, launcherSnapshotClient: snapshotClient,
            localServicePreviewState: null,
        };
        const browser = await renderHook(() => useBrowserSurfaceHostProps(browserInput));
        try {
            await vi.waitFor(() => expect(browser.getCurrent().launchpadRows).toEqual([
                expect.objectContaining({ title: 'l12fx-http', section: 'running',
                    serviceRow: expect.objectContaining({ status: 'running' }) }),
            ]));
            expect(browser.getCurrent().localServiceTargets).toEqual(snapshot.targets);
            await flushHookEffects();
            expect(snapshotClient).toHaveBeenCalledTimes(reads);
            expect(inventoryMachineRpc.fetchLocalServiceInventorySnapshotViaMachineRpc).toHaveBeenCalledTimes(inventoryReads);
            expect(inventoryMachineRpc.watchLocalServiceInventorySnapshotViaMachineRpc).toHaveBeenCalledTimes(inventoryWatches);
            browserInput.workspaceRoot = '/repo/other-checkout';
            await browser.rerender();
            await vi.waitFor(() => expect(browser.getCurrent().feed.refreshStatus).toBe('idle'));
            expect(browser.getCurrent().launchpadRows).toEqual([]);
            expect(services.getCurrent().state.targetsById.get('managed:preview')?.title).toBe('l12fx-http');
            expect(inventoryMachineRpc.fetchLocalServiceInventorySnapshotViaMachineRpc).toHaveBeenCalledTimes(inventoryReads);
            expect(inventoryMachineRpc.watchLocalServiceInventorySnapshotViaMachineRpc).toHaveBeenCalledTimes(inventoryWatches);
        } finally {
            await browser.unmount();
            await services.unmount();
        }
    });

    it.each(['hidden', 'unmounted'] as const)('drops retained launcher facts on actual credential retirement after becoming %s', async visibility => {
        const serverUrl = `https://launcher-retirement-${visibility}.example.test`;
        const connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a' });
        onTestFinished(() => connection.dispose());
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        const resolved = await resolveServerCredentialAccountScope(connection.serverId);
        if (resolved.kind !== 'bound' || !resolved.credentialKey) throw new Error('Expected real credential-qualified Home');
        const key = { machineId: 'machine-a', serverId: resolved.scope.serverId, sessionId: 'session-a',
            accountId: resolved.scope.accountId, credentialKey: resolved.credentialKey };
        const watchSignals: AbortSignal[] = [];
        vi.spyOn(inventoryMachineRpc, 'watchLocalServiceInventorySnapshotViaMachineRpc').mockImplementation(async input => {
            if (input.signal) watchSignals.push(input.signal);
            return new Promise(() => {});
        });
        const snapshotClient = vi.fn<LocalServiceLauncherSnapshotClient>(async () => ({ ok: true, snapshot: initialSnapshot }));
        function Probe() {
            useLocalServiceLauncherStateController({ ...key, snapshotClient });
            return null;
        }
        const frame = (active: boolean) => <RetainedPanelSurface isActive={active}><Probe /></RetainedPanelSurface>;
        const screen = await renderScreen(frame(true));
        await vi.waitFor(() => expect(getLocalServiceLauncherState(key).updatedAt).toBe(1_000));
        await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
        await flushHookEffects();
        if (visibility === 'hidden') await screen.update(frame(false));
        else await screen.unmount();
        expect(watchSignals[0]?.aborted).toBe(true);
        expect(getLocalServiceLauncherState(key).targetsById.get('managed:preview')?.title).toBe('Preview');
        const closedReads = snapshotClient.mock.calls.length;
        const retained = getLocalServiceLauncherState(key);
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const otherHome = await upsertServerProfileOnly({ serverUrl: `https://launcher-other-${visibility}.example.test`, name: 'Other Home' });
        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: connection.serverId }, connection.credentials)).toBe(true);
            expect(await TokenStorage.setCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id }, connection.credentials)).toBe(true);
            expect(await TokenStorage.removeCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toBe(true);
        });
        expect(getLocalServiceLauncherState(key)).toBe(retained);
        expect(snapshotClient).toHaveBeenCalledTimes(closedReads);
        await act(async () => {
            expect(await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId: connection.serverId })).toBe(true);
        });
        expect(getLocalServiceLauncherState(key).targetsById.size).toBe(0);
        await flushHookEffects();
        expect(snapshotClient).toHaveBeenCalledTimes(closedReads);
        if (visibility === 'hidden') await screen.unmount();
    });

    it('keeps qualified cached rows without hidden demand and retires real credential reads', async () => {
        const serverUrl = 'https://launcher-retained.example.test';
        const connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: 'srv_launcher_retained' });
        onTestFinished(() => connection.dispose());
        const watchSignals: AbortSignal[] = [];
        vi.spyOn(inventoryMachineRpc, 'watchLocalServiceInventorySnapshotViaMachineRpc').mockImplementation(async input => {
            if (input.signal) watchSignals.push(input.signal);
            return new Promise(() => {});
        });
        const inventorySnapshotClient = vi.fn(async () => ({ ok: true as const, snapshot: {
            v: 1 as const, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle' as const, entries: [], diagnostics: [],
        } }));
        const pending = createDeferred<Awaited<ReturnType<LocalServiceLauncherSnapshotClient>>>();
        let deferAccountA = false;
        const pendingSignals: AbortSignal[] = [];
        const snapshotClient = vi.fn<LocalServiceLauncherSnapshotClient>(async input => {
            if (input.accountId === 'account-b') return { ok: true, snapshot: { ...initialSnapshot, updatedAt: 3_000,
                targets: [{ ...initialSnapshot.targets[0]!, title: 'Account B preview' }] } };
            if (deferAccountA) {
                if (input.signal) pendingSignals.push(input.signal);
                return pending.promise;
            }
            return { ok: true, snapshot: initialSnapshot };
        });
        let latest: ReturnType<typeof useLocalServiceLauncherStateController> | undefined;
        function Probe() {
            latest = useLocalServiceLauncherStateController({ machineId: 'machine-a', serverId: connection.serverId,
                sessionId: 'session-a', snapshotClient, inventorySnapshotClient });
            return null;
        }
        const frame = (active: boolean) => <RetainedPanelSurface isActive={active}><Probe /></RetainedPanelSurface>;
        const screen = await renderScreen(frame(false));
        expect(snapshotClient).not.toHaveBeenCalled();
        expect(inventorySnapshotClient).not.toHaveBeenCalled();
        await screen.update(frame(true));
        await vi.waitFor(() => expect(latest?.state.updatedAt).toBe(1_000));
        await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
        await flushHookEffects();
        const initialReads = vi.mocked(snapshotClient).mock.calls.length;
        await screen.update(frame(false));
        expect(watchSignals[0]?.aborted).toBe(true);
        expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Preview');
        const closedInventoryReads = inventorySnapshotClient.mock.calls.length;
        await flushHookEffects();
        expect(snapshotClient).toHaveBeenCalledTimes(initialReads);
        expect(inventorySnapshotClient).toHaveBeenCalledTimes(closedInventoryReads);
        deferAccountA = true;
        await screen.update(frame(true));
        expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Preview');
        await vi.waitFor(() => expect(snapshotClient).toHaveBeenCalledTimes(initialReads + 1));
        const retiredApplySnapshot = latest!.applySnapshot;
        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: connection.serverId }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature`,
            })).toBe(true);
        });
        await vi.waitFor(() => expect(pendingSignals[0]?.aborted).toBe(true));
        await vi.waitFor(() => expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Account B preview'));
        await act(async () => {
            retiredApplySnapshot(startedSnapshot);
            pending.resolve({ ok: true, snapshot: startedSnapshot });
        });
        await flushHookEffects();
        expect(latest?.state.updatedAt).toBe(3_000);
        expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Account B preview');
        await screen.unmount();
        expect(watchSignals.every(signal => signal.aborted)).toBe(true);
    });

    it('drives the machine-RPC launcher reader when no snapshot client is injected', async () => {
        const serverId = await createHookHome();
        const mod = await import('./useLocalServiceLauncherState');

        const spy = vi.spyOn(machineRpc, 'fetchLocalServiceLauncherSnapshotViaMachineRpc')
            .mockResolvedValue({ ok: false, reason: 'unavailable' });
        await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            serverId,
            sessionId: 'session-a',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId,
        }));
    });

    it('lets the launcher state owner replace state from a successful Start response snapshot', async () => {
        await createHookHome();
        const mod = await import('./useLocalServiceLauncherState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceLauncherStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStateController) return;

        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: initialSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            sessionId: 'session-a',
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(initialSnapshot.targets);

        await act(async () => {
            hook.getCurrent().applySnapshot(startedSnapshot);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(startedSnapshot.targets);
    });

    it('ignores externally applied Start snapshots for a different session', async () => {
        await createHookHome();
        const mod = await import('./useLocalServiceLauncherState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceLauncherStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStateController) return;

        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: initialSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            sessionId: 'session-a',
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const otherSessionSnapshot = {
            ...startedSnapshot,
            sessionId: 'session-b',
        } satisfies LocalServiceLauncherSnapshot;

        await act(async () => {
            hook.getCurrent().applySnapshot(otherSessionSnapshot);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(initialSnapshot.targets);
    });
});

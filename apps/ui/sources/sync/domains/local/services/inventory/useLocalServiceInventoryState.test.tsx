import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { LocalServiceInventorySnapshot } from './store';
import type {
    LocalServiceInventorySnapshotClientResult,
    LocalServiceInventoryWatchClientResult,
} from './api';
import type { LocalServiceInventorySnapshotClient } from './useLocalServiceInventoryState';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { getLocalServiceInventoryState, resetLocalServiceInventoryStoreForTests } = await import('./sharedStore');
const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');

const snapshot = {
    v: 1,
    machineId: 'machine-a',
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [{
        id: 'vite-5173',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
    }],
    diagnostics: [],
} satisfies LocalServiceInventorySnapshot;

describe('useLocalServiceInventoryState', () => {
    let serverId: string;
    beforeEach(async () => {
        const home = await createPlainArtifactHomeFixture('https://inventory-state.example.test', { accountId: 'account-a' });
        serverId = home.home.id;
        onTestFinished(() => home.dispose());
    });
    afterEach(async () => {
        await standardCleanup();
        resetLocalServiceInventoryStoreForTests();
        vi.useRealTimers();
    });

    it.each(['hidden', 'unmounted'] as const)('drops retained inventory facts on actual credential retirement after becoming %s', async visibility => {
        const { useLocalServiceInventoryStateController } = await import('./useLocalServiceInventoryState');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const resolved = await resolveServerCredentialAccountScope(serverId);
        const serverUrl = getServerProfileById(serverId)?.serverUrl;
        if (resolved.kind !== 'bound' || !resolved.credentialKey || !serverUrl) throw new Error('Expected real credential-qualified Home');
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        if (!credentials) throw new Error('Expected stored Home credentials');
        const key = { machineId: 'machine-a', serverId: resolved.scope.serverId,
            accountId: resolved.scope.accountId, credentialKey: resolved.credentialKey };
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({ ok: true, snapshot }));
        const watchSignals: AbortSignal[] = [];
        const observationSignals: AbortSignal[] = [];
        const watchClient = vi.fn(async (input: import('./api').LocalServiceInventoryWatchClientInput): Promise<LocalServiceInventoryWatchClientResult> => {
            // The mounted Machine subscription also holds one observation-only request (363303bc81).
            if (input.signal) (input.observationOnly ? observationSignals : watchSignals).push(input.signal);
            return new Promise(() => {});
        });
        let presented = true;
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(PluginSurfaceFocusEligibilityProvider, { active: presented, children });
        const hook = await renderHook(() => useLocalServiceInventoryStateController({ ...key, snapshotClient, watchClient }), { wrapper });
        await vi.waitFor(() => expect(getLocalServiceInventoryState(key).generatedAt).toBe(1_000));
        await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
        expect(observationSignals).toHaveLength(1);
        if (visibility === 'hidden') { presented = false; await hook.rerender(); }
        else await hook.unmount();
        expect(watchSignals[0]?.aborted).toBe(true);
        expect(observationSignals[0]?.aborted).toBe(true);
        expect(getLocalServiceInventoryState(key).rowsById.size).toBe(1);
        const closedReads = snapshotClient.mock.calls.length;
        const retained = getLocalServiceInventoryState(key);
        const otherHome = await upsertServerProfileOnly({ serverUrl: `https://inventory-other-${visibility}.example.test`, name: 'Other Home' });
        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, credentials)).toBe(true);
            expect(await TokenStorage.setCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id }, credentials)).toBe(true);
            expect(await TokenStorage.removeCredentialsForServerUrl(otherHome.serverUrl, { serverId: otherHome.id })).toBe(true);
        });
        expect(getLocalServiceInventoryState(key)).toBe(retained);
        expect(snapshotClient).toHaveBeenCalledTimes(closedReads);
        await act(async () => {
            expect(await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId })).toBe(true);
        });
        expect(getLocalServiceInventoryState(key).rowsById.size).toBe(0);
        await flushHookEffects();
        expect(snapshotClient).toHaveBeenCalledTimes(closedReads);
        if (visibility === 'hidden') await hook.unmount();
    });

    it('surfaces machine-RPC snapshot rows through the controller state', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId,
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId,
            refresh: false,
        }));
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);
    });

    it('falls closed to an empty list without throwing when the client is unavailable', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: false,
            reason: 'unavailable',
        }));
        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId,
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual([]);
        expect(hook.getCurrent().state.refreshState).toBe('error');
    });

    it('keeps already-hydrated rows visible when an invalidation refresh fails (UX continuity)', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const snapshotClient: LocalServiceInventorySnapshotClient = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, snapshot })
            .mockResolvedValueOnce({ ok: false as const, reason: 'request_failed' as const });
        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId,
            snapshotClient,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);

        await act(async () => {
            hook.getCurrent().refresh?.();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledTimes(2);
        // The transient failure marks an error but does not flash the hydrated list empty.
        expect(hook.getCurrent().state.refreshState).toBe('error');
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);
    });

    it('defaults the snapshot client to the machine-RPC inventory reader', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const machineRpc = await import('./machineRpc');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const spy = vi.spyOn(machineRpc, 'fetchLocalServiceInventorySnapshotViaMachineRpc')
            .mockResolvedValue({ ok: false, reason: 'unavailable' });
        await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a' }));
        spy.mockRestore();
    });
    it('surfaces a service started after mount through the daemon inventory watch (no poll)', async () => {
        const mod = await import('./useLocalServiceInventoryState');
        const store = await import('./store');

        const emptySnapshot = { ...snapshot, entries: [] } satisfies LocalServiceInventorySnapshot;
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot: emptySnapshot,
        }));
        let answerWatch: ((result: LocalServiceInventoryWatchClientResult) => void) | null = null;
        const watchClient = vi.fn(async () => await new Promise<LocalServiceInventoryWatchClientResult>((resolve) => {
            answerWatch = resolve;
        }));

        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId,
            snapshotClient,
            watchClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual([]);
        expect(answerWatch).toBeTypeOf('function');

        // The dev server starts here: the daemon answers the parked watch with the new snapshot.
        await act(async () => {
            answerWatch?.({ ok: true, changed: true, snapshot });
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);
        // Freshness came from the parked watch, not from a second snapshot fetch.
        expect(snapshotClient).toHaveBeenCalledTimes(1);
    });

    it('re-arms exactly one watch per answer and never schedules a refresh timer', async () => {
        vi.useFakeTimers();
        const mod = await import('./useLocalServiceInventoryState');

        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        let watchCalls = 0;
        const watchClient = vi.fn(async (): Promise<LocalServiceInventoryWatchClientResult> => {
            watchCalls += 1;
            // First park answers "nothing changed"; the re-arm then stays parked like a real daemon.
            return watchCalls === 1
                ? { ok: true, changed: false }
                : await new Promise<LocalServiceInventoryWatchClientResult>(() => {});
        });

        await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId,
            snapshotClient,
            watchClient,
        }));
        await flushHookEffects({ cycles: 3, turns: 3 });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(10 * 60_000);
        });

        // No interval anywhere: the snapshot is fetched once at mount and never on a schedule,
        // and the watch re-arms exactly once per answer rather than on a timer.
        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(watchClient).toHaveBeenCalledTimes(2);
    });
});

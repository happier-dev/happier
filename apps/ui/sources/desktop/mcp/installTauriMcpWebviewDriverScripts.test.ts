import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTauriMcpWebviewDriverScripts } from './installTauriMcpWebviewDriverScripts';
import { maybeInstallTauriMcpBridge } from './maybeInstallTauriMcpBridge';
import { SystemTaskSpecSchema, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { DesktopActivityOverlaySyncPayload } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { hasDesktopActivityOverlayQaFixtureProducer, selectDesktopActivityOverlayQaFixture, registerDesktopActivityOverlayQaFixtureProducer } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtureSelection';
import { controlPersonalHomeBootstrapQaMutationPause } from '@/components/personalHome/bootstrap/personalHomeBootstrapQaMutationPause';
import { storage } from '@/sync/domains/state/storage';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

// The actual default task runner and overlay bridge terminate at this native IPC boundary.
const native = vi.hoisted(() => ({
    nextTaskId: 0,
    taskSpecs: [] as SystemTaskSpec[],
    taskData: {} as Record<string, unknown>,
    taskResults: new Map<string, unknown>(),
    listeners: new Map<string, (payload: unknown) => void>(),
    overlayPayloads: [] as DesktopActivityOverlaySyncPayload[],
    overlayState: null as DesktopActivityOverlaySyncPayload | null,
    presentationRequests: [] as string[],
}));

vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    desktopHostKind: () => 'tauri',
    isDesktopHost: () => true,
    invokeDesktopHost: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'start_system_task') {
            const spec = SystemTaskSpecSchema.parse(JSON.parse(String(args?.specJson)));
            native.taskSpecs.push(spec);
            const taskId = `mcp_native_${++native.nextTaskId}`;
            native.taskResults.set(taskId, { protocolVersion: 1, taskId, ok: true, data: native.taskData });
            return { taskId };
        }
        if (command === 'get_system_task_snapshot') {
            return { events: [], result: native.taskResults.get(String(args?.taskId)) };
        }
        if (command === 'desktop_activity_overlay_sync') {
            // IPC receives the real producer's payload; the simulated host retains it verbatim.
            const payload = args?.payload as DesktopActivityOverlaySyncPayload;
            native.overlayPayloads.push(payload);
            native.overlayState = payload;
            return;
        }
        if (command === 'desktop_activity_overlay_get_window_state') return native.overlayState;
        if (command === 'desktop_activity_overlay_request_presentation') { native.presentationRequests.push(String(args?.requestedState)); return; }
        throw new Error(`Unexpected desktop IPC command: ${command}`);
    },
    listenDesktopHostEvent: async (event: string, listener: (payload: unknown) => void) => {
        native.listeners.set(event, listener);
        return () => { native.listeners.delete(event); };
    },
}));

type QaCommands = {
    applyHappierLocalSettings: (delta: unknown) => Promise<Record<string, unknown>>;
    seedDesktopActivityOverlayQaState: (mode: string) => Promise<Record<string, unknown>>;
    clearDesktopActivityOverlayQaState: () => Promise<Record<string, unknown>>;
    readPersonalHomeBootstrapQaObservation: () => Record<string, unknown>;
    navigateHappierQaPath: (path: string) => Record<string, unknown>;
    readPersonalHomeDaemonQaStatus: () => Promise<unknown>;
    stopPersonalHomeDaemonForQa: () => Promise<unknown>;
    controlPersonalHomeBootstrapQaPause: (request: unknown) => Record<string, unknown>;
    uninstallPersonalHomeRuntimeForQa: () => Promise<Record<string, unknown>>;
};
const qaWindows: Array<typeof globalThis & { __MCP__: QaCommands }> = [];

function installDefaultQaBridge(windowObj = { __MCP__: {} } as unknown as typeof globalThis) {
    // A DOM adapter fixture only: every domain callback remains the production default.
    const documentObj = {
        querySelector: () => null,
        querySelectorAll: () => [],
        evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
    } as unknown as Document;
    installTauriMcpWebviewDriverScripts({ windowObj, documentObj });
    const installed = windowObj as typeof globalThis & { __MCP__: QaCommands };
    qaWindows.push(installed);
    return installed;
}

const ensureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn());
const legacyEnsureSessionVisibleForMessageRouteMock = vi.hoisted(() => vi.fn());
const getSyncSingletonMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: getSyncSingletonMock,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSessionVisibleForMessageRoute: legacyEnsureSessionVisibleForMessageRouteMock,
    },
}));

describe('installTauriMcpWebviewDriverScripts', () => {
    beforeEach(() => {
        vi.stubGlobal('window', globalThis);
        vi.stubGlobal('__TAURI_INTERNALS__', { transformCallback: () => 1, invoke: async (command: string) => {
            if (command === 'plugin:event|listen') return 1;
            if (command === 'plugin:event|unlisten') return;
            if (command === 'desktop_host_get_availability') return {
                activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
            };
            throw new Error(`Unexpected host availability command: ${command}`);
        } });
        vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
        native.taskSpecs.length = 0;
        native.taskData = {};
        native.taskResults.clear();
        native.listeners.clear();
        native.overlayPayloads.length = 0;
        native.overlayState = null;
        native.presentationRequests.length = 0;
        selectDesktopActivityOverlayQaFixture(null);
        ensureSessionVisibleForMessageRouteMock.mockReset();
        legacyEnsureSessionVisibleForMessageRouteMock.mockReset();
        getSyncSingletonMock.mockReset();
        getSyncSingletonMock.mockReturnValue({
            ensureSessionVisibleForMessageRoute: ensureSessionVisibleForMessageRouteMock,
        });
        ensureSessionVisibleForMessageRouteMock.mockResolvedValue(true);
        legacyEnsureSessionVisibleForMessageRouteMock.mockResolvedValue(true);
    });

    afterEach(async () => {
        for (const windowObj of qaWindows.splice(0)) await windowObj.__MCP__.clearDesktopActivityOverlayQaState();
        controlPersonalHomeBootstrapQaMutationPause({ action: 'release' });
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('installs resolveRef helpers expected by mcp-server-tauri tooling', () => {
        const element = { tagName: 'BUTTON' } as unknown as Element;
        const other = { tagName: 'INPUT' } as unknown as Element;
        const reverseRefs = new Map<string, Element>([['e1', element]]);

        const windowObj = {
            __MCP__: {
                reverseRefs,
            },
        } as unknown as typeof globalThis;

        const documentObj = {
            querySelector: (selector: string) => selector === '.other' ? other : null,
            querySelectorAll: (selector: string) => selector === '.both' ? [element, other] : [],
            evaluate: () => ({ singleNodeValue: element, snapshotLength: 1, snapshotItem: () => element }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({ windowObj, documentObj });

        const mcp = (windowObj as unknown as { __MCP__: {
            resolveRef: (selector: string) => Element | null;
            resolveAll: (selector: string) => Element[];
            countAll: (selector: string) => number;
            reverseRefs?: Map<string, Element>;
        } }).__MCP__;
        expect(mcp.resolveRef('[ref=e1]')).toBe(element);
        expect(mcp.resolveRef('.other')).toBe(other);
        expect(mcp.resolveRef('.missing')).toBeNull();
        expect(mcp.resolveAll('e1')).toEqual([element]);
        expect(mcp.resolveAll('.both')).toEqual([element, other]);
        expect(mcp.countAll('.both')).toBe(2);
        expect(mcp.countAll('.missing')).toBe(0);
        delete mcp.reverseRefs;
        expect(() => mcp.resolveRef('e1')).toThrow('require a snapshot');
    });

    it('installs a canonical local-settings writer helper for the Tauri MCP bridge', async () => {
        const applied: Array<Record<string, unknown>> = [];
        let flushCount = 0;
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            applyLocalSettings: (delta) => {
                applied.push(delta);
            },
            flushDesktopOverlaySync: () => {
                flushCount += 1;
            },
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    applyHappierLocalSettings?: (delta: unknown) => Promise<{ ok: boolean; appliedKeys?: string[] }>;
                };
            }
        ).__MCP__?.applyHappierLocalSettings?.({
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'active_sessions',
        });

        expect(result).toMatchObject({
            ok: true,
            appliedKeys: ['desktopOverlayEnabled', 'desktopOverlayVisibilityMode'],
        });
        expect(applied).toEqual([
            {
                desktopOverlayEnabled: true,
                desktopOverlayVisibilityMode: 'active_sessions',
            },
        ]);
        expect(flushCount).toBe(1);
    });

    it('overwrites any preexisting applyHappierLocalSettings implementation so desktop overlay settings always flush', async () => {
        const applied: Array<Record<string, unknown>> = [];
        let flushCount = 0;
        let legacyCalled = 0;
        const windowObj = {
            __MCP__: {
                applyHappierLocalSettings: () => {
                    legacyCalled += 1;
                    return { ok: false, reason: 'legacy' };
                },
            },
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            applyLocalSettings: (delta) => {
                applied.push(delta);
            },
            flushDesktopOverlaySync: () => {
                flushCount += 1;
            },
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    applyHappierLocalSettings?: (delta: unknown) => Promise<{ ok: boolean; appliedKeys?: string[] }>;
                };
            }
        ).__MCP__?.applyHappierLocalSettings?.({
            desktopOverlayEnabled: true,
        });

        expect(result).toMatchObject({
            ok: true,
            appliedKeys: ['desktopOverlayEnabled'],
        });
        expect(legacyCalled).toBe(0);
        expect(applied).toEqual([{ desktopOverlayEnabled: true }]);
        expect(flushCount).toBe(1);
    });

    it('awaits the overlay sync flush before reporting local-settings writes as complete', async () => {
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        let flushCount = 0;
        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            applyLocalSettings: () => {},
            flushDesktopOverlaySync: async () => {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 0);
                });
                flushCount += 1;
            },
        });

        const promise = (
            windowObj as unknown as {
                __MCP__?: {
                    applyHappierLocalSettings?: (delta: unknown) => Promise<{ ok: boolean }>;
                };
            }
        ).__MCP__?.applyHappierLocalSettings?.({ desktopOverlayEnabled: true });

        expect(flushCount).toBe(0);
        await promise;
        expect(flushCount).toBe(1);
    });

    it('installs a canonical session-visibility helper for the Tauri MCP bridge', async () => {
        const ensured: Array<{ sessionId: string; options?: { forceRefresh?: boolean } }> = [];
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            ensureSessionVisible: async (sessionId, options) => {
                ensured.push({ sessionId, options });
                return true;
            },
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    ensureHappierSessionVisible?: (
                        sessionId: unknown,
                        options?: { forceRefresh?: boolean },
                    ) => Promise<{ ok: boolean; sessionId?: string }>;
                };
            }
        ).__MCP__?.ensureHappierSessionVisible?.('sess_overlay', { forceRefresh: true });

        expect(result).toEqual({
            ok: true,
            sessionId: 'sess_overlay',
        });
        expect(ensured).toEqual([
            {
                sessionId: 'sess_overlay',
                options: { forceRefresh: true },
            },
        ]);
    });

    it('uses the runtime sync singleton for the default session-visibility helper', async () => {
        const windowObj = {
            __MCP__: {},
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
        });

        const result = await (
            windowObj as unknown as {
                __MCP__?: {
                    ensureHappierSessionVisible?: (
                        sessionId: unknown,
                        options?: { forceRefresh?: boolean },
                    ) => Promise<{ ok: boolean; sessionId?: string }>;
                };
            }
        ).__MCP__?.ensureHappierSessionVisible?.('sess_overlay', { forceRefresh: true });

        expect(result).toEqual({
            ok: true,
            sessionId: 'sess_overlay',
        });
        expect(getSyncSingletonMock).toHaveBeenCalledTimes(1);
        expect(ensureSessionVisibleForMessageRouteMock).toHaveBeenCalledWith('sess_overlay', { forceRefresh: true });
        expect(legacyEnsureSessionVisibleForMessageRouteMock).not.toHaveBeenCalled();
    });

    it('exposes checked-in Personal Home QA boundaries backed by the native document-start observer', async () => {
        const navigated: string[] = [];
        const windowObj = {
            __MCP__: {},
            __happierPersonalHomeQaForbiddenSurface: {
                state: { documentStart: true, seen: false },
            },
            location: { pathname: '/' },
            history: { pushState: (_state: unknown, _title: string, path: string) => navigated.push(path) },
            dispatchEvent: () => true,
            PopStateEvent: class { constructor(public readonly type: string) {} },
        } as unknown as typeof globalThis;
        const mcp = installDefaultQaBridge(windowObj).__MCP__;
        expect(mcp?.readPersonalHomeBootstrapQaObservation()).toEqual({
            installedAtDocumentStart: true,
            seenForbiddenOnboarding: false,
        });
        (windowObj as unknown as { __happierPersonalHomeQaForbiddenSurface: { state: { seen: boolean } } })
            .__happierPersonalHomeQaForbiddenSurface.state.seen = true;
        expect(mcp?.readPersonalHomeBootstrapQaObservation()).toEqual({
            installedAtDocumentStart: true,
            seenForbiddenOnboarding: true,
        });
        expect(mcp?.navigateHappierQaPath('/settings/server')).toEqual({ ok: true, pathname: '/settings/server' });
        expect(navigated).toEqual(['/settings/server']);
        native.taskData = { daemonRunning: true };
        await expect(mcp.readPersonalHomeDaemonQaStatus()).resolves.toMatchObject({ ok: true, data: { daemonRunning: true } });
        native.taskData = { daemonRunning: false };
        await expect(mcp.stopPersonalHomeDaemonForQa()).resolves.toMatchObject({ ok: true, data: { daemonRunning: false } });
        expect(native.taskSpecs.map(spec => spec.kind)).toEqual(['daemon.service.status.v1', 'daemon.service.stop.v1']);
    });

    it('selects fixtures for the mounted producer and pins through the real notch Action without native sync writes', async () => {
        const selectedModes: Array<string | null> = [];
        const unsubscribe = registerDesktopActivityOverlayQaFixtureProducer(model => selectedModes.push(model?.expanded.cards?.[0]?.kind ?? null));
        try {
            const windowObj = installDefaultQaBridge();
            await expect(windowObj.__MCP__.applyHappierLocalSettings({ desktopOverlayEnabled: true }))
                .resolves.toMatchObject({ ok: true, overlaySyncOk: true });
            expect(native.presentationRequests).toEqual(['rest']);
            await expect(windowObj.__MCP__.seedDesktopActivityOverlayQaState('permission_request')).resolves.toEqual({
                ok: true, mode: 'permission_request', state: 'pinned',
            });
            expect(selectedModes).toEqual(['permission_request']);
            expect(native.presentationRequests).toEqual(['rest', 'pinned']);
            expect(native.overlayPayloads).toHaveLength(0);
            await expect(windowObj.__MCP__.clearDesktopActivityOverlayQaState()).resolves.toEqual({ ok: true });
            expect(selectedModes).toEqual(['permission_request', null]);
            expect(native.presentationRequests).toEqual(['rest', 'pinned', 'rest']);
        } finally { unsubscribe(); }
    });

    it('respects an explicit MCP Ask policy before requesting native presentation', async () => {
        const previous = storage.getState().settings.actionsSettingsV1;
        const unsubscribe = registerDesktopActivityOverlayQaFixtureProducer(() => {});
        storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: { 'desktop.notch.set': { approvalRequiredSurfaces: ['mcp'] } },
        }) });
        try {
            const mcp = installDefaultQaBridge().__MCP__;
            await expect(mcp.applyHappierLocalSettings({ desktopOverlayEnabled: true }))
                .resolves.toMatchObject({ ok: true, overlaySyncOk: false });
            expect(native.presentationRequests).toEqual([]);
        } finally {
            storage.getState().applySettingsLocal({ actionsSettingsV1: previous });
            unsubscribe();
        }
    });

    it('pins desktop-overlay QA seed state without resends, expiry or repeated fixture publications', async () => {
        vi.useFakeTimers();
        const timersBefore = vi.getTimerCount();
        const publishedModes: Array<string | null> = [];
        const unsubscribe = registerDesktopActivityOverlayQaFixtureProducer(model => publishedModes.push(model?.expanded.cards?.[0]?.kind ?? null));
        try {
            const mcp = installDefaultQaBridge().__MCP__;
            await expect(mcp.seedDesktopActivityOverlayQaState('quota_summary')).resolves.toMatchObject({ ok: true });
            await expect(mcp.seedDesktopActivityOverlayQaState('quota_summary')).resolves.toMatchObject({ ok: true });
            await vi.advanceTimersByTimeAsync(30_350);
            expect(publishedModes).toEqual(['quota_summary']);
            expect(native.overlayPayloads).toHaveLength(0);
            expect(native.presentationRequests).toEqual(['pinned', 'pinned']);
            expect(vi.getTimerCount()).toBe(timersBefore);
            await mcp.seedDesktopActivityOverlayQaState('user_question');
            expect(publishedModes).toEqual(['quota_summary', 'user_question']);
            await mcp.clearDesktopActivityOverlayQaState();
            expect(publishedModes).toEqual(['quota_summary', 'user_question', null]);
            expect(native.overlayPayloads).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(timersBefore);
        } finally { unsubscribe(); }
    });

    it('reports unavailable without a mounted fixture producer and rejects unsupported seeds', async () => {
        const mcp = installDefaultQaBridge().__MCP__;
        await expect(mcp.applyHappierLocalSettings({ desktopOverlayEnabled: true })).resolves.toMatchObject({
            ok: true, overlaySyncOk: false, overlaySyncError: 'producer-unavailable',
        });
        await expect(mcp.seedDesktopActivityOverlayQaState('idle')).resolves.toEqual({ ok: false, reason: 'producer-unavailable', mode: 'idle' });
        await expect(mcp.seedDesktopActivityOverlayQaState('unknown')).resolves.toEqual({ ok: false, reason: 'unsupported-mode', mode: 'unknown' });
        expect(hasDesktopActivityOverlayQaFixtureProducer()).toBe(false);
        expect(native.overlayPayloads).toHaveLength(0);
        expect(native.presentationRequests).toHaveLength(0);
    });

    it('maybeInstallTauriMcpBridge installs scripts only on desktop', () => {
        const element = { tagName: 'BUTTON' } as unknown as Element;
        const reverseRefs = new Map<string, Element>([['e1', element]]);
        const windowObj = {
            __MCP__: {
                reverseRefs,
            },
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => element,
            querySelectorAll: () => [element],
            evaluate: () => ({ singleNodeValue: element, snapshotLength: 1, snapshotItem: () => element }),
        } as unknown as Document;

        maybeInstallTauriMcpBridge({ isDesktopShell: false, windowObj, documentObj });
        expect((windowObj as unknown as { __MCP__?: { resolveRef?: unknown } }).__MCP__?.resolveRef).toBeUndefined();

        maybeInstallTauriMcpBridge({ isDesktopShell: true, windowObj, documentObj });
        expect(typeof (windowObj as unknown as { __MCP__?: { resolveRef?: unknown } }).__MCP__?.resolveRef).toBe('function');
    });

    it('installs no QA driver surface in a production desktop build', () => {
        const element = { tagName: 'BUTTON' } as unknown as Element;
        const windowObj = {
            __MCP__: { reverseRefs: new Map<string, Element>([['e1', element]]) },
        } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => element,
            querySelectorAll: () => [element],
            evaluate: () => ({ singleNodeValue: element, snapshotLength: 1, snapshotItem: () => element }),
        } as unknown as Document;

        maybeInstallTauriMcpBridge({ isDesktopShell: true, isDevBuild: false, windowObj, documentObj });

        // Every command this bridge publishes drives real machine state — a five-minute hold on a
        // durable Personal Home bootstrap mutation, stopping the daemon, uninstalling the runtime.
        // None of them may exist in a shipped desktop build.
        const mcp = (windowObj as unknown as {
            __MCP__?: Record<string, unknown>;
        }).__MCP__ ?? {};
        for (const command of [
            'resolveRef',
            'applyHappierLocalSettings',
            'controlPersonalHomeBootstrapQaPause',
            'uninstallPersonalHomeRuntimeForQa',
            'stopPersonalHomeDaemonForQa',
            'readPersonalHomeDaemonQaStatus',
            'seedDesktopActivityOverlayQaState',
        ]) {
            expect(mcp[command]).toBeUndefined();
        }
    });

    it('exposes the checked-in bootstrap mutation pause and the canonical uninstall operation for loaded QA', async () => {
        const mcp = installDefaultQaBridge().__MCP__;

        // The hook drives the canonical pause owner rather than keeping its own QA state.
        expect(mcp?.controlPersonalHomeBootstrapQaPause?.({
            action: 'arm',
            kind: 'relay.runtime.installOrUpdate.v1',
            ordinal: 2,
            ttlMs: 5_000,
        })).toMatchObject({ ok: true, armed: { kind: 'relay.runtime.installOrUpdate.v1', ordinal: 2 } });
        expect(controlPersonalHomeBootstrapQaMutationPause({ action: 'read' })).toMatchObject({
            armed: { kind: 'relay.runtime.installOrUpdate.v1', ordinal: 2 },
        });
        expect(mcp?.controlPersonalHomeBootstrapQaPause?.({ action: 'nope' }))
            .toMatchObject({ ok: false, reason: 'invalid-action' });

        // The uninstall boundary exists for the paused destructive-arbitration journey, so it runs
        // while that arm is live and reaches the canonical operation exactly once.
        native.taskData = { uninstalled: true };
        await expect(mcp.uninstallPersonalHomeRuntimeForQa()).resolves.toEqual({ ok: true });
        expect(native.taskSpecs.map(spec => spec.kind)).toEqual(['relay.runtime.uninstall.v1']);

        expect(mcp?.controlPersonalHomeBootstrapQaPause?.({ action: 'release' }))
            .toMatchObject({ ok: true, armed: null, held: null });
    });

    it('keeps the canonical uninstall boundary inert until the checked-in pause is armed', async () => {
        const windowObj = { __MCP__: {} } as unknown as typeof globalThis;
        const documentObj = {
            querySelector: () => null,
            querySelectorAll: () => [],
            evaluate: () => ({ singleNodeValue: null, snapshotLength: 0, snapshotItem: () => null }),
        } as unknown as Document;
        let uninstallCalls = 0;

        installTauriMcpWebviewDriverScripts({
            windowObj,
            documentObj,
            uninstallPersonalHomeRuntimeQaTask: async () => {
                uninstallCalls += 1;
                return true;
            },
        });

        const mcp = (windowObj as unknown as {
            __MCP__?: { uninstallPersonalHomeRuntimeForQa?: () => Promise<Record<string, unknown>> };
        }).__MCP__;
        // An ordinary desktop shell installs this bridge, so an unarmed call must never reach the
        // real runtime uninstall; Settings stays the only product owner of that operation.
        await expect(mcp?.uninstallPersonalHomeRuntimeForQa?.()).resolves.toEqual({
            ok: false,
            reason: 'qa-pause-not-armed',
        });
        expect(uninstallCalls).toBe(0);
    });

    it('reports a failed canonical uninstall instead of self-attesting success', async () => {
        const mcp = installDefaultQaBridge().__MCP__;
        controlPersonalHomeBootstrapQaMutationPause({
            action: 'arm',
            kind: 'relay.runtime.installOrUpdate.v1',
            ordinal: 1,
            ttlMs: 5_000,
        });
        // A successful task envelope without the executor's positive confirmation is not success.
        native.taskData = { uninstalled: false };
        await expect(mcp.uninstallPersonalHomeRuntimeForQa()).resolves.toEqual({
            ok: false,
            reason: 'Runtime uninstall did not confirm completion.',
        });
        expect(native.taskSpecs.map(spec => spec.kind)).toEqual(['relay.runtime.uninstall.v1']);
        controlPersonalHomeBootstrapQaMutationPause({ action: 'release' });
    });
});

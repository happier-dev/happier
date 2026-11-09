import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { storage } from '@/sync/domains/state/storageStore';
import { dispatchDesktopCaptureWindowAction } from '@/utils/platform/desktopWindowActionDispatch';
import { readSessionChooserFromCaptureWindow } from './sessionChooserSource';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { executeDesktopWindowActionWithResult, requestCaptureNewSession } from '@/utils/platform/desktopWindowActionBridge';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { clearAllNewSessionAttachmentDrafts, readNewSessionAttachmentDrafts } from '@/components/sessions/new/attachments/newSessionAttachmentDraftStore';
import { resolveNewSessionDraftAttachmentFlowId } from '@/components/sessions/new/attachments/newSessionDraftAttachmentFlowId';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import type { NativeCaptureResult } from '@/desktop/capture/nativeCapture';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const host = vi.hoisted(() => ({
    invoke: vi.fn(), listeners: new Map<string, (value: unknown) => void>(),
    push: vi.fn(),
}));
vi.mock('expo-router', () => ({ router: { push: host.push } }));
// Only native IPC is replaced; requester, admission, snapshot and reply remain real.
vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    desktopHostKind: () => 'tauri',
    invokeDesktopHost: (command: string, args: unknown) => host.invoke(command, args),
    listenDesktopHostEvent: async (event: string, listener: (value: unknown) => void) => {
        host.listeners.set(event, listener);
        return () => { host.listeners.delete(event); };
    },
}));

const initialState = storage.getState();
vi.stubGlobal('indexedDB', new IDBFactory());
beforeAll(async () => { await loadSyncSingletonForTests(); await prepareSessionDraftPersistenceStorage(); });
afterAll(() => vi.unstubAllGlobals());
afterEach(() => { storage.setState(initialState, true); host.invoke.mockReset(); host.listeners.clear();
    host.push.mockReset(); retireActiveServerAccountScopeLifetime(); resetSessionDraftRepositoryForTests(); clearAllNewSessionAttachmentDrafts(); });

function installNativeBridge() {
    const emitted: unknown[] = [];
    const executor = { execute: vi.fn() };
    host.invoke.mockImplementation(async (command: string, args: { payload: Parameters<typeof dispatchDesktopCaptureWindowAction>[0] }) => {
        if (command === 'desktop_window_emit_action') await dispatchDesktopCaptureWindowAction(args.payload, executor);
        if (command === 'desktop_window_emit_action_result') {
            emitted.push(args.payload);
            host.listeners.get('desktopWindow://action-result')?.(args.payload);
        }
    });
    return { emitted, executor };
}

describe('Capture chooser bridge', () => {
    it('serves one explicit snapshot request and leaves no status subscription or unsolicited messages', async () => {
        const { emitted, executor } = installNativeBridge();
        storage.setState({ sessions: {}, sessionListIndexByServerId: {}, sessionListRowsByServerId: {} });
        expect(await readSessionChooserFromCaptureWindow({ kind: 'page', query: '', offset: 0, limit: 8 }))
            .toEqual({ rows: [], total: 0 });
        const request = host.invoke.mock.calls.find(([command]) => command === 'desktop_window_emit_action')?.[1].payload;
        expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_window_emit_action')).toHaveLength(1);
        expect(host.listeners.size).toBe(0);
        expect(emitted).toEqual([
            { windowLabel: 'capture', requestId: request.requestId, phase: 'admitted', ok: true },
            { windowLabel: 'capture', requestId: request.requestId, phase: 'settled', ok: true, result: { rows: [], total: 0 } },
        ]);
        expect(executor.execute).not.toHaveBeenCalled();
        for (let i = 0; i < 100; i++) storage.setState({ isDataReady: i % 2 === 0 });
        expect(emitted).toHaveLength(2);
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'activity_overlay', requestId: 'denied',
            actionIdentifier: 'screenCapture.sessionChooser.read', data: { kind: 'page', query: '', offset: 0, limit: 8 },
        }, executor);
        expect(emitted.at(-1)).toMatchObject({ ok: false, errorCode: 'window_action_refused' });
    });

    it('reads the exact requested Home when two Homes contain the same Session id', async () => {
        installNativeBridge();
        const row = (name: string) => createSessionListRenderableSessionFixture({ id: 'same',
            metadata: { path: '/project', name, host: 'machine' } });
        storage.setState({ sessions: {}, machines: {},
            sessionListRowsByServerId: { 'home-a': { same: row('First Home') }, 'home-b': { same: row('Second Home') } },
            ordinarySessionListMembershipByServerId: { 'home-a': ['same'], 'home-b': ['same'] },
        });
        // Native capture pins retain the Account as well as the chooser's address.
        const pinned = { serverId: 'home-b', accountId: 'account', sessionId: 'same' };
        const result = await readSessionChooserFromCaptureWindow({ kind: 'target', targetSession: pinned });
        expect(result.address).toEqual({ serverId: 'home-b', sessionId: 'same' });
        expect(result.row?.label).toBe('Second Home');
        expect(result.row?.address).toEqual(result.address);
        expect(host.listeners.size).toBe(0);
    });
});

describe('Capture chooser New Session handoff', () => {
    const scope = { serverId: 'capture-home', accountId: 'capture-account' };
    beforeEach(() => {
        storage.setState({ profileScope: scope });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://capture.test', generation: 1 });
    });
    function installCaptureBridge(options: { includeWindowText?: boolean; readFailure?: string;
        retireDuringRead?: boolean; showFailure?: boolean; settleFailure?: boolean } = {}) {
        const emitted: unknown[] = [];
        const executor = { execute: vi.fn() };
        host.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
            if (command === 'desktop_window_emit_action') {
                await dispatchDesktopCaptureWindowAction(args.payload as Parameters<typeof dispatchDesktopCaptureWindowAction>[0], executor);
            } else if (command === 'desktop_window_emit_action_result') {
                emitted.push(args.payload);
                host.listeners.get('desktopWindow://action-result')?.(args.payload);
            } else if (command === 'desktop_capture_read_result') {
                if (options.readFailure) throw options.readFailure;
                return { captureRef: 'capture-1', kind: 'still', path: '/captures/marked.png', mimeType: 'image/png',
                    byteSize: 4, pixelSize: { width: 1, height: 1 }, scale: 1, origin: null,
                    source: null, windowTextRef: null } satisfies NativeCaptureResult;
            } else if (command === 'desktop_capture_read_delivery_state') {
                return { inUse: true, disclosure: { hasMarks: true, includeWindowText: options.includeWindowText ?? false },
                    windowText: { status: 'ready', text: 'Private whole-window text', source: { appName: 'Terminal' } } };
            } else if (command === 'desktop_capture_read_prepared_png') {
                if (options.retireDuringRead) retireActiveServerAccountScopeLifetime();
                return [137, 80, 78, 71];
            } else if (command === 'desktop_capture_settle') {
                if (options.settleFailure) throw 'file_io';
                return { status: 'idle' };
            } else if (command === 'desktop_show_main_window') {
                if (options.showFailure) throw 'window_unavailable';
            } else throw new Error(`Unexpected IPC ${command}`);
        });
        return { emitted, executor };
    }
    const request = (data: Record<string, unknown> = { captureRef: 'capture-1', note: 'Look here' }) =>
        executeDesktopWindowActionWithResult({ windowLabel: 'capture', actionIdentifier: 'screenCapture.sessionChooser.newSession', data });

    it.each([false, true])('opens the ordinary main-Home draft from prepared pixels, disclosure text=%s', async includeWindowText => {
        const { emitted, executor } = installCaptureBridge({ includeWindowText });
        const result = await requestCaptureNewSession({ captureRef: 'capture-1', note: 'Look here' });
        expect(result).toMatchObject({ ok: true, result: { kind: 'opened', draftId: expect.any(String) } });
        const route = host.push.mock.calls[0]?.[0];
        expect(route).toMatchObject({ pathname: '/new', params: { draftId: expect.any(String) } });
        const draftId: string = route.params.draftId;
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toContain('Look here');
        const attachments = readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draftId));
        expect(attachments).toHaveLength(includeWindowText ? 2 : 1);
        expect(attachments[0]?.source).toMatchObject({ kind: 'memory', bytes: new Uint8Array([137, 80, 78, 71]) });
        expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_show_main_window')).toHaveLength(1);
        const commands = host.invoke.mock.calls.map(([command]) => command);
        expect(commands.indexOf('desktop_show_main_window')).toBeLessThan(commands.indexOf('desktop_capture_settle'));
        expect(executor.execute).not.toHaveBeenCalled();
        expect(emitted).toHaveLength(2);
        expect(host.invoke.mock.calls.filter(([command]) => command === 'desktop_capture_settle')).toEqual([
            ['desktop_capture_settle', { captureRef: 'capture-1' }],
        ]);
        expect(host.listeners.size).toBe(0);
    });

    it('refuses wrong labels and input disclosure overrides before reading capture contents', async () => {
        installCaptureBridge();
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'activity_overlay', requestId: 'wrong-label',
            actionIdentifier: 'screenCapture.sessionChooser.newSession', data: { captureRef: 'capture-1' } }, { execute: vi.fn() });
        expect(host.invoke.mock.calls.at(-1)?.[1].payload).toMatchObject({ ok: false, errorCode: 'window_action_refused' });
        for (const forbidden of [{ disclosureOverride: { includeWindowText: true } }, { includeWindowText: true },
            { marks: [] }, { png: [137, 80, 78, 71] }, { windowText: 'Override' }]) {
            await expect(request({ captureRef: 'capture-1', ...forbidden }))
                .resolves.toMatchObject({ ok: false, errorCode: 'invalid_input' });
        }
        expect(host.invoke.mock.calls.some(([command]) => command.startsWith('desktop_capture_'))).toBe(false);
        expect(host.push).not.toHaveBeenCalled();
    });

    it('keeps the capture when reading prepared delivery fails', async () => {
        installCaptureBridge({ readFailure: 'prepared_missing' });
        await expect(request()).resolves.toMatchObject({ ok: false, errorCode: 'prepared_missing' });
        expect(host.push).not.toHaveBeenCalled();
        expect(host.invoke.mock.calls.some(([command]) => command === 'desktop_capture_settle')).toBe(false);
    });

    it('keeps the admitted draft and capture when navigation fails', async () => {
        installCaptureBridge();
        host.push.mockImplementationOnce(() => { throw new Error('Router unavailable'); });
        await expect(request()).resolves.toMatchObject({ ok: false, result: { kind: 'unavailable', reason: 'navigation_unavailable' } });
        const draftId: string = host.push.mock.calls[0]?.[0].params.draftId;
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toContain('Look here');
        expect(readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draftId))).toHaveLength(1);
        expect(host.invoke.mock.calls.some(([command]) => command === 'desktop_capture_settle')).toBe(false);
    });

    it('does not navigate or settle into a retired main Account lifetime', async () => {
        installCaptureBridge({ retireDuringRead: true });
        await expect(request()).resolves.toMatchObject({ ok: false, result: { kind: 'stale', reason: 'host_retired' } });
        expect(host.push).not.toHaveBeenCalled();
        expect(host.invoke.mock.calls.some(([command]) => command === 'desktop_capture_settle')).toBe(false);
    });

    it('keeps the admitted draft and capture if the main window cannot be presented', async () => {
        installCaptureBridge({ showFailure: true });
        await expect(request()).resolves.toMatchObject({ ok: false, errorCode: 'operation_unavailable',
            details: { captureStaged: true, delivered: { kind: 'opened', draftId: expect.any(String) } } });
        const draftId: string = host.push.mock.calls[0]?.[0].params.draftId;
        expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toContain('Look here');
        expect(host.invoke.mock.calls.some(([command]) => command === 'desktop_capture_settle')).toBe(false);
    });

    it('reports a native settlement failure without losing the opened draft or claiming success', async () => {
        installCaptureBridge({ settleFailure: true });
        await expect(request()).resolves.toMatchObject({ ok: false, errorCode: 'file_io',
            details: { captureStaged: true, delivered: { kind: 'opened', draftId: expect.any(String) } } });
        const draftId: string = host.push.mock.calls[0]?.[0].params.draftId;
        expect(readNewSessionAttachmentDrafts(resolveNewSessionDraftAttachmentFlowId(draftId))).toHaveLength(1);
    });
});

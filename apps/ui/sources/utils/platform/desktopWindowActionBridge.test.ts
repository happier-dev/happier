import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    invoke: vi.fn(),
    listeners: new Map<string, (payload: unknown) => void>(),
    unlisten: vi.fn(),
    windowLabel: 'capture',
}));
// Tauri IPC is the process boundary; request matching and settlement remain real.
vi.mock('@/utils/platform/desktopHost', () => ({
    getDesktopHostWindowLabel: () => host.windowLabel,
    invokeDesktopHost: (command: string, args: unknown) => host.invoke(command, args),
    listenDesktopHostEvent: async (event: string, listener: (payload: unknown) => void) => {
        host.listeners.set(event, listener);
        return () => { host.listeners.delete(event); host.unlisten(); };
    },
}));

import { executeDesktopWindowActionWithResult, requestCaptureOpenSession } from './desktopWindowActionBridge';
import { executeDesktopActivityOverlayInteractionWithResult } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';

describe('desktop window Action result transport', () => {
    it('forwards admitted work once from main to the addressed presenter and waits for its result', async () => {
        host.windowLabel = 'main';
        const pending = executeDesktopWindowActionWithResult({ windowLabel: 'main', targetWindowLabel: 'destination_notes',
            requestId: 'forwarded', actionIdentifier: 'session.draft.append', data: { sessionId: 'lead', text: 'Window edit' } });
        await Promise.resolve();
        expect(host.invoke).toHaveBeenCalledTimes(1);
        expect(host.invoke).toHaveBeenCalledWith('desktop_window_emit_action', { payload: {
            windowLabel: 'main', targetWindowLabel: 'destination_notes', requestId: 'forwarded',
            actionIdentifier: 'session.draft.append', data: { sessionId: 'lead', text: 'Window edit' },
        } });
        host.listeners.get('desktopWindow://action-result')!({ windowLabel: 'main', requestId: 'forwarded',
            phase: 'settled', ok: true, result: { status: 'appended' } });
        await expect(pending).resolves.toMatchObject({ ok: true, result: { status: 'appended' } });
        expect(host.listeners.size).toBe(0);
    });
    afterEach(() => {
        vi.useRealTimers();
        host.listeners.clear();
        host.invoke.mockReset();
        host.unlisten.mockReset();
        host.windowLabel = 'capture';
    });

    it('addresses the actual capture window and ignores another capture window settlement', async () => {
        host.windowLabel = 'capture_2';
        let completed = false;
        const pending = executeDesktopWindowActionWithResult({ windowLabel: 'capture', requestId: 'same-request',
            actionIdentifier: 'screenCapture.send', data: { captureRef: 'second' },
        }).then(result => { completed = true; return result; });
        await Promise.resolve();
        expect(host.invoke).toHaveBeenCalledWith('desktop_window_emit_action', { payload: {
            windowLabel: 'capture_2', requestId: 'same-request', actionIdentifier: 'screenCapture.send', data: { captureRef: 'second' },
        } });
        const receive = host.listeners.get('desktopWindow://action-result')!;
        receive({ windowLabel: 'capture_1', requestId: 'same-request', ok: true });
        await Promise.resolve();
        expect(completed).toBe(false);
        receive({ windowLabel: 'capture_2', requestId: 'same-request', ok: true, result: { captureRef: 'second' } });
        await expect(pending).resolves.toMatchObject({ ok: true, result: { captureRef: 'second' } });
        expect(host.listeners.size).toBe(0);
    });

    it('waits for Capture upload settlement past 10 seconds with no timeout or idle traffic', async () => {
        vi.useFakeTimers();
        let completed = false;
        const pending = executeDesktopWindowActionWithResult({
            windowLabel: 'capture', requestId: 'capture-send', actionIdentifier: 'screenCapture.send',
            data: { captureRef: 'kept-capture' },
        }).then(result => { completed = true; return result; });
        await Promise.resolve();
        const receive = host.listeners.get('desktopWindow://action-result')!;
        receive({ windowLabel: 'capture', requestId: 'capture-send', phase: 'admitted', ok: true });
        await vi.advanceTimersByTimeAsync(10_001);
        expect(completed).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(host.invoke).toHaveBeenCalledTimes(1);
        receive({ windowLabel: 'capture', requestId: 'capture-send', phase: 'settled', ok: true, result: { messageRef: 'message-1' } });
        await expect(pending).resolves.toMatchObject({ ok: true, result: { messageRef: 'message-1' } });
        expect(host.unlisten).toHaveBeenCalledTimes(1);
    });

    it('ignores another window or request and removes its subscription on a settled failure', async () => {
        let completed = false;
        const pending = executeDesktopWindowActionWithResult({
            windowLabel: 'capture', requestId: 'draft', actionIdentifier: 'screenCapture.addToDraft', data: {},
        }).then(result => { completed = true; return result; });
        await Promise.resolve();
        const receive = host.listeners.get('desktopWindow://action-result')!;
        receive({ windowLabel: 'activity_overlay', requestId: 'draft', ok: true });
        receive({ windowLabel: 'capture', requestId: 'another', ok: true });
        await Promise.resolve();
        expect(completed).toBe(false);
        receive({ windowLabel: 'capture', requestId: 'draft', ok: false, errorCode: 'machine_unreachable' });
        await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'machine_unreachable' });
        expect(host.listeners.size).toBe(0);
    });

    it('retires a hidden Capture waiter without cancelling the already admitted main operation', async () => {
        const view = new AbortController();
        const pending = executeDesktopWindowActionWithResult({
            windowLabel: 'capture', requestId: 'hidden-send', actionIdentifier: 'screenCapture.send', data: {},
        }, { signal: view.signal });
        await Promise.resolve();
        host.listeners.get('desktopWindow://action-result')!({
            windowLabel: 'capture', requestId: 'hidden-send', phase: 'admitted', ok: true,
        });
        view.abort();
        expect(host.listeners.size).toBe(0);
        await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(host.invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_window_emit_action']);
        expect(host.unlisten).toHaveBeenCalledTimes(1);
    });

    it('cleans an asynchronously attached waiter when the Capture view closes before request emission', async () => {
        const view = new AbortController();
        const pending = executeDesktopWindowActionWithResult({
            windowLabel: 'capture', requestId: 'not-emitted', actionIdentifier: 'screenCapture.send', data: {},
        }, { signal: view.signal });
        view.abort();
        await Promise.resolve();
        expect(host.listeners.size).toBe(0);
        expect(host.invoke).not.toHaveBeenCalled();
        await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        const alreadyHidden = executeDesktopWindowActionWithResult({
            windowLabel: 'capture', actionIdentifier: 'screenCapture.send', data: {},
        }, { signal: view.signal });
        await expect(alreadyHidden).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(host.listeners.size).toBe(0);
        expect(host.invoke).not.toHaveBeenCalled();
    });

    it('retains the activity overlay own acknowledgement deadline', async () => {
        vi.useFakeTimers();
        const pending = executeDesktopActivityOverlayInteractionWithResult({
            requestId: 'reply', actionIdentifier: 'session.message.send', data: {},
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'ack_timeout' });
        expect(host.listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('carries the native caller refusal through the requesting window without leaking an opaque exception', async () => {
        host.invoke.mockRejectedValueOnce('desktop_window_action_source_refused');
        await expect(executeDesktopWindowActionWithResult({
            windowLabel: 'capture', actionIdentifier: 'screenCapture.send', data: {},
        })).resolves.toMatchObject({ ok: false, errorCode: 'desktop_window_action_source_refused' });
        expect(host.listeners.size).toBe(0);
    });

    it('sends the pill exact Session through the existing Capture request/result subscription', async () => {
        const session = { serverId: 'home', accountId: 'account', sessionId: 'session' };
        const pending = requestCaptureOpenSession(session);
        await Promise.resolve();
        expect(host.invoke).toHaveBeenCalledWith('desktop_window_emit_action', { payload: {
            windowLabel: 'capture', requestId: expect.any(String), actionIdentifier: 'screenCapture.session.open', data: session,
        } });
        const request = host.invoke.mock.calls[0]![1].payload;
        host.listeners.get('desktopWindow://action-result')!({ windowLabel: 'capture', requestId: request.requestId,
            phase: 'settled', ok: true, result: { status: 'opened', session } });
        await expect(pending).resolves.toMatchObject({ ok: true, result: { status: 'opened', session } });
        expect(host.listeners.size).toBe(0);
    });
});

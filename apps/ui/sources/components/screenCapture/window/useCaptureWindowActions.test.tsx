import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { useCaptureWindowActions } from './useCaptureWindowActions';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

const host = vi.hoisted(() => ({
    calls: [] as Array<{ command: string; args?: Record<string, unknown> }>,
    receive: null as ((payload: unknown) => void) | null,
    unlisten: vi.fn(),
}));
// The native IPC port is the window boundary; the bridge and hook run unchanged.
vi.mock('@/utils/platform/desktopHost', () => ({
    getDesktopHostWindowLabel: () => null,
    invokeDesktopHost: async (command: string, args?: Record<string, unknown>) => { host.calls.push({ command, args }); },
    listenDesktopHostEvent: async (_event: string, handler: (payload: unknown) => void) => {
        host.receive = handler;
        return () => { host.receive = null; host.unlisten(); };
    },
}));

function settle(outcome: Record<string, unknown>) {
    const request = host.calls.at(-1)?.args?.payload;
    if (!request || typeof request !== 'object' || !('requestId' in request)) throw new Error('No native request');
    host.receive?.({ windowLabel: 'capture', requestId: request.requestId, phase: 'settled', ...outcome });
}

describe('thin Capture window controls', () => {
    afterEach(async () => { await standardCleanup(); host.calls.length = 0; host.receive = null; host.unlisten.mockReset(); });

    it('routes recording continuations through the bridge and exposes a settled native refusal', async () => {
        const hook = await renderHook(useCaptureWindowActions);
        for (const action of ['pauseRecording', 'resumeRecording', 'stopRecording'] as const) {
            let pending: Promise<unknown> | undefined;
            await act(async () => { pending = hook.getCurrent()[action](7); });
            expect(host.calls.at(-1)?.args?.payload).toMatchObject({ actionIdentifier:
                `screenCapture.recording.${action.replace('Recording', '')}`, data: { operationRef: 7 } });
            await act(async () => { settle({ ok: action !== 'stopRecording', errorCode: 'video_pipeline_unavailable' }); await pending; });
        }
        expect(hook.getCurrent().state).toMatchObject({ status: 'settled', result: { ok: false, errorCode: 'video_pipeline_unavailable' } });
        let retry: Promise<unknown> | null = null;
        await act(async () => { retry = hook.getCurrent().retry(); });
        expect(host.calls.at(-1)?.args?.payload).toMatchObject({ actionIdentifier: 'screenCapture.recording.stop', data: { operationRef: 7 } });
        await act(async () => { settle({ ok: true }); await retry; });
        expect(hook.getCurrent().retry()).toBeNull();
    });

    it('retires an admitted Send waiter on hide without a hidden render or a second main request', async () => {
        const view = new AbortController();
        const counts = createRenderCommitCounter();
        const hook = await renderHook(() => { useRenderCommitCounter(counts); return useCaptureWindowActions(view.signal); });
        let pending: Promise<unknown> | undefined;
        await act(async () => { pending = hook.getCurrent().send({ captureRef: 'capture',
            session: { sessionId: 'session', serverId: 'home', accountId: 'account' } }); });
        const lateResult = host.receive;
        counts.reset();
        await act(async () => { view.abort(); await pending; });
        expect(host.receive).toBeNull();
        expect(host.calls).toHaveLength(1);
        expect(await pending).toMatchObject({ ok: false, errorCode: 'cancelled' });
        await act(async () => { lateResult?.({ windowLabel: 'capture', requestId: 'retired', ok: true }); });
        expect(counts.read()).toEqual({ renders: 0, commits: 0 });
    });

    it('reveals the kept file through its Action without changing delivery or retry state', async () => {
        const hook = await renderHook(useCaptureWindowActions);
        let pending: Promise<unknown> | null = null;
        await act(async () => { pending = hook.getCurrent().showInFolder('capture'); });
        expect(host.calls.at(-1)).toMatchObject({ command: 'desktop_window_emit_action', args: { payload: {
            windowLabel: 'capture', actionIdentifier: 'screenCapture.showInFolder', data: { captureRef: 'capture' },
        } } });
        await act(async () => { settle({ ok: true, result: { captureRef: 'capture', status: 'revealed' } }); });
        expect(await pending).toMatchObject({ ok: true, result: { status: 'revealed' } });
        expect(hook.getCurrent().state).toEqual({ status: 'idle' });
        expect(hook.getCurrent().retry()).toBeNull();
    });

    it.each([true, false])('does no native work while idle and uses the settled staging fact on Retry (staged=%s)', async staged => {
        const hook = await renderHook(useCaptureWindowActions);
        expect(host.calls).toHaveLength(0);
        expect(host.receive).toBeNull();
        const session = { sessionId: 'session', serverId: 'home', accountId: 'account' };
        let pending: Promise<unknown> | null = null;
        await act(async () => { pending = hook.getCurrent().send({ captureRef: 'capture', session, note: 'Look here' }); });
        await act(async () => { settle({ ok: false, errorCode: 'upload_failed', details: { captureStaged: staged } }); await pending; });
        expect(hook.getCurrent().state.status).toBe('settled');
        expect(host.receive).toBeNull();
        await act(async () => { pending = hook.getCurrent().retry(); });
        expect(host.calls.at(-1)).toMatchObject({ command: 'desktop_window_emit_action', args: { payload: {
            windowLabel: 'capture', actionIdentifier: 'screenCapture.send', ...(staged ? { intent: 'retry' } : {}),
            data: { captureRef: 'capture', session, note: 'Look here' },
        } } });
        if (!staged) expect(host.calls.at(-1)?.args?.payload).not.toHaveProperty('intent');
        await act(async () => { settle({ ok: true, result: { messageRef: 'sent' } }); await pending; });
        await act(async () => { expect(hook.getCurrent().retry()).toBeNull(); });
        expect(host.calls).toHaveLength(2);
        expect(host.unlisten).toHaveBeenCalledTimes(2);
    });

    it('does not retry an already-sent message when only native settlement failed', async () => {
        const hook = await renderHook(useCaptureWindowActions);
        const session = { sessionId: 'session', serverId: 'home', accountId: 'account' };
        let pending: Promise<unknown> | null = null;
        await act(async () => { pending = hook.getCurrent().send({ captureRef: 'capture', session }); });
        await act(async () => {
            settle({ ok: false, errorCode: 'native_failure', effectAttempted: true,
                details: { captureStaged: true, delivered: { captureRef: 'capture', messageRef: 'already-sent' } } });
            await pending;
        });
        expect(hook.getCurrent().retry()).toBeNull();
        expect(host.calls).toHaveLength(1);
        expect(hook.getCurrent().state).toMatchObject({ status: 'settled', result: { details: {
            delivered: { messageRef: 'already-sent' },
        } } });
    });

    it.each(['addToDraft', 'newSession'] as const)('retries failed %s at its own operation with the original input', async action => {
        const hook = await renderHook(useCaptureWindowActions);
        const input = { captureRef: 'capture', note: 'Original note',
            ...(action === 'addToDraft' ? { session: { sessionId: 'session', serverId: 'home', accountId: 'account' } } : {}) };
        let pending: Promise<unknown> | null = null;
        await act(async () => { pending = action === 'addToDraft'
            ? hook.getCurrent().addToDraft({ ...input, session: { sessionId: 'session', serverId: 'home', accountId: 'account' } })
            : hook.getCurrent().newSession(input); });
        await act(async () => { settle({ ok: false, errorCode: 'operation_unavailable' }); await pending; });
        await act(async () => { pending = hook.getCurrent().retry(); });
        expect(host.calls).toHaveLength(2);
        expect(host.calls.at(-1)?.args?.payload).toMatchObject({
            actionIdentifier: action === 'newSession' ? 'screenCapture.sessionChooser.newSession' : 'screenCapture.addToDraft',
            data: input,
        });
        await act(async () => { settle({ ok: true, result: action === 'newSession'
            ? { kind: 'opened' } : { captureRef: 'capture', imageNumber: 2 } }); await pending; });
        expect(hook.getCurrent().retry()).toBeNull();
    });
});

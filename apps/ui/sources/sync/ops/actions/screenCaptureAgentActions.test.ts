import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createNativeScreenCaptureAction } from './screenCaptureActions';
import type { NativeCaptureResult } from '@/desktop/capture/nativeCapture';

const events = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
// Only the native/webview event transport is replaced; admission and capture logic are real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = events.get(name) ?? new Set();
    handlers.add(handler); events.set(name, handlers);
    return () => { handlers.delete(handler); };
} }));

function emit(name: string, payload: unknown) {
    for (const handler of events.get(name) ?? []) handler({ payload });
}

describe('agent capture settlement through native state and the existing window bridge', () => {
    const capture: NativeCaptureResult = { captureRef: 'requested', kind: 'still', path: '/Pictures/Happier/requested.png',
        mimeType: 'image/png', byteSize: 3, pixelSize: { width: 1, height: 1 }, scale: 1,
        origin: null, source: null, windowTextRef: null };
    const target = { serverId: 'home', accountId: 'account', sessionId: 'requesting-session' };
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: target.serverId, runtimeAccountId: target.accountId, defaultSessionId: target.sessionId,
        defaultSessionMachineId: 'client' } as const;
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'screenCapture.start': ['agent'] } });
    // Boundary fixture supplies only the native/approval effects this real executor invokes.
    const executor = () => createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction(),
        isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context) } as ActionExecutorDeps);
    let starts: Array<Record<string, unknown> | undefined>;
    let holdStart: Promise<unknown> | undefined;
    beforeEach(() => {
        events.clear(); starts = []; holdStart = undefined;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_start') {
                starts.push(args);
                if (holdStart) return holdStart;
                return { status: 'selecting', operationRef: 7, mode: args?.mode, inventory: { displays: [], windows: [] } };
            }
            if (command === 'desktop_recording_resume') return { phase: 'recording', timing: { durationMs: 1000, activeSinceMs: 10_000 },
                sourceRef: 'requested', result: null, error: null };
            throw new Error('Unexpected desktop command');
        } });
    });
    afterEach(() => { events.clear(); vi.unstubAllGlobals(); });

    it('cancels the admitted Action while an OS picker response remains pending', async () => {
        let releaseStart: (value: unknown) => void = () => {};
        holdStart = new Promise(resolve => { releaseStart = resolve; });
        const controller = new AbortController();
        let settled = false;
        const action = executor().execute('screenCapture.start', { mode: 'screenshot' }, { ...context, signal: controller.signal })
            .then(result => { settled = true; return result; });
        try {
            await vi.waitFor(() => expect(starts).toHaveLength(1));
            controller.abort();
            await vi.waitFor(() => expect(settled).toBe(true));
            expect(await action).toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect([...events.values()].every(handlers => handlers.size === 0)).toBe(true);
        } finally { releaseStart({ status: 'cancelled' }); await action; }
    });

    it('keeps the admission open through unrelated results and a failed Send, then returns the person’s accepted result', async () => {
        let settled = false;
        const result = executor().execute('screenCapture.start', { mode: 'screenshot' }, context)
            .then(value => { settled = true; return value; });
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        expect(starts[0]).toMatchObject({ targetSession: target });
        expect(settled).toBe(false);
        emit('desktopCapture://state', { status: 'completed', operationRef: 8, result: { ...capture, captureRef: 'other' } });
        emit('desktopWindow://action-result', { windowLabel: 'capture', requestId: 'other', phase: 'settled', ok: true,
            result: { captureRef: 'other', messageRef: 'wrong-message' } });
        emit('desktopCapture://state', { status: 'completed', operationRef: 7, result: capture, targetSession: target });
        emit('desktopWindow://action-result', { windowLabel: 'capture', requestId: 'send', phase: 'settled', ok: false,
            errorCode: 'machine_unreachable' });
        await Promise.resolve();
        expect(settled).toBe(false);
        emit('desktopCapture://state', { status: 'failed', reason: 'invalid_selection' });
        emit('desktopWindow://action-result', { windowLabel: 'capture_7', requestId: 'send-retry', phase: 'settled', ok: true,
            result: { captureRef: capture.captureRef, messageRef: 'accepted-message' } });
        expect(await result).toEqual({ ok: true, result: { captureRef: capture.captureRef, messageRef: 'accepted-message' } });
        expect([...events.values()].every(handlers => handlers.size === 0)).toBe(true);
        expect(starts).toHaveLength(1);
    });

    it.each(['discard', 'cancel', 'failure'] as const)('settles %s and releases its native listeners', async outcome => {
        const result = executor().execute('screenCapture.start', { mode: 'screenshot', targetSession: target }, context);
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        if (outcome === 'discard') {
            emit('desktopCapture://state', { status: 'completed', operationRef: 7, result: capture, targetSession: target });
            emit('desktopWindow://action-result', { windowLabel: 'capture', requestId: 'discard', phase: 'settled', ok: true,
                result: { captureRef: capture.captureRef, status: 'discarded' } });
        } else emit('desktopCapture://state', outcome === 'cancel' ? { status: 'cancelled' }
            : { status: 'failed', reason: 'native_failure' });
        expect(await result).toMatchObject({ ok: false, errorCode: outcome === 'failure' ? 'native_failure' : 'cancelled' });
        expect([...events.values()].every(handlers => handlers.size === 0)).toBe(true);
    });

    it.each(['screenshot', 'recording'] as const)('creates one approval for %s and accepts continuation/delivery without another admission', async mode => {
        let approvals = 0;
        const defaults = ActionsSettingsV1Schema.parse({ v: 1 });
        const deps: Partial<ActionExecutorDeps> = {
            screenCaptureAction: createNativeScreenCaptureAction(),
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, defaults, context),
            isApprovalExecutionOriginCurrent: async () => true,
            approvalsCreate: async () => { approvals += 1; return { artifactId: 'capture-approval' }; },
            approvalsUpdate: async () => ({ ok: true as const }),
            approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve' as const,
                request: { ...request, status: 'approved' as const, decision: { kind: 'approve' as const, decidedAtMs: Date.now() } } }),
        };
        const approvedExecutor = createActionExecutor(deps as ActionExecutorDeps);
        const result = approvedExecutor.execute('screenCapture.start', { mode },
            { ...context, actionRequestId: 'capture-approval' });
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        expect(starts[0]?.mode).toBe(mode === 'screenshot' ? 'still' : 'recording');
        if (mode === 'recording') expect(await approvedExecutor.execute('screenCapture.recording.resume', { operationRef: 7 }, context))
            .toMatchObject({ ok: true, result: { phase: 'recording' } });
        emit('desktopCapture://state', { status: 'completed', operationRef: 7,
            result: mode === 'recording' ? { ...capture, kind: 'video', mimeType: 'video/mp4' } : capture, targetSession: target });
        emit('desktopWindow://action-result', { windowLabel: 'capture', requestId: 'add', phase: 'settled', ok: true,
            result: { captureRef: capture.captureRef, imageNumber: 2, waiting: false } });
        expect(await result).toEqual({ ok: true, result: { captureRef: capture.captureRef, imageNumber: 2, waiting: false } });
        expect(approvals).toBe(1);
        expect([...events.values()].every(handlers => handlers.size === 0)).toBe(true);
    });
});

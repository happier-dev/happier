import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor as createExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createNativeScreenCaptureAction, createScreenCaptureAction, prepareCaptureDelivery, readNativeCaptureDelivery, resolveCaptureDelivery, type CaptureDeliveryRecord } from './screenCaptureActions';
import { dispatchDesktopCaptureWindowAction } from '@/utils/platform/desktopWindowActionDispatch';
import type { NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import { createRecordingDocument, type RecordingDocument } from '@/components/screenCapture/recording/recordingDocument';
import { executeMediaAnnotationAction } from './mediaAnnotationActionRuntime';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

function createActionExecutor(deps: Partial<ActionExecutorDeps>) {
    return createExecutor(createActionExecutorBoundaryFixture(deps));
}

describe('capture delivery disclosure', () => {
    afterEach(() => vi.unstubAllGlobals());
    const original = new Uint8Array([1, 2, 3]);
    const prepared = new Uint8Array([4, 5, 6]);
    const record: CaptureDeliveryRecord = {
        captureRef: 'capture', image: { kind: 'prepared', bytes: prepared, name: 'Capture.png' },
        disclosure: { hasMarks: true, includeWindowText: false },
        windowText: { text: 'excluded window text', name: 'Window text.txt' }, inUse: false,
    };

    it('stages still bytes and the reload reference from the same retained native snapshot', async () => {
        const capture = { captureRef: 'capture', kind: 'still', path: '/Capture.png', mimeType: 'image/png' };
        const retained = { ...capture, captureRef: 'retained', path: '/capture-retained-prepared.png' };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_read_result') return capture;
            if (command === 'desktop_capture_read_delivery_state') return { inUse: false, disclosure: record.disclosure, windowText: null };
            if (command === 'desktop_capture_retain_prepared_png') return retained;
            // Parent pixels have changed since the immutable snapshot was retained.
            if (command === 'desktop_capture_read_prepared_png') return [9, 9, 9];
            if (command === 'desktop_capture_read_source_png' && args?.captureRef === 'retained') return [4, 5, 6];
            throw new Error(`Unexpected native command: ${command}`);
        } });
        const metadata = await readNativeCaptureDelivery('capture');
        if ('ok' in metadata) throw new Error('Expected prepared still');
        const delivery = resolveCaptureDelivery(metadata, { surface: 'ui' });
        if ('ok' in delivery || 'recording' in delivery) throw new Error('Expected admitted still');
        const staged = await prepareCaptureDelivery(delivery);
        expect(staged).toMatchObject({ copyImage: prepared, items: [{ kind: 'image', source: {
            bytes: prepared, savedFile: { kind: 'capture', captureRef: 'retained', content: 'source' },
        } }] });
    });

    it('admits a recording as metadata before any decoder, prepared-file or authoring initialization effect', async () => {
        const commands: string[] = [];
        const result = { captureRef: 'movie', kind: 'video', path: '/movie.mp4', mimeType: 'video/mp4' };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            commands.push(command);
            if (command === 'desktop_capture_read_result') return result;
            if (command === 'desktop_capture_read_delivery_state') return { inUse: true, disclosure: null, windowText: null, preparedRecording: null };
            throw new Error('Content must not be read before custody admission');
        } });
        const delivery = await readNativeCaptureDelivery('movie');
        expect(delivery).toMatchObject({ captureRef: 'movie', inUse: true, recording: { result } });
        if ('ok' in delivery) throw new Error('Expected recording metadata');
        expect(resolveCaptureDelivery(delivery, { surface: 'agent' })).toMatchObject({ ok: false, errorCode: 'capture_in_use' });
        expect(commands.sort()).toEqual(['desktop_capture_read_delivery_state', 'desktop_capture_read_result']);
    });

    it('uses burned-in prepared pixels and excludes text unless the persisted disclosure includes it', () => {
        expect(resolveCaptureDelivery(record, { surface: 'agent' })).toEqual({ image: record.image });
        expect(resolveCaptureDelivery({ ...record, disclosure: { ...record.disclosure, includeWindowText: true } }, { surface: 'ui' }))
            .toMatchObject({ windowText: record.windowText });
    });

    it('refuses original pixels for marked captures and another caller while the capture is being edited', () => {
        expect(resolveCaptureDelivery({ ...record, image: { ...record.image, kind: 'original', bytes: original } }, { surface: 'agent' }))
            .toMatchObject({ ok: false, errorCode: 'capture_not_prepared' });
        expect(resolveCaptureDelivery({ ...record, inUse: true }, { surface: 'agent' }))
            .toMatchObject({ ok: false, errorCode: 'capture_in_use' });
        expect(resolveCaptureDelivery({ ...record, inUse: true }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'capture_in_use' });
        expect(resolveCaptureDelivery({ ...record, inUse: true }, { surface: 'ui' }, { captureWindowPress: true }))
            .toMatchObject({ image: { bytes: prepared } });
        expect(resolveCaptureDelivery({ ...record, inUse: true }, { surface: 'agent' }, { captureWindowPress: true }))
            .toMatchObject({ ok: false, errorCode: 'capture_in_use' });
    });

    it('requires prepared pixels when native has no disclosure record yet', () => {
        expect(resolveCaptureDelivery({ ...record, disclosure: { includeWindowText: false },
            image: { ...record.image, kind: 'original', bytes: original } }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'capture_not_prepared' });
    });

    it.each(['screenCapture.addToDraft', 'screenCapture.send'] as const)('%s refuses disclosure and pixel overrides before reading capture content', async actionId => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => undefined });
        let reads = 0;
        const executor = createActionExecutor({ screenCaptureAction: createScreenCaptureAction({
            readDelivery: async () => { reads += 1; return record; },
            open: async () => {}, discard: async () => {},
        }) });
        for (const override of [{ includeWindowText: true }, { marks: [] }, { captureWindowPress: true }]) {
            expect(await executor.execute(actionId, { captureRef: record.captureRef,
                session: { serverId: 'server', accountId: 'account', sessionId: 'session' }, ...override }, { surface: 'agent' }))
                .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        }
        expect(reads).toBe(0);
    });

    it.each(['ui', 'agent', 'mcp'] as const)('rejects delivery from %s while the capture is being edited before reading pixel bytes', async surface => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => undefined });
        let pixelReads = 0;
        const settings = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'screenCapture.addToDraft': ['agent', 'mcp'] } });
        const executor = createActionExecutor({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
            screenCaptureAction: createScreenCaptureAction({
            readDelivery: async () => ({ ...record, inUse: true, image: { kind: 'prepared', name: 'Prepared.png',
                readBytes: async () => { pixelReads += 1; return prepared; } } }),
            open: async () => {}, discard: async () => {},
        }) });
        expect(await executor.execute('screenCapture.addToDraft', { captureRef: record.captureRef,
            session: { serverId: 'server', accountId: 'account', sessionId: 'session' } }, {
                surface, authority: surface === 'ui' ? 'present_user' : 'account_automation', actionCaller: { kind: 'host' },
                serverId: 'server', runtimeAccountId: 'account', defaultSessionMachineId: 'client',
            }))
            .toMatchObject({ ok: false, errorCode: 'capture_in_use' });
        expect(pixelReads).toBe(0);
    });

    it.each(['agent', 'mcp'] as const)('keeps %s custody authoritative before the first prepared record exists', async surface => {
        const commands: string[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            commands.push(command);
            if (command === 'desktop_capture_read_result') return { captureRef: 'capture', kind: 'still', path: '/Capture.png' };
            if (command === 'desktop_capture_read_delivery_state') return { inUse: true, disclosure: null, windowText: null };
            throw new Error('Capture content must not be read');
        } });
        const settings = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'screenCapture.addToDraft': [surface] } });
        const executor = createActionExecutor({
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
            screenCaptureAction: createNativeScreenCaptureAction(),
        });
        expect(await executor.execute('screenCapture.addToDraft', { captureRef: 'capture',
            session: { serverId: 'server', accountId: 'account', sessionId: 'session' } }, {
                surface, authority: 'account_automation', actionCaller: { kind: 'host' },
                serverId: 'server', runtimeAccountId: 'account', defaultSessionMachineId: 'client',
            })).toMatchObject({ ok: false, errorCode: 'capture_in_use' });
        expect(commands.sort()).toEqual(['desktop_capture_read_delivery_state', 'desktop_capture_read_result']);
    });

    it('persists a fresh agent capture’s default-on disclosure before its native text read', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const before = storage.getState().localSettings;
        const commands: string[] = [];
        let included = false;
        const capture: NativeCaptureResult = { captureRef: 'fresh', kind: 'still', path: '/Capture.png',
            mimeType: 'image/png', byteSize: 3, pixelSize: { width: 1, height: 1 }, scale: 1,
            origin: null, source: null, windowTextRef: null };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            commands.push(command);
            if (command === 'desktop_capture_start') return { status: 'completed', operationRef: 1, result: capture };
            if (command === 'desktop_capture_read_result') return capture;
            if (command === 'desktop_capture_read_delivery_state') return { inUse: false, disclosure: null, windowText: null };
            if (command === 'desktop_capture_read_source_png') return [1, 2, 3];
            if (command === 'desktop_capture_retain_prepared_png') return capture;
            if (command === 'desktop_capture_settle') return { status: 'idle' };
            if (command === 'desktop_capture_write_prepared_png') {
                included = (args?.disclosure as { includeWindowText: boolean }).includeWindowText;
                return capture;
            }
            // The native owner refuses text before the persisted Include authority exists.
            // A native cancellation after that boundary keeps this order test out of upload transport.
            if (command === 'desktop_capture_window_text') throw included ? 'cancelled' : 'blurred_capture';
            throw new Error('Unexpected fresh native command');
        } });
        const settings = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'screenCapture.start': ['agent'] } });
        try {
            storage.setState({ localSettings: { ...before, screenCaptureIncludeWindowText: true } });
            const executor = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction(),
                isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context) });
            expect(await executor.execute('screenCapture.start', { mode: 'screenshot', target: { kind: 'frontmost' }, targetSession: {
                serverId: 'server', accountId: 'account', sessionId: 'session' } }, {
                surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                serverId: 'server', runtimeAccountId: 'account', defaultSessionMachineId: 'client',
            })).toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(commands.indexOf('desktop_capture_write_prepared_png')).toBeLessThan(commands.indexOf('desktop_capture_window_text'));
        } finally { storage.setState({ localSettings: before }); }
    });

    it('runs the Capture window request through real Action admission and returns only its native settled result', async () => {
        const emitted: unknown[] = [];
        const opened: unknown[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_window_emit_action_result') emitted.push(args?.payload);
        } });
        const executor = createActionExecutor({ screenCaptureAction: createScreenCaptureAction({
            readDelivery: async () => record,
            open: async input => { opened.push(input); },
            discard: async () => {},
        }) });
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture', requestId: 'request',
            actionIdentifier: 'screenCapture.open', data: { captureRef: record.captureRef } }, executor);
        expect(opened).toEqual([{ captureRef: record.captureRef }]);
        expect(emitted).toEqual([
            { windowLabel: 'capture', requestId: 'request', phase: 'admitted', ok: true },
            { windowLabel: 'capture', requestId: 'request', phase: 'settled', ok: true,
                result: { captureRef: record.captureRef, status: 'opened' } },
        ]);
        expect(JSON.stringify(emitted)).not.toContain('excluded window text');
    });

    it('refuses non-desktop execution without reading or opening any native capture', async () => {
        const calls: string[] = [];
        const executor = createActionExecutor({ screenCaptureAction: createScreenCaptureAction({
            readDelivery: async () => { calls.push('read'); return record; },
            open: async () => { calls.push('open'); }, discard: async () => { calls.push('discard'); },
        }) });
        expect(await executor.execute('screenCapture.open', { captureRef: record.captureRef }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'desktop_only' });
        expect(calls).toEqual([]);
    });

    it('retains the native target pin when focus changes before reopening a capture', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { setFocusedSessionId, resetSessionSurfaceVisibilityForTests } = await import('@/sync/domains/session/sessionSurfaceVisibility');
        const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { resolveCaptureDefaultTarget } = await import('@/components/screenCapture/main/resolveCaptureDefaultTarget');
        const before = storage.getState();
        const pinned = { serverId: 'home', accountId: 'account', sessionId: 'pinned' };
        let forwarded: unknown;
        let stateReads = 0;
        const captured: NativeCaptureResult = { captureRef: record.captureRef, kind: 'still', path: '/Pictures/Capture.png',
            mimeType: 'image/png', byteSize: 3, pixelSize: { width: 1, height: 1 }, scale: 1,
            origin: null, source: null, windowTextRef: null };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_read_state') {
                stateReads += 1;
                return args?.captureRef === captured.captureRef
                    ? { status: 'completed', operationRef: 1, targetSession: pinned, result: captured }
                    : { status: 'completed', operationRef: 2, result: { ...captured, captureRef: 'newer' } };
            }
            if (command === 'desktop_capture_open') { forwarded = args?.targetSession; return { status: 'idle' }; }
            throw new Error('Unexpected native command');
        } });
        try {
            storage.setState({ sessionListRowsByServerId: { home: { focused: createSessionListRenderableSessionFixture({ id: 'focused' }) } },
                ordinarySessionListMembershipByServerId: { home: ['focused'] } });
            setFocusedSessionId('focused', 'home');
            expect(resolveCaptureDefaultTarget()).toEqual({ serverId: 'home', sessionId: 'focused' });
            expect(await createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction() }).execute('screenCapture.open',
                { captureRef: record.captureRef }, { surface: 'ui' })).toMatchObject({ ok: true });
            expect(forwarded).toEqual(pinned);
            expect(stateReads).toBe(1);
        } finally { resetSessionSurfaceVisibilityForTests(); storage.setState(before, true); }
    });

    it('remembers only an accepted explicit Capture chooser pick in the existing recent-target owner', async () => {
        const { readLastCaptureSessionPick } = await import('@/sync/domains/session/navigation/recentSessions');
        const { clearPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { buildServerScopedSessionKey } = await import('@/sync/domains/session/navigation/sessionNavigationOrder');
        const target = { serverId: 'home', accountId: 'account', sessionId: 'picked' };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => undefined });
        clearPersistenceStorage();
        try {
            const port = { readDelivery: async () => record, open: async () => {}, discard: async () => {} };
            const input = { captureRef: record.captureRef, targetSession: target };
            const executor = createActionExecutor({ screenCaptureAction: createScreenCaptureAction(port) });
            await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture_1', requestId: 'carried-pin',
                actionIdentifier: 'screenCapture.open', data: input }, executor);
            expect(readLastCaptureSessionPick()).toBeNull();
            await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture_1', requestId: 'chosen-pin', intent: 'chooseSession',
                actionIdentifier: 'screenCapture.open', data: input }, executor);
            expect(readLastCaptureSessionPick()?.sessionKey).toBe(buildServerScopedSessionKey('picked', 'home'));
        } finally { clearPersistenceStorage(); }
    });
});

describe('native recording Action continuation', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('drives the admitted operation through recording, pause, resume and finalized library output', async () => {
        const commands: string[] = [];
        const emitted: unknown[] = [];
        const timing = { durationMs: 2_500, activeSinceMs: 10_000 };
        const video: NativeCaptureResult = { captureRef: 'movie', kind: 'video', path: '/Pictures/Capture.mp4',
            mimeType: 'video/mp4', byteSize: 100, pixelSize: { width: 20, height: 10 }, scale: 1,
            origin: null, source: null, windowTextRef: null };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_window_emit_action_result') { emitted.push(args?.payload); return; }
            commands.push(command);
            if (command === 'desktop_capture_start') {
                expect(args).toEqual({ mode: 'recording', target: { kind: 'display', displayId: 1 } });
                return { status: 'recording', operationRef: 7,
                    recording: { phase: 'recording', timing, sourceRef: 'movie', result: null, error: null } };
            }
            expect(args).toEqual({ operationRef: 7 });
            return { phase: command.endsWith('stop') ? 'ready' : command.endsWith('pause') ? 'paused' : 'recording',
                timing: { ...timing, activeSinceMs: command.endsWith('pause') || command.endsWith('stop') ? null : timing.activeSinceMs },
                sourceRef: 'movie', result: command.endsWith('stop') ? video : null, error: null };
        } });
        const executor = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        const person = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const startId = ActionIdSchema.parse('screenCapture.start');
        const started = await executor.execute(startId, { mode: 'recording', target: { kind: 'display', displayId: 1 } }, person);
        expect(started).toMatchObject({ ok: true, result: { status: 'recording', operationRef: 7 } });
        if (started.ok) expect(getActionSpec(startId).outputSchema?.safeParse(started.result).success).toBe(true);
        for (const [suffix, phase] of [['status', 'recording'], ['pause', 'paused'], ['resume', 'recording'], ['stop', 'ready']] as const) {
            const id = ActionIdSchema.parse(`screenCapture.recording.${suffix}`);
            if (suffix === 'pause') {
                await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture', requestId: 'pause',
                    actionIdentifier: id, data: { operationRef: 7 } }, executor);
                expect(emitted).toEqual([
                    { windowLabel: 'capture', requestId: 'pause', phase: 'admitted', ok: true },
                    { windowLabel: 'capture', requestId: 'pause', phase: 'settled', ok: true,
                        result: { phase: 'paused', timing: { ...timing, activeSinceMs: null }, sourceRef: 'movie', result: null, error: null } },
                ]);
                continue;
            }
            const result = await executor.execute(id, { operationRef: 7 }, person);
            expect(result).toMatchObject({ ok: true, result: { phase, ...(phase === 'ready' ? { result: video } : {}) } });
            if (result.ok) expect(getActionSpec(id).outputSchema?.safeParse(result.result).success).toBe(true);
        }
        expect(commands).toEqual(['desktop_capture_start', 'desktop_recording_status', 'desktop_recording_pause',
            'desktop_recording_resume', 'desktop_recording_stop']);
    });

    it('preserves the native refusal and never retries the settled recording operation', async () => {
        const invoke = vi.fn().mockRejectedValue('operation_unavailable');
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const executor = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        const id = ActionIdSchema.parse('screenCapture.recording.pause');
        expect(await executor.execute(id, { operationRef: 7 }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
        expect(invoke).toHaveBeenCalledTimes(1);
    });
});

describe('recording document Actions through the native authoring slot', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('publishes the document owners one-frame trim and refuses an inverted replacement', async () => {
        let document = createRecordingDocument({ sourceCaptureRef: 'movie', durationMs: 4288,
            frameDurationMs: 1000 / 60, includeWindowText: false });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_recording_document_read') return document;
            if (command === 'desktop_recording_document_write') {
                document = args?.document as RecordingDocument;
                return document;
            }
            throw new Error('Unexpected authoring boundary command');
        } });
        const executor = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        expect(await executor.execute('screenCapture.recording.edit', { captureRef: 'movie', operations: [
            { kind: 'trim.set', startMs: 4288, endMs: 4288 },
        ] }, { surface: 'ui' })).toMatchObject({ ok: true });
        expect(document.trim).toEqual({ startMs: 4271, endMs: 4288 });
        const before = document;
        expect(await executor.execute('screenCapture.recording.edit', { captureRef: 'movie', operations: [
            { kind: 'trim.set', startMs: 4200, endMs: 4100 },
        ] }, { surface: 'ui' })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(document).toBe(before);
    });

    it('edits source-time moments and applies P2 frame marks through one current document without a disclosure bypass', async () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: true });
        const writes: RecordingDocument[] = [];
        const commands: string[] = [];
        const responses: unknown[] = [];
        const captured: NativeCaptureResult = { captureRef: 'movie', kind: 'video', path: '/Pictures/Capture.mp4',
            mimeType: 'video/mp4', byteSize: 100, pixelSize: { width: 80, height: 60 }, scale: 1,
            origin: null, source: null, windowTextRef: null };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            commands.push(command);
            if (command === 'desktop_window_emit_action_result') { responses.push(args?.payload); return; }
            if (command === 'desktop_recording_document_read') return document;
            if (command === 'desktop_recording_document_write') {
                // The native slot carries a constructor-built document through this typed IPC boundary.
                expect(args?.expectedDocument).toEqual(document);
                document = args?.document as RecordingDocument;
                writes.push(document);
                return document;
            }
            if (command === 'desktop_capture_read_result') return captured;
            throw new Error('Unexpected authoring boundary command');
        } });
        let approvalRequests = 0;
        const recordingSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'screenCapture.recording.edit': { approvalRequiredSurfaces: ['agent'] },
            'screenCapture.recording.read': { approvalRequiredSurfaces: ['agent'] },
        } });
        const executor = createActionExecutor({
            screenCaptureAction: createNativeScreenCaptureAction(), mediaAnnotation: executeMediaAnnotationAction,
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, recordingSettings, context),
            isApprovalExecutionOriginCurrent: async () => true,
            approvalsCreate: async () => { approvalRequests += 1; return { artifactId: 'recording-read-approval' }; },
            approvalsUpdate: async () => ({ ok: true }),
            approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve', request: {
                ...request, status: 'approved', decision: { kind: 'approve', decidedAtMs: 2 },
            } }),
        });
        const scope = { serverId: 'home', accountId: 'alice' };
        const person = { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId } as const;
        await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture', requestId: 'edit',
            actionIdentifier: 'screenCapture.recording.edit', data: { captureRef: 'movie', operations: [
            { kind: 'trim.set', startMs: 5_000, endMs: 15_000 },
            { kind: 'pin.add', sourceTimeMs: 7_000 },
            { kind: 'note.set', id: 'words', sourceTimeMs: 7_000, text: 'Observe the transition' },
        ] } }, executor);
        expect(responses.at(-1)).toMatchObject({ phase: 'settled', ok: true, result: { pins: [7_000] } });
        expect(writes).toHaveLength(1);
        const target = { kind: 'recordingFrame', captureRef: 'movie', sourceTimeMs: 7_000 } as const;
        const { storage } = await import('@/sync/domains/state/storage');
        const previousScope = storage.getState().profileScope;
        try {
            storage.setState({ profileScope: scope });
            await dispatchDesktopCaptureWindowAction({ windowLabel: 'capture', requestId: 'frame',
                actionIdentifier: 'media.annotation.read', data: { target, scope: { serverId: 'foreign', accountId: 'foreign' } } }, executor);
            expect(responses.at(-1)).toMatchObject({ ok: true, result: { image: { width: 80, height: 60 }, hasBlur: false } });
        } finally { storage.setState({ profileScope: previousScope }); }
        expect(await executor.execute('media.annotation.apply', { scope, target, operations: [{ kind: 'mark.add',
            mark: { id: 'private', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' } }] }, person))
            .toMatchObject({ ok: true, result: { status: 'replaced' } });
        expect(writes).toHaveLength(2);
        expect(document.videoDisclosure.included).toBe(false);
        expect(document.windowTextDisclosure.included).toBe(false);
        expect(await executor.execute('media.annotation.read', { scope, target }, person))
            .toMatchObject({ ok: true, result: { hasBlur: true, document: { marks: [{ id: 'private' }] } } });
        expect(await executor.execute('screenCapture.recording.read', { captureRef: 'movie' }, person))
            .toMatchObject({ ok: true, result: { captureRef: 'movie', trim: { startMs: 5_000, endMs: 15_000 },
                videoIncluded: false, windowTextIncluded: false, frames: [{ sourceTimeMs: 7_000, timeMs: 2_000, hasBlur: true }] } });
        expect(await executor.execute('screenCapture.recording.read', { captureRef: 'movie', frameAtMs: 20_001 }, {
            ...person, surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
            actionRequestId: 'recording-frame-read', defaultSessionMachineId: 'client',
        }))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(approvalRequests).toBe(1);
        expect(await executor.execute('screenCapture.recording.edit', { captureRef: 'movie', operations: [{ kind: 'includeVideo.set', mode: 'on' }] }, person))
            .toMatchObject({ ok: true, result: { videoIncluded: false } });
        expect(document.videoDisclosure.warning).toBe('pending');
        const approvedDisclosure = await executor.execute('screenCapture.recording.edit', { captureRef: 'movie', operations: [
            { kind: 'disclosure.warning', include: true },
            { kind: 'windowText.set', included: true },
            { kind: 'windowText.warning', include: true },
        ] }, {
            ...person, surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
            actionRequestId: 'recording-include-warning', defaultSessionMachineId: 'client',
        });
        expect(approvalRequests).toBe(2);
        expect(approvedDisclosure).toMatchObject({ ok: true, result: { videoIncluded: true, windowTextIncluded: true } });
        expect(await executor.execute('screenCapture.recording.edit', { captureRef: 'movie', operations: [
            { kind: 'disclosure.warning', include: true },
        ] }, person)).toMatchObject({ ok: true, result: { videoIncluded: true } });
        expect(await executor.execute('media.annotation.apply', { scope, target, operations: [{ kind: 'reset' }], cause: 'undo' }, person))
            .toMatchObject({ ok: true, result: { status: 'reverted' } });
        expect(document.windowTextDisclosure.included).toBe(true);
        expect(await executor.execute('media.annotation.apply', { scope, target, operations: [{ kind: 'mark.add',
            mark: { id: 'private', kind: 'blur', rect: { x: 0, y: 0, width: 20, height: 20 }, size: 'm' } }], cause: 'redo' }, person))
            .toMatchObject({ ok: true, result: { status: 'replaced' } });
        expect(document.videoDisclosure.included).toBe(false);
        const beforeAgentHistory = commands.length;
        expect(await executor.execute('media.annotation.apply', { scope, target, operations: [{ kind: 'reset' }], cause: 'undo' }, {
            ...person, surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
        })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(commands).toHaveLength(beforeAgentHistory);
        expect(await executor.execute('media.annotation.apply', { scope, target, operations: [{ kind: 'crop.set',
            rect: { x: 0, y: 0, width: 10, height: 10 } }] }, person)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(writes).toHaveLength(6);
        const beforeForeign = commands.length;
        expect(await executor.execute('media.annotation.apply', { scope: { ...scope, accountId: 'foreign' }, target, reset: true }, person))
            .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'annotation.targetUnavailable' } });
        expect(commands).toHaveLength(beforeForeign);
    });
});

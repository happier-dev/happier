import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRecentCaptures, openRecentCapture, readCaptureResult, readPreparedCapturePng, subscribeNativeCapturePermissions,
    loadNativeRecordingDocument, prepareNativeRecording, trimNativeRecording, writePreparedCapturePng,
    openNativeCapturePermissionSettings, readComputerDriverBundleDragInfo, type NativeCaptureResult } from './nativeCapture';
import { createRecordingDocument } from '@/components/screenCapture/recording/recordingDocument';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

const eventBoundary = vi.hoisted(() => ({
    listen: vi.fn<(event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>(),
}));
// Tauri events are the OS/webview transport; the capture adapter itself stays real.
vi.mock('@tauri-apps/api/event', () => ({ listen: eventBoundary.listen }));

afterEach(() => vi.unstubAllGlobals());

describe('native capture byte transport', () => {
    it.each([null, { isLocal: false, bundlePath: '/Applications/Driver.app' }, { isLocal: true, bundlePath: null }])(
        'offers no driver tile or native lookup when the canonical local bundle source is unavailable: %o', async source => {
            const invoke = vi.fn(async (_command: string, args?: { target?: { bundlePath?: string } }) => args?.target?.bundlePath
                ? { bundlePath: '/Applications/Driver.app', displayName: 'Driver' } : null);
            vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
            await expect(readComputerDriverBundleDragInfo(source)).resolves.toBeNull();
            expect(invoke).not.toHaveBeenCalled();
        },
    );
    it('positions the explicit permission helper once after Settings opens, without reading a grant', async () => {
        const commands: string[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => { commands.push(command); return true; } });
        await openNativeCapturePermissionSettings('window_text', { permissionHelper: true });
        expect(commands).toEqual(['desktop_capture_open_permission_settings', 'desktop_capture_place_permission_helper']);
        commands.length = 0;
        await openNativeCapturePermissionSettings('screen');
        expect(commands).toEqual(['desktop_capture_open_permission_settings']);
    });
    it.each(['pipewire_unavailable', 'video_encoder_unavailable', 'video_muxer_unavailable',
        'video_decoder_unavailable', 'cursor_unavailable', 'video_pipeline_unavailable'] as const)(
        'preserves the native prerequisite %s at the capture boundary without retrying', async code => {
            const invoke = vi.fn().mockRejectedValue(code);
            vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
            await expect(readCaptureResult('movie')).rejects.toMatchObject({ code, message: code });
            expect(invoke).toHaveBeenCalledTimes(1);
        },
    );
    it('starts zero native effects when recording trim is already aborted', async () => {
        const invoke = vi.fn(async () => ({ captureRef: 'unexpected-derivative' }));
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const controller = new AbortController(); controller.abort();
        await expect(trimNativeRecording('movie', 100, 200, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(invoke).not.toHaveBeenCalled();
    });
    it('cancels one admitted native trim and awaits both native settlement and cancel IPC before retry', async () => {
        let nativeStarted!: () => void;
        const started = new Promise<void>(resolve => { nativeStarted = resolve; });
        let cancelObserved!: () => void;
        const cancelling = new Promise<void>(resolve => { cancelObserved = resolve; });
        let finishNative!: (value: NativeCaptureResult) => void;
        const native = new Promise<NativeCaptureResult>(resolve => { finishNative = resolve; });
        let finishCancel!: () => void;
        const cancelReply = new Promise<void>(resolve => { finishCancel = resolve; });
        const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_recording_trim') { nativeStarted(); return native; }
            if (command === 'desktop_recording_trim_cancel') {
                expect(args).toEqual({ captureRef: 'movie' });
                cancelObserved(); return cancelReply;
            }
            throw 'operation_unavailable';
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const controller = new AbortController();
        let settled = false;
        const trimming = trimNativeRecording('movie', 100, 200, controller.signal);
        const outcome = trimming.then(result => { settled = true; return result; }, error => { settled = true; return error; });
        await started;
        controller.abort();
        await cancelling;
        expect(settled, 'abort does not leave the native writer running behind a settled caller').toBe(false);
        finishNative({ captureRef: 'completed-before-cancel', kind: 'video', path: '/library/derived.mp4',
            mimeType: 'video/mp4', byteSize: 8, pixelSize: { width: 2, height: 2 },
            scale: null, origin: null, source: null, windowTextRef: null });
        await Promise.resolve();
        expect(settled, 'a late cancel IPC must settle before the next trim can begin').toBe(false);
        finishCancel();
        expect(await outcome).toMatchObject({ name: 'AbortError' });
        const calls = invoke.mock.calls.length;
        controller.signal.dispatchEvent(new Event('abort'));
        await Promise.resolve();
        expect(invoke.mock.calls.length, 'settlement releases the abort listener').toBe(calls);
    });
    it('initializes one retained authoring document from the duration and local disclosure preference, then reuses it', async () => {
        getPersistenceStorage().set('local-settings', JSON.stringify({ screenCaptureIncludeWindowText: true }));
        const initial = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 2100, includeWindowText: true });
        let retained: ReturnType<typeof createRecordingDocument> | null = null;
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_recording_document_read') return retained;
            if (command === 'desktop_recording_timing') return { durationMs: 2100, frameDurationMs: 1000 / 25 };
            if (command === 'desktop_recording_document_write') {
                expect(args?.initializeOnly).toBe(true);
                expect(args?.document).toEqual(initial);
                // Another renderer committed a pin before native initialization adopted this request.
                retained = { ...initial, pins: [700] };
                return retained;
            }
            throw 'operation_unavailable';
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        const first = await loadNativeRecordingDocument('movie');
        expect(first).toEqual({ ...initial, pins: [700] });
        expect(invoke.mock.calls.map(([command]) => command)).toEqual([
            'desktop_recording_document_read', 'desktop_recording_timing', 'desktop_recording_document_write',
        ]);
        getPersistenceStorage().set('local-settings', JSON.stringify({ screenCaptureIncludeWindowText: false }));
        expect(await loadNativeRecordingDocument('movie')).toEqual(first);
        expect(invoke.mock.calls.map(([command]) => command).slice(3)).toEqual(['desktop_recording_document_read']);
    });
    it('prepares selected flattened frames in one native batch with the shared disclosure decision', async () => {
        const prepared = { captureRef: 'movie', frames: [
            { frameRef: 'frame-1', timeMs: 0, note: 'Timestamped note', byteSize: 3, pixelSize: { width: 1, height: 1 } },
            { frameRef: 'frame-2', timeMs: 1000, note: null, byteSize: 3, pixelSize: { width: 1, height: 1 } },
        ], videoRef: null, includeVideo: false, byteSize: 6 };
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_recording_prepare') {
                expect(args).toEqual({ captureRef: 'movie', frames: [
                    { timeMs: 0, bytes: [0, 255, 42], note: 'Timestamped note' },
                    { timeMs: 1000, bytes: [0, 255, 42], note: null },
                ], videoRef: null, includeVideo: false, hasMarks: true, includeWindowText: false });
                return prepared;
            }
            throw 'operation_unavailable';
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        expect(await prepareNativeRecording({ captureRef: 'movie', frames: [
            { timeMs: 0, bytes: new Uint8Array([0, 255, 42]), note: 'Timestamped note' },
            { timeMs: 1000, bytes: new Uint8Array([0, 255, 42]) },
        ], includeVideo: false, hasMarks: true, includeWindowText: false })).toEqual(prepared);
        expect(invoke).toHaveBeenCalledTimes(1); // One batch IPC, never K per-frame posts.
    });
    it('writes the edited PNG and reads only its prepared output by captureRef', async () => {
        let prepared: number[] = [];
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_write_prepared_png') {
                prepared = args!.bytes as number[];
                return { captureRef: args!.captureRef, path: '/library/capture-prepared.png',
                    mimeType: 'image/png', byteSize: prepared.length, pixelSize: { width: 2, height: 1 } };
            }
            if (command === 'desktop_capture_read_prepared_png') return prepared;
            throw new Error('unexpected native effect');
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        await writePreparedCapturePng('capture-1', new Uint8Array([0, 255, 42]), { hasMarks: true, includeWindowText: false });
        expect(await readPreparedCapturePng('capture-1')).toEqual(new Uint8Array([0, 255, 42]));
        expect(invoke.mock.calls.map(([command]) => command)).toEqual([
            'desktop_capture_write_prepared_png', 'desktop_capture_read_prepared_png',
        ]);
        expect(invoke.mock.calls[0]?.[1]).toEqual({ captureRef: 'capture-1', bytes: [0, 255, 42],
            disclosure: { hasMarks: true, includeWindowText: false } });
    });

    it('preserves a prepared-missing refusal instead of reading source bytes', async () => {
        const invoke = vi.fn().mockRejectedValue('prepared_missing');
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        await expect(readPreparedCapturePng('capture-1')).rejects.toMatchObject({ code: 'prepared_missing' });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('keeps a platform refusal actionable without exposing an unexpected native message', async () => {
        const invoke = vi.fn().mockRejectedValueOnce('portal_denied')
            .mockRejectedValueOnce(new Error('unexpected native diagnostic'));
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        await expect(readCaptureResult('capture-1')).rejects.toMatchObject({ code: 'portal_denied' });
        await expect(readCaptureResult('capture-1')).rejects.toMatchObject({ code: 'native_failure', message: 'native_failure' });
        expect(invoke).toHaveBeenCalledTimes(2);
    });

    it('preserves an incomplete selected-media refusal without retrying or falling back to another file', async () => {
        const invoke = vi.fn().mockRejectedValue('invalid_media');
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        await expect(openRecentCapture('/selected/incomplete.mp4')).rejects.toMatchObject({ code: 'invalid_media' });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('refuses browser and Electron capture without an invoke', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        vi.stubGlobal('navigator', { userAgent: 'Browser' });
        await expect(readCaptureResult('capture-1')).rejects.toMatchObject({ code: 'desktop_only' });
        await expect(listRecentCaptures()).rejects.toMatchObject({ code: 'desktop_only' });
        const invoke = vi.fn();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
        vi.stubGlobal('navigator', { userAgent: 'Electron/40.0' });
        await expect(readCaptureResult('capture-1')).rejects.toMatchObject({ code: 'desktop_only' });
        await expect(openRecentCapture('/selected/image.png')).rejects.toMatchObject({ code: 'desktop_only' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('releases native permission demand when its initial presenter fails', async () => {
        const stop = vi.fn();
        eventBoundary.listen.mockResolvedValue(stop);
        const demand: boolean[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (_command: string, args: Record<string, unknown>) => {
            demand.push(args.consumed === true);
            return args.consumed ? { screen: 'granted', windowText: 'request_required' } : null;
        } });
        await expect(subscribeNativeCapturePermissions(() => { throw new Error('presenter failed'); }))
            .rejects.toThrow('presenter failed');
        expect(demand).toEqual([true, false]);
        expect(stop).toHaveBeenCalledTimes(1);
    });
    it('retires the attached permission listener on hide before an in-flight initial watch read settles', async () => {
        const stop = vi.fn();
        eventBoundary.listen.mockResolvedValue(stop);
        let finishRead: ((value: unknown) => void) | undefined;
        let admitted: (() => void) | undefined;
        const started = new Promise<void>(resolve => { admitted = resolve; });
        const initialRead = new Promise(resolve => { finishRead = resolve; });
        const demand: boolean[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (_command: string, args: Record<string, unknown>) => {
            demand.push(args.consumed === true);
            if (args.consumed) { admitted?.(); return initialRead; }
            return null;
        } });
        const receive = vi.fn();
        const view = new AbortController();
        const pending = subscribeNativeCapturePermissions(receive, view.signal);
        await started;
        view.abort();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(demand).toEqual([true, false]);
        finishRead?.({ screen: 'granted', windowText: 'granted' });
        const dispose = await pending;
        dispose();
        expect(receive).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(demand).toEqual([true, false]);
    });
});

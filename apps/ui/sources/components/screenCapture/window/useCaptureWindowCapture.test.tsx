import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import type { NativeCaptureResult, NativeCaptureSnapshot } from '@/desktop/capture/nativeCapture';
import { useCaptureWindowCapture } from './useCaptureWindowCapture';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { loadLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { createRecordingDocument, reduceRecordingDocument } from '../recording/recordingDocument';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createNativeScreenCaptureAction } from '@/sync/ops/actions/screenCaptureActions';
import { executeMediaAnnotationAction } from '@/sync/ops/actions/mediaAnnotationActionRuntime';
import { dispatchDesktopCaptureWindowAction } from '@/utils/platform/desktopWindowActionDispatch';
import type { DesktopWindowActionRequest } from '@/utils/platform/desktopWindowActionBridge';
import { useRecordingMedia } from '../recording/useRecordingMedia';

// Expo asset resolution is the packaged-media boundary; playback stays at browser Audio.
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: string) => ({ uri: asset }) } }));

const events = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: unknown }) => void>() }));
// Tauri's event SDK is the process boundary; nativeCapture/desktopHost stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    events.listeners.set(event, handler);
    return () => { events.listeners.delete(event); };
} }));

const capture: NativeCaptureResult = { captureRef: 'capture', kind: 'still', path: '/library/Capture.png',
    mimeType: 'image/png', byteSize: 4, pixelSize: { width: 6, height: 4 }, scale: 1, origin: null, source: null, windowTextRef: null };
const targetSession = { serverId: 'home', accountId: 'account', sessionId: 'session' };

describe('Capture window native source and prepared export', () => {
    afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); });
    it('recovers a failed movie source without changing any edit or reinitializing its duration', async () => {
        const movie: NativeCaptureResult = { ...capture, kind: 'video', mimeType: 'video/mp4' };
        const edited = [
            { kind: 'trim.set', startMs: 36_936, endMs: 37_136 },
            { kind: 'defaultPin.move', sourceTimeMs: 2621 },
            { kind: 'pin.add', sourceTimeMs: 12_000 },
            { kind: 'note.set', id: 'note', sourceTimeMs: 12_000, text: 'Keep this edit' },
            { kind: 'includeVideo.set', mode: 'off' },
        ] satisfies import('../recording/recordingDocument').RecordingOperation[];
        const original = edited.reduce(reduceRecordingDocument,
            createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: movie.captureRef, durationMs: 37_136, includeWindowText: true }));
        let missing = true;
        const calls: string[] = [];
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') events.listeners.get('desktopCapture://window')?.({ payload: 'start' });
                else events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 1, result: movie, targetSession } });
                return true;
            }
            if (command === 'desktop_recording_document_read') return original;
            if (command === 'desktop_capture_read_source_png') {
                if (missing) throw 'file_io';
                return [1, 2, 3];
            }
            throw new Error(`Unexpected source recovery effect: ${command}`);
        } });
        const hook = await renderHook(() => ({ held: useCaptureWindowCapture(), source: useRecordingMedia(movie, null) }));
        // The source failure and native document replay settle independently.
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(hook.getCurrent().held.recordingDocument).toEqual(original);
        });
        expect(hook.getCurrent().source.status).toBe('failed');
        expect(hook.getCurrent().held.recordingDocument).toEqual(original);
        missing = false;
        await act(async () => { hook.getCurrent().source.retry(); });
        expect(hook.getCurrent().source.status).toBe('ready');
        expect(hook.getCurrent().held.recordingDocument).toEqual(original);
        expect(calls).not.toContain('desktop_recording_timing');
        expect(calls).not.toContain('desktop_recording_document_write');
    });

    it('keeps exactly one start wake listener hidden, performs no idle work, and subscribes before each native replay', async () => {
        const counts = createRenderCommitCounter();
        const raster = installImageAnnotationCanvasBoundary();
        const played: string[] = [];
        vi.stubGlobal('Audio', class { constructor(readonly src: string) {} async play() { played.push(this.src); } });
        let snapshot: NativeCaptureSnapshot = { status: 'idle' };
        const calls: string[] = [];
        let completeSource: ((bytes: number[]) => void) | undefined;
        let replayed: (() => void) | undefined;
        let announceWake: () => void = () => {};
        const wakeReady = new Promise<void>(resolve => { announceWake = resolve; });
        const lifecycle = (payload: 'start' | 'hidden') => events.listeners.get('desktopCapture://window')?.({ payload });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { if (snapshot.status !== 'idle') lifecycle('start'); announceWake(); }
                else {
                    expect(events.listeners.has('desktopCapture://state')).toBe(true);
                    events.listeners.get('desktopCapture://state')?.({ payload: snapshot });
                    replayed?.();
                }
                return snapshot.status !== 'idle';
            }
            if (command === 'desktop_capture_read_source_png') return args?.captureRef === 'pending'
                ? new Promise<number[]>(resolve => { completeSource = resolve; }) : [137, 80, 78, 71];
            throw new Error(`Unexpected hidden effect ${command}`);
        } });
        const hook = await renderHook(() => { useRenderCommitCounter(counts); return useCaptureWindowCapture(); });
        await act(async () => { await wakeReady; });
        expect([...events.listeners.keys()]).toEqual(['desktopCapture://window']);
        const start = async (captureRef: string) => {
            const replay = new Promise<void>(resolve => { replayed = resolve; });
            await act(async () => {
                snapshot = { status: 'completed', operationRef: 1, result: { ...capture, captureRef }, targetSession };
                lifecycle('start');
                await replay;
            });
        };
        await start('first');
        expect(hook.getCurrent()).toMatchObject({ active: true, status: 'ready', capture: { captureRef: 'first' } });
        expect(calls.filter(command => command === 'desktop_capture_read_source_png')).toHaveLength(1);
        await act(async () => { lifecycle('hidden'); });
        expect([...events.listeners.keys()]).toEqual(['desktopCapture://window']);
        counts.reset();
        const idleCalls = [...calls];
        vi.useFakeTimers();
        try {
            await act(async () => {
                events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', result: { ...capture, captureRef: 'headless' } } });
                events.listeners.get('desktopCapture://permissions')?.({ payload: { windowText: 'granted' } });
                vi.advanceTimersByTime(60_000);
            });
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            expect(calls).toEqual(idleCalls);
            expect(raster.encodeCount()).toBe(0);
            expect(played).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
        await start('second');
        expect(hook.getCurrent()).toMatchObject({ active: true, status: 'ready', capture: { captureRef: 'second' } });
        expect(calls.filter(command => command === 'desktop_capture_read_source_png')).toHaveLength(2);
        await act(async () => { lifecycle('hidden'); });
        await start('pending');
        expect(hook.getCurrent().status).toBe('loading');
        const signal = hook.getCurrent().signal;
        await act(async () => { lifecycle('hidden'); });
        expect(signal?.aborted).toBe(true);
        const createUrl = vi.spyOn(URL, 'createObjectURL');
        counts.reset();
        await act(async () => { completeSource?.([137, 80, 78, 71]); });
        expect(counts.read()).toEqual({ renders: 0, commits: 0 });
        expect(createUrl).not.toHaveBeenCalled();
        expect([...events.listeners.keys()]).toEqual(['desktopCapture://window']);
        await hook.unmount();
        expect(events.listeners.size).toBe(0);
    });
    it('projects the native system-selection note before explicitly committing that selection', async () => {
        const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
        const selection = { status: 'system_selection', operationRef: 7, mode: 'recording' };
        let announceReady: () => void = () => {};
        const ready = new Promise<void>(resolve => { announceReady = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args });
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                events.listeners.get('desktopCapture://state')?.({ payload: selection });
                announceReady(); return;
            }
            if (command === 'desktop_capture_commit') {
                const acquiring = { status: 'acquiring', operationRef: 7 };
                events.listeners.get('desktopCapture://state')?.({ payload: acquiring });
                return acquiring;
            }
            if (command === 'desktop_capture_cancel') {
                events.listeners.get('desktopCapture://state')?.({ payload: { status: 'cancelled' } });
                return { status: 'cancelled' };
            }
            throw new Error(`Unexpected source selection effect ${command}`);
        } });
        const hook = await renderHook(useCaptureWindowCapture);
        await act(async () => { await ready; });
        expect(hook.getCurrent()).toMatchObject({ status: 'system_selection', systemSelection: { operationRef: 7, mode: 'recording' } });
        expect(calls.map(call => call.command)).toEqual(['desktop_capture_window_ready', 'desktop_capture_window_ready']);
        await act(async () => { await hook.getCurrent().continueSystemSelection(); });
        expect(calls.at(-1)).toEqual({ command: 'desktop_capture_commit', args: { operationRef: 7, target: null } });
        await act(async () => { events.listeners.get('desktopCapture://state')?.({ payload: selection }); });
        await act(async () => { await hook.getCurrent().cancelSystemSelection(); });
        expect(calls.at(-1)).toEqual({ command: 'desktop_capture_cancel', args: { operationRef: 7 } });
        expect(hook.getCurrent()).toMatchObject({ status: 'empty', systemSelection: null });
        await hook.unmount();
    });
    it('holds a concrete recording failure without work until explicit native-owner recovery', async () => {
        vi.useFakeTimers();
        const counts = createRenderCommitCounter();
        const calls: string[] = [];
        const failed = { status: 'recording', operationRef: 7, recording: { phase: 'failed',
            timing: { durationMs: 0, activeSinceMs: null }, sourceRef: 'partial', result: null, error: 'video_encoder_unavailable' } };
        let announceReady: () => void = () => {};
        const ready = new Promise<void>(resolve => { announceReady = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                events.listeners.get('desktopCapture://state')?.({ payload: failed });
                announceReady(); return;
            }
            if (command === 'desktop_capture_retry') {
                expect(args).toBeUndefined(); // The renderer never reconstructs mode/source/session.
                const snapshot = { ...failed, recording: { ...failed.recording, phase: 'recording', error: null,
                    timing: { durationMs: 0, activeSinceMs: 10_000 } } };
                events.listeners.get('desktopCapture://state')?.({ payload: snapshot });
                return snapshot;
            }
            throw new Error(`Unexpected recovery effect ${command}`);
        } });
        const hook = await renderHook(() => { useRenderCommitCounter(counts); return useCaptureWindowCapture(); });
        try {
            await act(async () => { await ready; });
            expect(hook.getCurrent()).toMatchObject({ status: 'failed', errorCode: 'video_encoder_unavailable' });
            counts.reset();
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            expect(calls).toEqual(['desktop_capture_window_ready', 'desktop_capture_window_ready']);
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { await hook.getCurrent().retry(); });
            expect(hook.getCurrent()).toMatchObject({ status: 'recording', errorCode: null });
            expect(calls).toEqual(['desktop_capture_window_ready', 'desktop_capture_window_ready', 'desktop_capture_retry']);
        } finally { await hook.unmount(); vi.useRealTimers(); }
    });
    it('projects retained edits and commits operations through bridge admission, retaining native write errors and reopen recovery', async () => {
        const video = { ...capture, captureRef: 'movie', kind: 'video' as const, mimeType: 'video/mp4' };
        const snapshot = { status: 'completed', operationRef: 9, result: video, targetSession };
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 2000, includeWindowText: false });
        let refuseWrite = true;
        let frameAvailable = true;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            screenCaptureAction: createNativeScreenCaptureAction(), mediaAnnotation: executeMediaAnnotationAction,
        }));
        const calls: string[] = [];
        let reportReady: () => void = () => {};
        let ready = new Promise<void>(resolve => { reportReady = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_window_emit_action') {
                await dispatchDesktopCaptureWindowAction(args?.payload as DesktopWindowActionRequest, executor);
                return;
            }
            if (command === 'desktop_window_emit_action_result') {
                events.listeners.get('desktopWindow://action-result')?.({ payload: args?.payload }); return;
            }
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                events.listeners.get('desktopCapture://state')?.({ payload: snapshot });
                reportReady();
                return;
            }
            if (command === 'desktop_recording_document_read') return document;
            if (command === 'desktop_capture_read_result') return frameAvailable ? video : capture;
            if (command === 'desktop_recording_document_write') {
                expect(args?.initializeOnly).toBe(false);
                if (refuseWrite) throw 'capture_in_use';
                expect(args?.expectedDocument).toEqual(document);
                document = args?.document as typeof document;
                events.listeners.get('desktopCapture://state')?.({ payload: snapshot });
                return document;
            }
            throw new Error(`Unexpected recording boundary effect ${command}`);
        } });
        const hook = await renderHook(useCaptureWindowCapture);
        await act(async () => { await ready; });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', source: null, recordingDocument: document });
        document = reduceRecordingDocument(document, { kind: 'note.set', id: 'headless', sourceTimeMs: 500, text: 'Action edit' });
        await act(async () => { events.listeners.get('desktopCapture://state')?.({ payload: snapshot }); });
        expect(hook.getCurrent().recordingDocument).toEqual(document);
        await act(async () => {
            await expect(hook.getCurrent().commitRecordingDocument(
                reduceRecordingDocument(document, { kind: 'pin.add', sourceTimeMs: 800 }), document,
                [{ kind: 'pin.add', sourceTimeMs: 800 }],
            )).rejects.toMatchObject({ code: 'capture_in_use' });
        });
        expect(hook.getCurrent()).toMatchObject({ status: 'failed', errorCode: 'capture_in_use', recordingDocument: document });
        refuseWrite = false;
        await act(async () => { await hook.getCurrent().commitRecordingDocument(
            reduceRecordingDocument(document, { kind: 'pin.add', sourceTimeMs: 800 }), document, [{ kind: 'pin.add', sourceTimeMs: 800 }]); });
        expect(document.pins).toEqual([800]);
        expect(document.notes).toMatchObject([{ id: 'headless' }]);
        expect(hook.getCurrent().recordingDocument).toEqual(document);
        const { storage } = await import('@/sync/domains/state/storage');
        const previousScope = storage.getState().profileScope;
        try {
            storage.setState({ profileScope: targetSession });
            const clean = { v: 1 as const, image: { width: 6, height: 4, scale: 1 }, marks: [] };
            const blurred = { ...clean, marks: [{ kind: 'blur' as const, id: 'private', size: 'm' as const,
                rect: { x: 0, y: 0, width: 2, height: 2 } }] };
            frameAvailable = false;
            const unavailable = { kind: 'frame.document' as const, sourceTimeMs: 500, document: blurred, cause: 'edit' as const };
            await act(async () => { await expect(hook.getCurrent().commitRecordingDocument(
                reduceRecordingDocument(document, unavailable), document, [unavailable])).rejects.toMatchObject({ code: 'operation_unavailable' }); });
            expect(document.frames).toEqual([]);
            frameAvailable = true;
            for (const [frame, cause] of [[blurred, 'edit'], [clean, 'undo'], [blurred, 'redo']] as const) {
                const operation = { kind: 'frame.document' as const, sourceTimeMs: 500, document: frame, cause };
                await act(async () => { await hook.getCurrent().commitRecordingDocument(
                    reduceRecordingDocument(document, operation), document, [operation]); });
                expect(document.videoDisclosure.included).toBe(cause === 'undo');
                expect(hook.getCurrent().recordingDocument).toEqual(document);
            }
        } finally { storage.setState({ profileScope: previousScope }); }
        await hook.unmount();
        ready = new Promise<void>(resolve => { reportReady = resolve; });
        const reopened = await renderHook(useCaptureWindowCapture);
        await act(async () => { await ready; });
        expect(reopened.getCurrent().recordingDocument).toEqual(document);
        expect(calls.filter(command => command === 'desktop_window_emit_action')).toHaveLength(6);
        await reopened.unmount();
    });

    it('keeps loading and errors distinct and ignores retired recording reads and unmounted completion', async () => {
        const counts = createRenderCommitCounter();
        const first = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'first', durationMs: 2000, includeWindowText: false });
        const second = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'second', durationMs: 3000, includeWindowText: false });
        let finishFirst: (document: typeof first) => void = () => {};
        let held = new Promise<typeof first>(resolve => { finishFirst = resolve; });
        let failSecond = false;
        let reportReady: () => void = () => {};
        const ready = new Promise<void>(resolve => { reportReady = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; } reportReady(); return; }
            if (command === 'desktop_recording_document_read') {
                if (args?.captureRef === 'first') return held;
                if (failSecond) throw 'file_io';
                return second;
            }
            throw new Error(`Unexpected recording boundary effect ${command}`);
        } });
        const hook = await renderHook(() => { useRenderCommitCounter(counts); return useCaptureWindowCapture(); });
        await act(async () => { await ready; });
        const publish = (captureRef: string) => act(async () => {
            events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 9,
                result: { ...capture, captureRef, kind: 'video', mimeType: 'video/mp4' }, targetSession } });
        });
        await publish('first');
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', recordingDocument: null, errorCode: null });
        await publish('second');
        expect(hook.getCurrent().recordingDocument).toEqual(second);
        await act(async () => { finishFirst(first); });
        expect(hook.getCurrent().recordingDocument).toEqual(second);
        failSecond = true;
        await publish('second');
        expect(hook.getCurrent()).toMatchObject({ status: 'failed', recordingDocument: second, errorCode: 'file_io' });
        held = new Promise<typeof first>(resolve => { finishFirst = resolve; });
        await publish('first');
        await hook.unmount();
        counts.reset();
        await act(async () => { finishFirst(first); });
        expect(counts.read()).toEqual({ renders: 0, commits: 0 });
    });
    it.each([true, false])('plays once at open start with capture sound enabled=%s, never on mount or replay', async enabled => {
        getPersistenceStorage().set('local-settings', JSON.stringify({ screenCaptureSound: enabled }));
        const played: string[] = [];
        vi.stubGlobal('Audio', class {
            constructor(readonly src: string) {}
            async play() { played.push(this.src); }
        });
        installImageAnnotationCanvasBoundary();
        let reportReady: () => void = () => {};
        const ready = new Promise<void>(resolve => { reportReady = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; } reportReady(); return; }
            if (command === 'desktop_capture_read_source_png') return [137, 80, 78, 71];
            throw new Error(`Unexpected boundary command ${command}`);
        } });
        const hook = await renderHook(useCaptureWindowCapture);
        await act(async () => { await ready; });
        expect(played).toHaveLength(0);
        const publish = async (captureRef: string) => act(async () => {
            events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 1,
                result: { ...capture, captureRef }, targetSession } });
        });
        await publish('first');
        expect(played).toHaveLength(0);
        expect(hook.getCurrent().capture?.captureRef).toBe('first');
        expect(loadLocalSettings().screenCaptureSound).toBe(enabled);
        await act(async () => { hook.getCurrent().onOpenStart(); });
        await publish('first');
        await act(async () => { hook.getCurrent().onOpenStart(); });
        await hook.rerender();
        expect(played).toHaveLength(enabled ? 1 : 0);
        await publish('second');
        await act(async () => { hook.getCurrent().onOpenStart(); });
        expect(played).toHaveLength(enabled ? 2 : 0);
        if (enabled) expect(played[0]).toContain('happier_soft.wav');
        await hook.unmount();
    });
    it('projects pushed recording timing without an elapsed clock, source reads or status polling', async () => {
        vi.useFakeTimers();
        const counts = createRenderCommitCounter();
        const calls: string[] = [];
        const recording = { phase: 'recording' as const,
            timing: { durationMs: 2_500, activeSinceMs: 10_000 }, sourceRef: 'partial', result: null, error: null };
        let reportReady: () => void = () => {};
        const ready = new Promise<void>(resolve => { reportReady = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                events.listeners.get('desktopCapture://state')?.({ payload: { status: 'recording', operationRef: 7, recording } });
                reportReady();
                return;
            }
            throw new Error('Unexpected recording boundary read');
        } });
        const hook = await renderHook(() => { useRenderCommitCounter(counts); return useCaptureWindowCapture(); });
        try {
            await act(async () => { await ready; });
            expect(hook.getCurrent()).toMatchObject({ status: 'recording', recording: { operationRef: 7, snapshot: recording } });
            counts.reset();
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            expect(calls).toEqual(['desktop_capture_window_ready', 'desktop_capture_window_ready']);
            await act(async () => { events.listeners.get('desktopCapture://state')?.({ payload: {
                status: 'recording', operationRef: 7, recording: { ...recording, phase: 'paused',
                    timing: { durationMs: 4_500, activeSinceMs: null } },
            } }); });
            expect(hook.getCurrent()).toMatchObject({ recording: { snapshot: { phase: 'paused',
                timing: { durationMs: 4_500, activeSinceMs: null } } } });
            expect(counts.read()).toEqual({ renders: 1, commits: 1 });
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { events.listeners.get('desktopCapture://state')?.({ payload: {
                status: 'recording', operationRef: 7, recording: { ...recording, phase: 'failed', error: 'native_failure',
                    timing: { durationMs: 4_500, activeSinceMs: null } },
            } }); });
            expect(hook.getCurrent()).toMatchObject({ status: 'failed', capture: null, errorCode: 'native_failure',
                recording: { snapshot: { sourceRef: 'partial', result: null } } });
        } finally { await hook.unmount(); vi.useRealTimers(); }
    });
    it('reads one source per capture, uses contract-7 blur flatten, and writes one prepared PNG per press', async () => {
        const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
        let rendererReady: () => void = () => {};
        const ready = new Promise<void>(resolve => { rendererReady = resolve; });
        const sourcePixels = new Uint8ClampedArray(Array.from({ length: 24 }, (_, i) => [i * 7, i * 3, i * 5, 255]).flat());
        const raster = installImageAnnotationCanvasBoundary({ width: 6, height: 4, pixels: sourcePixels });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args });
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                rendererReady();
                return;
            }
            if (command === 'desktop_capture_read_source_png') return [137, 80, 78, 71];
            if (command === 'desktop_capture_write_prepared_png') return { captureRef: capture.captureRef,
                path: '/library/Prepared.png', mimeType: 'image/png', byteSize: 3, pixelSize: capture.pixelSize };
            throw new Error(`Unexpected boundary command ${command}`);
        } });
        const hook = await renderHook(useCaptureWindowCapture);
        await ready;
        await act(async () => {
            events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 1, result: capture, targetSession } });
        });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', capture, targetSession, source: { width: 6, height: 4, scale: 1 } });
        expect(hook.getCurrent().source?.uri).toMatch(/^blob:/);
        expect(calls.map(call => call.command)).toEqual(['desktop_capture_window_ready', 'desktop_capture_window_ready', 'desktop_capture_read_source_png']);
        await hook.rerender();
        expect(calls).toHaveLength(3);
        await act(async () => {
            expect(await hook.getCurrent().prepare({ v: 1, image: { width: 6, height: 4, scale: 1 },
                marks: [{ id: 'private', kind: 'blur', rect: { x: 1, y: 1, width: 4, height: 2 }, size: 's' }] }, { includeWindowText: false }))
                .toMatchObject({ ok: true, prepared: { captureRef: 'capture' }, png: new Uint8Array([9, 8, 7]) });
        });
        expect(raster.events).toContain('burnBlur');
        expect(raster.outputs[0]).not.toEqual(sourcePixels);
        expect(raster.encodeCount()).toBe(1);
        expect(calls.at(-1)).toEqual({ command: 'desktop_capture_write_prepared_png', args: { captureRef: 'capture', bytes: [9, 8, 7],
            disclosure: { hasMarks: true, includeWindowText: false } } });
        await hook.unmount();
        expect(events.listeners.size).toBe(0);
    });

    it('asks main once to pin an unpinned capture and consumes the native replay without a request loop', async () => {
        const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
        let rendererReady: () => void = () => {};
        const ready = new Promise<void>(resolve => { rendererReady = resolve; });
        let pinned: (() => void) | undefined;
        const pinSettled = new Promise<void>(resolve => { pinned = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args });
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                rendererReady();
                return;
            }
            if (command === 'desktop_capture_read_source_png') return [137, 80, 78, 71];
            if (command === 'desktop_window_emit_action') {
                const request = args?.payload;
                if (!request || typeof request !== 'object' || !('requestId' in request)) throw new Error('Missing request');
                events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 1, result: capture, targetSession } });
                events.listeners.get('desktopWindow://action-result')?.({ payload: { windowLabel: 'capture',
                    requestId: request.requestId, phase: 'settled', ok: true, result: { captureRef: capture.captureRef, status: 'opened' } } });
                pinned?.();
                return;
            }
            throw new Error(`Unexpected boundary command ${command}`);
        } });
        const hook = await renderHook(useCaptureWindowCapture);
        await ready;
        await act(async () => {
            events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 1, result: capture } });
        });
        await act(async () => { await pinSettled; });
        expect(hook.getCurrent().capture).toEqual(capture);
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', targetSession });
        await hook.rerender();
        const requests = calls.filter(call => call.command === 'desktop_window_emit_action');
        expect(requests).toHaveLength(1);
        expect(requests[0]?.args?.payload).toMatchObject({ windowLabel: 'capture',
            actionIdentifier: 'screenCapture.open', data: { captureRef: capture.captureRef } });
        expect(calls.filter(call => call.command === 'desktop_capture_read_source_png')).toHaveLength(1);
        expect(events.listeners.has('desktopWindow://action-result')).toBe(false);
        await hook.unmount();
        expect(events.listeners.size).toBe(0);
    });
});

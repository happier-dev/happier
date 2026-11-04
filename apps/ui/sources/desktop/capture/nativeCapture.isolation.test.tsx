import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emit, emitTo, type EventTarget } from '@tauri-apps/api/event';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { useCaptureWindowCapture } from '@/components/screenCapture/window/useCaptureWindowCapture';
import { useCaptureWindowActions } from '@/components/screenCapture/window/useCaptureWindowActions';
import { createRecordingDocument } from '@/components/screenCapture/recording/recordingDocument';
import { createImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createNativeScreenCaptureAction } from '@/sync/ops/actions/screenCaptureActions';
import { dispatchDesktopCaptureWindowAction } from '@/utils/platform/desktopWindowActionDispatch';
import type { DesktopWindowActionRequest, DesktopWindowActionResult } from '@/utils/platform/desktopWindowActionBridge';
import { registerCaptureAnnotationTarget, requestCaptureAnnotationAction } from './captureAnnotationActions';
import type { NativeCaptureResult, NativeCaptureSnapshot } from './nativeCapture';

// Only native IPC is replaced: the installed Tauri event SDK, host bridge,
// capture hooks, annotation store and Action dispatcher/executor all stay real.
vi.mock('expo-asset', () => ({ Asset: { fromModule: (uri: string) => ({ uri }) } }));

type Listener = { event: string; target: EventTarget; handler: number };
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, Listener>();
const snapshots = new Map<string, NativeCaptureSnapshot>();
const annotationReady = new Set<string>();
const annotationReplies = new Map<number, (result: unknown) => void>();
const annotationBound = new Map<string, () => void>();
const windowReady = new Map<string, () => void>();
const discarded: string[] = [];
let label = 'capture';
let sequence = 0;
let metadata = { currentWindow: { label }, currentWebview: { label } };

const first: NativeCaptureResult = { captureRef: 'still-A', kind: 'still', path: '/library/A.png',
    mimeType: 'image/png', byteSize: 4, pixelSize: { width: 6, height: 4 }, scale: 1,
    origin: null, source: { appName: 'App A', windowTitle: 'Window A', windowId: 1 }, windowTextRef: null };
const second: NativeCaptureResult = { ...first, captureRef: 'still-B', path: '/library/B.png',
    source: { appName: 'App B', windowTitle: 'Window B', windowId: 2 } };
const movie: NativeCaptureResult = { ...first, captureRef: 'movie', kind: 'video', path: '/library/movie.mp4', mimeType: 'video/mp4' };
const session = { serverId: 'home', accountId: 'account', sessionId: 'session' };
const completed = (result: NativeCaptureResult): NativeCaptureSnapshot => ({ status: 'completed', operationRef: 1, result, targetSession: session });

// Tauri's native event filter: broadcasts reach every subscription; a label
// emission reaches Any listeners or subscriptions for that label. The SDK
// produces these targets itself, rather than a mocked listen implementation.
function deliver(event: string, payload: unknown, target: EventTarget = { kind: 'Any' }) {
    for (const [id, listener] of [...listeners]) {
        if (listener.event !== event) continue;
        if (target.kind !== 'Any' && listener.target.kind !== 'Any'
            && (!('label' in target) || !('label' in listener.target) || target.label !== listener.target.label)) continue;
        callbacks.get(listener.handler)?.({ event, id, payload });
    }
}

function selectWindow(next: string) {
    label = next;
    metadata.currentWindow.label = next;
}

beforeEach(() => {
    sequence = 0;
    label = 'capture';
    metadata = { currentWindow: { label }, currentWebview: { label } };
    snapshots.set('capture', completed(first));
    snapshots.set('capture_2', completed(second));
    snapshots.set('capture_3', { status: 'recording', operationRef: 3, recording: {
        phase: 'recording', timing: { durationMs: 0, activeSinceMs: null }, sourceRef: 'movie', result: null, error: null }, origin: null });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
        screenCaptureAction: createNativeScreenCaptureAction(),
    }));
    const internals = {
        metadata,
        transformCallback(callback: (event: unknown) => void) {
            const id = ++sequence;
            callbacks.set(id, callback);
            return id;
        },
        async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
            if (command === 'plugin:event|listen') {
                const id = ++sequence;
                listeners.set(id, args as Listener);
                return id;
            }
            if (command === 'plugin:event|unlisten') { listeners.delete(Number(args.eventId)); return; }
            if (command === 'plugin:event|emit' || command === 'plugin:event|emit_to') {
                deliver(String(args.event), args.payload, args.target as EventTarget | undefined);
                return;
            }
            if (command === 'desktop_capture_window_ready') {
                if (args.phase === 'wake') deliver('desktopCapture://window', 'start', { kind: 'AnyLabel', label });
                if (args.phase === 'state') {
                    deliver('desktopCapture://state', snapshots.get(label), { kind: 'AnyLabel', label });
                    windowReady.get(label)?.();
                }
                return true;
            }
            if (command === 'desktop_capture_read_source_png') return [137, 80, 78, 71];
            if (command === 'desktop_recording_document_read') return createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 1000, includeWindowText: false });
            if (command === 'desktop_capture_discard') { discarded.push(String(args.captureRef)); return; }
            if (command === 'desktop_window_emit_action') {
                await dispatchDesktopCaptureWindowAction(args.payload as DesktopWindowActionRequest, executor);
                return;
            }
            if (command === 'desktop_window_emit_action_result') {
                const result = args.payload as DesktopWindowActionResult;
                deliver('desktopWindow://action-result', result, { kind: 'AnyLabel', label: result.windowLabel });
                return;
            }
            if (command === 'desktop_capture_annotation_ready') {
                if (args.ready) {
                    annotationReady.add(String(args.captureRef));
                    annotationBound.get(String(args.captureRef))?.();
                }
                else annotationReady.delete(String(args.captureRef));
                return;
            }
            if (command === 'desktop_capture_annotation_request') {
                const captureRef = String(args.captureRef);
                if (!annotationReady.has(captureRef)) return { status: 'unavailable', reason: 'annotation.targetUnavailable' };
                const owner = [...snapshots].find(([, state]) => state.status === 'completed' && state.result.captureRef === captureRef)?.[0];
                const requestId = ++sequence;
                return new Promise(resolve => {
                    annotationReplies.set(requestId, resolve);
                    deliver('desktopCapture://annotation-request', { captureRef, requestId, request: args.request }, { kind: 'AnyLabel', label: owner! });
                });
            }
            if (command === 'desktop_capture_annotation_result') {
                annotationReplies.get(Number(args.requestId))?.(args.result);
                annotationReplies.delete(Number(args.requestId));
                return;
            }
            throw new Error(`Unexpected native IPC: ${command}`);
        },
    };
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: (_event: string, id: number) => {
        const listener = listeners.get(id);
        if (listener) callbacks.delete(listener.handler);
    } });
});

afterEach(async () => {
    await standardCleanup();
    callbacks.clear(); listeners.clear(); snapshots.clear(); annotationReady.clear(); annotationReplies.clear(); annotationBound.clear(); windowReady.clear(); discarded.length = 0;
    vi.unstubAllGlobals();
});

function useEditor() {
    const capture = useCaptureWindowCapture();
    const actions = useCaptureWindowActions(capture.signal ?? undefined);
    const ref = capture.capture?.kind === 'still' ? capture.capture.captureRef : null;
    const annotator = React.useMemo(() => createImageAnnotator({ source: { uri: 'data:image/png;base64,AQID', width: 6, height: 4, scale: 1 } }), [ref]);
    React.useEffect(() => {
        if (!ref) return;
        const lifetime = new AbortController();
        void registerCaptureAnnotationTarget({ captureRef: ref, annotator, signal: lifetime.signal });
        return () => lifetime.abort();
    }, [ref, annotator]);
    return { capture, actions, annotator };
}

async function openEditor(windowLabel: string, expectedStatus: 'ready' | 'recording' = 'ready') {
    selectWindow(windowLabel);
    const ready = new Promise<void>(resolve => { windowReady.set(windowLabel, resolve); });
    const snapshot = snapshots.get(windowLabel);
    const ref = snapshot?.status === 'completed' && snapshot.result.kind === 'still' ? snapshot.result.captureRef : null;
    const bound = ref ? new Promise<void>(resolve => { annotationBound.set(ref, resolve); }) : Promise.resolve();
    const hook = await renderHook(useEditor);
    await act(async () => { await ready; });
    await act(async () => { await bound; });
    expect(hook.getCurrent().capture.status).toBe(expectedStatus);
    return hook;
}

describe('native capture renderer isolation through the installed Tauri event bridge', () => {
    it('delivers a label event only to its window, retains broadcasts and releases listeners', async () => {
        const a = vi.fn();
        const b = vi.fn();
        selectWindow('capture');
        const firstStop = listenDesktopHostEvent('desktopCapture://state', a);
        selectWindow('capture_2');
        const secondStop = listenDesktopHostEvent('desktopCapture://state', b);
        const stops = await Promise.all([firstStop, secondStop]);
        await emitTo('capture', 'desktopCapture://state', completed(first));
        expect(a).toHaveBeenCalledWith(completed(first));
        expect(b).not.toHaveBeenCalled();
        await emit('desktopCapture://permissions', { screen: 'granted' });
        await emit('desktopCapture://state', { status: 'idle' });
        expect(a).toHaveBeenCalledTimes(2);
        expect(b).toHaveBeenCalledExactlyOnceWith({ status: 'idle' });
        for (const stop of stops) await stop();
        expect(listeners.size).toBe(0);
        expect(callbacks.size).toBe(0);
    });

    it('keeps still refs and captions when a third window starts and completes a recording', async () => {
        const a = await openEditor('capture');
        const b = await openEditor('capture_2');
        const beforeA = a.getCurrent().capture;
        const beforeB = b.getCurrent().capture;
        const video = await openEditor('capture_3', 'recording');
        expect(video.getCurrent().capture.recording?.operationRef).toBe(3);
        expect(a.getCurrent().capture).toBe(beforeA);
        expect(b.getCurrent().capture).toBe(beforeB);
        await act(async () => { snapshots.set('capture_3', completed(movie)); await emitTo('capture_3', 'desktopCapture://state', completed(movie)); });
        expect(a.getCurrent().capture.capture).toEqual(first);
        expect(b.getCurrent().capture.capture).toEqual(second);
        expect(video.getCurrent().capture.capture).toEqual(movie);
    });

    it('discards the still addressed by the old window after a movie completes', async () => {
        const a = await openEditor('capture');
        await openEditor('capture_2');
        snapshots.set('capture_3', completed(movie));
        await act(async () => { await emitTo('capture_3', 'desktopCapture://state', completed(movie)); });
        selectWindow('capture');
        await act(async () => {
            expect(await a.getCurrent().actions.discard(a.getCurrent().capture.capture!.captureRef)).toMatchObject({ ok: true });
        });
        expect(discarded).toEqual([first.captureRef]);
    });

    it('resolves annotation Actions by each original captureRef after sibling state events', async () => {
        const a = await openEditor('capture');
        const b = await openEditor('capture_2');
        await act(async () => { await emitTo('capture_3', 'desktopCapture://state', completed(movie)); });
        const mark = { id: 'only-A', kind: 'blur', size: 'm', rect: { x: 1, y: 1, width: 2, height: 2 } } as const;
        expect(await requestCaptureAnnotationAction(first.captureRef, { actionId: 'media.annotation.apply', input: {
            scope: { serverId: 'home', accountId: 'account' }, target: { kind: 'capture', captureRef: first.captureRef },
            operations: [{ kind: 'mark.add', mark }],
        } })).toEqual({ status: 'replaced' });
        expect(a.getCurrent().annotator.store.getState().document.marks).toEqual([mark]);
        expect(b.getCurrent().annotator.store.getState().document.marks).toEqual([]);
        for (const [result, hook] of [[first, a], [second, b]] as const) {
            expect(await requestCaptureAnnotationAction(result.captureRef, { actionId: 'media.annotation.read', input: {
                scope: { serverId: 'home', accountId: 'account' }, target: { kind: 'capture', captureRef: result.captureRef },
            } })).toEqual({ document: hook.getCurrent().annotator.store.getState().document,
                image: { width: 6, height: 4, scale: 1 }, hasBlur: result === first });
        }
    });
});

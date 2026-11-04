import * as React from 'react';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, createDeferred, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { CaptureWindowRoute } from './CaptureWindowRoute';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ModalProvider } from '@/modal';
import { RecentCaptureGrid } from '../recent/RecentCaptureGrid';
import { CaptureWindowNote } from './CaptureWindowNote';
import { SessionChooser } from '@/components/sessions/selection/SessionChooser';
import { MultiTextInput } from '@/components/ui/forms/MultiTextInput';
import { CaptureWindowScreen, type CaptureDeliveryOutcome } from './CaptureWindowScreen';
import { installImageAnnotationCanvasBoundary } from '@/dev/testkit/mocks/imageAnnotationCanvas';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import type { NativeCaptureDisclosure, NativeCaptureResult, NativeCaptureSnapshot } from '@/desktop/capture/nativeCapture';
import { readPreparedCaptureDelivery, resolveCaptureDelivery } from '@/sync/ops/actions/screenCaptureDelivery';
import { CaptureDeliveryPill } from './CaptureDeliveryPill';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RecordingControlWindow } from '../recording/RecordingControlWindow';
import { CaptureWindowStates } from './CaptureWindowStates';
import type { DesktopWindowActionRequest } from '@/utils/platform/desktopWindowActionBridge';
import { createImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-asset', () => ({ Asset: { fromModule: (asset: string) => ({ uri: asset, localUri: asset, downloadAsync: async () => undefined }) } }));
vi.mock('@shopify/react-native-skia', async () => {
    const { createSkiaModuleMock } = await import('@/dev/testkit/mocks/skia');
    return createSkiaModuleMock().module;
});
// Radix's browser host is the external boundary; picker and modal ownership stay real.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});
const events = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: unknown }) => void>(), callbacks: 0, subscriptions: 0 }));
// Tauri event delivery is the native boundary; the capture hook, adapter and states stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    events.listeners.set(event, payload => { events.callbacks++; handler(payload); });
    events.subscriptions++;
    let attached = true;
    return () => { if (attached) { attached = false; events.subscriptions--; events.listeners.delete(event); } };
} }));

describe('Capture permission route', () => {
    let browser: { window: Window & typeof globalThis } | null = null;
    let portal: ReturnType<typeof installReactDomPortalBoundaryForTests>;
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        portal = installReactDomPortalBoundaryForTests();
        // This renderer has no compositor. First-frame ordering is exercised separately at the
        // real WebKit boundary and with controlled frames in captureWindowHost.test.ts.
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            queueMicrotask(() => callback(performance.now()));
            return 0;
        });
    });
    afterEach(async () => { await standardCleanup(); portal.restore(); vi.useRealTimers(); setReducedMotionPreferenceOverride(null); browser?.window.close(); browser = null; vi.unstubAllGlobals(); events.listeners.clear(); events.callbacks = 0; events.subscriptions = 0; });

    // Void UI handlers do not await native IPC or its lazy event-module import.
    // Poll committed output, flushing React without advancing the product clock.
    const settled = <T,>(read: () => T) => expect.poll(async () => {
        await act(async () => {});
        return read();
    });

    it.each(['send', 'discard'] as const)('keeps %s and Undo local to each editor instance', async operation => {
        browser = new JSDOM('<!doctype html><body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        setReducedMotionPreferenceOverride(true);
        Object.defineProperty(browser.window.HTMLElement.prototype, 'animate', { value: () => ({ finished: Promise.resolve(), cancel() {}, id: '' }) });
        Object.defineProperty(browser.window.HTMLElement.prototype, 'getAnimations', { value: () => [] });
        installImageAnnotationCanvasBoundary();
        const discarded = new Set<string>();
        const committed: string[] = [];
        const closed: string[] = [];
        const frame = { window: { x: 0, y: 0, width: 740, height: 500 },
            picture: { x: 24, y: 68, width: 400, height: 300 }, scale: 1,
            union: { x: 0, y: 0, width: 740, height: 500 } };
        const editor = (id: string) => <CaptureWindowScreen key={id} frame={frame} area={null}
            workArea={{ x: 0, y: 0, width: 1440, height: 900 }} screenInset={24} onMeasure={() => {}}
            annotator={createImageAnnotator({ source: { uri: 'data:image/png;base64,iVBORw==', width: 400, height: 300, scale: 1 } })}
            renderPicture={() => null} caption={{ icon: 'image', lead: null, facts: [] }}
            target={{ title: id, mark: null, machineName: 'Machine' }} unreachable={null}
            note={`${id} note`} onNoteChange={() => {}} thumbnailUri={null} hasWork more={{}}
            onDeliver={async () => ({ ok: true, pill: { kind: 'sent', session: id, detail: '' } })}
            onRetry={async () => ({ ok: false, cause: 'unused' })}
            onDiscard={() => { discarded.add(id); }} onUndoDiscard={() => { discarded.delete(id); }}
            onBeforeClose={async () => { if (discarded.has(id)) committed.push(id); }}
            onClosed={() => { closed.push(id); }} />;
        const screen = await renderScreen(<>{editor('first')}{editor('second')}</>, { createNodeMock: () => {
            const parent = browser!.window.document.createElement('div');
            const node = browser!.window.document.createElement('div'); parent.append(node);
            browser!.window.document.body.append(parent); return node;
        } });
        if (operation === 'send') {
            await act(async () => { screen.findAllByType(CaptureWindowNote)[0]!.props.onSend(); });
            await settled(() => screen.findAllByType(CaptureDeliveryPill).map(pill => pill.props.state.kind)).toEqual(['sent']);
            expect(screen.findAllByType(CaptureWindowNote)[1]!.props.note).toBe('second note');
            expect(closed).toEqual([]);
            await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.undoHoldMs); });
            await settled(() => closed).toEqual(['first']);
            expect(committed).toEqual([]);
        } else {
            for (const button of screen.findAllByType(IconButton).filter(button => button.props.testID === 'capture-window-discard')) {
                await pressTestInstanceAsync(button);
            }
            await settled(() => screen.findAllByType(CaptureDeliveryPill)).toHaveLength(2);
            await act(async () => { screen.findAllByType(CaptureDeliveryPill)[0]!.props.onUndo(); });
            expect(discarded).toEqual(new Set(['second']));
            await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.undoHoldMs); });
            await settled(() => committed).toEqual(['second']);
            expect(closed).toEqual(['second']);
            expect(screen.findAllByType(CaptureWindowNote)[0]!.props.note).toBe('first note');
        }
    });

    it.each([
        ['permission', { status: 'unavailable', reason: 'screen_permission_required' }],
        ['failed', { status: 'failed', reason: 'native_failure' }],
        ['systemSelection', { status: 'system_selection', operationRef: 1, mode: 'recording' }],
        ['recording', { status: 'recording', operationRef: 1, origin: null, recording: { phase: 'recording',
            timing: { durationMs: 1000, activeSinceMs: Date.now() }, sourceRef: 'recording', result: null, error: null } }],
    ] satisfies Array<[string, NativeCaptureSnapshot]>)('wires %s chrome and close/escape controls, retaining only its idle wake listener', async (kind, snapshot) => {
        browser = new JSDOM('<!doctype html><body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        const calls: string[] = [];
        let nativeVisible = false;
        let renders = 0;
        let ready: () => void = () => {};
        let replayed = new Promise<void>(resolve => { ready = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'paint') return true;
                if (args?.phase === 'wake') events.listeners.get('desktopCapture://window')?.({ payload: 'start' });
                else { events.listeners.get('desktopCapture://state')?.({ payload: snapshot }); ready(); }
                return true;
            }
            if (command === 'desktop_capture_display_facts') return [{ displayId: 1,
                frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1, desktopScale: 1,
                storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null }];
            if (command === 'desktop_capture_shortcuts') return { backend: 'native', availability: 'ready', bindings: [] };
            if (command === 'desktop_get_window_chrome_policy') return { strategy: 'custom-controls' };
            if (command === 'desktop_capture_permissions_watch') return args?.consumed ? {
                screen: 'denied', windowText: 'request_required', recoveryActions: { screen: [], windowText: [] },
            } : null;
            if (command === 'desktop_start_window_dragging' || command === 'desktop_capture_cancel') return;
            if (command === 'desktop_capture_window_present') { nativeVisible = true; return null; }
            if (command === 'desktop_capture_window_hide') {
                nativeVisible = false;
                // Native lifecycle delivery crosses IPC after the close handler has rendered.
                if (kind !== 'recording') events.listeners.get('desktopCapture://window')?.({ payload: 'hidden' });
            }
            else throw new Error(`Unexpected blocked-window boundary: ${command}`);
            return null;
        } });
        const screen = await renderScreen(<React.Profiler id="capture" onRender={() => { renders++; }}><CaptureWindowRoute /></React.Profiler>);
        await act(async () => { await replayed; });
        const chrome = screen.findAll(node => node.props.testID === (kind === 'recording' ? 'capture-recording-chrome' : 'capture-window-blocked-chrome') && typeof node.type === 'string')[0];
        expect(chrome).toBeDefined();
        await act(async () => { chrome!.props.onMouseDown({ buttons: 1, detail: 1, target: document.createElement('div'), preventDefault() {} }); });
        expect(calls.filter(command => command === 'desktop_start_window_dragging')).toHaveLength(1);
        if (kind === 'recording') {
            await act(async () => { chrome!.props.onLayout({ nativeEvent: { layout: { width: 253, height: 44 } } }); });
            expect(nativeVisible).toBe(true);
            expect(vi.getTimerCount()).toBeGreaterThan(0);
            const close = screen.findAllByType(IconButton).find(node => node.props.testID === 'recording-control-hide')!;
            const host = close.findAll(node => typeof node.type === 'string'
                && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function')).at(-1);
            await pressTestInstanceAsync(host, 'Hide, keep recording');
            expect(nativeVisible, 'closing must not present the measured recording control again').toBe(false);
            await act(async () => { events.listeners.get('desktopCapture://window')?.({ payload: 'hidden' }); });
            expect(calls).not.toContain('desktop_recording_stop');
            expect(calls).not.toContain('desktop_capture_cancel');
        } else {
            const close = screen.findAllByType(IconButton).find(node => node.props.testID === 'capture-window-close')!;
            const host = close.findAll(node => typeof node.type === 'string'
                && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function')).at(-1);
            await pressTestInstanceAsync(host, 'Close capture');
        }
        expect(calls.filter(command => command === 'desktop_capture_window_hide')).toHaveLength(1);
        expect([...events.listeners.keys()]).toEqual(['desktopCapture://window']);
        expect(events.subscriptions).toBe(1);
        const hiddenCalls = calls.length;
        const hiddenRenders = renders;
        const hiddenCallbacks = events.callbacks;
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => {
            for (const event of ['desktopCapture://state', 'desktopCapture://permissions', 'desktopWindow://action-result']) {
                events.listeners.get(event)?.({ payload: { status: 'idle' } });
            }
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect({ calls: calls.length - hiddenCalls, renders: renders - hiddenRenders,
            callbacks: events.callbacks - hiddenCallbacks, timers: vi.getTimerCount() })
            .toEqual({ calls: 0, renders: 0, callbacks: 0, timers: 0 });
        replayed = new Promise<void>(resolve => { ready = resolve; });
        await act(async () => { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); await replayed; });
        if (kind === 'recording') {
            const restored = screen.findAll(node => node.props.testID === 'capture-recording-chrome' && typeof node.type === 'string')[0]!;
            await act(async () => { restored.props.onLayout({ nativeEvent: { layout: { width: 253, height: 44 } } }); });
            expect(nativeVisible).toBe(true);
        }
        await act(async () => { document.dispatchEvent(new browser!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        if (kind === 'recording') {
            expect(nativeVisible, 'Escape must not present the measured recording control again').toBe(false);
            await act(async () => { events.listeners.get('desktopCapture://window')?.({ payload: 'hidden' }); });
        }
        expect(calls.filter(command => command === 'desktop_capture_window_hide')).toHaveLength(2);
        expect([...events.listeners.keys()]).toEqual(['desktopCapture://window']);
        expect(events.subscriptions).toBe(1);
    });

    it('shows a saved recording opening, its read failure with Retry, and closes from the failed window', async () => {
        browser = new JSDOM('<!doctype html><body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        const { createRecordingDocument } = await import('../recording/recordingDocument');
        const video: NativeCaptureResult = { captureRef: 'movie', kind: 'video', path: '/captures/movie.webm', mimeType: 'video/webm',
            byteSize: 3, pixelSize: { width: 40, height: 30 }, scale: 1, origin: null, source: null, windowTextRef: null };
        const recordingDocument = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 2000, includeWindowText: false });
        const snapshot: NativeCaptureSnapshot = { status: 'completed', operationRef: 1, result: video,
            targetSession: { serverId: 'home', accountId: 'account', sessionId: 'session' } };
        let reads = 0;
        let hides = 0;
        let failRead: (error: unknown) => void = () => {};
        let ready: () => void = () => {};
        const announced = new Promise<void>(resolve => { ready = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'paint') return true;
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                events.listeners.get('desktopCapture://state')?.({ payload: snapshot }); ready(); return;
            }
            if (command === 'desktop_capture_display_facts') return [{ displayId: 1,
                frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1, desktopScale: 1,
                storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null }];
            if (command === 'desktop_recording_document_read') return recordingDocument;
            if (command === 'desktop_capture_read_result') return video;
            if (command === 'desktop_capture_read_source_png') { reads++; return new Promise((_, reject) => { failRead = reject; }); }
            if (command === 'desktop_capture_window_present') return null;
            if (command === 'desktop_capture_window_hide') { hides++; events.listeners.get('desktopCapture://window')?.({ payload: 'hidden' }); return null; }
            throw new Error(`Unexpected recording-open boundary: ${command}`);
        } });
        const screen = await renderScreen(<CaptureWindowRoute />);
        await act(async () => { await announced; });
        const state = () => screen.findByType(CaptureWindowStates).props.state;
        expect(state()).toMatchObject({ kind: 'loading', title: t('screenCapture.recording.openingTitle') });
        await act(async () => { failRead('file_io'); });
        expect(state()).toMatchObject({ kind: 'failed', title: t('screenCapture.recording.openFailedTitle'),
            reason: t('screenCapture.recording.openFailedReason') });
        await act(async () => { state().onTryAgain(); });
        expect(reads).toBe(2);
        expect(state()).toMatchObject({ kind: 'loading' });
        await act(async () => { failRead('file_io'); });
        await act(async () => { screen.findByType(CaptureWindowStates).props.onClose(); });
        expect(hides).toBe(1);
    });

    it.each(['recording', 'failed'] as const)('keeps a %s discard failure presented and retries its partial source', async phase => {
        browser = new JSDOM('<!doctype html><body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        const discarded: string[] = [];
        const actions: string[] = [];
        const stopped = createDeferred<void>();
        let hides = 0;
        let ready: () => void = () => {};
        let announced = new Promise<void>(resolve => { ready = resolve; });
        const recording = { phase, timing: { durationMs: 1000, activeSinceMs: null }, sourceRef: 'partial', result: null,
            error: phase === 'failed' ? 'native_failure' as const : null };
        let snapshot: NativeCaptureSnapshot = { status: 'recording', operationRef: 1, origin: null, recording };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'paint') return true;
                if (args?.phase === 'wake') events.listeners.get('desktopCapture://window')?.({ payload: 'start' });
                else { events.listeners.get('desktopCapture://state')?.({ payload: snapshot }); ready(); }
                return true;
            }
            if (command === 'desktop_capture_display_facts') return [{ displayId: 1,
                frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1, desktopScale: 1,
                storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null }];
            if (command === 'desktop_capture_window_present') return null;
            if (command === 'desktop_capture_window_hide') { hides++; events.listeners.get('desktopCapture://window')?.({ payload: 'hidden' }); return; }
            if (command === 'desktop_window_emit_action') {
                const request = args?.payload as DesktopWindowActionRequest;
                actions.push(request.actionIdentifier);
                // Stop retains the movie during Undo; only discard can fail its file removal.
                if (request.actionIdentifier === 'screenCapture.recording.stop') {
                    events.listeners.get('desktopWindow://action-result')?.({ payload: { ...request, phase: 'settled',
                        ok: true, result: { ...recording, phase: 'ready' } } });
                    stopped.resolve();
                    return;
                }
                if (request.actionIdentifier !== 'screenCapture.discard') throw new Error(`Unexpected recording Action: ${request.actionIdentifier}`);
                discarded.push((request.data as { captureRef: string }).captureRef);
                if (discarded.length > 1) snapshot = { status: 'idle' };
                events.listeners.get('desktopWindow://action-result')?.({ payload: { ...request, phase: 'settled',
                    ...(discarded.length === 1 ? { ok: false, errorCode: 'file_io' } : { ok: true, result: { status: 'discarded' } }) } });
                return;
            }
            throw new Error(`Unexpected discard boundary: ${command}`);
        } });
        const screen = await renderScreen(<CaptureWindowRoute />);
        await act(async () => { await announced; });
        if (phase === 'recording') {
            await act(async () => {
                screen.findByType(RecordingControlWindow).props.onDiscard();
                await stopped.promise;
            });
            expect(screen.findByType(RecordingControlWindow).props.discarded).toBe(true);
            expect(discarded).toEqual([]);
            await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.undoHoldMs); });
        } else {
            await act(async () => { await screen.findByType(CaptureWindowStates).props.state.onDiscard(); });
        }
        await settled(() => screen.findByType(CaptureWindowStates).props.state).toMatchObject({ kind: 'failed', diagnostic: 'file_io' });
        expect(hides).toBe(0);
        await act(async () => { await screen.findByType(CaptureWindowStates).props.state.onTryAgain(); });
        await settled(() => hides).toBe(1);
        expect(discarded).toEqual(['partial', 'partial']);
        expect(hides).toBe(1);
        expect(actions).toEqual([...(phase === 'recording' ? ['screenCapture.recording.stop'] : []),
            'screenCapture.discard', 'screenCapture.discard']);
        announced = new Promise<void>(resolve => { ready = resolve; });
        snapshot = { status: 'recording', operationRef: 2, origin: null,
            recording: { ...recording, phase: 'recording', sourceRef: 'next-recording', error: null } };
        await act(async () => {
            events.listeners.get('desktopCapture://window')?.({ payload: 'start' });
            await announced;
        });
        expect(screen.findByType(RecordingControlWindow).props).toMatchObject({
            discarded: false, snapshot: { sourceRef: 'next-recording' },
        });
        expect(screen.findAllByType(CaptureWindowStates)).toHaveLength(0);
        expect(discarded).toEqual(['partial', 'partial']);
    });

    it('disables delivery with the projected image-input refusal for a pinned target', async () => {
        const reason = 'This Agent cannot receive images';
        const onSend = vi.fn();
        const onAddToDraft = vi.fn();
        const screen = await renderScreen(<CaptureWindowNote note="" onNoteChange={() => {}}
            target={{ title: 'Pinned session', mark: null, machineName: 'Machine', disabledReason: reason }}
            unreachable={null} windowText={null} busy={false} onSend={onSend} onAddToDraft={onAddToDraft} />);
        for (const testID of ['capture-window-send', 'capture-window-add']) {
            const button = screen.findAllByType(RoundButton).find(node => node.props.testID === testID);
            expect(button?.props.disabled).toBe(true);
            expect(button?.props.accessibilityHint).toBe(reason);
        }
        await act(async () => {
            const field = screen.findByType(MultiTextInput);
            field.props.onKeyPress({ key: 'Enter', ctrlKey: true, shiftKey: false, platformOS: 'web', webPlatform: 'Linux' });
            field.props.onKeyPress({ key: 'Enter', ctrlKey: true, shiftKey: true, platformOS: 'web', webPlatform: 'Linux' });
        });
        expect(onSend).not.toHaveBeenCalled();
        expect(onAddToDraft).not.toHaveBeenCalled();
    });

    it.each([['lastCapturePick', true], ['focusedSession', false], ['lastUsed', false]] as const)('says a %s default is the last capture\'s Session until a Session is chosen (cue=%s)', async (defaultReason, cued) => {
        browser = new JSDOM('<!doctype html><body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        setReducedMotionPreferenceOverride(true);
        Object.defineProperty(browser.window.HTMLElement.prototype, 'animate', { value: () => ({ finished: Promise.resolve(), cancel() {}, id: '' }) });
        Object.defineProperty(browser.window.HTMLElement.prototype, 'getAnimations', { value: () => [] });
        installImageAnnotationCanvasBoundary();
        const capture: NativeCaptureResult = { captureRef: 'cued', kind: 'still', path: '/captures/cued.png',
            mimeType: 'image/png', byteSize: 3, pixelSize: { width: 40, height: 30 }, scale: 1,
            origin: null, source: null, windowTextRef: null };
        const targetSession = { serverId: 'home', accountId: 'account', sessionId: 'session' };
        let ready: () => void = () => {};
        const announced = new Promise<void>(resolve => { ready = resolve; });
        const nativeTitles: unknown[] = [];
        const choices: unknown[] = [];
        // Tauri IPC is the native boundary; the capture hook, Action bridge and shell stay real.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_set_window_title') { nativeTitles.push(args?.title); return null; }
            if (command === 'desktop_capture_window_placement') return { previousFrame: null };
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'paint') return true;
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 1, result: capture } });
                ready(); return;
            }
            if (command === 'desktop_capture_display_facts') return [{ displayId: 1,
                frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1, desktopScale: 1,
                storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null }];
            if (command === 'desktop_capture_read_source_png') return [9, 8, 7];
            if (command === 'desktop_capture_window_text') return { status: 'unavailable', reason: 'provider_unavailable', source: null };
            if (command === 'desktop_window_emit_action') {
                const request = args?.payload as Record<string, unknown>;
                const data = request.data as Record<string, unknown>;
                if (request.intent === 'chooseSession') choices.push(data.targetSession);
                let result: unknown = { captureRef: capture.captureRef, status: 'opened' };
                if (request.actionIdentifier === 'screenCapture.open' && !data.targetSession) {
                    // Main chose the default once; native replays the pinned snapshot before the result.
                    events.listeners.get('desktopCapture://state')?.({ payload: { status: 'completed', operationRef: 1, result: capture, targetSession } });
                    result = { captureRef: capture.captureRef, status: 'opened', targetSession, defaultReason };
                }
                if (request.actionIdentifier === 'screenCapture.sessionChooser.read') result = data.kind === 'page' ? { rows: [], total: 0 }
                    : { address: { serverId: 'home', sessionId: 'session' }, accountId: 'account',
                        row: { id: 'home:session', address: { serverId: 'home', sessionId: 'session' }, label: 'Session',
                            subtitle: '/repo', agentId: '', machineId: null, machineName: 'Machine', place: '/repo', working: false,
                            statusText: '', statusTone: 'neutral', activityLabel: '' },
                        uploadAvailable: true, machineReachability: 'reachable', hasDraftText: false };
                events.listeners.get('desktopWindow://action-result')?.({ payload: { ...request, phase: 'settled', ok: true, result } });
                return;
            }
            return null;
        } });
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        const screen = await renderScreen(<CaptureWindowRoute />, { createNodeMock: () => {
            const parent = browser!.window.document.createElement('div');
            const node = browser!.window.document.createElement('div');
            parent.append(node); browser!.window.document.body.append(parent);
            return node;
        } });
        await act(async () => { await announced; });
        await settled(() => screen.findAllByType(CaptureWindowNote)[0]?.props.target?.title).toBe('Session');
        await act(async () => { screen.findByType(CaptureWindowScreen).props.onMeasure({ chromeTop: 60, chromeBottom: 90, floorWidth: 500 }); });
        await settled(() => screen.findByType(CaptureWindowNote).props.busy).toBe(false);
        expect(screen.findByType(CaptureWindowNote).props.target?.cue).toBe(cued ? t('screenCapture.window.sameAsLastCapture') : undefined);
        // New Session is a local target selection: no delivery, native pin or remembered default changes.
        await act(async () => { screen.findByType(SessionChooser).props.onNewSession(); });
        expect(screen.findByType(CaptureWindowNote).props.target).toMatchObject({ kind: 'newSession', title: t('transcript.selection.sendTo.newSession') });
        const send = screen.findAllByType(RoundButton).find(node => node.props.testID === 'capture-window-send');
        const add = screen.findAllByType(RoundButton).find(node => node.props.testID === 'capture-window-add');
        expect(send?.props).toMatchObject({ disabled: true, display: 'secondary' });
        expect(add?.props).toMatchObject({ disabled: false, display: 'default' });
        expect(screen.findAllByType(CaptureDeliveryPill)).toHaveLength(0);
        expect(choices).toEqual([]);
        // Choosing, even the same Session again, makes it this person's pick rather than the remembered one.
        await act(async () => { screen.findByType(SessionChooser).props.onSelect({ serverId: 'home', sessionId: 'session' }); });
        await settled(() => choices).toEqual([targetSession]);
        await settled(() => screen.findByType(CaptureWindowNote).props.target?.cue).toBeUndefined();
        // Assistive tech tells cascaded windows apart by this title; a source-less still is a region.
        expect(nativeTitles).toEqual([t('screenCapture.window.nativeTitle', { subject: t('screenCapture.window.region') })]);
    });

    it.each([
        ['send', false, false, false, 'button'], ['addToDraft', false, false, false, 'button'], ['newSession', false, false, false, 'button'],
        ['send', false, false, false, 'keyboard'], ['addToDraft', false, false, false, 'keyboard'], ['newSession', false, false, false, 'keyboard'],
        ['send', true, false, false, 'button'], ['send', false, true, false, 'button'], ['send', false, true, true, 'button'],
    ] as const)('keeps the applied %s receipt and its close owner (retry preparation=%s, native settled=%s, discard failure=%s, ingress=%s)', async (delivery, retryPreparation, nativeSettled, discardFailure, ingress) => {
        // jsdom is an untyped external browser fixture; all Capture/keyboard owners remain real.
        browser = new JSDOM('<!doctype html><body></body>', { url: 'http://capture.test' });
        vi.stubGlobal('window', browser.window);
        vi.stubGlobal('document', browser.window.document);
        setReducedMotionPreferenceOverride(true);
        Object.defineProperty(browser.window.HTMLElement.prototype, 'animate', { value: () => ({ finished: Promise.resolve(), cancel() {}, id: '' }) });
        Object.defineProperty(browser.window.HTMLElement.prototype, 'getAnimations', { value: () => [] });
        installImageAnnotationCanvasBoundary();
        const calls: string[] = [];
        const discardedRefs: string[] = [];
        let preparations = 0;
        let preparedDisclosure: NativeCaptureDisclosure | null = null;
        let preparedBytes: readonly number[] | null = null;
        let mainIdlePublications = 0;
        const capture: NativeCaptureResult = { captureRef: 'receipt', kind: 'still', path: '/captures/receipt.png',
            mimeType: 'image/png', byteSize: 3, pixelSize: { width: 40, height: 30 }, scale: 1,
            origin: null, source: null, windowTextRef: null };
        const targetSession = { serverId: 'home', accountId: 'account', sessionId: 'session' };
        let snapshot: NativeCaptureSnapshot = { status: 'completed', operationRef: 1, result: capture, targetSession };
        let ready: () => void = () => {};
        let replayReady: (() => void) | undefined;
        const announced = new Promise<void>(resolve => { ready = resolve; });
        const receipt = delivery === 'send' ? { captureRef: capture.captureRef, messageRef: 'accepted' }
            : delivery === 'addToDraft' ? { captureRef: capture.captureRef, imageNumber: 3 }
            : { kind: 'opened', seedId: 'new-session-seed' };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_set_window_title') return null;
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'paint') return true;
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; }
                events.listeners.get('desktopCapture://state')?.({ payload: snapshot });
                ready(); replayReady?.(); return;
            }
            if (command === 'desktop_capture_display_facts') return [{ displayId: 1,
                frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1, desktopScale: 1,
                storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null }];
            if (command === 'desktop_capture_read_source_png') return [9, 8, 7];
            if (command === 'desktop_capture_read_result') return capture;
            if (command === 'desktop_capture_read_delivery_state') return { inUse: true,
                disclosure: preparedDisclosure, windowText: null, preparedRecording: null };
            if (command === 'desktop_capture_read_prepared_png') {
                if (!preparedBytes) throw 'prepared_missing';
                return preparedBytes;
            }
            if (command === 'desktop_capture_write_prepared_png') {
                preparations++;
                if (retryPreparation && preparations === 1) throw 'file_io';
                preparedDisclosure = args!.disclosure as NativeCaptureDisclosure;
                preparedBytes = args!.bytes as number[];
                return { captureRef: capture.captureRef };
            }
            if (command === 'desktop_capture_window_text') return { status: 'unavailable', reason: 'provider_unavailable', source: null };
            if (command === 'desktop_capture_window_hide') {
                events.listeners.get('desktopCapture://window')?.({ payload: 'hidden' });
                return null;
            }
            if (command === 'desktop_capture_window_present') return null;
            if (command === 'desktop_window_emit_action') {
                const request = args?.payload as Record<string, unknown>;
                const targetRead = request.actionIdentifier === 'screenCapture.sessionChooser.read';
                const discard = request.actionIdentifier === 'screenCapture.discard';
                if (request.actionIdentifier === 'screenCapture.send' || request.actionIdentifier === 'screenCapture.addToDraft'
                    || request.actionIdentifier === 'screenCapture.sessionChooser.newSession') {
                    // Exercise the real receiving owner across the native IPC boundary: a fake
                    // main success must not conceal a still path that skipped preparation.
                    const record = await readPreparedCaptureDelivery(capture.captureRef);
                    const delivery = resolveCaptureDelivery(record, { surface: 'ui' }, { captureWindowPress: true });
                    expect(delivery).not.toHaveProperty('ok');
                    if ('ok' in delivery || !('image' in delivery)) throw new Error('Expected prepared still delivery');
                    const bytes = 'bytes' in delivery.image ? delivery.image.bytes : await delivery.image.readBytes();
                    expect(bytes).toEqual(new Uint8Array([9, 8, 7]));
                }
                if (discard) discardedRefs.push((request.data as { captureRef: string }).captureRef);
                // Native CaptureState's separately tested audience sends this Idle to main before the result, not Capture.
                if (!targetRead && nativeSettled) mainIdlePublications++;
                events.listeners.get('desktopWindow://action-result')?.({ payload: { ...request, phase: 'settled',
                    ...(targetRead ? { ok: true, result: (request.data as { kind: string }).kind === 'page' ? { rows: [], total: 0 } : { address: { serverId: 'home', sessionId: 'session' }, accountId: 'account',
                        row: { id: 'home:session', address: { serverId: 'home', sessionId: 'session' }, label: 'Session',
                            subtitle: '/repo', agentId: '', machineId: null, machineName: 'Machine', place: '/repo', working: false,
                            statusText: '', statusTone: 'neutral', activityLabel: '' },
                        uploadAvailable: true, machineReachability: 'reachable', hasDraftText: false } }
                        : discard ? discardFailure && discardedRefs.filter(ref => ref === discardedRefs.at(-1)).length === 1
                            ? { ok: false, errorCode: 'file_io' }
                            : { ok: true, result: { captureRef: discardedRefs.at(-1), status: 'discarded' } }
                        : nativeSettled ? { ok: true, result: receipt }
                        : { ok: false, errorCode: 'native_failure', details: { captureStaged: true, delivered: receipt } }),
                } });
                return;
            }
            throw new Error(`Unexpected receipt boundary: ${command}`);
        } });
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        const screen = await renderScreen(<CaptureWindowRoute />, { createNodeMock: () => {
            const parent = browser!.window.document.createElement('div');
            const node = browser!.window.document.createElement('div');
            parent.append(node); browser!.window.document.body.append(parent);
            return node;
        } });
        await act(async () => { await announced; });
        const owner = screen.findByType(CaptureWindowScreen);
        if (delivery === 'send' && !retryPreparation && !nativeSettled) {
            // The note accepts typing during the opening motion; Cmd+K must work then too.
            const note = document.createElement('textarea');
            document.body.append(note);
            note.focus();
            note.value = 'Keep this focused note';
            await act(async () => { screen.findByType(MultiTextInput).props.onChangeText(note.value); });
            await act(async () => { note.dispatchEvent(new browser!.window.KeyboardEvent('keydown', {
                key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true,
            })); });
            expect(screen.findByType(CaptureWindowNote).props.choosing).toBe(true);
            expect(screen.findByType(SessionChooser).props.open).toBe(true);
            expect(screen.findByType(CaptureWindowScreen).props.note).toBe('Keep this focused note');
        }
        if (nativeSettled) {
            await act(async () => { owner.props.onMeasure({ chromeTop: 60, chromeBottom: 90, floorWidth: 500 }); });
            await act(async () => { screen.findByType(CaptureWindowNote).props.onSend(); });
            await settled(() => screen.findByType(CaptureDeliveryPill).props.state).toMatchObject({ kind: 'sent' });
            await settled(() => screen.findHostByTestId('capture-window')?.props['aria-hidden']).toBe(true);
            expect(mainIdlePublications).toBe(1);
            expect(screen.findByType(CaptureWindowScreen)).toBe(owner);
            await act(async () => { document.dispatchEvent(new browser!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
            await settled(() => screen.findAllByType(CaptureWindowScreen)).toHaveLength(0);
            expect(calls.filter(command => command === 'desktop_capture_window_hide')).toHaveLength(1);
            expect(screen.findAllByType(CaptureWindowScreen)).toHaveLength(0);
            const openNext = async (captureRef: string, note: string) => {
                const replayed = new Promise<void>(resolve => { replayReady = resolve; });
                await act(async () => {
                    snapshot = { status: 'completed', operationRef: 2, result: { ...capture, captureRef }, targetSession };
                    events.listeners.get('desktopCapture://window')?.({ payload: 'start' });
                    await replayed;
                });
                await settled(() => screen.findAllByType(CaptureWindowScreen)).toHaveLength(1);
                await act(async () => { screen.findByType(CaptureWindowScreen).props.onMeasure({ chromeTop: 60, chromeBottom: 90, floorWidth: 500 }); });
                if (note) await act(async () => { screen.findByType(CaptureWindowNote).props.onNoteChange(note); });
            };
            const escape = () => document.dispatchEvent(new browser!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await openNext('discard-empty', '');
            await act(async () => { escape(); });
            await settled(() => discardedRefs).toEqual(['discard-empty']);
            if (discardFailure) {
                await settled(() => screen.findByType(CaptureDeliveryPill).props.state).toMatchObject({ kind: 'failed', operation: 'discard', cause: 'file_io' });
                expect(calls.filter(command => command === 'desktop_capture_window_hide')).toHaveLength(1);
                const retained = screen.findByType(CaptureWindowScreen);
                await act(async () => { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); escape(); });
                expect(screen.findByType(CaptureWindowScreen)).toBe(retained);
                expect(discardedRefs).toEqual(['discard-empty']);
                await act(async () => { screen.findByType(CaptureDeliveryPill).props.onRetry(); });
                await settled(() => discardedRefs).toEqual(['discard-empty', 'discard-empty']);
            }
            await settled(() => screen.findAllByType(CaptureWindowScreen)).toHaveLength(0);
            discardedRefs.length = 0;
            await openNext('discard-work', 'Keep these marks');
            expect(screen.findByType(CaptureWindowScreen).props.note).toBe('Keep these marks');
            await act(async () => { escape(); });
            expect(screen.findByType(CaptureDeliveryPill).props.state.kind).toBe('discarded');
            expect(discardedRefs).toEqual([]);
            await act(async () => { screen.findByType(CaptureDeliveryPill).props.onUndo(); });
            await settled(() => screen.findAllByType(CaptureDeliveryPill)).toHaveLength(0);
            expect(discardedRefs).toEqual([]);
            await act(async () => { escape(); });
            await settled(() => screen.findHostByTestId('capture-window')?.props['aria-hidden']).toBe(true);
            expect(discardedRefs).toEqual([]);
            await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.undoHoldMs); });
            await settled(() => discardedRefs).toEqual(['discard-work']);
            if (discardFailure) {
                await settled(() => screen.findByType(CaptureDeliveryPill).props.state).toMatchObject({ kind: 'failed', operation: 'discard', cause: 'file_io' });
                expect(calls.filter(command => command === 'desktop_capture_window_hide')).toHaveLength(2);
                await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.undoHoldMs); });
                expect(discardedRefs).toEqual(['discard-work']);
                await act(async () => { screen.findByType(CaptureDeliveryPill).props.onRetry(); });
                await settled(() => discardedRefs).toEqual(['discard-work', 'discard-work']);
            }
            await settled(() => screen.findAllByType(CaptureWindowScreen)).toHaveLength(0);
            if (discardFailure) {
                await openNext('discard-edit', 'Keep after editing');
                await act(async () => { escape(); });
                await settled(() => screen.findHostByTestId('capture-window')?.props['aria-hidden']).toBe(true);
                await act(async () => { escape(); });
                await settled(() => screen.findByType(CaptureDeliveryPill).props.state).toMatchObject({ kind: 'failed', operation: 'discard' });
                await act(async () => { screen.findByType(CaptureDeliveryPill).props.onEdit(); });
                await settled(() => screen.findAllByType(CaptureDeliveryPill)).toHaveLength(0);
                expect(screen.findByType(CaptureWindowScreen).props.note).toBe('Keep after editing');
                await act(async () => { screen.findByType(CaptureWindowNote).props.onSend(); });
                await settled(() => screen.findByType(CaptureDeliveryPill).props.state).toMatchObject({ kind: 'sent' });
                await settled(() => screen.findHostByTestId('capture-window')?.props['aria-hidden']).toBe(true);
                await act(async () => { escape(); });
                await settled(() => screen.findAllByType(CaptureWindowScreen)).toHaveLength(0);
                expect(discardedRefs.filter(ref => ref === 'discard-edit')).toHaveLength(1);
                expect(screen.findAllByType(CaptureWindowScreen)).toHaveLength(0);
            }
            return;
        }
        if (delivery === 'newSession') {
            await act(async () => { screen.findByType(SessionChooser).props.onNewSession(); });
            expect(preparations).toBe(0);
        }
        const operation = delivery === 'newSession' ? 'addToDraft' : delivery;
        if (retryPreparation) {
            let outcome: CaptureDeliveryOutcome | undefined;
            await act(async () => { outcome = await owner.props.onDeliver(operation); });
            expect(outcome).toMatchObject({ ok: false, phase: 'preparation' });
            await act(async () => { outcome = await owner.props.onRetry(delivery); });
            expect(preparations).toBe(2);
            expect(outcome).toMatchObject({ ok: true, pill: { kind: 'sent', cleanupWarning: 'native_failure' } });
        } else {
            await act(async () => { owner.props.onMeasure({ chromeTop: 60, chromeBottom: 90, floorWidth: 500 }); });
            await settled(() => screen.findByType(CaptureWindowNote).props.busy).toBe(false);
            await act(async () => {
                if (ingress === 'keyboard') document.dispatchEvent(new browser!.window.KeyboardEvent('keydown', {
                    key: 'Enter', code: 'Enter', metaKey: true, shiftKey: operation === 'addToDraft', bubbles: true, cancelable: true,
                }));
                else if (operation === 'send') screen.findByType(CaptureWindowNote).props.onSend();
                else screen.findByType(CaptureWindowNote).props.onAddToDraft();
            });
            await settled(() => screen.findAllByType(CaptureDeliveryPill)[0]?.props.state).toMatchObject({
                kind: delivery === 'send' ? 'sent' : delivery === 'addToDraft' ? 'added' : 'started', cleanupWarning: 'native_failure',
            });
        }
        expect(screen.findByType(CaptureWindowScreen)).toBe(owner);
        await act(async () => { owner.props.onClosed(); });
        expect(calls.filter(command => command === 'desktop_capture_window_hide')).toHaveLength(1);
        expect(screen.findAllByType(CaptureWindowScreen)).toHaveLength(0);
    });

    it('recovers a failed capture through the shared recent picker and reference-only main action', async () => {
        const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
        let ready: () => void = () => {};
        const announced = new Promise<void>(resolve => { ready = resolve; });
        let actionForwarded: () => void = () => {};
        const forwarded = new Promise<void>(resolve => { actionForwarded = resolve; });
        const entry = { path: '/captures/recent.png', name: 'recent.png', kind: 'still' as const,
            byteSize: 20, modifiedAt: null, modifiedAtNanos: null };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push({ command, args });
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'paint') return true;
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; } ready(); return; }
            if (command === 'desktop_capture_display_facts') return [{ displayId: 1,
                frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1, desktopScale: 1,
                storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null }];
            if (command === 'desktop_capture_recent_open') return { entries: [entry], folders: [] };
            if (command === 'desktop_capture_recent_close') return;
            if (command === 'desktop_capture_recent_open_media') return { captureRef: 'recent-1' };
            if (command === 'desktop_window_emit_action') {
                events.listeners.get('desktopWindow://action-result')?.({ payload: {
                    ...(args?.payload as Record<string, unknown>), phase: 'settled', ok: true,
                } });
                actionForwarded();
                return;
            }
            throw new Error(`Unexpected native command: ${command}`);
        } });
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><ModalProvider>
            <CaptureWindowRoute />
        </ModalProvider></InjectedAuthProvider>);
        await announced;
        await act(async () => {
            events.listeners.get('desktopCapture://state')?.({ payload: { status: 'failed', reason: 'native_failure' } });
        });
        expect(calls.some(({ command }) => command === 'desktop_capture_recent_open')).toBe(false);
        const attach = screen.findAllByType(RoundButton).find(button => button.props.title === t('screenCapture.window.attachRecent'));
        expect(attach).toBeDefined();
        const host = attach!.findAll(node => typeof node.type === 'string'
            && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function')).at(-1);
        await pressTestInstanceAsync(host, 'Attach a recent capture');
        await act(async () => {
            screen.findByType(RecentCaptureGrid).props.onChoose(entry);
            await forwarded;
        });
        expect(calls.find(({ command }) => command === 'desktop_capture_recent_open_media')?.args).toEqual({ path: entry.path });
        expect(calls.find(({ command }) => command === 'desktop_window_emit_action')?.args?.payload).toMatchObject({
            windowLabel: 'capture', actionIdentifier: 'screenCapture.open', data: { captureRef: 'recent-1' },
        });
        const payload = calls.find(({ command }) => command === 'desktop_window_emit_action')?.args?.payload as Record<string, unknown>;
        expect(payload.data).toEqual({ captureRef: 'recent-1' });
        expect(calls.some(({ command }) => command === 'desktop_capture_start')).toBe(false);
    });

    it.each([
        ['Ctrl+Alt+4', ['Ctrl', 'Alt', '4']],
        ['CmdOrCtrl+Shift+2', ['Ctrl', 'Shift', '2']],
    ] as const)('teaches active native shortcut %s and requests the screen grant through its recovery owner without starting capture', async (activeBinding, keycaps) => {
        const calls: string[] = [];
        let ready: () => void = () => {};
        const announced = new Promise<void>(resolve => { ready = resolve; });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'desktop_capture_window_ready') {
                if (args?.phase === 'paint') return true;
                if (args?.phase === 'wake') { events.listeners.get('desktopCapture://window')?.({ payload: 'start' }); return true; } ready(); return; }
            if (command === 'desktop_capture_display_facts') return [{ displayId: 1,
                frame: { x: 0, y: 0, width: 1440, height: 900 }, scale: 1, desktopScale: 1,
                storageKey: null, localizedName: null, safeAreaTop: 0, physicalNotchSize: null }];
            if (command === 'desktop_capture_shortcuts') return { backend: 'native', availability: 'ready',
                configureSupported: false, editing: false,
                bindings: [{ key: 'captureShortcut', requested: 'Ctrl+Shift+2', active: activeBinding, failure: null }] };
            if (command === 'desktop_capture_open_permission_settings') return;
            if (command === 'desktop_capture_window_set_floating') { expect(args).toEqual({ floating: false }); return; }
            if (command === 'desktop_capture_request_permission') {
                expect(args).toEqual({ subject: 'screen' });
                return { snapshot: { screen: 'denied', windowText: 'request_required' }, recovery: 'none', changed: true };
            }
            throw new Error(`Unexpected native command: ${command}`);
        } });
        const screen = await renderScreen(<CaptureWindowRoute />);
        await announced;
        await act(async () => {
            events.listeners.get('desktopCapture://state')?.({ payload: { status: 'unavailable', reason: 'screen_permission_required' } });
        });
        expect(screen.findAllByType(KeyHint).map(key => key.props.label)).toEqual(keycaps);
        const open = screen.findAllByType(RoundButton).find(button => button.props.title === t('screenCapture.permission.openSettings'));
        expect(open).toBeDefined();
        const host = open!.findAll(node => typeof node.type === 'string'
            && (typeof node.props.onPress === 'function' || typeof node.props.onClick === 'function')).at(-1);
        await pressTestInstanceAsync(host, 'Open settings');
        expect(calls).toContain('desktop_capture_window_set_floating');
        expect(calls.indexOf('desktop_capture_window_set_floating')).toBeLessThan(calls.indexOf('desktop_capture_request_permission'));
        expect(calls.filter(command => command === 'desktop_capture_request_permission')).toHaveLength(1);
        expect(calls).not.toContain('desktop_capture_open_permission_settings');
        expect(calls).not.toContain('desktop_capture_start');
    });
});

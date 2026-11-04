import * as React from 'react';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRenderCommitCounter, renderScreen, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { RecordingTimeline } from './RecordingTimeline';
import { createRecordingClock } from './recordingClock';
import { createRecordingDocument, projectRecordingDocument, reduceRecordingDocument } from './recordingDocument';
import type { RecordingMediaAccess } from './useRecordingEditor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
let pointerBrowser: JSDOM;
beforeEach(() => {
    pointerBrowser = new JSDOM('<body></body>');
    vi.stubGlobal('HTMLElement', pointerBrowser.window.HTMLElement);
});
afterEach(async () => { await standardCleanup(); pointerBrowser.window.close(); vi.unstubAllGlobals(); });
const media: RecordingMediaAccess = { renderPlayer: () => null, withFrames: operation => operation({
    seekTo: () => {}, readFrame: async () => ({ uri: 'data:image/png;base64,AQID', width: 4, height: 4, timeSeconds: 0 }),
}) };

describe('recording timeline committed gestures', () => {
    it('updates the accessible seek position on clock ticks and keyboard seek without rendering its editor or sibling', async () => {
        const browser = new JSDOM('<body></body>');
        const track = browser.window.document.createElement('div');
        const playhead = browser.window.document.createElement('div');
        const clock = createRecordingClock(2_000);
        const document = reduceRecordingDocument(createRecordingDocument({ sourceCaptureRef: 'movie', durationMs: 20_000,
            frameDurationMs: 1000 / 25, includeWindowText: false }), { kind: 'trim.set', startMs: 2_000, endMs: 10_000 });
        const editorRenders = createRenderCommitCounter();
        const siblingRenders = createRenderCommitCounter();
        function Sibling() { useRenderCommitCounter(siblingRenders); return null; }
        function Editor() {
            useRenderCommitCounter(editorRenders);
            return <><Sibling /><RecordingTimeline document={document} clock={clock} playing={false}
                aspectRatio={1} media={media} onTogglePlaying={() => {}} onScrub={clock.write} onSettle={() => {}}
                onSeek={clock.write} onTrim={() => {}} onMoveDefaultPin={() => {}} /></>;
        }
        const screen = await renderScreen(<Editor />, { createNodeMock: element => element.props.testID === 'recording-strip' ? track : playhead });
        try {
            expect(track.getAttribute('aria-valuenow')).toBe('2000');
            expect(track.getAttribute('aria-valuetext')).toBe('0:02');
            editorRenders.reset(); siblingRenders.reset();
            await act(async () => { clock.write(2_500); clock.write(3_000); });
            expect(track.getAttribute('aria-valuenow')).toBe('3000');
            expect(track.getAttribute('aria-valuetext')).toBe('0:03');
            await act(async () => screen.findHostByTestId('recording-strip')!.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }));
            expect(track.getAttribute('aria-valuenow')).toBe('4000');
            expect(track.getAttribute('aria-valuetext')).toBe('0:04');
            await act(async () => screen.findHostByTestId('recording-strip')!.props.onKeyDown({ key: 'ArrowLeft', shiftKey: true, preventDefault() {} }));
            expect(track.getAttribute('aria-valuenow')).toBe('3900');
            expect(editorRenders.read()).toEqual({ renders: 0, commits: 0 });
            expect(siblingRenders.read()).toEqual({ renders: 0, commits: 0 });
        } finally { await screen.unmount(); browser.window.close(); }
    });

    it('keeps one encoded frame when dragging across the other handle or pressing past it', async () => {
        const document = reduceRecordingDocument(createRecordingDocument({ sourceCaptureRef: 'movie', durationMs: 4288,
            frameDurationMs: 1000 / 60, includeWindowText: false }), { kind: 'trim.set', startMs: 4088, endMs: 4288 });
        const trim = vi.fn();
        const scrub = vi.fn();
        const track = { style: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 200 }) };
        const screen = await renderScreen(<RecordingTimeline document={document} clock={createRecordingClock(4088)} playing={false}
            aspectRatio={1} media={media} onTogglePlaying={() => {}} onScrub={scrub} onSettle={() => {}}
            onSeek={() => {}} onTrim={trim} onMoveDefaultPin={() => {}} />, { createNodeMock: () => track });
        await act(async () => screen.findHostByTestId('recording-trim-end')!.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} }));
        expect(trim).toHaveBeenLastCalledWith(4088, 4105);
        const listeners = new Map<string, (event: { clientX: number }) => void>();
        const target = Object.assign(pointerBrowser.window.document.createElement('div'), { setPointerCapture() {}, addEventListener: (name: string, listener: (event: { clientX: number }) => void) => listeners.set(name, listener),
            removeEventListener: (name: string) => listeners.delete(name) });
        await act(async () => screen.findHostByTestId('recording-trim-start')!.props.onPointerDown({ currentTarget: target, nativeEvent: { clientX: 0, pointerId: 1 }, stopPropagation() {} }));
        await act(async () => listeners.get('pointermove')!({ clientX: 250 }));
        expect(scrub).toHaveBeenLastCalledWith(4271);
        await act(async () => listeners.get('pointerup')!({ clientX: 250 }));
        expect(trim).toHaveBeenLastCalledWith(4271, 4288);
    });
    it.each(['pointercancel', 'unmount'] as const)('keeps the exact edited trim when a captured pointer ends through %s', async cancellation => {
        let document = reduceRecordingDocument(createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 37_136, includeWindowText: false }),
            { kind: 'trim.set', startMs: 36_936, endMs: 37_136 });
        document = reduceRecordingDocument(document, { kind: 'defaultPin.move', sourceTimeMs: 2621 });
        const original = document;
        const track = { style: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 500 }) };
        const screen = await renderScreen(<RecordingTimeline document={document} clock={createRecordingClock(36_936)} playing={false}
            aspectRatio={1} media={media} onTogglePlaying={() => {}} onScrub={() => {}} onSettle={() => {}} onSeek={() => {}}
            onTrim={(startMs, endMs) => { document = reduceRecordingDocument(document, { kind: 'trim.set', startMs, endMs }); }}
            onMoveDefaultPin={sourceTimeMs => { document = reduceRecordingDocument(document, { kind: 'defaultPin.move', sourceTimeMs }); }} />,
        { createNodeMock: () => track });
        const listeners = new Map<string, (event: { clientX: number }) => void>();
        const target = Object.assign(pointerBrowser.window.document.createElement('div'), { setPointerCapture() {}, addEventListener: (name: string, listener: (event: { clientX: number }) => void) => listeners.set(name, listener),
            removeEventListener: (name: string) => listeners.delete(name) });
        await act(async () => screen.findHostByTestId('recording-trim-end')!.props.onPointerDown({ currentTarget: target, nativeEvent: { clientX: 500, pointerId: 1 }, stopPropagation() {} }));
        // Cancellation has no final source coordinate; zero is a browser default, not an edit.
        if (cancellation === 'pointercancel') await act(async () => listeners.get('pointercancel')!({ clientX: 0 }));
        else await screen.unmount();
        expect(document).toEqual(original);
        expect(listeners.size).toBe(0);
    });

    it('settles a default-pin drag once while its document commit is pending', async () => {
        const document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        const reads: number[] = [];
        const track = { style: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 200 }) };
        const screen = await renderScreen(<RecordingTimeline document={document} clock={createRecordingClock(0)} playing={false}
            aspectRatio={1} media={media} onTogglePlaying={() => {}} onScrub={() => {}} onSettle={time => reads.push(time)}
            onSeek={time => reads.push(time)} onTrim={() => {}} onMoveDefaultPin={() => {}} />, { createNodeMock: () => track });
        const listeners = new Map<string, (event: { clientX: number }) => void>();
        const target = Object.assign(pointerBrowser.window.document.createElement('div'), { setPointerCapture() {}, addEventListener: (name: string, callback: (event: { clientX: number }) => void) => listeners.set(name, callback),
            removeEventListener: (name: string) => listeners.delete(name) });
        const pin = screen.findHostByTestId('recording-pin-default')!;
        await act(async () => pin.props.onPointerDown({ currentTarget: target, nativeEvent: { clientX: 0, pointerId: 1 }, stopPropagation() {} }));
        await act(async () => listeners.get('pointerup')!({ clientX: 50 }));
        // The browser follows pointer-up with click before the native document write settles.
        await act(async () => pin.props.onPress?.());
        expect(reads).toEqual([5000]);
    });

    it.each([[20_000, 200], [3_600_000, 600], [3_600_000, 1200]])('allows a 100ms trim in a %sms source at %spx by keyboard and pointer', async (durationMs, width) => {
        const initial = reduceRecordingDocument(createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs, includeWindowText: false }),
            { kind: 'trim.set', startMs: 0, endMs: 200 });
        const trim = vi.fn();
        const track = { style: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width }) };
        const screen = await renderScreen(<RecordingTimeline document={initial} clock={createRecordingClock(0)} playing={false}
            aspectRatio={1} media={media} onTogglePlaying={() => {}} onScrub={() => {}} onSettle={() => {}}
            onSeek={() => {}} onTrim={trim} onMoveDefaultPin={() => {}} />, { createNodeMock: () => track });
        await act(async () => screen.findHostByTestId('recording-strip')!.props.onLayout({ nativeEvent: { layout: { width } } }));
        const start = screen.root.findAll(node => typeof node.type === 'string' && node.props.onKeyDown && node.props['aria-valuenow'] === 0)[0]!;
        await act(async () => start.props.onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault() {} }));
        expect(trim).toHaveBeenLastCalledWith(100, 200);
        const listeners = new Map<string, (event: { clientX: number }) => void>();
        const target = Object.assign(pointerBrowser.window.document.createElement('div'), { setPointerCapture() {}, addEventListener: (name: string, callback: (event: { clientX: number }) => void) => listeners.set(name, callback),
            removeEventListener: (name: string) => listeners.delete(name) });
        await act(async () => start.props.onPointerDown({ currentTarget: target, nativeEvent: { clientX: 0, pointerId: 1 }, stopPropagation() {} }));
        await act(async () => listeners.get('pointerup')!({ clientX: 100 / durationMs * width }));
        expect(trim).toHaveBeenLastCalledWith(100, 200);
    });

    it('moves the projected default pin with a committed drag or keyboard and lets explicit moments replace it', async () => {
        let document = createRecordingDocument({ frameDurationMs: 1000 / 25, sourceCaptureRef: 'movie', durationMs: 20_000, includeWindowText: false });
        const moved: number[] = [];
        const track = { style: {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, width: 200 }) };
        function Timeline() {
            const [current, setCurrent] = React.useState(document);
            return <RecordingTimeline document={current} clock={createRecordingClock(0)} playing={false} aspectRatio={1} media={media}
                onTogglePlaying={() => {}} onScrub={() => {}} onSettle={() => {}} onSeek={() => {}} onTrim={() => {}}
                onMoveDefaultPin={sourceTimeMs => { moved.push(sourceTimeMs); document = reduceRecordingDocument(current, { kind: 'defaultPin.move', sourceTimeMs }); setCurrent(document); }} />;
        }
        const screen = await renderScreen(<Timeline />, { createNodeMock: () => track });
        const pin = screen.findHostByTestId('recording-pin-default')!;
        expect(pin).not.toBeNull();
        await act(async () => pin.props.onKeyDown({ key: 'ArrowRight', shiftKey: false, preventDefault() {}, stopPropagation() {} }));
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([1000]);
        const listeners = new Map<string, (event: { clientX: number }) => void>();
        const target = Object.assign(pointerBrowser.window.document.createElement('div'), { setPointerCapture() {}, addEventListener: (name: string, callback: (event: { clientX: number }) => void) => listeners.set(name, callback),
            removeEventListener: (name: string) => listeners.delete(name) });
        await act(async () => screen.findHostByTestId('recording-pin-default')!.props.onPointerDown({ currentTarget: target, nativeEvent: { clientX: 10, pointerId: 1 }, stopPropagation() {} }));
        await act(async () => listeners.get('pointermove')!({ clientX: 40 }));
        expect(moved).toEqual([1000]);
        await act(async () => listeners.get('pointerup')!({ clientX: 50 }));
        expect(projectRecordingDocument(document).frames.map(frame => frame.sourceTimeMs)).toEqual([5000]);
        expect(projectRecordingDocument(reduceRecordingDocument(document, { kind: 'pin.add', sourceTimeMs: 7000 })).frames.map(frame => frame.sourceTimeMs)).toEqual([7000]);
    });
});

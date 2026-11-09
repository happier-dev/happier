import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCdpScreencastProducer, type BrowserCdpScreencastFrame } from './cdpScreencast';
import type { BrowserSidecarCdpEventSubscriber, BrowserSidecarViewLifecycleSubscriber } from '../sidecar/controlAdapter';
import { createBrowserViewportOwner } from '../sidecar/viewport';

const view = { browserSessionId: 'browser', viewId: 'page' };
function harness() {
    const commands: { method: string; params?: Record<string, unknown> }[] = [];
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const lifecycle = new Set<BrowserSidecarViewLifecycleSubscriber>();
    let handle = { targetId: 'page', sessionId: 'page-cdp' };
    const contextCapture = {
        resolvePageHandle: () => handle,
        subscribeViewLifecycle: (listener: BrowserSidecarViewLifecycleSubscriber) => {
            lifecycle.add(listener); return () => { lifecycle.delete(listener); };
        },
        subscribeCdpEvents: (listener: BrowserSidecarCdpEventSubscriber) => {
            listeners.add(listener); return () => { listeners.delete(listener); };
        },
        transport: { dispatchPageCommand: async (command: typeof commands[number]) => {
            commands.push(command);
            return {};
        } },
    };
    const viewportOwner = createBrowserViewportOwner(contextCapture);
    const producer = createBrowserCdpScreencastProducer({ contextCapture: {
        ...contextCapture, resolveViewportOwner: () => viewportOwner,
    } });
    const frames: BrowserCdpScreencastFrame[] = [];
    const emit = (sessionId = handle.sessionId) => { for (const listener of listeners) listener({ sessionId, method: 'Page.screencastFrame',
        params: { sessionId: 1, data: 'ZnJhbWU=', metadata: { deviceWidth: 1280, deviceHeight: 800 } } }); };
    const starts = () => commands.filter(c => c.method === 'Page.startScreencast');
    const bind = (next = handle) => {
        handle = next;
        for (const listener of lifecycle) listener({ type: 'bound', ...view });
    };
    return { producer, viewportOwner, commands, frames, emit, starts, bind };
}

afterEach(() => vi.useRealTimers());
describe('shared browser screencast encoding owner', () => {
    it('requests one fresh frame for a new recording on a settled shared page and stays idle', async () => {
        vi.useFakeTimers();
        const h = harness();
        const recordingFrames: BrowserCdpScreencastFrame[] = [];
        try {
            const human = await h.producer.start({ view, purpose: 'humanViewer', onFrame: f => h.frames.push(f) });
            h.emit();
            const recording = await h.producer.start({ view, onFrame: f => recordingFrames.push(f) });
            // A recording needs current pixels, never the viewer's cached observation.
            expect(recordingFrames).toEqual([]);
            expect(h.starts()).toHaveLength(2);
            expect(h.commands.filter(c => c.method === 'Page.stopScreencast')).toHaveLength(1);
            h.emit();
            expect(recordingFrames).toHaveLength(1);
            const commands = h.commands.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.commands).toHaveLength(commands);
            await recording?.stop();
            await human?.stop();
        } finally { await h.producer.dispose(); h.viewportOwner.dispose(); }
    });

    it('keeps subscriptions on native rebind, ignores equal binding facts, and stops the current source on last release', async () => {
        vi.useFakeTimers();
        const h = harness();
        const errors: unknown[] = [];
        const observation: BrowserCdpScreencastFrame[] = [];
        try {
            const human = await h.producer.start({ view, purpose: 'humanViewer', onFrame: f => h.frames.push(f), onError: e => errors.push(e) });
            const observer = await h.producer.start({ view, onFrame: f => observation.push(f), onError: e => errors.push(e) });
            h.emit();
            const before = h.commands.length;
            for (let repeat = 0; repeat < 3; repeat++) h.bind();
            await vi.advanceTimersByTimeAsync(0);
            expect(h.commands).toHaveLength(before);
            h.bind({ targetId: 'reopened', sessionId: 'reopened-cdp' });
            await vi.advanceTimersByTimeAsync(0);
            expect(errors).toEqual([]);
            expect(h.starts()).toHaveLength(2);
            h.emit('page-cdp');
            expect(h.frames).toHaveLength(1);
            expect(observation).toHaveLength(1);
            h.emit();
            expect(h.frames).toHaveLength(2);
            expect(observation).toHaveLength(2);
            await human?.stop();
            h.emit();
            expect(h.frames).toHaveLength(2);
            expect(observation).toHaveLength(3);
            await observer?.stop();
            expect(h.commands.filter(c => c.method === 'Page.stopScreencast')).toHaveLength(2);
            expect(h.commands.filter(c => c.method === 'Page.stopScreencast').at(-1))
                .toMatchObject({ targetId: 'reopened', sessionId: 'reopened-cdp' });
            expect(h.commands.filter(c => c.method === 'Emulation.setFocusEmulationEnabled').at(-1))
                .toMatchObject({ params: { enabled: false } });
            const stopped = h.commands.length;
            h.emit();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.commands).toHaveLength(stopped);
            expect(observation).toHaveLength(3);
        } finally { await h.producer.dispose(); h.viewportOwner.dispose(); }
    });

    it('caps encoding at the applied controller backing store, updates resize once, and stays idle', async () => {
        vi.useFakeTimers();
        const h = harness();
        try {
            await h.viewportOwner.setViewport(view, { width: 390, height: 844, deviceScaleFactor: 3 });
            const human = await h.producer.start({ view, purpose: 'humanViewer', onFrame: f => h.frames.push(f) });
            expect(h.starts().at(-1)?.params).toMatchObject({ maxWidth: 1170, maxHeight: 2532 });
            h.emit();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.frames).toHaveLength(1);
            expect(h.starts()).toHaveLength(1);
            for (let n = 0; n < 20; n++) await h.viewportOwner.setViewport(view, { width: 390, height: 844, deviceScaleFactor: 3 });
            expect(h.starts()).toHaveLength(1);
            await h.viewportOwner.setViewport(view, { width: 844, height: 390, deviceScaleFactor: 3 });
            await vi.advanceTimersByTimeAsync(0);
            expect(h.starts().at(-1)?.params).toMatchObject({ maxWidth: 2532, maxHeight: 1170 });
            await human?.stop();
            const count = h.commands.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.commands).toHaveLength(count);
        } finally { await h.producer.dispose(); h.viewportOwner.dispose(); }
    });

    it.each([1, 2])('reduces motion encoding at DPR %s, restores one detailed still, then emits zero settled frames', async deviceScaleFactor => {
        vi.useFakeTimers();
        const h = harness();
        try {
            await h.viewportOwner.setViewport(view, { width: 1280, height: 800, deviceScaleFactor });
            await h.producer.start({ view, purpose: 'humanViewer', onFrame: f => h.frames.push(f) });
            const full = h.starts().at(-1)?.params;
            h.emit();
            await vi.advanceTimersByTimeAsync(50);
            h.emit();
            await vi.advanceTimersByTimeAsync(0);
            const moving = h.starts().at(-1)?.params;
            expect(moving?.quality).toBeLessThan(Number(full?.quality));
            expect(moving?.maxWidth).toBeLessThan(Number(full?.maxWidth));
            expect(moving).toMatchObject({ maxWidth: 960, maxHeight: 600 });
            // More movement extends the same settling deadline; it does not restart per frame.
            h.emit();
            await vi.advanceTimersByTimeAsync(50);
            h.emit();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(h.starts().at(-1)?.params).toEqual(full);
            expect(h.starts()).toHaveLength(3);
            // Chromium pushes one redraw when the detailed screencast resumes (real-CDP probe).
            const beforeStill = h.frames.length;
            h.emit();
            expect(h.frames).toHaveLength(beforeStill + 1);
            expect(h.commands.filter(c => c.method === 'Page.captureScreenshot')).toHaveLength(0);
            const count = h.frames.length;
            const commands = h.commands.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.frames).toHaveLength(count);
            expect(h.commands).toHaveLength(commands);
            expect(h.commands.filter(c => c.method === 'Page.captureScreenshot')).toHaveLength(0);
        } finally { await h.producer.dispose(); h.viewportOwner.dispose(); }
    });

    it('keeps the shared recording encoder detailed and clears a pending still on last stop', async () => {
        vi.useFakeTimers();
        const h = harness();
        try {
            await h.viewportOwner.setViewport(view, { width: 800, height: 600, deviceScaleFactor: 1 });
            const human = await h.producer.start({ view, purpose: 'humanViewer', onFrame: f => h.frames.push(f) });
            const recording = await h.producer.start({ view, onFrame: () => undefined });
            await vi.advanceTimersByTimeAsync(0);
            const detailedStarts = h.starts().length;
            expect(h.starts().at(-1)?.params).toEqual({ format: 'jpeg', quality: 80 });
            h.emit(); await vi.advanceTimersByTimeAsync(50); h.emit();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(h.starts()).toHaveLength(detailedStarts);
            await recording?.stop();
            h.emit(); await vi.advanceTimersByTimeAsync(50); h.emit();
            await human?.stop();
            const count = h.commands.length;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.commands).toHaveLength(count);
        } finally { await h.producer.dispose(); h.viewportOwner.dispose(); }
    });

    it('restores native detail when a recording joins motion and resumes viewer sizing when it leaves', async () => {
        vi.useFakeTimers();
        const h = harness();
        try {
            await h.viewportOwner.setViewport(view, { width: 640, height: 400, deviceScaleFactor: 1 });
            const human = await h.producer.start({ view, purpose: 'humanViewer', onFrame: f => h.frames.push(f) });
            h.emit(); await vi.advanceTimersByTimeAsync(50); h.emit();
            await vi.advanceTimersByTimeAsync(0);
            expect(h.starts().at(-1)?.params).toMatchObject({ maxWidth: 480, maxHeight: 300, quality: 65 });
            const recording = await h.producer.start({ view, onFrame: () => undefined });
            expect(h.starts().at(-1)?.params).toEqual({ format: 'jpeg', quality: 80 });
            const starts = h.starts().length;
            await h.viewportOwner.setViewport(view, { width: 800, height: 600, deviceScaleFactor: 2 });
            h.emit(); await vi.advanceTimersByTimeAsync(50); h.emit();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(h.starts()).toHaveLength(starts);
            await recording?.stop();
            await vi.advanceTimersByTimeAsync(0);
            expect(h.starts().at(-1)?.params).toMatchObject({ maxWidth: 1600, maxHeight: 1200, quality: 80 });
            await human?.stop();
        } finally { await h.producer.dispose(); h.viewportOwner.dispose(); }
    });
});

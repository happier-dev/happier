/**
 * Deferral contract for the viewport anchor capture host.
 *
 * Live A->B->A RED (2026-07-11): trailing untrusted (Legend estimate-correction) scroll
 * observations inside the capture debounce window applied the anchor-capture cancellation
 * effect as a hard invalidation, destroying the pending capture. Shallow detaches then never
 * persisted an anchor or offset, and re-entering the session restored `distance-oneshot(0)` =
 * the live tail. External movement must DEFER the pending capture (the capture callback reads
 * fresh geometry at fire time), so the settled truth is captured once movement quiesces and
 * the session-exit flush still has a capture to persist.
 */
import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReactNativeAppStateEmitter, renderHook } from '@/dev/testkit';
import { createTranscriptViewportCommandController } from '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController';
import { useTranscriptSessionExitHandoff } from '@/components/sessions/transcript/viewport/lifecycle/host/useTranscriptSessionExitHandoff';

import { useTranscriptViewportAnchorCaptureHost } from './useTranscriptViewportAnchorCaptureHost';

type AnchorCaptureHostDeps = Parameters<typeof useTranscriptViewportAnchorCaptureHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createMembers() {
    return {
        cancelScheduledViewportAnchorCapture: vi.fn(),
        currentSessionIdRef: createRef('s1'),
        emitViewportChange: vi.fn(),
        isEntryViewportCommandActive: vi.fn(() => false),
        listDataRef: createRef([]),
        listLayoutHeightRef: createRef(0),
        listRef: createRef(null),
        pinThresholdPx: 72,
        readCurrentNativeDistanceFromBottom: vi.fn<() => number | null>(() => null),
        recordViewportTelemetryEvent: vi.fn(),
        resolveWebScrollMetrics: vi.fn(() => null),
        scheduledViewportAnchorCaptureRef: createRef(null),
        shouldSuppressGenericViewportStateForProtectedJumpSeq: vi.fn(() => false),
        viewportAnchorCaptureGenerationRef: createRef(0),
        wantsPinnedRef: createRef(false),
    };
}

function buildDeps(members: ReturnType<typeof createMembers>): AnchorCaptureHostDeps {
    return {
        ...members,
        debounceMs: 200,
    };
}

function createFakeExitMetrics(values: Readonly<{ scrollTop: number; scrollHeight: number; clientHeight: number }>) {
    const element = {
        clientHeight: values.clientHeight,
        scrollHeight: values.scrollHeight,
        scrollTop: values.scrollTop,
        getBoundingClientRect: () => ({ top: 0, bottom: values.clientHeight, height: values.clientHeight }),
        querySelectorAll: () => [],
        querySelector: () => null,
    };
    return {
        element,
        scrollTop: values.scrollTop,
        scrollHeight: values.scrollHeight,
        clientHeight: values.clientHeight,
    } as unknown as ReturnType<AnchorCaptureHostDeps['resolveWebScrollMetrics']>;
}

class FakeAnchorElement {
    public parentElement: FakeAnchorElement | null = null;

    constructor(
        private readonly testId: string | null,
        private readonly top: number,
        private readonly bottom: number,
    ) {}

    getAttribute(name: string) {
        return name === 'data-testid' ? this.testId : null;
    }

    getBoundingClientRect() {
        return {
            top: this.top,
            bottom: this.bottom,
            left: 0,
            right: 0,
            width: 0,
            height: this.bottom - this.top,
            x: 0,
            y: this.top,
            toJSON: () => ({}),
        };
    }

    querySelectorAll() {
        return [] as FakeAnchorElement[];
    }

    querySelector() {
        return null;
    }
}

function createWebCaptureMetrics(values: Readonly<{
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    messageId: string;
    itemId: string;
    itemTop: number;
}>) {
    const container = new FakeAnchorElement(null, 0, values.clientHeight);
    const item = new FakeAnchorElement(
        `transcript-item-${values.itemId}`,
        values.itemTop,
        values.itemTop + values.clientHeight,
    );
    const message = new FakeAnchorElement(
        `transcript-anchor-message-${values.messageId}`,
        80,
        140,
    );
    item.parentElement = container;
    message.parentElement = item;
    container.querySelectorAll = () => [item, message];
    Object.assign(container, {
        clientHeight: values.clientHeight,
        scrollHeight: values.scrollHeight,
        scrollTop: values.scrollTop,
    });
    return {
        element: container,
        scrollTop: values.scrollTop,
        scrollHeight: values.scrollHeight,
        clientHeight: values.clientHeight,
    } as unknown as ReturnType<AnchorCaptureHostDeps['resolveWebScrollMetrics']>;
}

async function withBrowserLifecycleBoundary(
    run: (dispatch: (eventName: string) => void) => Promise<void>,
): Promise<void> {
    const browserTarget = new EventTarget();
    const browserGlobal = globalThis as unknown as Record<string, unknown>;
    const originalAddEventListener = browserGlobal.addEventListener;
    const originalRemoveEventListener = browserGlobal.removeEventListener;
    const originalDispatchEvent = browserGlobal.dispatchEvent;
    browserGlobal.addEventListener = browserTarget.addEventListener.bind(browserTarget);
    browserGlobal.removeEventListener = browserTarget.removeEventListener.bind(browserTarget);
    browserGlobal.dispatchEvent = browserTarget.dispatchEvent.bind(browserTarget);
    try {
        await run((eventName) => {
            browserTarget.dispatchEvent(new Event(eventName));
        });
    } finally {
        browserGlobal.addEventListener = originalAddEventListener;
        browserGlobal.removeEventListener = originalRemoveEventListener;
        browserGlobal.dispatchEvent = originalDispatchEvent;
    }
}

describe('useTranscriptViewportAnchorCaptureHost deferral', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('re-debounces a scheduled capture on external movement instead of destroying it', async () => {
        const members = createMembers();
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();

        host.schedule({ isPinned: false, offsetY: 1_234, shouldRestoreViewport: true });
        vi.advanceTimersByTime(100);
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        // External (untrusted) movement lands mid-debounce: defer, do not invalidate.
        host.defer();
        vi.advanceTimersByTime(150);
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        // The capture fires after the deferred quiescence window with the pending state.
        vi.advanceTimersByTime(80);
        expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
        expect(members.emitViewportChange).toHaveBeenCalledWith(expect.objectContaining({
            isPinned: false,
            offsetY: 1_234,
            shouldRestoreViewport: true,
        }));

        await hook.unmount();
    });

    it('captures one fire-time identity and distance after default PageUp movement', async () => {
        const originalPlatformOS = Platform.OS;
        const globalWithHTMLElement = globalThis as unknown as Record<'HTMLElement', unknown>;
        const originalHTMLElement = globalWithHTMLElement.HTMLElement;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        globalWithHTMLElement.HTMLElement = FakeAnchorElement;
        try {
            const members = createMembers();
            let metrics = createWebCaptureMetrics({
                clientHeight: 500,
                itemId: 'turn-before',
                itemTop: -20,
                messageId: 'message-before',
                scrollHeight: 4_000,
                scrollTop: 1_010,
            });
            members.resolveWebScrollMetrics = vi.fn(() => metrics);
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().schedule({
                isPinned: false,
                offsetY: 2_490,
                shouldRestoreViewport: true,
            });

            metrics = createWebCaptureMetrics({
                clientHeight: 500,
                itemId: 'turn-after',
                itemTop: -73,
                messageId: 'message-after',
                scrollHeight: 4_000,
                scrollTop: 730,
            });
            vi.advanceTimersByTime(250);

            expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
            expect(members.emitViewportChange).toHaveBeenCalledWith({
                anchor: {
                    capturedAtMs: expect.any(Number),
                    itemId: 'turn-after',
                    itemOffsetPx: -73,
                    kind: 'message',
                    messageId: 'message-after',
                },
                isPinned: false,
                offsetY: 2_770,
                shouldRestoreViewport: true,
            });

            await hook.unmount();
        } finally {
            globalWithHTMLElement.HTMLElement = originalHTMLElement;
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('preserves the prior durable snapshot when web fire-time geometry is unavailable', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const members = createMembers();
            members.resolveWebScrollMetrics = vi.fn(() => null);
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().schedule({
                isPinned: false,
                offsetY: 2_490,
                shouldRestoreViewport: true,
            });
            vi.advanceTimersByTime(250);

            expect(members.emitViewportChange).not.toHaveBeenCalled();
            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('keeps the deferred capture flushable at session exit', async () => {
        const members = createMembers();
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();

        host.schedule({ isPinned: false, offsetY: 987, shouldRestoreViewport: true });
        vi.advanceTimersByTime(100);
        host.defer();
        host.flush();
        expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
        expect(members.emitViewportChange).toHaveBeenCalledWith(expect.objectContaining({
            offsetY: 987,
        }));

        await hook.unmount();
    });

    it('captures one fire-time logical identity and offset on pagehide before the debounce fires', async () => {
        const originalPlatformOS = Platform.OS;
        const globalWithHTMLElement = globalThis as unknown as Record<'HTMLElement', unknown>;
        const originalHTMLElement = globalWithHTMLElement.HTMLElement;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        globalWithHTMLElement.HTMLElement = FakeAnchorElement;
        try {
            await withBrowserLifecycleBoundary(async (dispatch) => {
                const members = createMembers();
                members.resolveWebScrollMetrics = vi.fn(() => createWebCaptureMetrics({
                    clientHeight: 500,
                    itemId: 'turn-fire-time',
                    itemTop: -73,
                    messageId: 'message-fire-time',
                    scrollHeight: 4_000,
                    scrollTop: 730,
                }));
                const hook = await renderHook(
                    (deps: AnchorCaptureHostDeps) => {
                        const captureAtExitRef = React.useRef<
                            (options?: Readonly<{ deferEmit?: boolean }>) => void
                        >(() => {});
                        const exitCurrentSession = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
                            captureAtExitRef.current(options);
                        }, []);
                        const commitSessionId = React.useCallback(() => {}, []);
                        useTranscriptSessionExitHandoff({
                            commitSessionId,
                            exitCurrentSession,
                            sessionId: deps.currentSessionIdRef.current,
                        });
                        const host = useTranscriptViewportAnchorCaptureHost(deps);
                        React.useLayoutEffect(() => {
                            captureAtExitRef.current = host.captureAtExit;
                        }, [host.captureAtExit]);
                        return host;
                    },
                    { initialProps: buildDeps(members) },
                );

                hook.getCurrent().schedule({
                    isPinned: false,
                    offsetY: 2_490,
                    shouldRestoreViewport: true,
                });
                await React.act(async () => {
                    dispatch('pagehide');
                });

                expect(members.emitViewportChange).toHaveBeenCalledExactlyOnceWith({
                    anchor: {
                        capturedAtMs: expect.any(Number),
                        itemId: 'turn-fire-time',
                        itemOffsetPx: -73,
                        kind: 'message',
                        messageId: 'message-fire-time',
                    },
                    isPinned: false,
                    offsetY: 2_770,
                    shouldRestoreViewport: true,
                });

                await hook.unmount();
            });
        } finally {
            globalWithHTMLElement.HTMLElement = originalHTMLElement;
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('captures one fire-time native logical identity and offset on inactive before the debounce fires', async () => {
        const originalPlatformOS = Platform.OS;
        const appStateBoundary = createReactNativeAppStateEmitter();
        const restoreAppState = appStateBoundary.install(AppState);
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            const commitSessionId = vi.fn();
            members.wantsPinnedRef.current = false;
            members.listLayoutHeightRef.current = 600;
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(800);
            members.listDataRef.current = [
                { id: 'row-before', kind: 'message', messageId: 'message-before' },
                { id: 'row-fire-time', kind: 'message', messageId: 'message-fire-time' },
                { id: 'row-after', kind: 'message', messageId: 'message-after' },
            ] as never;
            members.listRef.current = {
                transcriptViewportCommandSpace: 'standard',
                computeVisibleIndices: () => ({ startIndex: 1, endIndex: 1 }),
                getAbsoluteLastScrollOffset: () => 1_000,
                getLayout: (index: number) => index === 1
                    ? { x: 0, y: 900, width: 320, height: 1_000 }
                    : undefined,
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            } as never;
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => {
                    const captureAtExitRef = React.useRef<
                        (options?: Readonly<{ deferEmit?: boolean }>) => void
                    >(() => {});
                    const exitCurrentSession = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
                        captureAtExitRef.current(options);
                    }, []);
                    useTranscriptSessionExitHandoff({
                        commitSessionId,
                        exitCurrentSession,
                        sessionId: deps.currentSessionIdRef.current,
                    });
                    const host = useTranscriptViewportAnchorCaptureHost(deps);
                    React.useLayoutEffect(() => {
                        captureAtExitRef.current = host.captureAtExit;
                    }, [host.captureAtExit]);
                    return host;
                },
                { initialProps: buildDeps(members) },
            );

            expect(commitSessionId).toHaveBeenCalledExactlyOnceWith('s1');
            hook.getCurrent().schedule({
                isPinned: false,
                offsetY: 2_490,
                shouldRestoreViewport: true,
            });
            await React.act(async () => {
                appStateBoundary.emit('inactive');
            });

            expect(members.emitViewportChange).toHaveBeenCalledExactlyOnceWith({
                anchor: {
                    capturedAtMs: expect.any(Number),
                    itemId: 'row-fire-time',
                    itemOffsetPx: -100,
                    kind: 'message',
                    messageId: 'message-fire-time',
                },
                isPinned: false,
                offsetY: 800,
                shouldRestoreViewport: true,
            });

            appStateBoundary.emit('background');
            expect(members.emitViewportChange).toHaveBeenCalledTimes(1);

            await hook.unmount();
            expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
        } finally {
            restoreAppState();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('persists one renderer-owned native physical identity, within-row offset, and distance when Legend model geometry disagrees', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.listLayoutHeightRef.current = 600;
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(1_700);
            members.listDataRef.current = [
                { id: 'row-before', kind: 'message', messageId: 'message-before' },
                { id: 'row-physical', kind: 'message', messageId: 'message-physical' },
                { id: 'row-after', kind: 'message', messageId: 'message-after' },
            ] as never;
            const observeNativePhysicalViewport = vi.fn(() => ({
                status: 'captured',
                capture: {
                    capturedAtMs: 100,
                    dataKey: 's1',
                    itemIndex: 1,
                    itemKey: 'row-physical',
                    itemOffsetPx: -2_196,
                    offsetY: 1_280,
                },
            }));
            members.listRef.current = {
                computeVisibleIndices: () => ({ startIndex: 1, endIndex: 1 }),
                getAbsoluteLastScrollOffset: () => 2_000,
                getLayout: (index: number) => index === 1
                    ? { x: 0, y: 247, width: 320, height: 3_000 }
                    : undefined,
                observeNativePhysicalViewport,
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            } as never;
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().schedule({
                isPinned: false,
                offsetY: 1_700,
                shouldRestoreViewport: true,
            });
            await vi.advanceTimersByTimeAsync(200);

            expect(observeNativePhysicalViewport).toHaveBeenCalledWith({
                focusOffsetPx: 108,
                onComplete: expect.any(Function),
            });
            expect(members.emitViewportChange).toHaveBeenCalledExactlyOnceWith({
                anchor: {
                    capturedAtMs: 100,
                    itemId: 'row-physical',
                    itemOffsetPx: -2_196,
                    kind: 'message',
                    messageId: 'message-physical',
                },
                isPinned: false,
                offsetY: 1_280,
                shouldRestoreViewport: true,
            });

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('atomically refuses scheduled, flushed, and exit native Legend persistence when no current physical fact exists', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.listLayoutHeightRef.current = 600;
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(1_700);
            members.listDataRef.current = [
                { id: 'row-model', kind: 'message', messageId: 'message-model' },
            ] as never;
            const observeNativePhysicalViewport = vi.fn(() => ({ status: 'unavailable' }));
            members.listRef.current = {
                computeVisibleIndices: () => ({ startIndex: 0, endIndex: 0 }),
                getAbsoluteLastScrollOffset: () => 2_000,
                getLayout: () => ({ x: 0, y: 247, width: 320, height: 3_000 }),
                observeNativePhysicalViewport,
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            } as never;
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );
            const detachedState = {
                isPinned: false,
                offsetY: 1_700,
                shouldRestoreViewport: true,
            } as const;

            hook.getCurrent().schedule(detachedState);
            await vi.advanceTimersByTimeAsync(200);
            expect(members.emitViewportChange).not.toHaveBeenCalled();

            hook.getCurrent().schedule(detachedState);
            hook.getCurrent().flush();
            expect(members.emitViewportChange).not.toHaveBeenCalled();

            expect(hook.getCurrent().captureAtExit({ deferEmit: false })).toBeNull();
            expect(members.emitViewportChange).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('drops a delayed native physical completion after the renderer ref remounts', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.listLayoutHeightRef.current = 600;
            members.listDataRef.current = [
                { id: 'row-physical', kind: 'message', messageId: 'message-physical' },
            ] as never;
            let completePhysicalCapture: ((capture: Readonly<{
                capturedAtMs: number;
                dataKey: string;
                itemIndex: number;
                itemKey: string;
                itemOffsetPx: number;
                offsetY: number;
            }> | null) => void) | undefined;
            const observeNativePhysicalViewport = vi.fn((request: Readonly<{
                focusOffsetPx: number;
                onComplete?: typeof completePhysicalCapture;
            }>) => {
                completePhysicalCapture = request.onComplete;
                return { cancel: vi.fn(), status: 'pending' };
            });
            const originalListRef = {
                computeVisibleIndices: () => ({ startIndex: 0, endIndex: 0 }),
                getAbsoluteLastScrollOffset: () => 2_000,
                getLayout: () => ({ x: 0, y: 247, width: 320, height: 3_000 }),
                observeNativePhysicalViewport,
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            };
            members.listRef.current = originalListRef as never;
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().schedule({
                isPinned: false,
                offsetY: 1_700,
                shouldRestoreViewport: true,
            });
            await vi.advanceTimersByTimeAsync(200);
            expect(completePhysicalCapture).toEqual(expect.any(Function));
            expect(members.emitViewportChange).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);

            members.listRef.current = {
                ...originalListRef,
                observeNativePhysicalViewport: vi.fn(() => ({ status: 'unavailable' })),
            } as never;
            completePhysicalCapture?.({
                capturedAtMs: 100,
                dataKey: 's1',
                itemIndex: 0,
                itemKey: 'row-physical',
                itemOffsetPx: -2_196,
                offsetY: 1_280,
            });

            expect(members.emitViewportChange).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('cancels pending physical capture while the app or renderer owns entry positioning, then captures after both settle', async () => {
        const originalPlatformOS = Platform.OS;
        const appStateBoundary = createReactNativeAppStateEmitter();
        const restoreAppState = appStateBoundary.install(AppState);
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            const controller = createTranscriptViewportCommandController();
            let rendererEntryPlacementActive = true;
            controller.resetForSession({ openEntryTransaction: true, sessionId: 's1' });
            members.isEntryViewportCommandActive = vi.fn(
                () => controller.activeOwner() === 'entry',
            );
            members.cancelScheduledViewportAnchorCapture.mockImplementation(() => {
                const scheduled = members.scheduledViewportAnchorCaptureRef.current as
                    AnchorCaptureHostDeps['scheduledViewportAnchorCaptureRef']['current'];
                if (!scheduled) return;
                members.scheduledViewportAnchorCaptureRef.current = null;
                clearTimeout(scheduled.timeoutId);
            });
            members.listLayoutHeightRef.current = 600;
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(800);
            members.listDataRef.current = [
                { id: 'row-entry-estimate', kind: 'message', messageId: 'message-entry-estimate' },
            ] as never;
            members.listRef.current = {
                transcriptViewportCommandSpace: 'standard',
                computeVisibleIndices: () => ({ startIndex: 0, endIndex: 0 }),
                getAbsoluteLastScrollOffset: () => 1_000,
                getLayout: () => ({ x: 0, y: 900, width: 320, height: 1_000 }),
                hasActiveEntryPlacement: () => rendererEntryPlacementActive,
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            } as never;
            const durableViewport = {
                anchor: {
                    capturedAtMs: 1,
                    itemId: 'row-durable',
                    itemOffsetPx: 24,
                    kind: 'message' as const,
                    messageId: 'message-durable',
                },
                isPinned: false,
                offsetY: 1_600,
                shouldRestoreViewport: true,
            };
            let persistedViewport = durableViewport;
            members.emitViewportChange.mockImplementation((state) => {
                persistedViewport = state as typeof durableViewport;
            });

            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => {
                    const captureAtExitRef = React.useRef<
                        (options?: Readonly<{ deferEmit?: boolean }>) => void
                    >(() => {});
                    const exitCurrentSession = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
                        captureAtExitRef.current(options);
                    }, []);
                    useTranscriptSessionExitHandoff({
                        commitSessionId: () => {},
                        exitCurrentSession,
                        sessionId: deps.currentSessionIdRef.current,
                    });
                    const host = useTranscriptViewportAnchorCaptureHost(deps);
                    React.useLayoutEffect(() => {
                        captureAtExitRef.current = host.captureAtExit;
                    }, [host.captureAtExit]);
                    return host;
                },
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().schedule({
                isPinned: false,
                offsetY: 400,
                shouldRestoreViewport: true,
            });
            await React.act(async () => {
                appStateBoundary.emit('inactive');
                appStateBoundary.emit('background');
            });
            vi.advanceTimersByTime(1_000);

            expect(controller.activeOwner()).toBe('entry');
            expect(members.cancelScheduledViewportAnchorCapture).toHaveBeenCalled();
            expect(members.emitViewportChange).not.toHaveBeenCalled();
            expect(persistedViewport).toBe(durableViewport);

            controller.closeTransaction('entry', 'confirmed');
            await React.act(async () => {
                appStateBoundary.emit('active');
                appStateBoundary.emit('background');
            });

            expect(controller.activeOwner()).toBe('follow');
            expect(members.emitViewportChange).not.toHaveBeenCalled();
            expect(persistedViewport).toBe(durableViewport);

            rendererEntryPlacementActive = false;
            await React.act(async () => {
                appStateBoundary.emit('active');
                appStateBoundary.emit('background');
            });

            expect(members.emitViewportChange).toHaveBeenCalledExactlyOnceWith({
                anchor: {
                    capturedAtMs: expect.any(Number),
                    itemId: 'row-entry-estimate',
                    itemOffsetPx: -100,
                    kind: 'message',
                    messageId: 'message-entry-estimate',
                },
                isPinned: false,
                offsetY: 800,
                shouldRestoreViewport: true,
            });
            expect(persistedViewport).not.toBe(durableViewport);

            await hook.unmount();
        } finally {
            restoreAppState();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('publishes native live-tail deletion state on background before a pending detached capture fires', async () => {
        const originalPlatformOS = Platform.OS;
        const appStateBoundary = createReactNativeAppStateEmitter();
        const restoreAppState = appStateBoundary.install(AppState);
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.wantsPinnedRef.current = true;
            members.listLayoutHeightRef.current = 600;
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(50);
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => {
                    const captureAtExitRef = React.useRef<
                        (options?: Readonly<{ deferEmit?: boolean }>) => void
                    >(() => {});
                    const exitCurrentSession = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
                        captureAtExitRef.current(options);
                    }, []);
                    useTranscriptSessionExitHandoff({
                        commitSessionId: () => {},
                        exitCurrentSession,
                        sessionId: deps.currentSessionIdRef.current,
                    });
                    const host = useTranscriptViewportAnchorCaptureHost(deps);
                    React.useLayoutEffect(() => {
                        captureAtExitRef.current = host.captureAtExit;
                    }, [host.captureAtExit]);
                    return host;
                },
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().schedule({
                isPinned: false,
                offsetY: 373,
                shouldRestoreViewport: true,
            });
            await React.act(async () => {
                appStateBoundary.emit('background');
            });

            expect(members.emitViewportChange).toHaveBeenCalledExactlyOnceWith({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            });

            await hook.unmount();
            expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
        } finally {
            restoreAppState();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('publishes live-tail deletion state on pagehide before a pending detached capture fires', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            await withBrowserLifecycleBoundary(async (dispatch) => {
                const members = createMembers();
                members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({
                    clientHeight: 600,
                    scrollHeight: 4_000,
                    scrollTop: 3_350,
                }));
                const hook = await renderHook(
                    (deps: AnchorCaptureHostDeps) => {
                        const captureAtExitRef = React.useRef<
                            (options?: Readonly<{ deferEmit?: boolean }>) => void
                        >(() => {});
                        const exitCurrentSession = React.useCallback((options?: Readonly<{ deferEmit?: boolean }>) => {
                            captureAtExitRef.current(options);
                        }, []);
                        const commitSessionId = React.useCallback(() => {}, []);
                        useTranscriptSessionExitHandoff({
                            commitSessionId,
                            exitCurrentSession,
                            sessionId: deps.currentSessionIdRef.current,
                        });
                        const host = useTranscriptViewportAnchorCaptureHost(deps);
                        React.useLayoutEffect(() => {
                            captureAtExitRef.current = host.captureAtExit;
                        }, [host.captureAtExit]);
                        return host;
                    },
                    { initialProps: buildDeps(members) },
                );

                hook.getCurrent().schedule({
                    isPinned: false,
                    offsetY: 373,
                    shouldRestoreViewport: true,
                });
                await React.act(async () => {
                    dispatch('pagehide');
                });

                expect(members.emitViewportChange).toHaveBeenCalledExactlyOnceWith({
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                });

                await hook.unmount();
            });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('drops a scheduled capture whose debounce fires after the user re-pinned at the tail (S-G)', async () => {
        // Live S-G write attribution (2026-07-11, SGM lane): during a wheel-down descent to
        // the bottom, detached-input captures kept being (re)scheduled with descent-time
        // offsets. The user reached the tail (live-tail intent deleted the persisted record),
        // and THEN the pending debounce fired with its schedule-time wantsPinned=false,
        // re-writing a stale detached record {anchor:null, offsetY:<mid-descent>} that the
        // next session entry restored. Fire-time truth must win: a live wantsPinned viewport
        // never persists a detached capture.
        const members = createMembers();
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();

        members.wantsPinnedRef.current = false;
        host.schedule({ isPinned: false, offsetY: 585, shouldRestoreViewport: true });
        vi.advanceTimersByTime(100);

        // The user reaches the tail; the semantic owner flips live-tail intent on.
        members.wantsPinnedRef.current = true;
        vi.advanceTimersByTime(300);
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('drops a pending capture at flush/exit when the viewport re-pinned meanwhile (S-G)', async () => {
        const members = createMembers();
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();

        members.wantsPinnedRef.current = false;
        host.schedule({ isPinned: false, offsetY: 373, shouldRestoreViewport: true });
        members.wantsPinnedRef.current = true;
        host.flush();
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        host.schedule({ isPinned: false, offsetY: 373, shouldRestoreViewport: true });
        members.wantsPinnedRef.current = true;
        host.captureAtExit({ deferEmit: false });
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('retries an empty debounced capture and then emits with the anchor field omitted', async () => {
        // Live clamp-to-tail capture (2026-07-13, streaming session): the debounced
        // capture fired mid row-measurement churn, came back EMPTY, and emitted
        // `anchor: null` — clearing any previously persisted identity and leaving the
        // session with a px-only distance record that estimate churn cannot restore.
        // An empty capture must (1) retry within the debounce cadence so a quiescent
        // gap can still produce an identity, and (2) when retries exhaust, emit with
        // the anchor OMITTED (additive persistence, same convention as captureAtExit).
        const members = createMembers();
        // Native churn shape: visible indices + scroll offset resolve, but no row has a
        // measurable layout yet ('no_measurable_items' — the retry-worthy failure).
        const getAbsoluteLastScrollOffset = vi.fn(() => 500);
        members.listDataRef = createRef([
            { id: 'msg:a', kind: 'message', messageId: 'a' },
            { id: 'msg:b', kind: 'message', messageId: 'b' },
        ] as never);
        members.listRef = createRef({
            computeVisibleIndices: () => ({ startIndex: 0, endIndex: 1 }),
            getAbsoluteLastScrollOffset,
            getLayout: () => undefined,
        } as never);
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();

        host.schedule({ isPinned: false, offsetY: 1_234, shouldRestoreViewport: true });
        // First fire: empty capture → retry re-arms instead of emitting.
        vi.advanceTimersByTime(250);
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        // Retries exhaust on the debounce cadence; the offset truth still persists.
        vi.advanceTimersByTime(1_000);
        expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
        expect(members.emitViewportChange).toHaveBeenCalledWith(expect.objectContaining({
            isPinned: false,
            offsetY: 1_234,
            shouldRestoreViewport: true,
        }));
        const emitted = members.emitViewportChange.mock.calls[0][0] as Record<string, unknown>;
        expect('anchor' in emitted).toBe(false);
        // The capture genuinely re-read geometry on each retry.
        expect(getAbsoluteLastScrollOffset.mock.calls.length).toBeGreaterThanOrEqual(2);

        await hook.unmount();
    });

    it('flush emits an empty capture immediately with the anchor field omitted (exit is final)', async () => {
        const members = createMembers();
        members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({ scrollTop: 500, scrollHeight: 4_000, clientHeight: 600 }));
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        const host = hook.getCurrent();

        host.schedule({ isPinned: false, offsetY: 987, shouldRestoreViewport: true });
        host.flush();
        expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
        const emitted = members.emitViewportChange.mock.calls[0][0] as Record<string, unknown>;
        expect(emitted.offsetY).toBe(987);
        expect('anchor' in emitted).toBe(false);

        await hook.unmount();
    });

    it('is a no-op without a scheduled capture', async () => {
        const members = createMembers();
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        hook.getCurrent().defer();
        vi.advanceTimersByTime(500);
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('captures the detached truth at session exit when no capture is pending', async () => {
        // Live A->B->A RED (2026-07-11): the web genuineness classifier sometimes never
        // produced a qualifying detach observation, so nothing was ever scheduled and the
        // session left with NO persisted anchor/offset. The exit is the canonical persistence
        // choke point: a measurably detached session leaving the screen persists its truth.
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const members = createMembers();
            members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({ scrollTop: 500, scrollHeight: 4_000, clientHeight: 600 }));
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );
            members.wantsPinnedRef.current = false;
            hook.getCurrent().captureAtExit({ deferEmit: false });
            expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
            expect(members.emitViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                isPinned: false,
                offsetY: 2_900,
                shouldRestoreViewport: true,
            }));
            // No anchor resolved from the fake DOM: the anchor field must be OMITTED, never null,
            // so a previously persisted identity is preserved.
            const emitted = members.emitViewportChange.mock.calls[0][0] as Record<string, unknown>;
            expect('anchor' in emitted).toBe(false);

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('preserves a renderer-owned web tail when teardown geometry is transiently displaced', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const members = createMembers();
            members.wantsPinnedRef.current = true;
            members.listRef.current = {
                hasLiveWebHold: (target: Readonly<{ kind: 'end' | 'item' }>) => target.kind === 'end',
            } as never;
            members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({
                clientHeight: 600,
                scrollHeight: 4_000,
                scrollTop: 1_174,
            }));
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            const selection = hook.getCurrent().captureAtExit({ deferEmit: false });

            expect(selection).toEqual({
                source: 'physical-exit',
                viewport: {
                    anchor: null,
                    capturedAtMs: expect.any(Number),
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            });
            expect(members.emitViewportChange).toHaveBeenCalledExactlyOnceWith({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            });
            expect(members.recordViewportTelemetryEvent).not.toHaveBeenCalledWith(
                expect.objectContaining({ reason: 'anchor-captured' }),
                expect.anything(),
            );

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('preserves a renderer-owned keyed anchor instead of persisting teardown geometry', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const members = createMembers();
            members.wantsPinnedRef.current = false;
            members.listRef.current = {
                hasLiveWebHold: (target: Readonly<{ kind: 'end' | 'item' }>) => target.kind === 'item',
            } as never;
            members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({
                clientHeight: 600,
                scrollHeight: 4_000,
                scrollTop: 0,
            }));
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            expect(hook.getCurrent().captureAtExit({ deferEmit: false })).toBeNull();
            expect(members.cancelScheduledViewportAnchorCapture).toHaveBeenCalled();
            expect(members.resolveWebScrollMetrics).not.toHaveBeenCalled();
            expect(members.emitViewportChange).not.toHaveBeenCalled();

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('captures native detached identity and within-row offset at exit despite stale live-tail intent', async () => {
        // Live iOS A->B->A RED (2026-07-24): after an explicit jump-to-bottom, a trusted
        // far-up swipe left Legend visibly detached for 10s, but the earlier tail intent
        // remained the durable entry fallback. Native exit currently ignores the still-live
        // standard-space Legend geometry unless a debounced capture happens to be pending.
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.wantsPinnedRef.current = true;
            members.listLayoutHeightRef.current = 600;
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(800);
            members.listDataRef.current = [
                { id: 'row-before', kind: 'message', messageId: 'message-before' },
                { id: 'row-focus', kind: 'message', messageId: 'message-focus' },
                { id: 'row-after', kind: 'message', messageId: 'message-after' },
            ] as never;
            members.listRef.current = {
                transcriptViewportCommandSpace: 'standard',
                computeVisibleIndices: () => ({ startIndex: 1, endIndex: 1 }),
                getAbsoluteLastScrollOffset: () => 1_000,
                getLayout: (index: number) => index === 1
                    ? { x: 0, y: 900, width: 320, height: 1_000 }
                    : undefined,
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            } as never;
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().captureAtExit({ deferEmit: false });

            expect(members.emitViewportChange).toHaveBeenCalledTimes(1);
            expect(members.emitViewportChange).toHaveBeenCalledWith({
                anchor: {
                    capturedAtMs: expect.any(Number),
                    itemId: 'row-focus',
                    itemOffsetPx: -100,
                    kind: 'message',
                    messageId: 'message-focus',
                },
                isPinned: false,
                offsetY: 800,
                shouldRestoreViewport: true,
            });

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('captures the native exit snapshot before the renderer ref detaches', async () => {
        // React detaches the native renderer during layout unmount, before passive cleanup.
        // Capturing from a passive effect therefore cannot observe the fire-time Legend
        // geometry even though it was authoritative at the start of the exit.
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.wantsPinnedRef.current = false;
            members.listLayoutHeightRef.current = 600;
            members.listDataRef.current = [
                { id: 'row-focus', kind: 'message', messageId: 'message-focus' },
            ] as never;
            members.listRef.current = {
                transcriptViewportCommandSpace: 'standard',
                computeVisibleIndices: () => ({ startIndex: 0, endIndex: 0 }),
                getAbsoluteLastScrollOffset: () => 1_000,
                getLayout: () => ({ x: 0, y: 900, width: 320, height: 1_000 }),
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            } as never;
            members.readCurrentNativeDistanceFromBottom.mockImplementation(() => (
                members.listRef.current === null ? null : 800
            ));
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => {
                    const captureAtExitRef = React.useRef<(options?: Readonly<{ deferEmit?: boolean }>) => void>(() => {});
                    const exitCurrentSession = React.useCallback(() => {
                        captureAtExitRef.current({ deferEmit: true });
                    }, []);
                    const commitSessionId = React.useCallback(() => {}, []);
                    useTranscriptSessionExitHandoff({
                        commitSessionId,
                        exitCurrentSession,
                        sessionId: deps.currentSessionIdRef.current,
                    });
                    const host = useTranscriptViewportAnchorCaptureHost(deps);
                    React.useLayoutEffect(() => {
                        captureAtExitRef.current = host.captureAtExit;
                    }, [host.captureAtExit]);
                    React.useLayoutEffect(() => () => {
                        deps.listRef.current = null;
                    }, [deps.listRef]);
                    return host;
                },
                { initialProps: buildDeps(members) },
            );

            await hook.unmount();
            await Promise.resolve();

            expect(members.emitViewportChange).toHaveBeenCalledWith({
                anchor: expect.objectContaining({
                    itemId: 'row-focus',
                    itemOffsetPx: -100,
                    messageId: 'message-focus',
                }),
                isPinned: false,
                offsetY: 800,
                shouldRestoreViewport: true,
            });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('uses the canonical native pin threshold for a shallow stale-intent detach at exit', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.wantsPinnedRef.current = true;
            members.listLayoutHeightRef.current = 600;
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(100);
            members.listDataRef.current = [
                { id: 'row-focus', kind: 'message', messageId: 'message-focus' },
            ] as never;
            members.listRef.current = {
                transcriptViewportCommandSpace: 'standard',
                computeVisibleIndices: () => ({ startIndex: 0, endIndex: 0 }),
                getAbsoluteLastScrollOffset: () => 1_000,
                getLayout: () => ({ x: 0, y: 900, width: 320, height: 1_000 }),
                scrollToIndex: vi.fn(),
                scrollToOffset: vi.fn(),
            } as never;
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().captureAtExit({ deferEmit: false });

            expect(members.emitViewportChange).toHaveBeenCalledWith(expect.objectContaining({
                anchor: expect.objectContaining({ itemId: 'row-focus', itemOffsetPx: -100 }),
                isPinned: false,
                offsetY: 100,
                shouldRestoreViewport: true,
            }));
            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('uses the canonical web pin threshold for a shallow stale-intent detach at exit', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const members = createMembers();
            members.wantsPinnedRef.current = true;
            members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({
                clientHeight: 600,
                scrollHeight: 1_000,
                scrollTop: 300,
            }));
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().captureAtExit({ deferEmit: false });

            expect(members.emitViewportChange).toHaveBeenCalledWith({
                isPinned: false,
                offsetY: 100,
                shouldRestoreViewport: true,
            });
            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('preserves durable state without web geometry and publishes live-tail state within the pin threshold', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const members = createMembers();
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );
            // No metrics at teardown: nothing trustworthy to persist.
            members.wantsPinnedRef.current = false;
            hook.getCurrent().captureAtExit({ deferEmit: false });
            expect(members.emitViewportChange).not.toHaveBeenCalled();

            // Fire-time geometry owns the exit. Within 72px, publish live-tail state even
            // when the semantic intent was stale.
            members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({
                scrollTop: 3_350,
                scrollHeight: 4_000,
                clientHeight: 600,
            }));
            await hook.rerender(buildDeps(members));
            members.wantsPinnedRef.current = true;
            hook.getCurrent().captureAtExit({ deferEmit: false });
            expect(members.emitViewportChange).toHaveBeenCalledWith({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            });

            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('cancels a pending capture and preserves durable state when exit geometry is unavailable', async () => {
        const members = createMembers();
        const hook = await renderHook(
            (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
            { initialProps: buildDeps(members) },
        );
        members.wantsPinnedRef.current = false;
        const host = hook.getCurrent();
        host.schedule({ isPinned: false, offsetY: 777, shouldRestoreViewport: true });
        host.captureAtExit({ deferEmit: false });
        expect(members.cancelScheduledViewportAnchorCapture).toHaveBeenCalled();
        expect(members.emitViewportChange).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('preserves durable state when native exit geometry is non-finite', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        try {
            const members = createMembers();
            members.readCurrentNativeDistanceFromBottom.mockReturnValue(Number.NaN);
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            hook.getCurrent().captureAtExit({ deferEmit: false });

            expect(members.cancelScheduledViewportAnchorCapture).toHaveBeenCalledTimes(1);
            expect(members.emitViewportChange).not.toHaveBeenCalled();
            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('returns the coherent tail snapshot selected from the same fire-time geometry it emits', async () => {
        const originalPlatformOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        vi.setSystemTime(new Date(300));
        try {
            const members = createMembers();
            members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({
                clientHeight: 600,
                scrollHeight: 4_000,
                scrollTop: 3_350,
            }));
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            expect(hook.getCurrent().captureAtExit({ deferEmit: false })).toEqual({
                source: 'physical-exit',
                viewport: {
                    anchor: null,
                    capturedAtMs: 300,
                    isPinned: true,
                    offsetY: 0,
                    shouldRestoreViewport: false,
                },
            });
            expect(members.emitViewportChange).toHaveBeenCalledWith({
                isPinned: true,
                offsetY: 0,
                shouldRestoreViewport: false,
            });
            await hook.unmount();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });

    it('returns a coherent anchored snapshot, but no handoff when detached geometry has no identity', async () => {
        const originalPlatformOS = Platform.OS;
        const globalWithHTMLElement = globalThis as unknown as Record<'HTMLElement', unknown>;
        const originalHTMLElement = globalWithHTMLElement.HTMLElement;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        globalWithHTMLElement.HTMLElement = FakeAnchorElement;
        vi.setSystemTime(new Date(400));
        try {
            const members = createMembers();
            members.resolveWebScrollMetrics = vi.fn(() => createWebCaptureMetrics({
                clientHeight: 600,
                itemId: 'm2',
                itemTop: 55,
                messageId: 'm2',
                scrollHeight: 4_000,
                scrollTop: 500,
            }));
            const hook = await renderHook(
                (deps: AnchorCaptureHostDeps) => useTranscriptViewportAnchorCaptureHost(deps),
                { initialProps: buildDeps(members) },
            );

            expect(hook.getCurrent().captureAtExit({ deferEmit: false })).toEqual({
                source: 'physical-exit',
                viewport: {
                    anchor: {
                        capturedAtMs: 400,
                        itemId: 'm2',
                        itemOffsetPx: 55,
                        kind: 'message',
                        messageId: 'm2',
                    },
                    capturedAtMs: 400,
                    isPinned: false,
                    offsetY: 2_900,
                    shouldRestoreViewport: true,
                },
            });

            members.emitViewportChange.mockClear();
            members.resolveWebScrollMetrics = vi.fn(() => createFakeExitMetrics({
                clientHeight: 600,
                scrollHeight: 4_000,
                scrollTop: 500,
            }));
            await hook.rerender(buildDeps(members));
            expect(hook.getCurrent().captureAtExit({ deferEmit: false })).toBeNull();
            expect(members.emitViewportChange).toHaveBeenCalledWith({
                isPinned: false,
                offsetY: 2_900,
                shouldRestoreViewport: true,
            });

            await hook.unmount();
        } finally {
            globalWithHTMLElement.HTMLElement = originalHTMLElement;
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatformOS });
        }
    });
});

describe('resolveDetachedInputAnchorCaptureState', () => {
    it('produces a detached capture state from live geometry beyond the pin threshold', async () => {
        const { resolveDetachedInputAnchorCaptureState } = await import('./useTranscriptViewportAnchorCaptureHost');
        expect(resolveDetachedInputAnchorCaptureState(
            createFakeExitMetrics({ scrollTop: 500, scrollHeight: 4_000, clientHeight: 600 }),
            120,
        )).toEqual({ isPinned: false, offsetY: 2_900, shouldRestoreViewport: true });
    });

    it('yields nothing near the tail or without live geometry', async () => {
        const { resolveDetachedInputAnchorCaptureState } = await import('./useTranscriptViewportAnchorCaptureHost');
        expect(resolveDetachedInputAnchorCaptureState(
            createFakeExitMetrics({ scrollTop: 3_350, scrollHeight: 4_000, clientHeight: 600 }),
            120,
        )).toBeNull();
        expect(resolveDetachedInputAnchorCaptureState(null, 120)).toBeNull();
    });
});

import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFlashListChatListHarness } from '@/dev/testkit';
import type {
    LastNativeRestoreIndexCommand,
    ScrollableChatListRef,
} from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptViewportCommand } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    createWebDomScrollObservation,
    type WebDomScrollObservation,
} from './driver/webDomObservation';

/**
 * Focused, deps-mocked unit test for the transcript command writer — the ONE place that issues raw
 * scroll writes (web DOM `scrollTop`; native `scrollToEnd`/`scrollToOffset`/`scrollToIndex`). The host
 * `Platform.OS` is the only `react-native` member the writer reads; we drive it through the CANONICAL
 * testkit lever (`resetFlashListChatListHarness({ platformOs })`) via `setPlatform`, which both resets the
 * harness and mirrors the chosen OS into the hoisted Platform mock holder (the same hoisted-holder pattern
 * the sibling `ChatList.flashListV2Inverted` suite uses). No component render — the deps bundle stands in
 * for the host bindings, so we can assert the EXACT raw write the node received and the boolean return for
 * both platforms.
 */

const platformMockState = vi.hoisted(() => ({ os: 'ios' as 'web' | 'ios' }));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return platformMockState.os;
        },
        select: (values: Record<string, unknown>) =>
            values?.[platformMockState.os] ?? values?.default,
    },
}));

const { performTranscriptViewportCommand } = await import(
    '@/components/sessions/transcript/viewport/performTranscriptViewportCommand'
);
const { performWebDomPrependAnchorRestoreCommand } = await import(
    '@/components/sessions/transcript/viewport/driver/webDom'
);

/** Canonical testkit lever: reset the harness AND mirror the chosen OS into the hoisted Platform mock. */
function setPlatform(platformOs: 'web' | 'ios'): void {
    resetFlashListChatListHarness({ platformOs });
    platformMockState.os = platformOs;
}

type DepsType = Parameters<typeof performTranscriptViewportCommand>[1];

// --- fakes ----------------------------------------------------------------

type ScrollToIndexCall = { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number };
type ScrollToOffsetCall = { offset: number; animated?: boolean };
type ScrollToEndCall = { animated?: boolean } | undefined;

type FakeScrollNode = ScrollableChatListRef & {
    indexCalls: ScrollToIndexCall[];
    offsetCalls: ScrollToOffsetCall[];
    endCalls: ScrollToEndCall[];
    transcriptViewportCommandSpace?: 'standard' | 'native-inverted';
};

function createFakeScrollNode(
    options: Readonly<{
        getLayout?: NonNullable<ScrollableChatListRef['getLayout']>;
        transcriptViewportCommandSpace?: 'standard' | 'native-inverted';
        withScrollToEnd?: boolean;
        withScrollToIndex?: boolean;
        withScrollToOffset?: boolean;
    }> = {},
): FakeScrollNode {
    const indexCalls: ScrollToIndexCall[] = [];
    const offsetCalls: ScrollToOffsetCall[] = [];
    const endCalls: ScrollToEndCall[] = [];
    const node = {
        indexCalls,
        offsetCalls,
        endCalls,
        transcriptViewportCommandSpace: options.transcriptViewportCommandSpace,
    } as FakeScrollNode;
    if (options.withScrollToIndex !== false) {
        (node as { scrollToIndex: ScrollableChatListRef['scrollToIndex'] }).scrollToIndex = (params) => {
            indexCalls.push(params);
        };
    }
    if (options.withScrollToOffset !== false) {
        (node as { scrollToOffset: ScrollableChatListRef['scrollToOffset'] }).scrollToOffset = (params) => {
            offsetCalls.push(params);
        };
    }
    if (options.withScrollToEnd) {
        (node as { scrollToEnd?: NonNullable<ScrollableChatListRef['scrollToEnd']> }).scrollToEnd = (params) => {
            endCalls.push(params);
        };
    }
    if (options.getLayout) {
        (node as { getLayout: NonNullable<ScrollableChatListRef['getLayout']> }).getLayout = options.getLayout;
    }
    return node;
}

type WebElementWithLanding = WebTranscriptScrollMetrics['element'] & {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
};

type FakeWebAnchor = Readonly<{
    bottom: number;
    testId: string;
    top: number;
}>;

const TestHTMLElement = (globalThis.HTMLElement ?? class TestHTMLElement {}) as typeof HTMLElement;
if (globalThis.HTMLElement == null) {
    Object.defineProperty(globalThis, 'HTMLElement', {
        configurable: true,
        value: TestHTMLElement,
        writable: true,
    });
}

function createFakeHTMLElement<T extends object>(shape: T): T {
    const element = Object.create(TestHTMLElement.prototype) as T;
    Object.defineProperties(element, Object.getOwnPropertyDescriptors(shape));
    return element;
}

/**
 * A controllable fake scroller. `scrollTop` clamps to [0, scrollHeight - clientHeight] (mirrors the
 * harness DOM scroller + real browsers under-shooting), so the LANDED scrollTop the writer reads back
 * reflects clamped reality, not the requested target.
 */
function createFakeWebScrollMetrics(
    options: Readonly<{
        anchors?: readonly FakeWebAnchor[];
        scrollTop?: number;
        scrollHeight?: number;
        clientHeight?: number;
    }> = {},
): WebTranscriptScrollMetrics {
    const scrollHeight = options.scrollHeight ?? 1000;
    const clientHeight = options.clientHeight ?? 400;
    const anchors = options.anchors ?? [];
    let scrollTopValue = 0;
    const element = createFakeHTMLElement({
        scrollHeight,
        clientHeight,
        get scrollTop() {
            return scrollTopValue;
        },
        set scrollTop(value: number) {
            const max = Math.max(0, scrollHeight - clientHeight);
            scrollTopValue = Math.max(0, Math.min(value, max));
        },
        getBoundingClientRect() {
            return { top: 0, bottom: clientHeight, height: clientHeight };
        },
        querySelectorAll(selector: string) {
            if (selector !== '[data-testid]') return [];
            return anchors.map((anchor) => createFakeHTMLElement({
                getAttribute(name: string) {
                    return name === 'data-testid' ? anchor.testId : null;
                },
                getBoundingClientRect() {
                    return {
                        top: anchor.top,
                        bottom: anchor.bottom,
                        height: Math.max(0, anchor.bottom - anchor.top),
                    };
                },
            }));
        },
    } as unknown as WebElementWithLanding);
    element.scrollTop = options.scrollTop ?? 0;
    return {
        element: element as WebTranscriptScrollMetrics['element'],
        get scrollTop() {
            return element.scrollTop;
        },
        scrollHeight,
        clientHeight,
    } as WebTranscriptScrollMetrics;
}

type RecordedTelemetry = Record<string, unknown> & { type: string; writer?: unknown; mode: unknown };

type DepsOverrides = {
    node?: FakeScrollNode | null;
    webMetrics?: WebTranscriptScrollMetrics | null;
    listContentHeight?: number;
    listLayoutHeight?: number;
    listDataLength?: number;
    listData?: readonly { readonly id: string }[];
    items?: readonly { readonly id: string }[];
    itemsLength?: number;
    composerInsetHeight?: number;
    nativeHotTailHeight?: number;
    shouldUseWebHotColdSplit?: boolean;
    shouldUseNativeHotColdSplit?: boolean;
    coldItemCount?: number;
    resolveRestoreAnchorIndex?: (anchor: { kind: 'message' | 'toolGroup' | 'item'; itemId: string; messageId?: string | null }) => number | null;
    telemetryPlatform?: 'web' | 'ios' | 'android' | 'native-other';
    resolveJumpToSeqIndex?: (seq: number) => number | null;
};

type DepsBundle = {
    deps: DepsType;
    recorded: RecordedTelemetry[];
    restoreDecisions: Array<{ reason: string; params?: unknown }>;
    lastNativeRestoreIndexCommandRef: MutableRefObject<LastNativeRestoreIndexCommand | null>;
    webDomObservation: WebDomScrollObservation;
    clearWebPrependRangeReserve: ReturnType<typeof vi.fn>;
};

function makeRef<T>(value: T): MutableRefObject<T> {
    return { current: value };
}

function buildDeps(overrides: DepsOverrides = {}): DepsBundle {
    const recorded: RecordedTelemetry[] = [];
    const restoreDecisions: Array<{ reason: string; params?: unknown }> = [];
    const lastNativeRestoreIndexCommandRef = makeRef<LastNativeRestoreIndexCommand | null>(null);
    const webDomObservation = createWebDomScrollObservation();
    const clearWebPrependRangeReserve = vi.fn();

    const deps: DepsType = {
        listRef: { current: overrides.node ?? null },
        listContentHeightRef: { current: overrides.listContentHeight ?? 1000 },
        listLayoutHeightRef: { current: overrides.listLayoutHeight ?? 400 },
        listDataRef: { current: overrides.listData ?? { length: overrides.listDataLength ?? 5 } },
        itemsRef: { current: overrides.items ?? { length: overrides.itemsLength ?? 5 } },
        composerInsetHeightRef: { current: overrides.composerInsetHeight ?? 0 },
        nativeHotTailHeightRef: { current: overrides.nativeHotTailHeight ?? 0 },
        lastPinOffsetForIntentRef: { current: null },
        lastNativePinOffsetRef: { current: null },
        webDomObservation,
        lastNativeRestoreIndexCommandRef,
        nativeMountSettleStable: true,
        telemetryPlatform: overrides.telemetryPlatform ?? 'ios',
        shouldUseNativeHotColdSplit: overrides.shouldUseNativeHotColdSplit ?? false,
        webHotColdCountsRef: {
            current: {
                coldCount: overrides.coldItemCount ?? 0,
                hotCount: (overrides.shouldUseWebHotColdSplit ?? false) ? 1 : 0,
            },
        },
        clearWebPrependRangeReserve,
        resolveWebScrollMetrics: () => overrides.webMetrics ?? null,
        resolveRestoreAnchorIndex: overrides.resolveRestoreAnchorIndex ?? (() => null),
        resolveJumpToSeqIndex: overrides.resolveJumpToSeqIndex ?? (() => null),
        recordViewportTelemetryEvent: (event) => {
            recorded.push(event as RecordedTelemetry);
        },
        recordRestoreDecisionTelemetry: (reason, params) => {
            restoreDecisions.push({ reason, params });
        },
        resolveWebViewportTelemetryDiagnostics: () => ({ diag: true }),
        resolveInvertedBottomPinCarveTelemetryFields: () => ({ carve: true }),
    };

    return {
        deps,
        recorded,
        restoreDecisions,
        lastNativeRestoreIndexCommandRef,
        webDomObservation,
        clearWebPrependRangeReserve,
    };
}

function lastWrite(recorded: RecordedTelemetry[]): RecordedTelemetry {
    const writes = recorded.filter((event) => event.type === 'scroll-write');
    return writes[writes.length - 1];
}

const BASE_SESSION = 'session-1';
const RESTORE_ANCHOR = { kind: 'message' as const, itemId: 'row-2', messageId: 'message-2' };

afterEach(() => {
    vi.clearAllMocks();
});

describe('performTranscriptViewportCommand', () => {
    describe('skip-native-js-pin', () => {
        beforeEach(() => setPlatform('ios'));

        it('records an mvcp-skip scroll-write and returns true without touching the node', () => {
            const bundle = buildDeps({ node: createFakeScrollNode() });
            const command = {
                kind: 'skip-native-js-pin',
                sessionId: BASE_SESSION,
                reason: 'content-size-change',
                skipReason: 'mvcp-only',
                mode: 'follow-bottom',
            } satisfies TranscriptViewportCommand;

            const result = performTranscriptViewportCommand(command, bundle.deps);

            expect(result).toBe(true);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('mvcp-skip');
            expect(write.reason).toBe('content-size-change');
            const node = bundle.deps.listRef.current as FakeScrollNode;
            expect(node.indexCalls).toHaveLength(0);
            expect(node.offsetCalls).toHaveLength(0);
        });
    });

    describe('pin-bottom — web', () => {
        beforeEach(() => setPlatform('web'));

        it('writes the visual bottom scrollTop (scrollHeight) and returns true', () => {
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 10 });
            const bundle = buildDeps({ webMetrics: metrics });
            const command = {
                kind: 'pin-bottom',
                sessionId: BASE_SESSION,
                reason: 'content-size-change',
                mode: 'follow-bottom',
            } satisfies TranscriptViewportCommand;

            const result = performTranscriptViewportCommand(command, bundle.deps);

            expect(result).toBe(true);
            // Visual bottom for a non-legacy list = max scrollTop (scrollHeight - clientHeight = 600).
            expect(metrics.element.scrollTop).toBe(600);
            // The write+observe primitive records the LANDED value into the observation refs.
            expect(bundle.webDomObservation.getState()).toMatchObject({
                observedScrollHeight: 1000,
                observedScrollTop: 600,
            });
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-bottom');
            expect(write.targetOffsetY).toBe(600);
            expect(bundle.clearWebPrependRangeReserve).toHaveBeenCalledTimes(1);
        });

        it('returns false when no web metrics are resolvable', () => {
            const bundle = buildDeps({ webMetrics: null });
            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );
            expect(result).toBe(false);
            expect(bundle.recorded.filter((e) => e.type === 'scroll-write')).toHaveLength(0);
        });
    });

    describe('pin-bottom — native', () => {
        beforeEach(() => setPlatform('ios'));

        it('returns false when the node is missing', () => {
            const bundle = buildDeps({ node: null });
            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );
            expect(result).toBe(false);
        });

        it('uses the canonical inverted bottom command for native follow pins with inset', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1000,
                listLayoutHeight: 400,
                composerInsetHeight: 40,
                nativeHotTailHeight: 12,
            });
            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toEqual([{ index: 0, animated: false, viewOffset: -52 }]);
            expect(node.offsetCalls).toHaveLength(0);
            expect(node.endCalls).toHaveLength(0);
            expect(lastWrite(bundle.recorded).writer).toBe('native-scroll-to-offset');
        });

        it('uses standard native scroll space for the Legend renderer command adapter', () => {
            const node = createFakeScrollNode({
                transcriptViewportCommandSpace: 'standard',
                withScrollToEnd: true,
            });
            const bundle = buildDeps({
                node,
                listContentHeight: 1000,
                listLayoutHeight: 400,
                composerInsetHeight: 40,
                nativeHotTailHeight: 12,
            });

            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(node.endCalls).toEqual([]);
            expect(node.indexCalls).toHaveLength(0);
            expect(node.offsetCalls).toEqual([{ offset: 600, animated: false }]);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'native-scroll-to-offset',
                reason: 'content-size-change',
                mode: 'follow-bottom',
                targetOffsetY: 600,
                distanceFromBottom: 0,
            });
        });

        it('maps semantic native distance and history commands directly in standard Legend scroll space', () => {
            const node = createFakeScrollNode({ transcriptViewportCommandSpace: 'standard' });
            const bundle = buildDeps({
                node,
                listContentHeight: 1200,
                listLayoutHeight: 500,
            });

            expect(performTranscriptViewportCommand({
                kind: 'restore-distance',
                sessionId: BASE_SESSION,
                reason: 'entry-restore',
                mode: 'restore-distance',
                distanceFromLiveTailPx: 125,
                animated: false,
            }, bundle.deps)).toBe(true);
            expect(performTranscriptViewportCommand({
                kind: 'apply-history-correction',
                sessionId: BASE_SESSION,
                reason: 'prepend-restore',
                mode: 'restore-anchor',
                targetDistanceFromHistoryStartPx: 240,
                animated: true,
            }, bundle.deps)).toBe(true);
            expect(performTranscriptViewportCommand({
                kind: 'recover-jump-to-seq',
                sessionId: BASE_SESSION,
                reason: 'jump-to-seq',
                mode: 'jump-to-seq',
                failedRenderedIndex: 3,
                averageItemLengthPx: 100,
                animated: true,
            } as TranscriptViewportCommand, bundle.deps)).toBe(true);

            expect(node.offsetCalls).toEqual([
                { offset: 575, animated: false },
                { offset: 240, animated: true },
                { offset: 300, animated: true },
            ]);
            expect(bundle.recorded.filter((event) => event.type === 'scroll-write').map((event) => event.targetOffsetY))
                .toEqual([575, 240, 300]);
        });

        it('keeps standard Legend index commands in source-index space and skips FlashList hot-cold remapping', () => {
            const node = createFakeScrollNode({ transcriptViewportCommandSpace: 'standard' });
            const resolveJumpToSeqIndex = vi.fn(() => 8);
            const bundle = buildDeps({
                node,
                itemsLength: 10,
                listDataLength: 4,
                resolveJumpToSeqIndex,
                shouldUseNativeHotColdSplit: true,
            });

            const result = performTranscriptViewportCommand({
                kind: 'jump-to-seq',
                sessionId: BASE_SESSION,
                reason: 'jump-to-seq',
                mode: 'jump-to-seq',
                seq: 42,
                align: { kind: 'top-with-item-offset', itemOffsetPx: 32 },
                animated: true,
            }, bundle.deps);

            expect(result).toBe(true);
            expect(resolveJumpToSeqIndex).toHaveBeenCalledWith(42);
            expect(node.indexCalls).toEqual([{ index: 8, animated: true, viewOffset: 32 }]);
            expect(bundle.lastNativeRestoreIndexCommandRef.current).toMatchObject({
                index: 8,
                reason: 'jump-to-seq',
                sessionId: BASE_SESSION,
                viewOffset: 32,
            });
        });

        it('uses the canonical inverted bottom command for native explicit jumps', () => {
            const node = createFakeScrollNode({ withScrollToEnd: true });
            const bundle = buildDeps({
                node,
                composerInsetHeight: 18,
                nativeHotTailHeight: 6,
            });
            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'jump-to-bottom', mode: 'jump-to-bottom' },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toEqual([{ index: 0, animated: false, viewOffset: -24 }]);
            expect(node.endCalls).toHaveLength(0);
            expect(node.offsetCalls).toHaveLength(0);
            expect(lastWrite(bundle.recorded).writer).toBe('native-explicit-jump');
        });

        it('uses the canonical inverted bottom command for native automatic bottom pins', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 200,
                listLayoutHeight: 50,
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'pin-bottom',
                    sessionId: BASE_SESSION,
                    reason: 'content-size-change',
                    mode: 'follow-bottom',
                    contentHeight: 1200,
                    layoutHeight: 600,
                } satisfies TranscriptViewportCommand,
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toEqual([{ index: 0, animated: false }]);
            expect(node.offsetCalls).toHaveLength(0);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                contentHeight: 1200,
                layoutHeight: 600,
                targetOffsetY: 0,
            });
        });

        it('uses the canonical inverted bottom command for fractional content metrics', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 200,
                listLayoutHeight: 50,
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'pin-bottom',
                    sessionId: BASE_SESSION,
                    reason: 'content-size-change',
                    mode: 'follow-bottom',
                    contentHeight: 10_000.1,
                    layoutHeight: 331.9,
                } satisfies TranscriptViewportCommand,
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toEqual([{ index: 0, animated: false }]);
            expect(node.offsetCalls).toHaveLength(0);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                contentHeight: 10_000.1,
                layoutHeight: 331.9,
                targetOffsetY: 0,
            });
        });

        it('inverted bottom commands scrollToIndex(0) with viewOffset = -(composerInset + hotTail)', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                composerInsetHeight: 16,
                nativeHotTailHeight: 24,
            });
            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toEqual([{ index: 0, animated: false, viewOffset: -40 }]);
            expect(node.offsetCalls).toHaveLength(0);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('native-scroll-to-offset');
            // The inverted-bottom carve telemetry fields are merged into the write event.
            expect(write.carve).toBe(true);
        });

        it('inverted bottom with zero inset omits viewOffset', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                composerInsetHeight: 0,
                nativeHotTailHeight: 0,
            });
            performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );
            expect(node.indexCalls).toEqual([{ index: 0, animated: false }]);
        });

        it('does not use the retired standard not-ready branch for native explicit jumps', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 0,
                listLayoutHeight: 0,
                listDataLength: 3,
            });
            // Drop scrollToEnd; canonical native still uses inverted scrollToIndex(0).
            delete (node as { scrollToEnd?: unknown }).scrollToEnd;
            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'jump-to-bottom', mode: 'jump-to-bottom' },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toEqual([{ index: 0, animated: false }]);
            expect(node.offsetCalls).toHaveLength(0);
            expect(bundle.restoreDecisions).toHaveLength(0);
        });
    });

    describe('restore-distance — web', () => {
        beforeEach(() => setPlatform('web'));

        it('preserve-live-tail-distance derives the web scrollTop target inside the web driver', () => {
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 2400, clientHeight: 500, scrollTop: 1495 });
            const bundle = buildDeps({ webMetrics: metrics });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'preserve-live-tail-distance',
                    sessionId: BASE_SESSION,
                    reason: 'content-size-change',
                    mode: 'follow-bottom',
                    previousDistanceFromLiveTailPx: 10,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            // maxScrollTop (1900) - previously-held live-tail distance (10) = 1890.
            expect(metrics.element.scrollTop).toBe(1890);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-bottom');
            expect(write.reason).toBe('content-size-change');
            expect(write.mode).toBe('follow-bottom');
            expect(write.targetOffsetY).toBe(1890);
            expect(write.distanceFromBottom).toBe(10);
        });

        it('restore-distance maps distance-from-live-tail to scrollTop via max - distance (non-legacy)', () => {
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
            const bundle = buildDeps({ webMetrics: metrics });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 100,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            // maxScrollTop (600) - distanceFromBottom (100) = 500.
            expect(metrics.element.scrollTop).toBe(500);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
            expect(write.distanceFromBottom).toBe(100);
        });

        it('restore-distance treats stale web legacy input as canonical FlashList geometry', () => {
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
            const bundle = buildDeps({ webMetrics: metrics });
            performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 100,
                },
                bundle.deps,
            );
            // maxScrollTop (600) - distanceFromBottom (100) = 500.
            expect(metrics.element.scrollTop).toBe(500);
        });
    });

    describe('restore-distance — native', () => {
        beforeEach(() => setPlatform('ios'));

        it('restore-distance returns false when the node lacks scrollToOffset', () => {
            const node = createFakeScrollNode({ withScrollToOffset: false });
            const bundle = buildDeps({ node });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 100,
                },
                bundle.deps,
            );
            expect(result).toBe(false);
        });

        it('restore-distance maps through the canonical inverted seam', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1000,
                listLayoutHeight: 400,
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 100,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            // canonical target = max(0, maxOffset 600 - distance 100) = 500; inverted raw target mirrors to 100.
            expect(node.offsetCalls).toEqual([{ offset: 100, animated: false }]);
        });

        it('restore-distance maps canonical target to RAW through the native inverted driver owner', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1000,
                listLayoutHeight: 400,
            });
            performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 100,
                },
                bundle.deps,
            );
            // canonical target = 600 - 100 = 500; inverted seam mirrors: scrollableExtent (600) - 500 = 100.
            expect(node.offsetCalls).toEqual([{ offset: 100, animated: false }]);
        });

        it('restore-distance uses canonical mapping with measured layout', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1000,
                listLayoutHeight: 400,
            });
            performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 100,
                },
                bundle.deps,
            );
            expect(node.offsetCalls).toEqual([{ offset: 100, animated: false }]);
        });

        it('restore-distance honors an explicit command.contentHeight through the canonical inverted seam', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1000,
                listLayoutHeight: 400,
            });
            performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 50,
                    contentHeight: 800,
                },
                bundle.deps,
            );
            // maxOffset from command.contentHeight 800 - layout 400 = 400; canonical target = 350; inverted raw = 50.
            expect(node.offsetCalls).toEqual([{ offset: 50, animated: false }]);
        });

        it('applies native history correction through the driver with the same canonical-to-raw mapping', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1500,
                listLayoutHeight: 300,
            });

            const result = performTranscriptViewportCommand(
                {
                    kind: 'apply-history-correction',
                    sessionId: BASE_SESSION,
                    reason: 'prepend-restore',
                    mode: 'restore-anchor',
                    targetDistanceFromHistoryStartPx: 820,
                    animated: false,
                } as TranscriptViewportCommand,
                bundle.deps,
            );

            expect(result).toBe(true);
            // Canonical target = 820 from history start; inverted raw target mirrors across maxOffset 1200.
            expect(node.offsetCalls).toEqual([{ offset: 380, animated: false }]);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'native-scroll-to-offset',
                reason: 'prepend-restore',
                mode: 'restore-anchor',
                targetOffsetY: 820,
            });
        });

        it('applies native history correction through the canonical inverted seam', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1500,
                listLayoutHeight: 300,
            });

            const result = performTranscriptViewportCommand(
                {
                    kind: 'apply-history-correction',
                    sessionId: BASE_SESSION,
                    reason: 'prepend-restore',
                    mode: 'restore-anchor',
                    targetDistanceFromHistoryStartPx: 820,
                    animated: false,
                } as TranscriptViewportCommand,
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(node.offsetCalls).toEqual([{ offset: 380, animated: false }]);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'native-scroll-to-offset',
                reason: 'prepend-restore',
                mode: 'restore-anchor',
                targetOffsetY: 820,
            });
        });
    });

    describe('restore-anchor / jump-to-seq — web hot/cold split', () => {
        beforeEach(() => setPlatform('web'));

        it('returns false when the anchor is not loaded or resolvable', () => {
            const resolveRestoreAnchorIndex = vi.fn(() => null);
            const bundle = buildDeps({ resolveRestoreAnchorIndex, shouldUseWebHotColdSplit: true });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 0 },
                },
                bundle.deps,
            );
            expect(result).toBe(false);
            expect(resolveRestoreAnchorIndex).toHaveBeenCalledWith(RESTORE_ANCHOR);
        });

        it('hot-tail target pins to web visual bottom (scrollHeight) instead of a cold index', () => {
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
            const node = createFakeScrollNode();
            // coldCount 0 (degenerate/empty cold slice) → resolveWebColdListScrollTarget = pin_to_bottom.
            const bundle = buildDeps({
                node,
                webMetrics: metrics,
                resolveRestoreAnchorIndex: () => 10,
                shouldUseWebHotColdSplit: true,
                coldItemCount: 0,
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 0 },
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(metrics.element.scrollTop).toBe(600);
            expect(node.indexCalls).toHaveLength(0);
            expect(lastWrite(bundle.recorded).writer).toBe('web-dom-bottom');
        });

        it('cold restore target writes DOM scrollTop to the item anchor instead of RN-web scrollToIndex', () => {
            const node = createFakeScrollNode();
            const webMetrics = createFakeWebScrollMetrics({
                anchors: [{ testId: 'transcript-item-row-2', top: 220, bottom: 320 }],
                scrollTop: 50,
            });
            const bundle = buildDeps({
                node,
                webMetrics,
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                resolveRestoreAnchorIndex: () => 2,
                // The telemetry writer name reads the dedicated telemetryPlatform dep (not Platform.OS).
                telemetryPlatform: 'web',
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 80 },
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toHaveLength(0);
            expect(webMetrics.element.scrollTop).toBe(190);
            // Web never writes the native restore-index command ref.
            expect(bundle.lastNativeRestoreIndexCommandRef.current).toBeNull();
            expect(bundle.webDomObservation.getState().observedScrollTop).toBe(190);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
            expect(write.targetOffsetY).toBe(190);
        });

        it('jump-to-seq reads the LIVE web hot/cold counts at command time (stale-closure guard)', () => {
            // Jump commands run inside long async flows (window materialization + landing
            // settle); a captured split flag/count remaps the write into the wrong index space
            // when the window re-slices mid-flight (live RG1/RG2 wrong-space class).
            const node = createFakeScrollNode();
            const webMetrics = createFakeWebScrollMetrics({
                anchors: [{ testId: 'transcript-item-row-4', top: 220, bottom: 320 }],
                scrollTop: 50,
                scrollHeight: 1600,
                clientHeight: 400,
            });
            const bundle = buildDeps({
                node,
                webMetrics,
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                shouldUseWebHotColdSplit: false,
                coldItemCount: 0,
                resolveJumpToSeqIndex: () => 6,
                telemetryPlatform: 'web',
            });
            // Split activates AFTER deps were built (mid-flight re-slice): full index 6 is a
            // hot-tail row and must remap to the last cold row under the LIVE counts. With the
            // stale captured counts (split inactive), index 6 has no listData row and the
            // command dies as a wrong-space no-op.
            (bundle.deps.webHotColdCountsRef as { current: { coldCount: number; hotCount: number } }).current = {
                coldCount: 5,
                hotCount: 2,
            };
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 331,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
        });

        it('jump-to-seq lands exactly on a mounted hot-tail footer target instead of clamping to the last cold row', () => {
            // The web hot/cold split renders the tail outside the recycler, but footer rows
            // still mount `transcript-item-<id>` testids. A jump whose target sits in the hot
            // region must rect-scroll to the target row itself; the legacy last-cold-row clamp
            // strands the viewport one footer above the target (live RG1 in-app evidence).
            const node = createFakeScrollNode();
            const webMetrics = createFakeWebScrollMetrics({
                anchors: [
                    { testId: 'transcript-item-row-4', top: 220, bottom: 320 },
                    { testId: 'transcript-item-hot-6', top: 900, bottom: 1000 },
                ],
                scrollTop: 50,
                scrollHeight: 1600,
                clientHeight: 400,
            });
            const bundle = buildDeps({
                node,
                webMetrics,
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                items: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                    { id: 'hot-5' },
                    { id: 'hot-6' },
                ],
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                resolveJumpToSeqIndex: () => 6,
                telemetryPlatform: 'web',
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 331,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
            // Centered on the hot-6 rect (top 900 rel. viewport, height 100), not row-4's rect.
            expect(webMetrics.element.scrollTop).toBeGreaterThan(500);
        });

        it('visible anchor correction derives the DOM target inside the web driver', () => {
            const node = createFakeScrollNode();
            const webMetrics = createFakeWebScrollMetrics({
                anchors: [{ testId: 'transcript-item-turn:1', top: 180, bottom: 640 }],
                scrollTop: 500,
                scrollHeight: 1600,
                clientHeight: 600,
            });
            const bundle = buildDeps({ node, webMetrics, telemetryPlatform: 'web' });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-visible-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: {
                        anchor: { kind: 'item', itemId: 'turn:1', messageId: null },
                        itemOffsetPx: 72,
                    },
                    animated: false,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(node.indexCalls).toHaveLength(0);
            expect(webMetrics.element.scrollTop).toBe(608);
            expect(bundle.webDomObservation.getState().observedScrollTop).toBe(608);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
            expect(write.reason).toBe('entry-restore');
            expect(write.mode).toBe('restore-anchor');
            expect(write.targetOffsetY).toBe(608);
        });

        it('web prepend anchor correction returns the helper strategy from the web driver', () => {
            const node = createFakeScrollNode();
            const webMetrics = createFakeWebScrollMetrics({
                anchors: [{ testId: 'transcript-anchor-message-m1', top: 260, bottom: 360 }],
                scrollTop: 400,
                scrollHeight: 2200,
                clientHeight: 600,
            });
            const prependAnchor = {
                metrics: {
                    element: webMetrics.element,
                    scrollTop: 400,
                    scrollHeight: 1800,
                    clientHeight: 600,
                },
                anchorTestId: 'transcript-anchor-message-m1',
                anchorTop: 96,
                itemTestId: 'transcript-item-turn:1',
                itemTop: 40,
                stabilizeForMs: 3000,
                userIntentAtMs: 1,
                expiresAtMs: Date.now() + 3000,
            };
            const bundle = buildDeps({ node, webMetrics, telemetryPlatform: 'web' });
            const result = performWebDomPrependAnchorRestoreCommand(
                {
                    kind: 'restore-web-prepend-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'prepend-restore',
                    mode: 'restore-anchor',
                    anchor: prependAnchor,
                    animated: false,
                },
                bundle.deps,
            );

            expect(result).toEqual({ didAdjustScroll: true, strategy: 'anchor' });
            expect(node.indexCalls).toHaveLength(0);
            expect(webMetrics.element.scrollTop).toBe(564);
            expect(bundle.webDomObservation.getState().observedScrollTop).toBe(564);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
            expect(write.reason).toBe('prepend-restore');
            expect(write.mode).toBe('restore-anchor');
            expect(write.targetOffsetY).toBe(564);
        });

        it('cold restore target uses list layout fallback when the row is virtualized out of the DOM', () => {
            const getLayout = vi.fn((index: number) => (
                index === 2 ? { x: 0, y: 900, width: 0, height: 160 } : undefined
            ));
            const node = createFakeScrollNode({ getLayout });
            const webMetrics = createFakeWebScrollMetrics({
                anchors: [{ testId: 'transcript-item-row-visible', top: 220, bottom: 320 }],
                scrollTop: 50,
                scrollHeight: 1800,
                clientHeight: 400,
            });
            const bundle = buildDeps({
                node,
                webMetrics,
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                resolveRestoreAnchorIndex: () => 2,
                telemetryPlatform: 'web',
            });

            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 80 },
                },
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(getLayout).toHaveBeenCalledWith(2);
            // Restore-anchor commands stay DOM-only (the re-anchor nudge is jump-to-seq-scoped).
            expect(node.indexCalls).toHaveLength(0);
            expect(webMetrics.element.scrollTop).toBe(820);
            expect(bundle.webDomObservation.getState()).toMatchObject({
                observedScrollHeight: 1800,
                observedScrollTop: 820,
            });
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'web-dom-restore',
                targetOffsetY: 820,
            });
        });

        it('maps a full hot-tail restore-anchor index to the last cold row inside the web driver', () => {
            const getLayout = vi.fn((index: number) => (
                index === 4 ? { x: 0, y: 1400, width: 0, height: 120 } : undefined
            ));
            const node = createFakeScrollNode({ getLayout });
            const resolveRestoreAnchorIndex = vi.fn(() => 8);
            const bundle = buildDeps({
                node,
                webMetrics: createFakeWebScrollMetrics({
                    anchors: [],
                    scrollTop: 0,
                    scrollHeight: 2400,
                    clientHeight: 500,
                }),
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                resolveRestoreAnchorIndex,
                telemetryPlatform: 'web',
            });

            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 80 },
                },
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(resolveRestoreAnchorIndex).toHaveBeenCalledWith(RESTORE_ANCHOR);
            expect(getLayout).toHaveBeenCalledWith(4);
            // Restore-anchor commands stay DOM-only (the re-anchor nudge is jump-to-seq-scoped).
            expect(node.indexCalls).toHaveLength(0);
            expect(bundle.webDomObservation.getState().observedScrollTop).toBe(1320);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'web-dom-restore',
                targetOffsetY: 1320,
            });
        });

        it('jump-to-seq cold target centers the DOM item instead of using RN-web scrollToIndex', () => {
            const node = createFakeScrollNode();
            const resolveJumpToSeqIndex = vi.fn(() => 3);
            const bundle = buildDeps({
                node,
                webMetrics: createFakeWebScrollMetrics({
                    anchors: [{ testId: 'transcript-item-row-3', top: 500, bottom: 620 }],
                    scrollTop: 40,
                }),
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                resolveJumpToSeqIndex,
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 42,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(resolveJumpToSeqIndex).toHaveBeenCalledWith(42);
            expect(node.indexCalls).toHaveLength(0);
            expect(bundle.webDomObservation.getState().observedScrollTop).toBe(400);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
            expect(write.targetOffsetY).toBe(400);
        });

        it('jump-to-seq cold target can align near the top for navigation user-turn jumps', () => {
            const node = createFakeScrollNode();
            const resolveJumpToSeqIndex = vi.fn(() => 3);
            const bundle = buildDeps({
                node,
                webMetrics: createFakeWebScrollMetrics({
                    anchors: [{ testId: 'transcript-item-row-3', top: 500, bottom: 620 }],
                    scrollTop: 40,
                }),
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                resolveJumpToSeqIndex,
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 42,
                    align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(resolveJumpToSeqIndex).toHaveBeenCalledWith(42);
            expect(node.indexCalls).toHaveLength(0);
            expect(bundle.webDomObservation.getState().observedScrollTop).toBe(516);
            const write = lastWrite(bundle.recorded);
            expect(write.writer).toBe('web-dom-restore');
            expect(write.targetOffsetY).toBe(516);
        });

        it('jump-to-seq cold target uses list layout fallback when the row is virtualized out of the DOM', () => {
            const getLayout = vi.fn((index: number) => (
                index === 3 ? { x: 0, y: 1200, width: 0, height: 140 } : undefined
            ));
            const node = createFakeScrollNode({ getLayout });
            const resolveJumpToSeqIndex = vi.fn(() => 3);
            const bundle = buildDeps({
                node,
                webMetrics: createFakeWebScrollMetrics({
                    anchors: [{ testId: 'transcript-item-row-visible', top: 500, bottom: 620 }],
                    scrollTop: 40,
                    scrollHeight: 2200,
                    clientHeight: 400,
                }),
                listData: [
                    { id: 'row-0' },
                    { id: 'row-1' },
                    { id: 'row-2' },
                    { id: 'row-3' },
                    { id: 'row-4' },
                ],
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                telemetryPlatform: 'web',
                resolveJumpToSeqIndex,
            });

            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 42,
                },
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(resolveJumpToSeqIndex).toHaveBeenCalledWith(42);
            expect(getLayout).toHaveBeenCalledWith(3);
            // The unmounted-target render-window re-anchor nudge is allowed; the DOM write below stays the offset owner.
            expect(node.indexCalls).toEqual([{ index: 3, animated: false }]);
            expect(bundle.webDomObservation.getState()).toMatchObject({
                observedScrollHeight: 2200,
                observedScrollTop: 1070,
            });
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'web-dom-restore',
                targetOffsetY: 1070,
            });
        });
    });

    describe('restore-anchor / jump-to-seq — native', () => {
        beforeEach(() => setPlatform('ios'));

        it('returns false when the node lacks scrollToIndex', () => {
            const node = createFakeScrollNode({ withScrollToIndex: false });
            const bundle = buildDeps({ node, resolveRestoreAnchorIndex: () => 1 });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 0 },
                },
                bundle.deps,
            );
            expect(result).toBe(false);
        });

        it('restore-anchor writes lastNativeRestoreIndexCommandRef and scrolls with driver-derived viewOffset', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({ node, resolveRestoreAnchorIndex: () => 4, telemetryPlatform: 'ios' });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 12 },
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            // viewPosition is only added on web; native restore omits it.
            expect(node.indexCalls).toEqual([{ index: 4, animated: false, viewOffset: -12 }]);
            const stored = bundle.lastNativeRestoreIndexCommandRef.current;
            expect(stored?.index).toBe(4);
            expect(stored?.reason).toBe('entry-restore');
            expect(stored?.sessionId).toBe(BASE_SESSION);
            expect(stored?.viewOffset).toBe(-12);
            expect(lastWrite(bundle.recorded).writer).toBe('native-scroll-to-index');
        });

        it('native hot/cold split remaps the full rendered index to a cold rendered index', () => {
            const node = createFakeScrollNode();
            // fullCount 10, coldCount 4, renderedFullIndex 0 (newest, a hot-tail row) → cold rendered 0.
            const bundle = buildDeps({
                node,
                shouldUseNativeHotColdSplit: true,
                itemsLength: 10,
                listDataLength: 4,
                resolveRestoreAnchorIndex: () => 0,
            });
            performTranscriptViewportCommand(
                {
                    kind: 'restore-anchor',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-anchor',
                    target: { anchor: RESTORE_ANCHOR, itemOffsetPx: 0 },
                },
                bundle.deps,
            );
            // canonicalIndex = 10 - 1 - 0 = 9 (hot-tail) → cold rendered index 0.
            expect(node.indexCalls[0]?.index).toBe(0);
            expect(bundle.lastNativeRestoreIndexCommandRef.current?.index).toBe(0);
        });

        it('jump-to-seq uses viewPosition 0.5 and stores the ref without viewOffset', () => {
            const node = createFakeScrollNode();
            const resolveJumpToSeqIndex = vi.fn(() => 5);
            const bundle = buildDeps({ node, resolveJumpToSeqIndex });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 7,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(resolveJumpToSeqIndex).toHaveBeenCalledWith(7);
            expect(node.indexCalls).toEqual([{ index: 5, animated: true, viewPosition: 0.5 }]);
            const stored = bundle.lastNativeRestoreIndexCommandRef.current;
            expect(stored?.index).toBe(5);
            expect(stored?.viewOffset).toBeUndefined();
        });

        it('jump-to-seq can align near the top on native through the existing index command', () => {
            const node = createFakeScrollNode();
            const resolveJumpToSeqIndex = vi.fn(() => 5);
            const bundle = buildDeps({ node, resolveJumpToSeqIndex });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 7,
                    align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(resolveJumpToSeqIndex).toHaveBeenCalledWith(7);
            expect(node.indexCalls).toEqual([{ index: 5, animated: true, viewOffset: -24 }]);
            const stored = bundle.lastNativeRestoreIndexCommandRef.current;
            expect(stored?.index).toBe(5);
            expect(stored?.viewOffset).toBe(-24);
        });

        it('jump-to-seq returns false when the seq is not loaded or resolvable', () => {
            const node = createFakeScrollNode();
            const resolveJumpToSeqIndex = vi.fn(() => null);
            const bundle = buildDeps({ node, resolveJumpToSeqIndex });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 7,
                },
                bundle.deps,
            );
            expect(result).toBe(false);
            expect(resolveJumpToSeqIndex).toHaveBeenCalledWith(7);
            expect(node.indexCalls).toHaveLength(0);
            expect(bundle.lastNativeRestoreIndexCommandRef.current).toBeNull();
        });

        it('jump-to-seq failure recovery derives raw fallback writes inside the native driver', () => {
            const node = createFakeScrollNode();
            const bundle = buildDeps({
                node,
                listContentHeight: 1500,
                listLayoutHeight: 300,
            });

            const result = performTranscriptViewportCommand(
                {
                    kind: 'recover-jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    failedRenderedIndex: 3,
                    averageItemLengthPx: 100,
                    animated: true,
                } as TranscriptViewportCommand,
                bundle.deps,
            );

            expect(result).toBe(true);
            // Platform failure facts estimate RAW offset 300. Under inverted canonical telemetry
            // records maxOffset 1200 - raw 300 = 900 while the raw write remains 300.
            expect(node.offsetCalls).toEqual([{ offset: 300, animated: true }]);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'native-scroll-to-offset',
                reason: 'jump-to-seq',
                mode: 'jump-to-seq',
                targetOffsetY: 900,
            });
        });
    });

    describe('unknown command', () => {
        beforeEach(() => setPlatform('ios'));

        it('returns false for a no-op command kind', () => {
            const bundle = buildDeps({ node: createFakeScrollNode() });
            const result = performTranscriptViewportCommand(
                { kind: 'none', sessionId: BASE_SESSION, reason: 'noop', mode: 'follow-bottom' },
                bundle.deps,
            );
            expect(result).toBe(false);
        });
    });
});

import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetChatListHarness } from '@/dev/testkit';
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
 * testkit lever (`resetChatListHarness({ platformOs })`) via `setPlatform`, which both resets the
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

/** Canonical testkit lever: reset the harness AND mirror the chosen OS into the hoisted Platform mock. */
function setPlatform(platformOs: 'web' | 'ios'): void {
    resetChatListHarness({ platformOs });
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
};

function createFakeScrollNode(
    options: Readonly<{
        getLayout?: NonNullable<ScrollableChatListRef['getLayout']>;
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
    shouldUseWebHotColdSplit?: boolean;
    shouldUseNativeHotColdSplit?: boolean;
    coldItemCount?: number;
    resolveRestoreAnchorIndex?: (anchor: { kind: 'message' | 'toolGroup' | 'item'; itemId: string; messageId?: string | null }) => number | null;
    resolveRendererDataTarget?: (command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-anchor' | 'jump-to-seq' }>>) =>
        | Readonly<{ kind: 'data'; index: number; itemId: string }>
        | Readonly<{
            kind: 'outside-data';
            fallbackIndex: number | null;
            itemId: string;
            reason: 'projection-window' | 'renderer-edge';
            targetSeq: number | null;
        }>
        | null;
    telemetryPlatform?: 'web' | 'ios' | 'android' | 'native-other';
    resolveJumpToSeqIndex?: (seq: number) => number | null;
};

type DepsBundle = {
    deps: DepsType;
    recorded: RecordedTelemetry[];
    restoreDecisions: Array<{ reason: string; params?: unknown }>;
    lastNativeRestoreIndexCommandRef: MutableRefObject<LastNativeRestoreIndexCommand | null>;
    webDomObservation: WebDomScrollObservation;
};

function makeRef<T>(value: T): MutableRefObject<T> {
    return { current: value };
}

function buildDeps(overrides: DepsOverrides = {}): DepsBundle {
    const recorded: RecordedTelemetry[] = [];
    const restoreDecisions: Array<{ reason: string; params?: unknown }> = [];
    const lastNativeRestoreIndexCommandRef = makeRef<LastNativeRestoreIndexCommand | null>(null);
    const webDomObservation = createWebDomScrollObservation();

    const deps: DepsType = {
        listRef: { current: overrides.node ?? null },
        listContentHeightRef: { current: overrides.listContentHeight ?? 1000 },
        listLayoutHeightRef: { current: overrides.listLayoutHeight ?? 400 },
        listDataRef: { current: overrides.listData ?? { length: overrides.listDataLength ?? 5 } },
        lastPinOffsetForIntentRef: { current: null },
        webDomObservation,
        lastNativeRestoreIndexCommandRef,
        nativeMountSettleStable: true,
        telemetryPlatform: overrides.telemetryPlatform ?? 'ios',
        resolveWebScrollMetrics: () => overrides.webMetrics ?? null,
        resolveRendererDataTarget: overrides.resolveRendererDataTarget ?? ((command) => {
            const fullIndex = command.kind === 'restore-anchor'
                ? overrides.resolveRestoreAnchorIndex?.(command.target.anchor) ?? null
                : overrides.resolveJumpToSeqIndex?.(command.seq) ?? null;
            if (fullIndex == null) return null;
            const itemId = overrides.items?.[fullIndex]?.id ?? `row-${fullIndex}`;
            if (overrides.shouldUseWebHotColdSplit && fullIndex >= (overrides.coldItemCount ?? 0)) {
                const coldCount = overrides.coldItemCount ?? 0;
                return {
                    kind: 'outside-data',
                    fallbackIndex: coldCount > 0 ? coldCount - 1 : null,
                    itemId,
                    reason: 'renderer-edge',
                    targetSeq: null,
                };
            }
            if (overrides.shouldUseNativeHotColdSplit) {
                const fullCount = overrides.itemsLength ?? overrides.items?.length ?? 5;
                const coldCount = overrides.listDataLength ?? overrides.listData?.length ?? 5;
                const canonicalIndex = fullCount - 1 - fullIndex;
                const coldCanonicalIndex = Math.min(Math.max(0, canonicalIndex), Math.max(0, coldCount - 1));
                return {
                    kind: 'data',
                    index: coldCount - 1 - coldCanonicalIndex,
                    itemId,
                };
            }
            return { kind: 'data', index: fullIndex, itemId };
        }),
        recordViewportTelemetryEvent: (event) => {
            recorded.push(event as RecordedTelemetry);
        },
        recordRestoreDecisionTelemetry: (reason, params) => {
            restoreDecisions.push({ reason, params });
        },
        resolveWebViewportTelemetryDiagnostics: () => ({ diag: true }),
    };

    return {
        deps,
        recorded,
        restoreDecisions,
        lastNativeRestoreIndexCommandRef,
        webDomObservation,
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

        it('defers to a live renderer-held end intent instead of re-writing the tail', () => {
            // Open-landing capture 2026-07-22 (session cmrw2np7w): repeated driver pin
            // writes raced the renderer verifyLanding corrections and Legend's own
            // maintain-at-end while initial row measurement oscillated scrollHeight —
            // three writers chasing different bottoms = the visible open jiggle.
            // Native pin-bottom already routes through the renderer
            // (scrollRendererToEnd latches and writes in one owner); the web DOM
            // driver defers the same way once the renderer owns the tail. The FIRST
            // pin (no live end hold) still writes and latches.
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 10 });
            const node = createFakeScrollNode();
            (node as unknown as { hasLiveWebHold: (target: { kind: string }) => boolean }).hasLiveWebHold =
                (target) => target.kind === 'end';
            const bundle = buildDeps({ node, webMetrics: metrics });
            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );
            expect(result).toBe(true);
            // No write: the renderer's held-'end' machinery owns the landing.
            expect(metrics.element.scrollTop).toBe(10);
            expect(bundle.recorded.filter((e) => e.type === 'scroll-write')).toHaveLength(0);
        });

        it('hands the first bottom landing to a renderer that can own the live tail', () => {
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 10 });
            const node = createFakeScrollNode({ withScrollToEnd: true });
            (node as unknown as { hasLiveWebHold: (target: { kind: string }) => boolean }).hasLiveWebHold =
                () => false;
            const bundle = buildDeps({ node, webMetrics: metrics });

            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'jump-to-bottom', mode: 'jump-to-bottom' },
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(node.endCalls).toEqual([{ animated: false }]);
            expect(metrics.element.scrollTop).toBe(10);
            expect(bundle.recorded.filter((event) => event.type === 'scroll-write')).toHaveLength(0);
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

        it('uses standard native scroll space for the Legend renderer command adapter', () => {
            const node = createFakeScrollNode({ withScrollToEnd: true });
            const bundle = buildDeps({
                node,
                listContentHeight: 1000,
                listLayoutHeight: 400,
            });

            const result = performTranscriptViewportCommand(
                { kind: 'pin-bottom', sessionId: BASE_SESSION, reason: 'content-size-change', mode: 'follow-bottom' },
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(node.endCalls).toEqual([{ animated: false }]);
            expect(node.indexCalls).toHaveLength(0);
            expect(node.offsetCalls).toHaveLength(0);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'native-scroll-to-offset',
                reason: 'content-size-change',
                mode: 'follow-bottom',
                targetOffsetY: 600,
                distanceFromBottom: 0,
            });
        });

        it('maps semantic native distance and history commands directly in standard Legend scroll space', () => {
            const node = createFakeScrollNode();
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

        it('uses the renderer-data target projected before the standard Legend driver', () => {
            const node = createFakeScrollNode();
            const resolveJumpToSeqIndex = vi.fn(() => 8);
            const resolveRendererDataTarget = vi.fn(() => ({
                kind: 'data' as const,
                index: 0,
                itemId: 'cold-row-0',
            }));
            const bundle = buildDeps({
                node,
                itemsLength: 10,
                listDataLength: 4,
                resolveJumpToSeqIndex,
                resolveRendererDataTarget,
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
            expect(resolveRendererDataTarget).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'jump-to-seq',
                seq: 42,
            }));
            expect(resolveJumpToSeqIndex).not.toHaveBeenCalled();
            expect(node.indexCalls).toEqual([{ index: 0, animated: true, viewOffset: 32 }]);
            expect(bundle.lastNativeRestoreIndexCommandRef.current).toMatchObject({
                index: 0,
                reason: 'jump-to-seq',
                sessionId: BASE_SESSION,
                viewOffset: 32,
            });
        });

    });

    describe('restore-distance — web', () => {
        beforeEach(() => setPlatform('web'));

        it('restore-distance at distance 0 defers to a live renderer-held end intent', () => {
            // Distance 0 IS the live tail — the same single-owner rule as
            // pin-bottom/preserve. Detached distances stay transaction-owned.
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
            const node = createFakeScrollNode();
            (node as unknown as { hasLiveWebHold: (target: { kind: string }) => boolean }).hasLiveWebHold =
                (target) => target.kind === 'end';
            const bundle = buildDeps({ node, webMetrics: metrics });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'restore-distance',
                    sessionId: BASE_SESSION,
                    reason: 'entry-restore',
                    mode: 'restore-distance',
                    distanceFromLiveTailPx: 0,
                },
                bundle.deps,
            );
            expect(result).toBe(true);
            expect(metrics.element.scrollTop).toBe(100);
            expect(bundle.recorded.filter((e) => e.type === 'scroll-write')).toHaveLength(0);
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
            // A degenerate/empty recycler target carries no fallback index, so the web
            // driver preserves the compatibility behavior by landing at visual bottom.
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

        it('tail-fallback restore defers to a live renderer-held end intent', () => {
            // The entry-restore bottom fallback is a tail-targeting write like
            // pin-bottom; during open it re-fires from the entry re-verify loop
            // while the renderer already owns the tail (open-landing capture
            // 2026-07-22) — defer under the same single-owner rule.
            const metrics = createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
            const node = createFakeScrollNode();
            (node as unknown as { hasLiveWebHold: (target: { kind: string }) => boolean }).hasLiveWebHold =
                (target) => target.kind === 'end';
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
            expect(metrics.element.scrollTop).toBe(0);
            expect(bundle.recorded.filter((e) => e.type === 'scroll-write')).toHaveLength(0);
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

        it('arms the renderer-owned entry anchor hold after a successful web restore-anchor write', () => {
            // Live A->B->A RED (2026-07-11): the entry restore wrote an anchor-aligned offset
            // against estimate-based geometry (contentHeight 25938), then giant-row
            // measurements collapsed the content ~5x with no owner re-verifying the anchor —
            // the browser clamped scrollTop and the restored row was lost near the tail.
            // restore-visible-anchor already arms the renderer hold; restore-anchor must too.
            const node = createFakeScrollNode();
            const holdWebEntryAnchor = vi.fn();
            (node as unknown as { holdWebEntryAnchor: unknown }).holdWebEntryAnchor = holdWebEntryAnchor;
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
            expect(holdWebEntryAnchor).toHaveBeenCalledWith({
                itemId: 'row-2',
                itemOffsetPx: 80,
                kind: 'message',
                messageId: 'message-2',
                reason: 'entry-restore',
            });
        });

        it('jump-to-seq reads the live renderer-data projection at command time', () => {
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
            let currentTarget: Exclude<ReturnType<NonNullable<DepsOverrides['resolveRendererDataTarget']>>, null> = {
                kind: 'data' as const,
                index: 6,
                itemId: 'row-6',
            };
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
                resolveRendererDataTarget: () => currentTarget,
                telemetryPlatform: 'web',
            });
            // The projection changes after deps are built (mid-flight re-slice). The command
            // must consume the current typed target rather than captured split counts.
            currentTarget = {
                kind: 'outside-data',
                fallbackIndex: 4,
                itemId: 'row-6',
                reason: 'renderer-edge',
                targetSeq: 331,
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

        it('jump-to-seq to an unloaded target revokes the renderer-held tail at dispatch', () => {
            // Live capture 2026-07-23: jumping to a target outside the loaded window
            // while pinned pages older content in for seconds with NO landing write;
            // the surviving held-'end' re-pinned to the bottom through every prepend
            // and the user ended at the tail instead of the jump target. The jump
            // must revoke tail ownership at dispatch; the eventual landing arms the
            // keyed hold as the new owner.
            const node = createFakeScrollNode();
            const releaseWebHeldIntent = vi.fn();
            (node as unknown as { hasLiveWebHold: (target: { kind: string }) => boolean }).hasLiveWebHold =
                (target) => target.kind === 'end';
            (node as unknown as { releaseWebHeldIntent: typeof releaseWebHeldIntent }).releaseWebHeldIntent = releaseWebHeldIntent;
            const bundle = buildDeps({
                node,
                webMetrics: createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }),
                shouldUseWebHotColdSplit: true,
                coldItemCount: 5,
                resolveJumpToSeqIndex: () => null,
            });
            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 999,
                },
                bundle.deps,
            );
            expect(result).toBe(false);
            expect(releaseWebHeldIntent).toHaveBeenCalledTimes(1);
        });

        it('restore-anchor never revokes the renderer-held tail at dispatch', () => {
            // Restores are transaction-owned landings, not user navigation: an entry
            // restore racing a live pinned tail must not strip the tail owner.
            const node = createFakeScrollNode();
            const releaseWebHeldIntent = vi.fn();
            (node as unknown as { hasLiveWebHold: (target: { kind: string }) => boolean }).hasLiveWebHold =
                (target) => target.kind === 'end';
            (node as unknown as { releaseWebHeldIntent: typeof releaseWebHeldIntent }).releaseWebHeldIntent = releaseWebHeldIntent;
            const bundle = buildDeps({
                node,
                webMetrics: createFakeWebScrollMetrics({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }),
                shouldUseWebHotColdSplit: true,
                coldItemCount: 0,
                resolveRestoreAnchorIndex: () => 10,
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
            expect(releaseWebHeldIntent).not.toHaveBeenCalled();
        });

        it('jump-to-seq hands landing ownership to the renderer by arming the target anchor hold', () => {
            // Live capture 2026-07-22 (nav-rail jump while pinned): the jump wrote its
            // target while the renderer kept its own held intent, and the two landing
            // verifiers (renderer verifyLanding vs the jump re-verify loop) oscillated
            // the viewport ±24px indefinitely. A jump command must take renderer
            // ownership of its target exactly like pin-bottom takes the tail
            // (scrollToEnd) and restore-anchor takes its anchor.
            const node = createFakeScrollNode();
            const holdWebEntryAnchor = vi.fn();
            (node as unknown as { holdWebEntryAnchor: typeof holdWebEntryAnchor }).holdWebEntryAnchor = holdWebEntryAnchor;
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
            expect(holdWebEntryAnchor).toHaveBeenCalledWith({
                itemId: 'row-3',
                // item content-y (500 + 40) minus the landed target (400).
                itemOffsetPx: 140,
                kind: 'item',
                messageId: null,
                reason: 'jump-to-seq',
            });
        });

        it('keeps an unmounted giant-tail jump in approach ownership until the exact target mounts', () => {
            // Exact-current live A failure: the first early jump starts at the physical tail
            // with only the giant final row mounted. Its measured-band extrapolation clamps
            // the approach write to zero. That estimate-only approach is not a completed
            // keyed landing: publishing an anchor here makes the next landing pass defer to
            // a target hold whose row has never mounted, while the second user click succeeds
            // only after the target window has settled.
            const node = createFakeScrollNode();
            const holdWebEntryAnchor = vi.fn();
            (node as unknown as { holdWebEntryAnchor: typeof holdWebEntryAnchor }).holdWebEntryAnchor = holdWebEntryAnchor;
            const listData = Array.from({ length: 46 }, (_, index) => ({ id: `row-${index}` }));
            const bundle = buildDeps({
                node,
                webMetrics: createFakeWebScrollMetrics({
                    anchors: [{
                        testId: 'transcript-item-row-45',
                        top: -28928,
                        bottom: 382,
                    }],
                    scrollTop: 77778,
                    scrollHeight: 78166,
                    clientHeight: 388,
                }),
                listData,
                telemetryPlatform: 'web',
                resolveJumpToSeqIndex: () => 0,
            });

            const result = performTranscriptViewportCommand(
                {
                    kind: 'jump-to-seq',
                    sessionId: BASE_SESSION,
                    reason: 'jump-to-seq',
                    mode: 'jump-to-seq',
                    seq: 1,
                    align: { kind: 'top-with-item-offset', itemOffsetPx: 24 },
                },
                bundle.deps,
            );

            expect(result).toBe(true);
            expect(node.indexCalls).toEqual([{ index: 0, animated: false }]);
            expect(bundle.webDomObservation.getState().observedScrollTop).toBe(0);
            expect(holdWebEntryAnchor).not.toHaveBeenCalled();
        });

        it('jump-to-seq defers to a live renderer keyed hold for the same target instead of re-writing', () => {
            // The post-landing re-verify loop re-issues jump-to-seq for seconds; once the
            // renderer anchor hold owns the target, those re-writes must stand down or
            // the two verifiers fight (same live capture as above).
            const node = createFakeScrollNode();
            (node as unknown as { hasLiveWebHold: (target: { kind: string; itemId?: string }) => boolean }).hasLiveWebHold =
                (target) => target.kind === 'item' && target.itemId === 'row-3';
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
            // No write happened: the renderer hold owns the landing.
            expect(bundle.webDomObservation.getState().observedScrollTop).not.toBe(400);
            expect(bundle.recorded.filter((event) => event.type === 'scroll-write')).toHaveLength(0);
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
            expect(node.indexCalls).toEqual([{
                index: 4,
                animated: false,
                viewOffset: 12,
                context: {
                    anchor: {
                        itemId: 'row-2',
                        itemOffsetPx: 12,
                        kind: 'message',
                        messageId: 'message-2',
                        reason: 'entry-restore',
                    },
                    kind: 'entry-placement',
                },
            }]);
            const stored = bundle.lastNativeRestoreIndexCommandRef.current;
            expect(stored?.index).toBe(4);
            expect(stored?.reason).toBe('entry-restore');
            expect(stored?.sessionId).toBe(BASE_SESSION);
            expect(stored?.viewOffset).toBe(12);
            expect(lastWrite(bundle.recorded).writer).toBe('native-scroll-to-index');
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
            expect(node.indexCalls).toEqual([{ index: 5, animated: true, viewOffset: 24 }]);
            const stored = bundle.lastNativeRestoreIndexCommandRef.current;
            expect(stored?.index).toBe(5);
            expect(stored?.viewOffset).toBe(24);
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
            // Standard-space driver: failure facts estimate offset 300 and telemetry records it as-is.
            expect(node.offsetCalls).toEqual([{ offset: 300, animated: true }]);
            expect(lastWrite(bundle.recorded)).toMatchObject({
                writer: 'native-scroll-to-offset',
                reason: 'jump-to-seq',
                mode: 'jump-to-seq',
                targetOffsetY: 300,
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

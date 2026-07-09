import type { MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetFlashListChatListHarness } from '@/dev/testkit';
import type { TranscriptViewportTelemetryEvent } from '@/components/sessions/transcript/scroll/transcriptViewportTelemetry';
import type {
    LastNativeRestoreIndexCommand,
    ScrollableChatListRef,
} from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptViewportDriverDeps } from '@/components/sessions/transcript/viewport/driver/types';
import type { TranscriptViewportCommand } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import { createWebDomScrollObservation } from './webDomObservation';

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

const { createTranscriptViewportCommandController } = await import(
    '@/components/sessions/transcript/viewport/createTranscriptViewportCommandController'
);
const { createTranscriptViewportCommandHost } = await import(
    '@/components/sessions/transcript/viewport/driver/commandHost'
);

function setPlatform(platformOs: 'web' | 'ios'): void {
    resetFlashListChatListHarness({ platformOs });
    platformMockState.os = platformOs;
}

type ScrollToIndexCall = { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number };
type ScrollToOffsetCall = { offset: number; animated?: boolean };

type FakeScrollNode = ScrollableChatListRef & {
    indexCalls: ScrollToIndexCall[];
    offsetCalls: ScrollToOffsetCall[];
};

function createFakeScrollNode(options: Readonly<{
    getLayout?: ScrollableChatListRef['getLayout'];
}> = {}): FakeScrollNode {
    const indexCalls: ScrollToIndexCall[] = [];
    const offsetCalls: ScrollToOffsetCall[] = [];
    return {
        ...(options.getLayout ? { getLayout: options.getLayout } : {}),
        indexCalls,
        offsetCalls,
        scrollToIndex: (params) => {
            indexCalls.push(params);
        },
        scrollToOffset: (params) => {
            offsetCalls.push(params);
        },
    } as FakeScrollNode;
}

type WebElementWithLanding = WebTranscriptScrollMetrics['element'] & {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
};

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

function createFakeWebScrollMetrics(
    options: Readonly<{
        anchorTop?: number;
        clientHeight?: number;
        scrollHeight?: number;
        scrollTop?: number;
    }> = {},
): WebTranscriptScrollMetrics {
    const clientHeight = options.clientHeight ?? 400;
    let scrollHeightValue = options.scrollHeight ?? 1000;
    let scrollTopValue = 0;
    const anchorTop = options.anchorTop ?? 60;
    const element = createFakeHTMLElement({
        clientHeight,
        get scrollHeight() {
            return scrollHeightValue;
        },
        set scrollHeight(value: number) {
            scrollHeightValue = value;
        },
        get scrollTop() {
            return scrollTopValue;
        },
        set scrollTop(value: number) {
            const max = Math.max(0, scrollHeightValue - clientHeight);
            scrollTopValue = Math.max(0, Math.min(value, max));
        },
        getBoundingClientRect() {
            return { top: 0, bottom: clientHeight, height: clientHeight };
        },
        querySelectorAll(selector: string) {
            if (selector !== '[data-testid]') return [];
            return [
                createFakeHTMLElement({
                    getAttribute(name: string) {
                        return name === 'data-testid' ? 'transcript-item-row-2' : null;
                    },
                    getBoundingClientRect() {
                        return { top: anchorTop, bottom: anchorTop + 40, height: 40 };
                    },
                }),
            ];
        },
    } as unknown as WebElementWithLanding);
    element.scrollTop = options.scrollTop ?? 0;
    return {
        element: element as WebTranscriptScrollMetrics['element'],
        get scrollTop() {
            return element.scrollTop;
        },
        scrollHeight: options.scrollHeight ?? 1000,
        clientHeight,
    } as WebTranscriptScrollMetrics;
}

type RecordedTelemetry = Readonly<Record<string, unknown> & {
    mode: unknown;
    type: TranscriptViewportTelemetryEvent['type'];
    writer?: unknown;
}>;

type DriverDepsBundle = Readonly<{
    deps: TranscriptViewportDriverDeps;
    node: FakeScrollNode;
    recorded: RecordedTelemetry[];
}>;

function makeRef<T>(value: T): MutableRefObject<T> {
    return { current: value };
}

function buildDriverDeps(
    overrides: Readonly<{
        listContentHeight?: number;
        listData?: TranscriptViewportDriverDeps['listDataRef']['current'];
        listLayoutHeight?: number;
        node?: FakeScrollNode;
        telemetryPlatform?: 'web' | 'ios';
        webMetrics?: WebTranscriptScrollMetrics | null;
    }> = {},
): DriverDepsBundle {
    const node = overrides.node ?? createFakeScrollNode();
    const recorded: RecordedTelemetry[] = [];
    const deps: TranscriptViewportDriverDeps = {
        listRef: { current: node },
        listContentHeightRef: { current: overrides.listContentHeight ?? 1200 },
        listLayoutHeightRef: { current: overrides.listLayoutHeight ?? 500 },
        listDataRef: { current: overrides.listData ?? { length: 5 } },
        itemsRef: { current: { length: 5 } },
        composerInsetHeightRef: { current: 0 },
        nativeHotTailHeightRef: { current: 0 },
        lastPinOffsetForIntentRef: { current: null },
        lastNativePinOffsetRef: { current: null },
        webDomObservation: createWebDomScrollObservation(),
        lastNativeRestoreIndexCommandRef: makeRef<LastNativeRestoreIndexCommand | null>(null),
        nativeMountSettleStable: true,
        telemetryPlatform: overrides.telemetryPlatform ?? 'ios',
        shouldUseNativeHotColdSplit: false,
        webHotColdCountsRef: { current: { coldCount: 0, hotCount: 0 } },
        clearWebPrependRangeReserve: vi.fn(),
        resolveRestoreAnchorIndex: () => null,
        resolveJumpToSeqIndex: () => null,
        resolveWebScrollMetrics: () => overrides.webMetrics ?? null,
        recordViewportTelemetryEvent: (event) => {
            recorded.push(event as RecordedTelemetry);
        },
        recordRestoreDecisionTelemetry: vi.fn(),
        resolveWebViewportTelemetryDiagnostics: () => ({ diag: true }),
        resolveInvertedBottomPinCarveTelemetryFields: () => ({ carve: true }),
    };
    return { deps, node, recorded };
}

function createHost(params: Readonly<{
    clearWebPrependRestoreWindow?: (outcome: string) => void;
    controller: ReturnType<typeof createTranscriptViewportCommandController>;
    deps: TranscriptViewportDriverDeps;
    hasWebPrependRestoreWindow?: () => boolean;
}>) {
    return createTranscriptViewportCommandHost({
        clearWebPrependRestoreWindow: params.clearWebPrependRestoreWindow ?? (() => {}),
        controller: params.controller,
        driverDeps: params.deps,
        hasWebPrependRestoreWindow: params.hasWebPrependRestoreWindow ?? (() => false),
        isWeb: () => platformMockState.os === 'web',
    });
}

function lastWrite(recorded: readonly RecordedTelemetry[], type: TranscriptViewportTelemetryEvent['type']) {
    const writes = recorded.filter((event) => event.type === type);
    return writes[writes.length - 1];
}

const BASE_SESSION = 'session-a';

afterEach(() => {
    vi.clearAllMocks();
});

describe('transcript viewport command host', () => {
    beforeEach(() => setPlatform('ios'));

    it('execute routes through controller ownership and records rejected-write telemetry', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: true, sessionId: BASE_SESSION });
        const bundle = buildDriverDeps();
        const host = createHost({ controller, deps: bundle.deps });

        const accepted = host.execute({
            kind: 'pin-bottom',
            sessionId: BASE_SESSION,
            reason: 'stream-append',
            mode: 'follow-bottom',
        });

        expect(accepted).toBe(false);
        expect(bundle.node.indexCalls).toHaveLength(0);
        expect(bundle.node.offsetCalls).toHaveLength(0);
        expect(lastWrite(bundle.recorded, 'scroll-write')).toBeUndefined();
        expect(lastWrite(bundle.recorded, 'scroll-write-rejected')).toMatchObject({
            type: 'scroll-write-rejected',
            writer: 'native-scroll-to-offset',
            reason: 'stream-append',
            rejectedOwner: 'follow',
            activeOwner: 'entry',
            mode: 'follow-bottom',
            layoutHeight: 500,
            contentHeight: 1200,
            nativeMountSettleStable: true,
        });
    });

    it('executeWithAnimation applies animation only to scroll commands', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: false, sessionId: BASE_SESSION });
        const bundle = buildDriverDeps();
        const host = createHost({ controller, deps: bundle.deps });

        expect(host.executeWithAnimation({
            kind: 'pin-bottom',
            sessionId: BASE_SESSION,
            reason: 'jump-to-bottom',
            mode: 'jump-to-bottom',
            force: true,
        }, true)).toBe(true);
        expect(bundle.node.indexCalls).toEqual([
            expect.objectContaining({ index: 0, animated: true }),
        ]);

        expect(host.executeWithAnimation({
            kind: 'none',
            sessionId: BASE_SESSION,
            reason: 'already-at-bottom',
            mode: 'follow-bottom',
        }, true)).toBe(false);
        expect(bundle.node.indexCalls).toHaveLength(1);
        expect(bundle.recorded.filter((event) => event.type === 'scroll-write')).toHaveLength(1);
    });

    it('restoreWebPrependAnchor returns detailed web restore result through the command host', () => {
        setPlatform('web');
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: false, sessionId: BASE_SESSION });
        const metrics = createFakeWebScrollMetrics({ anchorTop: 80, scrollTop: 100 });
        const bundle = buildDriverDeps({ telemetryPlatform: 'web', webMetrics: metrics });
        const host = createHost({
            controller,
            deps: bundle.deps,
            hasWebPrependRestoreWindow: () => true,
        });

        const result = host.restoreWebPrependAnchor({
            sessionId: BASE_SESSION,
            anchor: {
                metrics,
                anchorTestId: 'transcript-item-row-2',
                anchorTop: 50,
                itemTestId: null,
                itemTop: null,
                stabilizeForMs: 0,
                userIntentAtMs: 0,
                expiresAtMs: Date.now() + 1000,
            },
        });

        expect(result).toEqual({ didAdjustScroll: true, strategy: 'anchor' });
        expect(metrics.element.scrollTop).toBe(130);
        expect(lastWrite(bundle.recorded, 'scroll-write')).toMatchObject({
            type: 'scroll-write',
            writer: 'web-dom-restore',
            reason: 'prepend-restore',
            mode: 'restore-anchor',
            targetOffsetY: 130,
            layoutHeight: 400,
            contentHeight: 1000,
        });
    });

    it('restoreWebVisibleAnchor returns detailed web restore result through the command host', () => {
        setPlatform('web');
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: true, sessionId: BASE_SESSION });
        const metrics = createFakeWebScrollMetrics({ anchorTop: 80, scrollTop: 100 });
        const bundle = buildDriverDeps({ telemetryPlatform: 'web', webMetrics: metrics });
        const host = createHost({ controller, deps: bundle.deps });

        const result = host.restoreWebVisibleAnchor({
            sessionId: BASE_SESSION,
            anchor: {
                kind: 'item',
                itemId: 'row-2',
                itemOffsetPx: 50,
                messageId: null,
            },
        });

        expect(result).toEqual({ didAdjustScroll: true, status: 'restored' });
        expect(metrics.element.scrollTop).toBe(130);
        expect(lastWrite(bundle.recorded, 'scroll-write')).toMatchObject({
            type: 'scroll-write',
            writer: 'web-dom-restore',
            reason: 'entry-restore',
            mode: 'restore-anchor',
            targetOffsetY: 130,
            layoutHeight: 400,
            contentHeight: 1000,
        });
    });

    it('restoreWebVisibleAnchor requests a renderer scroll to the resolved item index when the web anchor ids are stale', () => {
        setPlatform('web');
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: true, sessionId: BASE_SESSION });
        const getLayout = vi.fn((index: number) => (
            index === 1 ? { x: 0, y: 160, width: 0, height: 100 } : undefined
        ));
        const node = createFakeScrollNode({ getLayout });
        const metrics = createFakeWebScrollMetrics({ clientHeight: 100, scrollHeight: 1000, scrollTop: 0 });
        Object.defineProperty(metrics.element, 'querySelectorAll', {
            configurable: true,
            value: () => [],
        });
        const bundle = buildDriverDeps({
            listData: {
                0: { id: 'row-1' },
                1: { id: 'new-runtime-m2' },
                2: { id: 'row-3' },
                length: 3,
            },
            node,
            telemetryPlatform: 'web',
            webMetrics: metrics,
        });
        const host = createHost({ controller, deps: bundle.deps });

        const result = host.restoreWebVisibleAnchor({
            sessionId: BASE_SESSION,
            anchor: {
                kind: 'message',
                itemId: 'old-runtime-m2',
                itemOffsetPx: 40,
                messageId: 'server-m2',
            },
            itemIndex: 1,
        });

        expect(result).toEqual({ didAdjustScroll: false, status: 'scroll_requested' });
        expect(getLayout).not.toHaveBeenCalled();
        expect(node.indexCalls).toEqual([{ index: 1, animated: false }]);
        expect(node.offsetCalls).toHaveLength(0);
        expect(metrics.element.scrollTop).toBe(0);
        expect(lastWrite(bundle.recorded, 'scroll-write')).toBeUndefined();
    });

    it('drops stale-session commands before driver side effects', () => {
        const controller = createTranscriptViewportCommandController();
        controller.resetForSession({ openEntryTransaction: false, sessionId: BASE_SESSION });
        controller.setCurrentSessionId('session-b');
        const bundle = buildDriverDeps();
        const host = createHost({ controller, deps: bundle.deps });

        const accepted = host.execute({
            kind: 'pin-bottom',
            sessionId: BASE_SESSION,
            reason: 'stream-append',
            mode: 'follow-bottom',
        });

        expect(accepted).toBe(false);
        expect(bundle.node.indexCalls).toHaveLength(0);
        expect(bundle.node.offsetCalls).toHaveLength(0);
        expect(bundle.recorded).toHaveLength(0);
    });
});

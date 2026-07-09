import { queryExactWebTranscriptDataTestId } from '@/components/sessions/transcript/webTranscriptDomTestId';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export const TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-item-';
export const TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-anchor-message-';
export const TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-anchor-tool-call-';
export const TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-anchor-tool-group-';

export type WebTranscriptPrependAnchor = Readonly<{
    metrics: WebTranscriptScrollMetrics;
    anchorTestId: string | null;
    anchorTop: number | null;
    itemTestId: string | null;
    itemTop: number | null;
    stabilizeForMs: number;
    userIntentAtMs: number;
    expiresAtMs: number;
}>;

export type WebTranscriptPrependRestoreResult = Readonly<{
    didAdjustScroll: boolean;
    strategy: 'anchor' | 'item' | 'growth' | 'none';
}>;

export type WebTranscriptViewportAnchorKind = 'message' | 'toolGroup' | 'item';

export type WebTranscriptViewportAnchor = Readonly<{
    kind: WebTranscriptViewportAnchorKind;
    messageId: string | null;
    itemId: string;
    itemOffsetPx: number;
}>;

export type WebTranscriptViewportAnchorRestoreResult = Readonly<{
    didAdjustScroll: boolean;
    // 'scroll_requested': anchor was not in the DOM and its rendered index is within the cold
    // list; scrollToIndex was called to bring it into the FlashList render window. The caller
    // should schedule a retry attempt (e.g. requestAnimationFrame) after FlashList re-renders.
    status: 'restored' | 'already_aligned' | 'not_found' | 'not_applied' | 'scroll_requested';
}>;

export type WebTranscriptScrollTopWriter = (targetScrollTop: number) => boolean;

export type WebTranscriptScrollTopWriteOptions = Readonly<{
    writeScrollTop: WebTranscriptScrollTopWriter;
}>;

export function readWebPrependAnchorTestIdSuffix(
    testId: string | null | undefined,
    prefix: string,
): string | null {
    if (!testId?.startsWith(prefix)) return null;
    const suffix = testId.slice(prefix.length);
    return suffix.length > 0 ? suffix : null;
}

function resolveElementByTestId(params: Readonly<{
    container: HTMLElement;
    anchorTestId: string;
}>): HTMLElement | null {
    const exactMatch = queryExactWebTranscriptDataTestId(params.container, params.anchorTestId);
    if (exactMatch.attempted) {
        return typeof HTMLElement !== 'undefined' && exactMatch.element instanceof HTMLElement ? exactMatch.element : null;
    }

    const nodes = params.container.querySelectorAll('[data-testid]');
    for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.getAttribute('data-testid') !== params.anchorTestId) continue;
        return node;
    }
    return null;
}

function resolveVisibleAnchorTop(params: Readonly<{
    container: HTMLElement;
    anchorTestId: string;
}>): number | null {
    if (typeof params.container.getBoundingClientRect !== 'function') return null;
    const anchorElement = resolveElementByTestId(params);
    if (!anchorElement) return null;
    const containerRect = params.container.getBoundingClientRect();
    const anchorRect = anchorElement.getBoundingClientRect();
    return anchorRect.top - containerRect.top;
}

function resolveAnchorFocusOffsetPx(containerHeight: number): number {
    const preferred = Math.round(containerHeight * 0.18);
    return Math.max(64, Math.min(128, preferred));
}

function resolveTrackedAnchorPrefix(testId: string | null): string | null {
    if (!testId) return null;
    if (testId.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
        return TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX;
    }
    if (testId.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
        return TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX;
    }
    if (testId.startsWith(TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
        return TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX;
    }
    if (testId.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
        return TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX;
    }
    return null;
}

function resolveViewportAnchorKindAndMessageId(testId: string): Readonly<{
    kind: WebTranscriptViewportAnchorKind;
    messageId: string | null;
}> | null {
    const messageId = readWebPrependAnchorTestIdSuffix(
        testId,
        TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX,
    );
    if (messageId) {
        return {
            kind: 'message',
            messageId,
        };
    }
    const toolGroupMessageId = readWebPrependAnchorTestIdSuffix(
        testId,
        TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX,
    );
    if (toolGroupMessageId) {
        return {
            kind: 'toolGroup',
            messageId: toolGroupMessageId,
        };
    }
    const toolCallMessageId = readWebPrependAnchorTestIdSuffix(
        testId,
        TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX,
    );
    if (toolCallMessageId) {
        return {
            kind: 'toolGroup',
            messageId: toolCallMessageId,
        };
    }
    if (testId.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
        return {
            kind: 'item',
            messageId: null,
        };
    }
    return null;
}

function resolveTranscriptItemIdFromTestId(testId: string | null): string | null {
    return readWebPrependAnchorTestIdSuffix(testId, TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX);
}

type VisibleAnchorCandidate = Readonly<{
    element: HTMLElement;
    height: number;
    testId: string;
    top: number;
}>;

type RankedVisibleAnchorCandidate = VisibleAnchorCandidate & Readonly<{
    distance: number;
}>;

type TrackedAnchorScan = Readonly<{
    bestAny: RankedVisibleAnchorCandidate | null;
    bestItem: RankedVisibleAnchorCandidate | null;
    bestStable: RankedVisibleAnchorCandidate | null;
    byTestId: Map<string, VisibleAnchorCandidate>;
}>;

function isStableTranscriptAnchorTestId(testId: string): boolean {
    return testId.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX) ||
        testId.startsWith(TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX) ||
        testId.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX);
}

function isTranscriptItemAnchorTestId(testId: string): boolean {
    return testId.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX);
}

function chooseCloserVisibleAnchor(
    current: RankedVisibleAnchorCandidate | null,
    candidate: RankedVisibleAnchorCandidate,
): RankedVisibleAnchorCandidate {
    if (current == null) return candidate;
    if (candidate.distance < current.distance) return candidate;
    if (candidate.distance > current.distance) return current;
    if (candidate.height < current.height) return candidate;
    if (candidate.height > current.height) return current;
    return candidate.top < current.top ? candidate : current;
}

function createTrackedAnchorScan(container: HTMLElement): TrackedAnchorScan | null {
    if (typeof container.getBoundingClientRect !== 'function') return null;
    const containerRect = container.getBoundingClientRect();
    const focusOffset = resolveAnchorFocusOffsetPx(containerRect.height);
    const byTestId = new Map<string, VisibleAnchorCandidate>();
    let bestAny: RankedVisibleAnchorCandidate | null = null;
    let bestItem: RankedVisibleAnchorCandidate | null = null;
    let bestStable: RankedVisibleAnchorCandidate | null = null;

    const nodes = container.querySelectorAll('[data-testid]');
    for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const testId = node.getAttribute('data-testid');
        if (!testId || !resolveTrackedAnchorPrefix(testId)) continue;

        const rect = node.getBoundingClientRect();
        const top = rect.top - containerRect.top;
        const bottom = rect.bottom - containerRect.top;
        const height = Math.max(0, rect.height);
        const candidate: VisibleAnchorCandidate = { element: node, height, testId, top };
        byTestId.set(testId, candidate);

        const overlapTop = Math.max(rect.top, containerRect.top);
        const overlapBottom = Math.min(rect.bottom, containerRect.bottom);
        if (overlapBottom - overlapTop <= 0) continue;

        const isOversizedCoarseToolGroup =
            testId.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX) &&
            height > containerRect.height;
        const distance =
            !isOversizedCoarseToolGroup && top <= focusOffset && bottom >= focusOffset
                ? 0
                : Math.min(Math.abs(focusOffset - top), Math.abs(focusOffset - bottom));
        const rankedCandidate = { ...candidate, distance };
        bestAny = chooseCloserVisibleAnchor(bestAny, rankedCandidate);
        if (isStableTranscriptAnchorTestId(testId)) {
            bestStable = chooseCloserVisibleAnchor(bestStable, rankedCandidate);
        }
        if (isTranscriptItemAnchorTestId(testId)) {
            bestItem = chooseCloserVisibleAnchor(bestItem, rankedCandidate);
        }
    }

    return { bestAny, bestItem, bestStable, byTestId };
}

function resolveContainingItemAnchorTestId(
    container: HTMLElement,
    anchorTestId: string | null,
): string | null {
    if (!anchorTestId) return null;
    const anchorElement = resolveElementByTestId({ container, anchorTestId });
    let current: HTMLElement | null = anchorElement?.parentElement ?? null;
    while (current && current !== container) {
        const testId = current.getAttribute('data-testid');
        if (testId?.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            return testId;
        }
        current = current.parentElement;
    }
    return null;
}

function resolveViewportRestoreItemAnchorTestId(
    container: HTMLElement,
    anchor: WebTranscriptViewportAnchor,
): string {
    const stableAnchorTestId =
        anchor.kind === 'message' && anchor.messageId
            ? `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${anchor.messageId}`
            : anchor.kind === 'toolGroup' && anchor.messageId
                ? `${TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX}${anchor.messageId}`
                : null;
    if (stableAnchorTestId) {
        const currentItemTestId = resolveContainingItemAnchorTestId(container, stableAnchorTestId);
        if (currentItemTestId) return currentItemTestId;
    }
    return `${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${anchor.itemId}`;
}

function resolveContainingItemAnchorTestIdFromScan(
    container: HTMLElement,
    scan: TrackedAnchorScan,
    anchorTestId: string | null,
): string | null {
    if (!anchorTestId) return null;
    let current: HTMLElement | null = scan.byTestId.get(anchorTestId)?.element.parentElement ?? null;
    while (current && current !== container) {
        const testId = current.getAttribute('data-testid');
        if (testId?.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            return testId;
        }
        current = current.parentElement;
    }
    return null;
}

function resolvePreferredItemAnchorTestIdFromScan(
    container: HTMLElement,
    scan: TrackedAnchorScan,
    anchorTestId: string | null,
): string | null {
    return resolveContainingItemAnchorTestIdFromScan(container, scan, anchorTestId) ?? scan.bestItem?.testId ?? null;
}

function resolveScannedAnchorTop(scan: TrackedAnchorScan, testId: string | null): number | null {
    if (!testId) return null;
    const candidate = scan.byTestId.get(testId);
    return candidate ? candidate.top : null;
}

function captureWebTranscriptAnchorSelection(container: HTMLElement): Readonly<{
    anchorTestId: string | null;
    anchorTop: number | null;
    itemTestId: string | null;
    itemTop: number | null;
}> {
    const scan = createTrackedAnchorScan(container);
    if (!scan) return { anchorTestId: null, anchorTop: null, itemTestId: null, itemTop: null };
    const anchorTestId = (scan.bestStable ?? scan.bestAny)?.testId ?? null;
    const itemTestId = resolvePreferredItemAnchorTestIdFromScan(container, scan, anchorTestId);
    return {
        anchorTestId,
        anchorTop: resolveScannedAnchorTop(scan, anchorTestId),
        itemTestId,
        itemTop: resolveScannedAnchorTop(scan, itemTestId),
    };
}

export function captureWebTranscriptViewportAnchor(params: Readonly<{
    container: HTMLElement;
}>): WebTranscriptViewportAnchor | null {
    const captured = captureWebTranscriptAnchorSelection(params.container);
    if (!captured.anchorTestId) return null;

    const anchorIdentity = resolveViewportAnchorKindAndMessageId(captured.anchorTestId);
    if (!anchorIdentity) return null;

    const itemId = resolveTranscriptItemIdFromTestId(captured.itemTestId);
    if (!itemId || !captured.itemTestId) return null;

    if (typeof captured.itemTop !== 'number' || !Number.isFinite(captured.itemTop)) return null;

    return {
        ...anchorIdentity,
        itemId,
        itemOffsetPx: captured.itemTop,
    };
}

/**
 * Read-only alignment check for a saved viewport anchor: same DOM resolution as
 * `restoreWebTranscriptViewportAnchor`, but never mutates scroll. Used by the entry-restore
 * transaction wiring to classify conclusive aligned|misaligned observations before spending
 * the single correction write.
 */
export function resolveWebTranscriptViewportAnchorAlignment(params: Readonly<{
    container: HTMLElement;
    anchor: WebTranscriptViewportAnchor;
    tolerancePx?: number;
}>): Readonly<{ status: 'aligned' | 'misaligned'; deltaPx: number }> | Readonly<{ status: 'not_found' }> {
    const itemTop = resolveVisibleAnchorTop({
        container: params.container,
        anchorTestId: resolveViewportRestoreItemAnchorTestId(params.container, params.anchor),
    });
    if (typeof itemTop !== 'number' || !Number.isFinite(itemTop)) {
        return { status: 'not_found' };
    }
    const deltaPx = Math.trunc(itemTop - params.anchor.itemOffsetPx);
    const tolerancePx = Math.max(0, Math.trunc(params.tolerancePx ?? 0));
    return {
        status: Math.abs(deltaPx) <= tolerancePx ? 'aligned' : 'misaligned',
        deltaPx,
    };
}

export function restoreWebTranscriptViewportAnchor(params: Readonly<{
    container: HTMLElement;
    anchor: WebTranscriptViewportAnchor;
}>, options: WebTranscriptScrollTopWriteOptions): WebTranscriptViewportAnchorRestoreResult {
    const itemTop = resolveVisibleAnchorTop({
        container: params.container,
        anchorTestId: resolveViewportRestoreItemAnchorTestId(params.container, params.anchor),
    });
    if (typeof itemTop !== 'number' || !Number.isFinite(itemTop)) {
        return { didAdjustScroll: false, status: 'not_found' };
    }

    const delta = Math.trunc(itemTop - params.anchor.itemOffsetPx);
    if (delta === 0) {
        return { didAdjustScroll: false, status: 'already_aligned' };
    }

    try {
        const targetScrollTop = params.container.scrollTop + delta;
        if (!Number.isFinite(targetScrollTop)) {
            return { didAdjustScroll: false, status: 'not_found' };
        }
        return options.writeScrollTop(targetScrollTop)
            ? { didAdjustScroll: true, status: 'restored' }
            : { didAdjustScroll: false, status: 'not_applied' };
    } catch {
        return { didAdjustScroll: false, status: 'not_found' };
    }
}

export function captureWebTranscriptPrependAnchor(params: Readonly<{
    metrics: WebTranscriptScrollMetrics;
    userIntentAtMs: number;
    stabilizeForMs: number;
}>): WebTranscriptPrependAnchor {
    const captured = captureWebTranscriptAnchorSelection(params.metrics.element);

    return {
        metrics: params.metrics,
        anchorTestId: captured.anchorTestId,
        anchorTop: captured.anchorTop,
        itemTestId: captured.itemTestId,
        itemTop: captured.itemTop,
        stabilizeForMs: Math.max(0, Math.trunc(params.stabilizeForMs)),
        userIntentAtMs: params.userIntentAtMs,
        expiresAtMs: Date.now() + Math.max(0, Math.trunc(params.stabilizeForMs)),
    };
}

export function restoreWebTranscriptPrependAnchor(
    anchor: WebTranscriptPrependAnchor,
    options: WebTranscriptScrollTopWriteOptions,
): WebTranscriptPrependRestoreResult {
    const { element } = anchor.metrics;

    const restoreFromScrollHeightGrowth = (): WebTranscriptPrependRestoreResult | null => {
        const nextScrollHeight = element.scrollHeight;
        // targetScrollTop = baseline scrollTop + any net scrollHeight growth.
        // When sh drops then recovers to the same level (growth = 0 or negative)
        // and the browser clamped scrollTop downward during the drop, the target
        // still equals the original baseline scrollTop.  The remainingGrowthPx
        // check below catches that case and writes the corrected value.
        const targetScrollTop = anchor.metrics.scrollTop + Math.max(0, nextScrollHeight - anchor.metrics.scrollHeight);
        if (!Number.isFinite(targetScrollTop)) return null;
        const remainingGrowthPx = Math.trunc(targetScrollTop - element.scrollTop);
        if (remainingGrowthPx <= 1) return null;
        try {
            return options.writeScrollTop(targetScrollTop)
                ? { didAdjustScroll: true, strategy: 'growth' }
                : { didAdjustScroll: false, strategy: 'none' };
        } catch {
            return { didAdjustScroll: false, strategy: 'none' };
        }
    };

    if (anchor.anchorTestId != null && anchor.anchorTop != null) {
        const nextTop = resolveVisibleAnchorTop({ container: element, anchorTestId: anchor.anchorTestId });
        if (typeof nextTop === 'number' && Number.isFinite(nextTop)) {
            const delta = Math.trunc(nextTop - anchor.anchorTop);
            if (delta !== 0) {
                try {
                    const targetScrollTop = element.scrollTop + delta;
                    if (!Number.isFinite(targetScrollTop)) {
                        return { didAdjustScroll: false, strategy: 'none' };
                    }
                    return options.writeScrollTop(targetScrollTop)
                        ? { didAdjustScroll: true, strategy: 'anchor' }
                        : { didAdjustScroll: false, strategy: 'none' };
                } catch {
                    return { didAdjustScroll: false, strategy: 'none' };
                }
            }
            return { didAdjustScroll: false, strategy: 'anchor' };
        }
    }

    if (anchor.itemTestId != null && anchor.itemTop != null) {
        const nextItemTop = resolveVisibleAnchorTop({ container: element, anchorTestId: anchor.itemTestId });
        if (typeof nextItemTop === 'number' && Number.isFinite(nextItemTop)) {
            const delta = Math.trunc(nextItemTop - anchor.itemTop);
            if (delta !== 0) {
                try {
                    const targetScrollTop = element.scrollTop + delta;
                    if (!Number.isFinite(targetScrollTop)) {
                        return { didAdjustScroll: false, strategy: 'none' };
                    }
                    return options.writeScrollTop(targetScrollTop)
                        ? { didAdjustScroll: true, strategy: 'item' }
                        : { didAdjustScroll: false, strategy: 'none' };
                } catch {
                    return { didAdjustScroll: false, strategy: 'none' };
                }
            }
            return { didAdjustScroll: false, strategy: 'item' };
        }
    }

    const growthResult = restoreFromScrollHeightGrowth();
    if (growthResult) return growthResult;
    return { didAdjustScroll: false, strategy: 'none' };
}

export function refreshWebTranscriptPrependAnchor(
    anchor: WebTranscriptPrependAnchor,
    metrics: WebTranscriptScrollMetrics,
    options?: Readonly<{
        adoptCurrentAnchorPosition?: boolean;
        recaptureAnchor?: boolean;
        recaptureItem?: boolean;
        resetExpiry?: boolean;
        preserveBaselineMetrics?: boolean;
        userIntentAtMs?: number;
    }>,
): WebTranscriptPrependAnchor {
    const shouldRecaptureAnchor = options?.recaptureAnchor === true;
    const shouldRecaptureItem = options?.recaptureItem === true || shouldRecaptureAnchor;
    const shouldRetargetAnchorForUserIntent =
        shouldRecaptureAnchor &&
        typeof options?.userIntentAtMs === 'number' &&
        Number.isFinite(options.userIntentAtMs) &&
        options.userIntentAtMs !== anchor.userIntentAtMs;
    let anchorTestId = anchor.anchorTestId;
    let anchorTop = anchor.anchorTop;
    let itemTestId = anchor.itemTestId;
    let itemTop = anchor.itemTop;
    if (shouldRecaptureItem) {
        const scan = createTrackedAnchorScan(metrics.element);
        if (scan) {
            if (shouldRecaptureAnchor) {
                const currentAnchorStillMounted =
                    shouldRetargetAnchorForUserIntent !== true &&
                    anchor.anchorTestId != null &&
                    scan.byTestId.has(anchor.anchorTestId);
                if (currentAnchorStillMounted && options?.adoptCurrentAnchorPosition === true) {
                    anchorTop = resolveScannedAnchorTop(scan, anchor.anchorTestId);
                } else if (!currentAnchorStillMounted) {
                    anchorTestId = (scan.bestStable ?? scan.bestAny)?.testId ?? null;
                    anchorTop = resolveScannedAnchorTop(scan, anchorTestId);
                }
            }
            itemTestId = resolvePreferredItemAnchorTestIdFromScan(metrics.element, scan, anchorTestId);
            itemTop = resolveScannedAnchorTop(scan, itemTestId);
            if (
                shouldRetargetAnchorForUserIntent !== true &&
                anchor.itemTestId != null &&
                scan.byTestId.has(anchor.itemTestId)
            ) {
                itemTestId = anchor.itemTestId;
                itemTop = options?.adoptCurrentAnchorPosition === true
                    ? resolveScannedAnchorTop(scan, anchor.itemTestId)
                    : anchor.itemTop;
            }
        } else {
            if (shouldRecaptureAnchor) {
                anchorTestId = null;
                anchorTop = null;
            }
            itemTestId = null;
            itemTop = null;
        }
    }

    return {
        ...anchor,
        anchorTestId,
        anchorTop,
        itemTestId,
        itemTop,
        metrics:
            options?.preserveBaselineMetrics === true
                ? {
                    ...metrics,
                    scrollTop: anchor.metrics.scrollTop,
                    scrollHeight: anchor.metrics.scrollHeight,
                }
                : metrics,
        userIntentAtMs:
            typeof options?.userIntentAtMs === 'number' && Number.isFinite(options.userIntentAtMs)
                ? options.userIntentAtMs
                : anchor.userIntentAtMs,
        expiresAtMs: options?.resetExpiry === true ? Date.now() + anchor.stabilizeForMs : anchor.expiresAtMs,
    };
}

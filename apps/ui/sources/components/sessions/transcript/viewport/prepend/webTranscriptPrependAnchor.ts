import { queryExactWebTranscriptDataTestId } from '@/components/sessions/transcript/webTranscriptDomTestId';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export const TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-item-';
export const TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-anchor-message-';
export const TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-anchor-tool-call-';
export const TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-anchor-tool-group-';

export type WebTranscriptViewportAnchorKind = 'message' | 'toolGroup' | 'item';

export type WebTranscriptViewportAnchor = Readonly<{
    kind: WebTranscriptViewportAnchorKind;
    messageId: string | null;
    itemId: string;
    itemOffsetPx: number;
}>;

export type WebTranscriptViewportAnchorRestoreResult = Readonly<{
    didAdjustScroll: boolean;
    // 'scroll_requested': the anchor belongs to the projected list but is outside the mounted
    // virtual window. The caller should retry after scrollToIndex materializes it.
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

/**
 * The one containment rule: an anchor element's position is the position of the transcript
 * ITEM that contains it. Capture and every later read walk this same chain, so the element a
 * capture measured is the element a later read can name.
 */
function resolveContainingItemElement(
    container: HTMLElement,
    anchorElement: HTMLElement | null,
): HTMLElement | null {
    let current: HTMLElement | null = anchorElement?.parentElement ?? null;
    while (current && current !== container) {
        const testId = current.getAttribute('data-testid');
        if (testId?.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}

/**
 * Resolves the element an anchor's `itemOffsetPx` was measured on.
 *
 * `itemId` is capture's own record of that element (`captureWebTranscriptAnchorSelection`
 * stores the top of `transcript-item-<itemId>`), so reading it back is what makes the stored
 * offset comparable at all. Anything else is a different element, and the CONSTANT distance
 * between the two is spent on the reader as a phantom scroll correction: a tool group rendered
 * as per-unit items carries `transcript-anchor-tool-group-<id>` in its `…#header` item and
 * `transcript-anchor-tool-call-<id>` in its `…#tool:<id>` item, both naming the same message
 * id, so an identity rebuilt from `kind` + `messageId` alone cannot say which was measured.
 * Rebuilding the tool-CALL anchor for every `toolGroup` anchor was the measured web
 * scroll-back (11/11 captured writes carried a `#header` anchor whose stored offset equalled
 * its own live top exactly, while the rebuilt element read 32/88/116 px away; 2026-08-04).
 *
 * The message-identity walk below is RECOVERY ONLY — it runs when the recorded item is no
 * longer mounted (a turn re-split, a tool group re-chunked), where no element can reproduce
 * the original measurement and placing the remembered message approximately is the best
 * available answer.
 */
function resolveViewportAnchorItemElement(
    container: HTMLElement,
    anchor: WebTranscriptViewportAnchor,
): HTMLElement | null {
    const measuredItem = resolveElementByTestId({
        container,
        anchorTestId: `${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${anchor.itemId}`,
    });
    if (measuredItem) return measuredItem;

    const stableAnchorTestId =
        anchor.kind === 'message' && anchor.messageId
            ? `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${anchor.messageId}`
            : anchor.kind === 'toolGroup' && anchor.messageId
                ? `${TRANSCRIPT_WEB_TOOL_CALL_PREPEND_ANCHOR_TEST_ID_PREFIX}${anchor.messageId}`
                : null;
    if (!stableAnchorTestId) return null;
    return resolveContainingItemElement(
        container,
        resolveElementByTestId({ container, anchorTestId: stableAnchorTestId }),
    );
}

function resolveViewportAnchorItemTop(
    container: HTMLElement,
    anchor: WebTranscriptViewportAnchor,
): number | null {
    if (typeof container.getBoundingClientRect !== 'function') return null;
    const itemElement = resolveViewportAnchorItemElement(container, anchor);
    if (!itemElement) return null;
    const top = itemElement.getBoundingClientRect().top - container.getBoundingClientRect().top;
    return Number.isFinite(top) ? top : null;
}

function resolveContainingItemAnchorTestIdFromScan(
    container: HTMLElement,
    scan: TrackedAnchorScan,
    anchorTestId: string | null,
): string | null {
    if (!anchorTestId) return null;
    const itemElement = resolveContainingItemElement(container, scan.byTestId.get(anchorTestId)?.element ?? null);
    return itemElement?.getAttribute('data-testid') ?? null;
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
    const itemTop = resolveViewportAnchorItemTop(params.container, params.anchor);
    if (itemTop === null) {
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
    const itemTop = resolveViewportAnchorItemTop(params.container, params.anchor);
    if (itemTop === null) {
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

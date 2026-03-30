import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

export const TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-item-';
export const TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX = 'transcript-anchor-message-';
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

function resolveElementByTestId(params: Readonly<{
    container: HTMLElement;
    anchorTestId: string;
}>): HTMLElement | null {
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
    if (testId.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX)) {
        return TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX;
    }
    return null;
}

function resolveClosestVisibleTestId(container: HTMLElement, matcher?: (testId: string) => boolean): string | null {
    if (typeof container.getBoundingClientRect !== 'function') return null;
    const containerRect = container.getBoundingClientRect();
    const focusOffset = resolveAnchorFocusOffsetPx(containerRect.height);
    const nodes = container.querySelectorAll('[data-testid]');
    let best: {
        testId: string;
        distance: number;
        height: number;
        top: number;
    } | null = null;

    for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        const testId = node.getAttribute('data-testid');
        if (!testId || !resolveTrackedAnchorPrefix(testId)) continue;
        if (matcher && !matcher(testId)) continue;

        const rect = node.getBoundingClientRect();
        const overlapTop = Math.max(rect.top, containerRect.top);
        const overlapBottom = Math.min(rect.bottom, containerRect.bottom);
        if (overlapBottom - overlapTop <= 0) continue;

        const top = rect.top - containerRect.top;
        const bottom = rect.bottom - containerRect.top;
        const height = Math.max(0, rect.height);
        const distance =
            top <= focusOffset && bottom >= focusOffset
                ? 0
                : Math.min(Math.abs(focusOffset - top), Math.abs(focusOffset - bottom));

        if (
            best == null
            || distance < best.distance
            || (distance === best.distance && height < best.height)
            || (distance === best.distance && height === best.height && top < best.top)
        ) {
            best = { testId, distance, height, top };
        }
    }

    return best?.testId ?? null;
}

function resolveFirstVisibleAnchorTestId(container: HTMLElement): string | null {
    return resolveClosestVisibleTestId(
        container,
        (testId) =>
            testId.startsWith(TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX) ||
            testId.startsWith(TRANSCRIPT_WEB_TOOL_GROUP_PREPEND_ANCHOR_TEST_ID_PREFIX),
    ) ?? resolveClosestVisibleTestId(container);
}

function resolveFirstVisibleItemAnchorTestId(container: HTMLElement): string | null {
    return resolveClosestVisibleTestId(
        container,
        (testId) => testId.startsWith(TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX),
    );
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

function resolvePreferredItemAnchorTestId(container: HTMLElement, anchorTestId: string | null): string | null {
    return resolveContainingItemAnchorTestId(container, anchorTestId) ?? resolveFirstVisibleItemAnchorTestId(container);
}

export function captureWebTranscriptPrependAnchor(params: Readonly<{
    metrics: WebTranscriptScrollMetrics;
    userIntentAtMs: number;
    stabilizeForMs: number;
}>): WebTranscriptPrependAnchor {
    const anchorTestId = resolveFirstVisibleAnchorTestId(params.metrics.element);
    const anchorTop =
        anchorTestId != null
            ? resolveVisibleAnchorTop({ container: params.metrics.element, anchorTestId })
            : null;
    const itemTestId = resolvePreferredItemAnchorTestId(params.metrics.element, anchorTestId);
    const itemTop =
        itemTestId != null
            ? resolveVisibleAnchorTop({ container: params.metrics.element, anchorTestId: itemTestId })
            : null;

    return {
        metrics: params.metrics,
        anchorTestId,
        anchorTop,
        itemTestId,
        itemTop,
        stabilizeForMs: Math.max(0, Math.trunc(params.stabilizeForMs)),
        userIntentAtMs: params.userIntentAtMs,
        expiresAtMs: Date.now() + Math.max(0, Math.trunc(params.stabilizeForMs)),
    };
}

export function restoreWebTranscriptPrependAnchor(anchor: WebTranscriptPrependAnchor): WebTranscriptPrependRestoreResult {
    const { element } = anchor.metrics;

    if (anchor.anchorTestId != null && anchor.anchorTop != null) {
        const nextTop = resolveVisibleAnchorTop({ container: element, anchorTestId: anchor.anchorTestId });
        if (typeof nextTop === 'number' && Number.isFinite(nextTop)) {
            const delta = Math.trunc(nextTop - anchor.anchorTop);
            if (delta !== 0) {
                try {
                    element.scrollTop += delta;
                    return { didAdjustScroll: true, strategy: 'anchor' };
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
                    element.scrollTop += delta;
                    return { didAdjustScroll: true, strategy: 'item' };
                } catch {
                    return { didAdjustScroll: false, strategy: 'none' };
                }
            }
            return { didAdjustScroll: false, strategy: 'item' };
        }
    }

    const nextScrollHeight = element.scrollHeight;
    const growth = Math.max(0, nextScrollHeight - anchor.metrics.scrollHeight);
    if (growth <= 0) return { didAdjustScroll: false, strategy: 'none' };
    try {
        element.scrollTop = anchor.metrics.scrollTop + growth;
        return { didAdjustScroll: true, strategy: 'growth' };
    } catch {
        return { didAdjustScroll: false, strategy: 'none' };
    }
}

export function refreshWebTranscriptPrependAnchor(
    anchor: WebTranscriptPrependAnchor,
    metrics: WebTranscriptScrollMetrics,
    options?: Readonly<{
        recaptureAnchor?: boolean;
        recaptureItem?: boolean;
        resetExpiry?: boolean;
        preserveBaselineMetrics?: boolean;
        userIntentAtMs?: number;
    }>,
): WebTranscriptPrependAnchor {
    const shouldRecaptureAnchor = options?.recaptureAnchor === true;
    const shouldRecaptureItem = options?.recaptureItem === true || shouldRecaptureAnchor;
    const anchorTestId = shouldRecaptureAnchor ? resolveFirstVisibleAnchorTestId(metrics.element) : anchor.anchorTestId;
    const anchorTop =
        shouldRecaptureAnchor && anchorTestId != null
            ? resolveVisibleAnchorTop({ container: metrics.element, anchorTestId })
            : (shouldRecaptureAnchor ? null : anchor.anchorTop);
    const itemTestId = shouldRecaptureItem
        ? resolvePreferredItemAnchorTestId(metrics.element, anchorTestId)
        : anchor.itemTestId;
    const itemTop =
        shouldRecaptureItem && itemTestId != null
            ? resolveVisibleAnchorTop({ container: metrics.element, anchorTestId: itemTestId })
            : (shouldRecaptureItem ? null : anchor.itemTop);

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

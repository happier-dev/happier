import { isWebElementScrollable, resolveWebScrollableElement } from '../../ui/scroll/resolveWebScrollableElement';

export type WebTranscriptScrollMetrics = Readonly<{
    element: HTMLElement;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}>;

export function resolveWebTranscriptScrollMetrics(params: Readonly<{
    root: HTMLElement | null | undefined;
    cachedElement?: HTMLElement | null | undefined;
    win: Window;
    minOverflowPx?: number;
    maxDescendants?: number;
    maxAncestors?: number;
    pick?: 'first' | 'best';
    score?: (el: HTMLElement) => number;
    allowRootFallback?: boolean;
}>): WebTranscriptScrollMetrics | null {
    const root = params.root ?? null;
    if (!root) return null;

    const minOverflowPx =
        typeof params.minOverflowPx === 'number' && Number.isFinite(params.minOverflowPx)
            ? Math.max(0, Math.trunc(params.minOverflowPx))
            : 50;

    const cachedElement = params.cachedElement ?? null;
    if (
        cachedElement
        && (cachedElement as any).isConnected !== false
        && typeof (root as any).contains === 'function'
        && (root as any).contains(cachedElement)
        && isWebElementScrollable({ el: cachedElement, win: params.win, minOverflowPx })
    ) {
        return {
            element: cachedElement,
            scrollTop: cachedElement.scrollTop,
            scrollHeight: cachedElement.scrollHeight,
            clientHeight: cachedElement.clientHeight,
        };
    }

    const element = resolveWebScrollableElement(root, {
        win: params.win,
        minOverflowPx,
        maxDescendants: params.maxDescendants,
        maxAncestors: params.maxAncestors,
        pick: params.pick ?? 'best',
        score: params.score,
    });
    if (!element) {
        if (params.allowRootFallback !== true) return null;
        return {
            element: root,
            scrollTop: root.scrollTop,
            scrollHeight: root.scrollHeight,
            clientHeight: root.clientHeight,
        };
    }

    return {
        element,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
    };
}

export function isWebTranscriptScrollable(metrics: WebTranscriptScrollMetrics, minOverflowPx = 1): boolean {
    const threshold = Number.isFinite(minOverflowPx) ? Math.max(0, Math.trunc(minOverflowPx)) : 1;
    return metrics.scrollHeight > metrics.clientHeight + threshold;
}

export function getWebTranscriptDistanceFromBottom(metrics: WebTranscriptScrollMetrics): number {
    return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function resolveWebTranscriptMaxScrollTop(metrics: WebTranscriptScrollMetrics): number {
    return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

export function isWebTranscriptAtVisualBottom(
    metrics: WebTranscriptScrollMetrics,
    tolerancePx = 0,
): boolean {
    const tolerance =
        typeof tolerancePx === 'number' && Number.isFinite(tolerancePx)
            ? Math.max(0, tolerancePx)
            : 0;
    return getWebTranscriptDistanceFromBottom(metrics) <= tolerance;
}

export function restoreWebTranscriptPrependByGrowth(metrics: WebTranscriptScrollMetrics): boolean {
    const nextScrollHeight = metrics.element.scrollHeight;
    const growth = Math.max(0, nextScrollHeight - metrics.scrollHeight);
    if (growth <= 0) return false;
    try {
        metrics.element.scrollTop = metrics.scrollTop + growth;
        return true;
    } catch {
        return false;
    }
}

import { queryExactWebTranscriptDataTestId } from '@/components/sessions/transcript/webTranscriptDomTestId';
import { TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX } from '@/components/sessions/transcript/webTranscriptPrependAnchor';
import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';

import {
    deriveWebTranscriptNavigationAnchorRows,
    type TranscriptNavigationRuntimeAnchor,
    type WebTranscriptNavigationAnchorRowSource,
} from './transcriptNavigationRuntimeAnchors';
import type { NavigationVisibilityStore } from './transcriptNavigationVisibilityStore';
import { deriveWebTranscriptVisibleAnchorFacts } from './webTranscriptVisibleAnchorFacts';

export type WebTranscriptNavigationVisibilityScrollIntent = Readonly<{ isTrusted: boolean }>;

type ScheduledObservation = Readonly<{
    anchors: readonly TranscriptNavigationRuntimeAnchor[];
    metrics: WebTranscriptScrollMetrics;
    scrollIntent: WebTranscriptNavigationVisibilityScrollIntent | null;
    store: NavigationVisibilityStore;
}>;

type AnchorElement = Pick<HTMLElement, 'getAttribute' | 'getBoundingClientRect'>;

const scheduledByStore = new WeakMap<NavigationVisibilityStore, {
    frame: ReturnType<typeof requestAnimationFrame>;
    observation: ScheduledObservation;
}>();

function escapeAttributeValue(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
        return CSS.escape(value);
    }
    return value.replace(/["\\]/g, '\\$&');
}

function buildRegisteredAnchorSelector(anchors: readonly TranscriptNavigationRuntimeAnchor[]): string | null {
    const testIds: string[] = [];
    const seen = new Set<string>();
    for (const anchor of anchors) {
        for (const messageId of anchor.messageIds) {
            const normalizedMessageId = typeof messageId === 'string' ? messageId.trim() : '';
            if (!normalizedMessageId) continue;
            const testId = `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${normalizedMessageId}`;
            if (seen.has(testId)) continue;
            seen.add(testId);
            testIds.push(testId);
        }
    }
    if (testIds.length === 0) return null;
    return testIds.map((testId) => `[data-testid="${escapeAttributeValue(testId)}"]`).join(',');
}

function isAnchorElement(value: unknown): value is AnchorElement {
    return typeof value === 'object' && value !== null
        && typeof (value as AnchorElement).getAttribute === 'function'
        && typeof (value as AnchorElement).getBoundingClientRect === 'function';
}

export function hasAnyWebTranscriptDataTestId(container: Element, testIds: readonly string[]): boolean {
    for (const testId of testIds) {
        const normalizedTestId = typeof testId === 'string' ? testId.trim() : '';
        if (!normalizedTestId) continue;
        if (queryExactWebTranscriptDataTestId(container, normalizedTestId).element) return true;
    }
    return false;
}

function queryRegisteredAnchorNodes(
    container: HTMLElement,
    anchors: readonly TranscriptNavigationRuntimeAnchor[],
): readonly AnchorElement[] {
    const nodes: AnchorElement[] = [];
    const seen = new Set<AnchorElement>();
    for (const anchor of anchors) {
        for (const messageId of anchor.messageIds) {
            const normalizedMessageId = typeof messageId === 'string' ? messageId.trim() : '';
            if (!normalizedMessageId) continue;
            const testId = `${TRANSCRIPT_WEB_MESSAGE_PREPEND_ANCHOR_TEST_ID_PREFIX}${normalizedMessageId}`;
            const exact = queryExactWebTranscriptDataTestId(container, testId);
            if (isAnchorElement(exact.element) && !seen.has(exact.element)) {
                seen.add(exact.element);
                nodes.push(exact.element);
            }
        }
    }
    if (nodes.length > 0) return nodes;

    const selector = buildRegisteredAnchorSelector(anchors);
    if (!selector || typeof container.querySelectorAll !== 'function') return [];
    return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(isAnchorElement);
}

export function observeWebTranscriptNavigationVisibility(params: ScheduledObservation): void {
    if (!params.store.hasSubscribers()) return;
    const anchors = params.anchors;
    if (anchors.length === 0) {
        params.store.set(null);
        return;
    }
    const getContainerRect = params.metrics.element.getBoundingClientRect?.bind(params.metrics.element);
    if (!getContainerRect) return;
    let containerRect: DOMRect | null = null;
    try {
        containerRect = getContainerRect() as DOMRect;
    } catch {
        return;
    }
    const rows: WebTranscriptNavigationAnchorRowSource[] = [];
    try {
        for (const node of queryRegisteredAnchorNodes(params.metrics.element, anchors)) {
            const testId = node.getAttribute('data-testid');
            const rect = node.getBoundingClientRect?.();
            if (!rect) continue;
            rows.push({
                testId,
                topPx: rect.top,
                bottomPx: rect.bottom,
            });
        }
    } catch {
        return;
    }
    const anchorRows = deriveWebTranscriptNavigationAnchorRows({
        anchors,
        rows,
    });
    const visibility = deriveWebTranscriptVisibleAnchorFacts({
        anchors,
        preferUserTurnAnchor: true,
        rows: anchorRows,
        scrollIntent: params.scrollIntent
            ? {
                isTrusted: params.scrollIntent.isTrusted,
                programmaticScrollActive: false,
            }
            : null,
        viewport: {
            topPx: containerRect.top,
            bottomPx: containerRect.top + params.metrics.clientHeight,
        },
    });
    params.store.set({
        currentAnchorId: visibility.currentAnchorId,
        visibleAnchorIds: visibility.visibleAnchorIds,
    });
}

export function resolveFirstVisibleWebAnchorTestId(params: Readonly<{
    anchors: readonly TranscriptNavigationRuntimeAnchor[];
    metrics: WebTranscriptScrollMetrics;
}>): string | undefined {
    if (params.anchors.length === 0) return undefined;
    const getContainerRect = params.metrics.element.getBoundingClientRect?.bind(params.metrics.element);
    if (!getContainerRect) return undefined;
    let containerRect: DOMRect | null = null;
    try {
        containerRect = getContainerRect() as DOMRect;
    } catch {
        return undefined;
    }
    const viewportTop = containerRect.top;
    const viewportBottom = containerRect.top + params.metrics.clientHeight;
    try {
        for (const node of queryRegisteredAnchorNodes(params.metrics.element, params.anchors)) {
            const testId = node.getAttribute('data-testid') ?? undefined;
            if (!testId) continue;
            const rect = node.getBoundingClientRect?.();
            if (!rect) continue;
            if (rect.bottom > viewportTop && rect.top < viewportBottom) {
                return testId;
            }
        }
    } catch {
        return undefined;
    }
    return undefined;
}

export function scheduleWebTranscriptNavigationVisibilityObservation(params: ScheduledObservation): void {
    if (!params.store.hasSubscribers()) return;
    const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as ReturnType<typeof requestAnimationFrame>;
    const caf = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame
        : (id: ReturnType<typeof requestAnimationFrame>) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    const existing = scheduledByStore.get(params.store);
    if (existing) {
        caf(existing.frame);
    }
    const frame = raf(() => {
        scheduledByStore.delete(params.store);
        observeWebTranscriptNavigationVisibility(params);
    });
    scheduledByStore.set(params.store, { frame, observation: params });
}

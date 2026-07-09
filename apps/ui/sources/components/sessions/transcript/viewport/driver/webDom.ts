import { resolveWebColdListScrollTarget } from '@/components/sessions/transcript/segments/resolveWebHotColdScrollDecision';
import { queryExactWebTranscriptDataTestId } from '@/components/sessions/transcript/webTranscriptDomTestId';
import { TRANSCRIPT_WEB_HOT_TAIL_ITEM_TEST_ID_PREFIX } from '@/components/sessions/transcript/web/WebTranscriptSplitFooter';
import {
    restoreWebTranscriptViewportAnchor,
    restoreWebTranscriptPrependAnchor,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
    type WebTranscriptPrependRestoreResult,
    type WebTranscriptViewportAnchorRestoreResult,
} from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';
import {
    getWebTranscriptDistanceFromBottom,
    isWebTranscriptScrollable,
    resolveWebTranscriptMaxScrollTop,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';
import type { TranscriptViewportCommand } from '@/components/sessions/transcript/viewport/transcriptViewportTypes';
import type {
    TranscriptViewportDriverDeps,
    TranscriptViewportDriverWriteResult,
    TranscriptViewportListData,
    WebDomMeasuredItemLayout,
    WebDomTranscriptItemAlignment,
} from './types';
import type { WebDomScrollObservation } from './webDomObservation';

type TestIdElement = Readonly<{
    getAttribute?: (name: string) => string | null;
    getBoundingClientRect?: () => Readonly<{ bottom: number; height?: number; top: number }>;
}>;

export function performWebDomViewportCommand(
    command: TranscriptViewportCommand,
    deps: TranscriptViewportDriverDeps,
): boolean {
    if (command.kind === 'pin-bottom') {
        deps.clearWebPrependRangeReserve();
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        return writeWebDomScrollTop({
            deps,
            metrics,
            mode: command.mode,
            reason: command.reason,
            targetScrollTop: metrics.scrollHeight,
            trigger: command.reason === 'prepend-restore' ? 'prepend-restore' : command.mode === 'jump-to-bottom' ? 'jump' : 'restore',
            writer: 'web-dom-bottom',
            distanceFromBottom: (landedScrollTop) => Math.max(0, Math.trunc(metrics.scrollHeight - metrics.clientHeight - landedScrollTop)),
        });
    }

    if (command.kind === 'preserve-live-tail-distance') {
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        const maxScrollTop = resolveWebTranscriptMaxScrollTop(metrics);
        const previousDistanceFromLiveTailPx = Math.max(0, Math.trunc(command.previousDistanceFromLiveTailPx));
        const targetScrollTop = Math.max(0, Math.min(maxScrollTop, maxScrollTop - previousDistanceFromLiveTailPx));
        if (Math.abs(targetScrollTop - metrics.scrollTop) < 0.5) return false;

        return writeWebDomScrollTop({
            deps,
            metrics,
            mode: command.mode,
            reason: command.reason,
            schedulerAuthorityReason: command.schedulerAuthorityReason,
            schedulerAuthorityWriter: command.schedulerAuthorityWriter,
            targetScrollTop,
            trigger: 'restore',
            writer: 'web-dom-bottom',
            distanceFromBottom: (landedScrollTop) => getWebTranscriptDistanceFromBottom({
                ...metrics,
                scrollTop: landedScrollTop,
            }),
        });
    }

    if (command.kind === 'restore-distance') {
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        const targetScrollTop = Math.max(0, resolveWebTranscriptMaxScrollTop(metrics) - command.distanceFromLiveTailPx);

        return writeWebDomScrollTop({
            deps,
            metrics,
            mode: command.mode,
            reason: command.reason,
            targetScrollTop,
            trigger: command.reason === 'prepend-restore' ? 'prepend-restore' : 'restore',
            writer: 'web-dom-restore',
            distanceFromBottom: () => command.distanceFromLiveTailPx,
        });
    }

    if (command.kind === 'restore-visible-anchor') {
        const result = performWebDomVisibleAnchorRestoreCommand(command, deps);
        return result.status === 'restored' || result.status === 'already_aligned';
    }

    if (command.kind === 'restore-web-prepend-anchor') {
        return performWebDomPrependAnchorRestoreCommand(command, deps).didAdjustScroll;
    }

    if (command.kind === 'restore-anchor' || command.kind === 'jump-to-seq') {
        let index = command.kind === 'jump-to-seq'
            ? (command.routeMessageId
                ? deps.resolveJumpToSeqIndex(
                    command.seq,
                    command.routeMessageId,
                    command.transcriptBlockIndex,
                    command.role,
                )
                : deps.resolveJumpToSeqIndex(command.seq))
            : deps.resolveRestoreAnchorIndex(command.target.anchor);
        if (typeof index !== 'number' || !Number.isFinite(index)) return false;
        const webHotColdCounts = deps.webHotColdCountsRef.current;
        let hotFooterItemId: string | null = null;
        if (webHotColdCounts.hotCount > 0 && index >= webHotColdCounts.coldCount) {
            // Web hot-tail footer target: footer rows render outside the recycler but still
            // mount their `transcript-item-<id>` testids, so an exact rect scroll onto the
            // target row itself beats the legacy "last cold row" clamp (which strands the
            // viewport one footer-height above the target).
            hotFooterItemId = resolveTranscriptViewportListDataItemIdAtIndex(deps.itemsRef.current, index);
        }
        if (webHotColdCounts.hotCount > 0 && !hotFooterItemId) {
            const target = resolveWebColdListScrollTarget({
                fullIndex: index,
                coldCount: webHotColdCounts.coldCount,
                reason: command.kind === 'jump-to-seq'
                    ? 'jump-to-seq'
                    : command.reason === 'prepend-restore'
                        ? 'prepend-recovery'
                        : 'restore-anchor',
            });
            if (target.kind === 'pin_to_bottom') {
                const metrics = deps.resolveWebScrollMetrics();
                if (!metrics) return false;
                return writeWebDomScrollTop({
                    deps,
                    metrics,
                    mode: command.mode,
                    reason: command.reason,
                    targetScrollTop: metrics.scrollHeight,
                    trigger: command.kind === 'jump-to-seq' ? 'jump' : command.reason === 'prepend-restore' ? 'prepend-restore' : 'restore',
                    writer: 'web-dom-bottom',
                    distanceFromBottom: (landedScrollTop) => getWebTranscriptDistanceFromBottom({
                        ...metrics,
                        scrollTop: landedScrollTop,
                    }),
                });
            }
            index = target.index;
        }

        const itemId = hotFooterItemId ?? resolveTranscriptViewportListDataItemIdAtIndex(deps.listDataRef.current, index);
        if (!itemId) return false;
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        if (
            command.kind === 'jump-to-seq'
            && !hotFooterItemId
            && !findWebTranscriptItemElement({ container: metrics.element, itemId })
        ) {
            // Unmounted jump target: after a data replacement (target-window activation) the
            // web recycler can keep its render window pinned to the previously measured range
            // and never mount the target index at any scrollTop. Ask the renderer to re-anchor
            // its window at the target; prepend/entry restores intentionally stay DOM-only so
            // they preserve the existing anchor-recovery ownership contract.
            try {
                deps.listRef.current?.scrollToIndex?.({ index, animated: false });
            } catch {
                // Renderer refusal is non-fatal; the DOM estimate write still applies.
            }
        }
        // Prefer measured-band extrapolation over the renderer's estimated layout for
        // unmounted targets; the estimate goes stale once measured rows shift content.
        // Hot-tail footer targets are always mounted but use a different testID prefix
        // (`transcript-web-hot-tail-item-*` vs `transcript-item-*`) so findWebTranscriptItemElement
        // cannot locate them. Read their rect directly via the hot-tail prefix so
        // scrollWebDomToTranscriptItem can use the measured layout path instead.
        const bandLayout = hotFooterItemId
            ? null
            : resolveWebBandExtrapolatedTranscriptItemLayout({
                container: metrics.element,
                listData: deps.listDataRef.current,
                scrollTop: metrics.scrollTop,
                targetIndex: index,
            });
        const itemLayout = hotFooterItemId
            ? readWebHotTailItemLayout(metrics.element, hotFooterItemId, metrics.scrollTop)
            : bandLayout ?? readScrollableChatListItemLayout(deps.listRef.current, index);
        const result = scrollWebDomToTranscriptItem({
            align: command.kind === 'jump-to-seq'
                ? command.align ?? { kind: 'center' }
                : { kind: 'top-with-item-offset', itemOffsetPx: command.target.itemOffsetPx },
            itemId,
            itemLayout,
            metrics,
            observation: deps.webDomObservation,
        });
        if (!result.ok) return false;
        deps.recordViewportTelemetryEvent({
            type: 'scroll-write',
            writer: 'web-dom-restore',
            reason: command.reason,
            mode: command.mode,
            targetOffsetY: result.targetScrollTop,
            layoutHeight: metrics.clientHeight,
            contentHeight: metrics.scrollHeight,
            distanceFromBottom: getWebTranscriptDistanceFromBottom({
                ...metrics,
                scrollTop: result.landedScrollTop,
            }),
            ...deps.resolveWebViewportTelemetryDiagnostics({
                metrics,
                programmaticWebWrite: true,
                scrollable: isWebTranscriptScrollable(metrics, 1),
                trigger: command.kind === 'jump-to-seq'
                    ? 'jump'
                    : command.reason === 'prepend-restore'
                        ? 'prepend-restore'
                        : 'restore',
            }),
        });
        return true;
    }

    return false;
}

export function performWebDomPrependAnchorRestoreCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-web-prepend-anchor' }>>,
    deps: TranscriptViewportDriverDeps,
): WebTranscriptPrependRestoreResult {
    const metrics = deps.resolveWebScrollMetrics();
    if (!metrics) return { didAdjustScroll: false, strategy: 'none' };
    return restoreWebTranscriptPrependAnchor(command.anchor, {
        writeScrollTop: (targetScrollTop) => writeWebDomScrollTop({
            deps,
            metrics,
            mode: command.mode,
            reason: command.reason,
            targetScrollTop,
            trigger: 'prepend-restore',
            writer: 'web-dom-restore',
            distanceFromBottom: (landedScrollTop) => getWebTranscriptDistanceFromBottom({
                ...metrics,
                scrollTop: landedScrollTop,
            }),
        }),
    });
}

export function performWebDomVisibleAnchorRestoreCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-visible-anchor' }>>,
    deps: TranscriptViewportDriverDeps,
): WebTranscriptViewportAnchorRestoreResult {
    const metrics = deps.resolveWebScrollMetrics();
    if (!metrics) return { didAdjustScroll: false, status: 'not_applied' };
    const directResult = restoreWebTranscriptViewportAnchor({
        container: metrics.element,
        anchor: {
            kind: command.target.anchor.kind,
            itemId: command.target.anchor.itemId,
            messageId: command.target.anchor.messageId ?? null,
            itemOffsetPx: command.target.itemOffsetPx,
        },
    }, {
        writeScrollTop: (targetScrollTop) => writeWebDomScrollTop({
            deps,
            metrics,
            mode: command.mode,
            reason: command.reason,
            targetScrollTop,
            trigger: 'restore',
            writer: 'web-dom-restore',
            distanceFromBottom: (landedScrollTop) => getWebTranscriptDistanceFromBottom({
                ...metrics,
                scrollTop: landedScrollTop,
            }),
        }),
    });
    if (directResult.status !== 'not_found') return directResult;

    const itemIndex = command.target.itemIndex;
    if (typeof itemIndex !== 'number' || !Number.isFinite(itemIndex)) return directResult;
    const normalizedIndex = Math.max(0, Math.trunc(itemIndex));
    // Hot-tail guard: FlashList excludes hot-tail items from listData on web. When the anchor
    // index falls in the hot tail the item won't be in the DOM and attempting any layout-based
    // scroll writes the wrong coordinates. Return not_found so the caller can use the
    // distance-from-bottom fallback instead.
    if (normalizedIndex >= deps.listDataRef.current.length) return directResult;
    // Anchor is within the cold list but was not found in the DOM on the first attempt.
    // FlashList only renders a virtual window of rows; the anchor may not yet be in that
    // window. Call scrollToIndex to bring it into view — FlashList will render the item and
    // change listContentHeight, triggering a retry attempt that will succeed via direct lookup.
    try {
        deps.listRef.current?.scrollToIndex?.({ index: normalizedIndex, animated: false });
    } catch {
        // scrollToIndex can throw when the item layout is not yet known; non-fatal.
    }
    return { didAdjustScroll: false, status: 'scroll_requested' };
}

export type WebDomLocalHeightChangeMode = 'follow-bottom' | 'preserve-position';

export type WebDomLocalHeightChangeResult =
    | Readonly<{
        ok: true;
        distanceFromBottom: number;
        landedScrollTop: number;
        previousScrollTop: number;
        targetScrollTop: number;
    }>
    | Readonly<{
        ok: false;
        previousScrollTop: number;
        reason: 'already_aligned' | 'no_growth' | 'write_failed';
        targetScrollTop?: number;
    }>;

export function restoreWebDomLocalHeightChange(params: Readonly<{
    capturedMetrics: WebTranscriptScrollMetrics;
    mode: WebDomLocalHeightChangeMode;
    observation: WebDomScrollObservation;
}>): WebDomLocalHeightChangeResult {
    const element = params.capturedMetrics.element;
    const liveMetrics: WebTranscriptScrollMetrics = {
        element,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
    };
    const previousScrollTop = liveMetrics.scrollTop;
    const targetScrollTop = params.mode === 'follow-bottom'
        ? resolveWebTranscriptMaxScrollTop(liveMetrics)
        : resolvePreservedWebLocalHeightScrollTop({
            capturedMetrics: params.capturedMetrics,
            liveMetrics,
        });
    if (targetScrollTop == null) {
        return {
            ok: false,
            previousScrollTop,
            reason: 'no_growth',
        };
    }
    if (targetScrollTop === previousScrollTop) {
        return {
            ok: false,
            previousScrollTop,
            reason: 'already_aligned',
            targetScrollTop,
        };
    }

    const write = params.observation.recordProgrammaticScrollTopWrite({
        element,
        targetScrollTop,
    });
    if (!write.ok) {
        return {
            ok: false,
            previousScrollTop,
            reason: 'write_failed',
            targetScrollTop,
        };
    }

    return {
        ok: true,
        distanceFromBottom: getWebTranscriptDistanceFromBottom({
            ...liveMetrics,
            scrollTop: write.landedScrollTop,
        }),
        landedScrollTop: write.landedScrollTop,
        previousScrollTop,
        targetScrollTop,
    };
}

export type WebDomPrependGrowthResult =
    | Readonly<{
        ok: true;
        distanceFromBottom: number;
        growthPx: number;
        landedScrollTop: number;
        previousScrollTop: number;
        targetScrollTop: number;
    }>
    | Readonly<{
        ok: false;
        previousScrollTop: number;
        reason: 'no_growth' | 'write_failed';
        targetScrollTop?: number;
    }>;

export function restoreWebDomPrependGrowth(params: Readonly<{
    capturedMetrics: WebTranscriptScrollMetrics;
    observation: WebDomScrollObservation;
}>): WebDomPrependGrowthResult {
    const element = params.capturedMetrics.element;
    const liveMetrics: WebTranscriptScrollMetrics = {
        element,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
    };
    const previousScrollTop = liveMetrics.scrollTop;
    const growthPx = Math.max(0, liveMetrics.scrollHeight - params.capturedMetrics.scrollHeight);
    if (growthPx <= 0) {
        return {
            ok: false,
            previousScrollTop,
            reason: 'no_growth',
        };
    }

    const targetScrollTop = params.capturedMetrics.scrollTop + growthPx;
    const write = params.observation.recordProgrammaticScrollTopWrite({
        element,
        targetScrollTop,
    });
    if (!write.ok) {
        return {
            ok: false,
            previousScrollTop,
            reason: 'write_failed',
            targetScrollTop,
        };
    }

    return {
        ok: true,
        distanceFromBottom: getWebTranscriptDistanceFromBottom({
            ...liveMetrics,
            scrollTop: write.landedScrollTop,
        }),
        growthPx,
        landedScrollTop: write.landedScrollTop,
        previousScrollTop,
        targetScrollTop,
    };
}

/**
 * Position estimate for an UNMOUNTED listData row, extrapolated from the rows that ARE
 * mounted in the DOM. FlashList layout estimates go stale the moment measured rows shift
 * real content — an estimate-space write then parks the viewport inside an unrendered gap
 * and re-issuing the same estimate never converges (live RG1/RG2 evidence). Measured
 * neighbors give a monotonically improving aim: interpolate between the nearest mounted
 * rows on each side of the target index, or extrapolate past the band edge using the
 * measured band's average row height.
 */
export function resolveWebBandExtrapolatedTranscriptItemLayout(params: Readonly<{
    container: HTMLElement;
    listData: TranscriptViewportListData;
    scrollTop: number;
    targetIndex: number;
}>): WebDomMeasuredItemLayout | null {
    if (typeof params.container.getBoundingClientRect !== 'function') return null;
    if (typeof params.container.querySelectorAll !== 'function') return null;
    const containerRect = params.container.getBoundingClientRect();
    const indexByTestId = new Map<string, number>();
    for (let index = 0; index < params.listData.length; index += 1) {
        const itemId = params.listData[index]?.id;
        if (typeof itemId === 'string' && itemId.length > 0) {
            indexByTestId.set(`${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${itemId}`, index);
        }
    }
    if (indexByTestId.size === 0) return null;

    let before: Readonly<{ index: number; top: number; height: number }> | null = null;
    let after: Readonly<{ index: number; top: number; height: number }> | null = null;
    let bandRowCount = 0;
    let bandHeightSum = 0;
    for (const node of params.container.querySelectorAll('[data-testid]')) {
        const element = node as unknown as TestIdElement;
        const testId = element.getAttribute?.('data-testid');
        if (!testId) continue;
        const index = indexByTestId.get(testId);
        if (index === undefined || typeof element.getBoundingClientRect !== 'function') continue;
        const rect = element.getBoundingClientRect();
        const top = rect.top - containerRect.top + params.scrollTop;
        const height = Math.max(0, typeof rect.height === 'number' && Number.isFinite(rect.height)
            ? rect.height
            : rect.bottom - rect.top);
        bandRowCount += 1;
        bandHeightSum += height;
        if (index === params.targetIndex) {
            return { y: top, height };
        }
        if (index < params.targetIndex) {
            if (!before || index > before.index) before = { index, top, height };
        } else if (!after || index < after.index) {
            after = { index, top, height };
        }
    }
    if (!before && !after) return null;
    const averageRowHeight = bandRowCount > 0 ? bandHeightSum / bandRowCount : 0;
    if (before && after && after.index > before.index) {
        const fraction = (params.targetIndex - before.index) / (after.index - before.index);
        return {
            y: before.top + fraction * (after.top - before.top),
            height: averageRowHeight || before.height,
        };
    }
    if (before) {
        const rowHeight = averageRowHeight || before.height;
        return { y: before.top + (params.targetIndex - before.index) * rowHeight, height: rowHeight };
    }
    const anchor = after as Readonly<{ index: number; top: number; height: number }>;
    const rowHeight = averageRowHeight || anchor.height;
    return { y: anchor.top - (anchor.index - params.targetIndex) * rowHeight, height: rowHeight };
}

export function scrollWebDomToTranscriptItem(params: Readonly<{
    align: WebDomTranscriptItemAlignment;
    itemId: string;
    itemLayout?: WebDomMeasuredItemLayout | null;
    metrics: WebTranscriptScrollMetrics;
    observation: WebDomScrollObservation;
}>): TranscriptViewportDriverWriteResult {
    const targetItem = findWebTranscriptItemElement({
        container: params.metrics.element,
        itemId: params.itemId,
    });
    if (!targetItem && params.itemLayout == null) return { ok: false, reason: 'not_found' };

    const targetScrollTop = targetItem
        ? resolveWebTranscriptItemTargetScrollTop({
            align: params.align,
            item: targetItem,
            metrics: params.metrics,
        })
        : resolveWebTranscriptMeasuredLayoutTargetScrollTop({
            align: params.align,
            itemLayout: params.itemLayout,
            metrics: params.metrics,
        });
    if (targetScrollTop == null) return { ok: false, reason: 'invalid_geometry' };

    const write = params.observation.recordProgrammaticScrollTopWrite({
        element: params.metrics.element,
        targetScrollTop,
    });
    if (!write.ok) return { ok: false, reason: 'write_failed' };

    return {
        ok: true,
        landedScrollTop: write.landedScrollTop,
        targetScrollTop,
    };
}

function writeWebDomScrollTop(params: Readonly<{
    deps: TranscriptViewportDriverDeps;
    distanceFromBottom: (landedScrollTop: number) => number;
    metrics: WebTranscriptScrollMetrics;
    mode: TranscriptViewportCommand['mode'];
    reason: Exclude<TranscriptViewportCommand, Readonly<{ kind: 'none' }> | Readonly<{ kind: 'skip-native-js-pin' }>>['reason'];
    schedulerAuthorityReason?: Extract<TranscriptViewportCommand, { kind: 'preserve-live-tail-distance' }>['schedulerAuthorityReason'];
    schedulerAuthorityWriter?: Extract<TranscriptViewportCommand, { kind: 'preserve-live-tail-distance' }>['schedulerAuthorityWriter'];
    targetScrollTop: number;
    trigger: 'prepend-restore' | 'jump' | 'restore';
    writer: 'web-dom-bottom' | 'web-dom-restore';
}>): boolean {
    const previousOffsetY = params.metrics.scrollTop;
    const write = params.deps.webDomObservation.recordProgrammaticScrollTopWrite({
        element: params.metrics.element,
        targetScrollTop: params.targetScrollTop,
    });
    if (!write.ok) return false;
    params.deps.recordViewportTelemetryEvent({
        type: 'scroll-write',
        writer: params.writer,
        reason: params.reason,
        mode: params.mode,
        targetOffsetY: write.landedScrollTop,
        previousOffsetY,
        ...(params.schedulerAuthorityReason ? { schedulerAuthorityReason: params.schedulerAuthorityReason } : {}),
        ...(params.schedulerAuthorityWriter ? { schedulerAuthorityWriter: params.schedulerAuthorityWriter } : {}),
        layoutHeight: params.metrics.clientHeight,
        contentHeight: params.metrics.scrollHeight,
        distanceFromBottom: params.distanceFromBottom(write.landedScrollTop),
        ...params.deps.resolveWebViewportTelemetryDiagnostics({
            metrics: params.metrics,
            programmaticWebWrite: true,
            scrollable: isWebTranscriptScrollable(params.metrics, 1),
            trigger: params.trigger,
        }),
    });
    return true;
}

function resolvePreservedWebLocalHeightScrollTop(params: Readonly<{
    capturedMetrics: WebTranscriptScrollMetrics;
    liveMetrics: WebTranscriptScrollMetrics;
}>): number | null {
    const growth = Math.max(0, params.liveMetrics.scrollHeight - params.capturedMetrics.scrollHeight);
    if (growth <= 0) return null;
    return params.capturedMetrics.scrollTop + growth;
}

function findWebTranscriptItemElement(params: Readonly<{
    container: HTMLElement;
    itemId: string;
}>): TestIdElement | null {
    const itemId = params.itemId.trim();
    if (!itemId) return null;
    const targetTestId = `${TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX}${itemId}`;
    const exactMatch = queryExactWebTranscriptDataTestId(params.container, targetTestId);
    if (exactMatch.attempted) return exactMatch.element as TestIdElement | null;

    const nodes = params.container.querySelectorAll('[data-testid]');
    for (const node of nodes) {
        const element = node as TestIdElement;
        if (element.getAttribute?.('data-testid') === targetTestId) {
            return element;
        }
    }
    return null;
}

function resolveWebTranscriptItemTargetScrollTop(params: Readonly<{
    align: WebDomTranscriptItemAlignment;
    item: TestIdElement;
    metrics: WebTranscriptScrollMetrics;
}>): number | null {
    if (typeof params.metrics.element.getBoundingClientRect !== 'function') return null;
    if (typeof params.item.getBoundingClientRect !== 'function') return null;

    const containerRect = params.metrics.element.getBoundingClientRect();
    const itemRect = params.item.getBoundingClientRect();
    const itemTop = itemRect.top - containerRect.top;
    const itemHeight = Number.isFinite(itemRect.height)
        ? Math.max(0, Number(itemRect.height))
        : Math.max(0, itemRect.bottom - itemRect.top);
    const targetScrollTop = params.align.kind === 'center'
        ? params.metrics.scrollTop + itemTop + itemHeight / 2 - params.metrics.clientHeight / 2
        : params.metrics.scrollTop + itemTop - params.align.itemOffsetPx;

    if (!Number.isFinite(targetScrollTop)) return null;
    return Math.max(0, Math.trunc(targetScrollTop));
}

function resolveWebTranscriptMeasuredLayoutTargetScrollTop(params: Readonly<{
    align: WebDomTranscriptItemAlignment;
    itemLayout: WebDomMeasuredItemLayout | null | undefined;
    metrics: WebTranscriptScrollMetrics;
}>): number | null {
    const y = params.itemLayout?.y;
    const height = params.itemLayout?.height;
    if (typeof y !== 'number' || !Number.isFinite(y)) return null;
    if (typeof height !== 'number' || !Number.isFinite(height)) return null;

    const targetScrollTop = params.align.kind === 'center'
        ? y + Math.max(0, height) / 2 - params.metrics.clientHeight / 2
        : y - params.align.itemOffsetPx;

    if (!Number.isFinite(targetScrollTop)) return null;
    return Math.max(0, Math.trunc(targetScrollTop));
}

function resolveTranscriptViewportListDataItemIdAtIndex(
    listData: TranscriptViewportListData,
    index: number,
): string | null {
    const item = listData[index];
    const itemId = item?.id;
    return typeof itemId === 'string' && itemId.trim().length > 0 ? itemId : null;
}

/**
 * Resolves the measured layout for a web hot-tail footer item. Hot-tail items are always
 * mounted in the DOM but use the `transcript-web-hot-tail-item-*` testID prefix rather
 * than `transcript-item-*`, so `findWebTranscriptItemElement` cannot locate them. This
 * helper uses the correct prefix and computes an absolute scroll-space `y` from the
 * element's bounding rect relative to the scroll container.
 */
function readWebHotTailItemLayout(
    container: HTMLElement,
    itemId: string,
    scrollTop: number,
): Readonly<{ height: number; y: number }> | null {
    if (typeof container.getBoundingClientRect !== 'function') return null;
    if (typeof container.querySelectorAll !== 'function') return null;
    const targetTestId = `${TRANSCRIPT_WEB_HOT_TAIL_ITEM_TEST_ID_PREFIX}${itemId}`;
    const exactMatch = queryExactWebTranscriptDataTestId(container, targetTestId);
    let element: TestIdElement | null = null;
    if (exactMatch.attempted) {
        element = exactMatch.element as TestIdElement | null;
    } else {
        for (const node of container.querySelectorAll('[data-testid]')) {
            const el = node as TestIdElement;
            if (el.getAttribute?.('data-testid') === targetTestId) {
                element = el;
                break;
            }
        }
    }
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    const containerRect = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const top = rect.top - containerRect.top + scrollTop;
    const height = Math.max(0, typeof rect.height === 'number' && Number.isFinite(rect.height)
        ? rect.height
        : rect.bottom - rect.top);
    if (!Number.isFinite(top) || !Number.isFinite(height)) return null;
    return { y: top, height };
}

function readScrollableChatListItemLayout(
    node: ScrollableChatListRef | null,
    index: number,
): Readonly<{ height: number; y: number }> | null {
    if (!node || typeof node.getLayout !== 'function') return null;
    try {
        const layout = node.getLayout(index);
        if (!layout) return null;
        if (!Number.isFinite(layout.y) || !Number.isFinite(layout.height)) return null;
        return {
            height: Math.max(0, layout.height),
            y: layout.y,
        };
    } catch {
        return null;
    }
}

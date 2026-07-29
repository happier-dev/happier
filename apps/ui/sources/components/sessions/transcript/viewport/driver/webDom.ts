import { queryExactWebTranscriptDataTestId } from '@/components/sessions/transcript/webTranscriptDomTestId';
import {
    restoreWebTranscriptViewportAnchor,
    TRANSCRIPT_WEB_PREPEND_ANCHOR_TEST_ID_PREFIX,
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

/**
 * Whether the renderer already owns the live tail through its held-'end' intent.
 * Tail-targeting driver writes defer while it is live: the renderer's
 * maintain-at-end + verifyLanding machinery is the ONE landing owner (native
 * pin-bottom already routes through the renderer via scrollRendererToEnd), and a
 * parallel DOM write reads a different scrollHeight snapshot mid-measure — the
 * captured session-open jiggle (2026-07-22, three writers chasing an oscillating
 * bottom).
 */
function rendererOwnsLiveWebTail(deps: TranscriptViewportDriverDeps): boolean {
    return deps.listRef.current?.hasLiveWebHold?.({ kind: 'end' }) === true;
}

function handBottomLandingToRenderer(deps: TranscriptViewportDriverDeps): boolean {
    const renderer = deps.listRef.current;
    if (typeof renderer?.hasLiveWebHold !== 'function' || typeof renderer.scrollToEnd !== 'function') {
        return false;
    }
    renderer.scrollToEnd({ animated: false });
    return true;
}

export function performWebDomViewportCommand(
    command: TranscriptViewportCommand,
    deps: TranscriptViewportDriverDeps,
): boolean {
    if (command.kind === 'pin-bottom') {
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        if (rendererOwnsLiveWebTail(deps)) return true;
        // Legend must own the first physical landing as well as steady follow. A
        // raw DOM write can clamp against the pre-mutation height without updating
        // Legend's maintain-at-end state, so subsequent streamed growth never
        // enters its threshold.
        if (handBottomLandingToRenderer(deps)) return true;
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

    if (command.kind === 'restore-distance') {
        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        // Distance 0 IS the live tail: same single-owner rule as pin-bottom /
        // pin-bottom. Detached distances stay transaction-owned.
        if (command.distanceFromLiveTailPx === 0 && rendererOwnsLiveWebTail(deps)) return true;
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

    if (command.kind === 'restore-anchor' || command.kind === 'jump-to-seq') {
        if (command.kind === 'jump-to-seq') {
            // An explicit user jump revokes tail ownership AT DISPATCH, not only at
            // landing: an out-of-window target pages older content in for seconds
            // before any landing write, and a surviving held-'end' re-pins to the
            // bottom through every prepend — the user is dragged away from where
            // they navigated (live capture 2026-07-23). The landing arms the keyed
            // anchor hold as the new owner; a landing already owned by a live
            // keyed hold defers below before this release can disturb it.
            if (deps.listRef.current?.hasLiveWebHold?.({ kind: 'end' }) === true) {
                deps.listRef.current?.releaseWebHeldIntent?.();
            }
        }
        const rendererTarget = deps.resolveRendererDataTarget(command);
        if (!rendererTarget) return false;
        const index = rendererTarget.kind === 'data'
            ? rendererTarget.index
            : rendererTarget.fallbackIndex;

        const metrics = deps.resolveWebScrollMetrics();
        if (!metrics) return false;
        if (index == null) {
            // Outside-data target with no fallback index: the only remaining semantic is the
            // visual end of the loaded window.
            if (rendererOwnsLiveWebTail(deps)) return true;
            return writeWebDomScrollTop({
                deps,
                metrics,
                mode: command.mode,
                reason: command.reason,
                targetScrollTop: metrics.scrollHeight,
                trigger: command.kind === 'jump-to-seq'
                    ? 'jump'
                    : command.reason === 'prepend-restore'
                        ? 'prepend-restore'
                        : 'restore',
                writer: 'web-dom-bottom',
                distanceFromBottom: (landedScrollTop) => getWebTranscriptDistanceFromBottom({
                    ...metrics,
                    scrollTop: landedScrollTop,
                }),
            });
        }
        const itemId = resolveTranscriptViewportListDataItemIdAtIndex(deps.listDataRef.current, index);
        if (!itemId) return false;
        if (
            command.kind === 'jump-to-seq'
            && deps.listRef.current?.hasLiveWebHold?.({ kind: 'item', itemId }) === true
        ) {
            // The renderer already holds this jump target (armed by the first landing
            // below): its keyed hold owns landing corrections through re-measure churn.
            // Re-writing here from the app-side re-verify loop creates a second landing
            // verifier and the two oscillate the viewport indefinitely (live capture
            // 2026-07-22: verifyLanding vs jump re-verify, ±24px every frame after a
            // nav-rail jump while pinned).
            return true;
        }
        if (
            command.kind === 'jump-to-seq'
            && !findWebTranscriptItemElement({ container: metrics.element, itemId })
        ) {
            // Unmounted jump target: after a data replacement (target-window activation) the
            // web recycler can keep its render window pinned to the previously measured range
            // and never mount the target index at any scrollTop. Ask the renderer to re-anchor
            // its window at the target; prepend/entry restores intentionally stay DOM-only so
            // they preserve the existing anchor-recovery ownership contract.
            try {
                deps.listRef.current?.scrollToIndex?.({ index: index ?? 0, animated: false });
            } catch {
                // Renderer refusal is non-fatal; the DOM estimate write still applies.
            }
        }
        // Prefer measured-band extrapolation over the renderer's estimated layout for
        // unmounted targets; the estimate goes stale once measured rows shift content.
        const bandLayout = resolveWebBandExtrapolatedTranscriptItemLayout({
            container: metrics.element,
            listData: deps.listDataRef.current,
            scrollTop: metrics.scrollTop,
            targetIndex: index,
        });
        const itemLayout = bandLayout ?? readScrollableChatListItemLayout(deps.listRef.current, index);
        // Pre-write reads for the jump anchor hold below: rects and scrollTop both
        // change once the write lands, but content-y (rect-derived + scrollTop at the
        // same instant) is scroll-invariant only when both are read together.
        const preWriteScrollTop = metrics.scrollTop;
        const holdTargetElement = command.kind === 'jump-to-seq'
            ? findWebTranscriptItemElement({ container: metrics.element, itemId })
            : null;
        const holdTargetRect = holdTargetElement?.getBoundingClientRect?.();
        const exactHoldItemContentY = holdTargetRect
            ? holdTargetRect.top - metrics.element.getBoundingClientRect().top + preWriteScrollTop
            : null;
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
        if (command.kind === 'jump-to-seq' && exactHoldItemContentY !== null) {
            // Take renderer ownership of the jump target, exactly like pin-bottom takes
            // the tail (scrollToEnd) and restore-anchor takes its anchor: the
            // armed hold REPLACES any index bootstrap left by an earlier unmounted
            // approach, leaving ONE landing owner with the re-measure machinery.
            // An estimate-only approach is not a completed landing: publishing its
            // extrapolated content-y as an anchor makes later landing passes defer before
            // the target has ever mounted.
            deps.listRef.current?.holdWebEntryAnchor?.({
                itemId,
                itemOffsetPx: Math.round(exactHoldItemContentY - result.targetScrollTop),
                kind: 'item',
                messageId: null,
                reason: command.reason,
            });
        }
        if (command.kind === 'restore-anchor') {
            // Legend web: entry/prepend anchor restores land against estimate-heavy geometry;
            // giant-row measurements can collapse the content several-fold right after the
            // write (live A->B->A: 25938px of estimates measured down to ~4903px, clamping
            // scrollTop and losing the restored row). Arm the renderer-owned bounded anchor
            // hold — the same contract restore-visible-anchor already uses — so measurement
            // signals keep re-verifying the restored identity.
            deps.listRef.current?.holdWebEntryAnchor?.({
                itemId,
                itemOffsetPx: command.target.itemOffsetPx,
                kind: command.target.anchor.kind,
                messageId: command.target.anchor.messageId ?? null,
                reason: command.reason,
            });
        }
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

export function performWebDomVisibleAnchorRestoreCommand(
    command: Extract<TranscriptViewportCommand, Readonly<{ kind: 'restore-visible-anchor' }>>,
    deps: TranscriptViewportDriverDeps,
): WebTranscriptViewportAnchorRestoreResult {
    const result = performWebDomVisibleAnchorRestoreCommandInner(command, deps);
    if (result.status === 'restored' || result.status === 'already_aligned') {
        // Legend web: arm the renderer-owned bounded anchor hold so post-restore row
        // remeasurement (estimate-heavy re-entry windows) cannot silently displace the
        // restored anchor.
        deps.listRef.current?.holdWebEntryAnchor?.({
            itemId: command.target.anchor.itemId,
            itemOffsetPx: command.target.itemOffsetPx,
            kind: command.target.anchor.kind,
            messageId: command.target.anchor.messageId ?? null,
            reason: command.reason,
        });
    }
    return result;
}

function performWebDomVisibleAnchorRestoreCommandInner(
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
    // The requested source index must belong to the current projected list. An out-of-projection
    // target has no valid DOM geometry, so leave it not_found for the caller's fallback.
    if (normalizedIndex >= deps.listDataRef.current.length) return directResult;
    // The anchor belongs to the projection but is outside the mounted virtual window.
    // Materialize it through scrollToIndex; the resulting layout/content signal retries
    // the direct keyed lookup against measured DOM geometry.
    try {
        deps.listRef.current?.scrollToIndex?.({
            index: normalizedIndex,
            animated: false,
            viewOffset: command.target.itemOffsetPx,
            viewPosition: 0,
            ...(command.reason === 'entry-restore'
                ? {
                    context: {
                        anchor: {
                            itemId: command.target.anchor.itemId,
                            itemOffsetPx: command.target.itemOffsetPx,
                            kind: command.target.anchor.kind,
                            messageId: command.target.anchor.messageId ?? null,
                            reason: command.reason,
                        },
                        kind: 'entry-placement' as const,
                    },
                }
                : {}),
        });
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
 * mounted in the DOM. Virtual layout estimates go stale the moment measured rows shift
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
    reason: Exclude<TranscriptViewportCommand, Readonly<{ kind: 'none' }>>['reason'];
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

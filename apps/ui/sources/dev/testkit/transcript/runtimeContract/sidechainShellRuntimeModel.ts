import {
    orientTranscriptListItems,
    resolveTranscriptListPresentation,
} from '@/components/sessions/transcript/listOrientation';
import {
    getWebTranscriptDistanceFromBottom,
    resolveWebTranscriptMaxScrollTop,
    type WebTranscriptScrollMetrics,
} from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import {
    createWebDomScrollObservation,
} from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import {
    applySidechainInitialBottomPinRequest,
    type SidechainInitialBottomPinSkipReason,
} from '@/components/sessions/transcript/viewport/shell/sidechainInitialBottomPin';

export type SidechainShellRuntimeItem = Readonly<{
    heightPx: number;
    id: string;
}>;

export type SidechainShellRuntimeModelOptions = Readonly<{
    estimatedItemSizePx: number;
    footerHeightPx?: number;
    initialScrollTopPx?: number;
    items: readonly SidechainShellRuntimeItem[];
    layoutHeightPx: number;
    platformOS: string;
}>;

export type SidechainInitialBottomPinResult =
    | Readonly<{ ok: false; reason: 'already_applied' | 'empty' | 'jump_target' | 'local_interaction' | 'not_ready' }>
    | Readonly<{
        method: 'estimated-offset-fallback' | 'scroll-to-index';
        ok: true;
        targetIndex: number;
        targetItemId: string;
        targetScrollTop: number;
    }>;

type RuntimeElement = {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
};

type WebLocalHeightMode = 'follow-bottom' | 'preserve-position';

function normalizeNonNegative(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

function mapSkipReason(
    reason: SidechainInitialBottomPinSkipReason,
): Exclude<SidechainInitialBottomPinResult, Readonly<{ ok: true }>>['reason'] {
    switch (reason) {
        case 'already-applied':
            return 'already_applied';
        case 'empty':
            return 'empty';
        case 'jump-target':
            return 'jump_target';
        case 'local-interaction':
            return 'local_interaction';
        case 'not-ready':
            return 'not_ready';
    }
}

class SidechainShellRuntimeModel {
    private readonly estimatedItemSizePx: number;
    private readonly footerHeightPx: number;
    private readonly renderedItems: readonly SidechainShellRuntimeItem[];
    private readonly dataOrder: 'oldest-first' | 'newest-first';
    private readonly element: RuntimeElement;
    private readonly observation = createWebDomScrollObservation();
    private layoutReady = false;
    private contentReady = false;
    private initialBottomPinAlreadyApplied = false;

    public constructor(options: SidechainShellRuntimeModelOptions) {
        const presentation = resolveTranscriptListPresentation({
            platformIsWeb: options.platformOS === 'web',
        });
        this.dataOrder = presentation.orientation === 'inverted' ? 'newest-first' : 'oldest-first';
        this.renderedItems = orientTranscriptListItems(options.items, presentation.orientation);
        this.estimatedItemSizePx = options.estimatedItemSizePx;
        this.footerHeightPx = normalizeNonNegative(options.footerHeightPx ?? 0);
        this.element = {
            clientHeight: options.layoutHeightPx,
            scrollHeight: this.contentHeightPx(),
            scrollTop: normalizeNonNegative(options.initialScrollTopPx ?? 0),
        };
        this.element.scrollTop = this.clampScrollTop(this.element.scrollTop);
    }

    public commitLayout(): void {
        this.layoutReady = true;
    }

    public commitContent(): void {
        this.contentReady = true;
        this.syncScrollHeight();
    }

    public requestInitialBottomPin(
        options: Readonly<{ simulateScrollToIndexFailure?: boolean }> = {},
    ): SidechainInitialBottomPinResult {
        const result = applySidechainInitialBottomPinRequest({
            alreadyApplied: this.initialBottomPinAlreadyApplied,
            contentHeightPx: this.contentReady ? this.element.scrollHeight : 0,
            dataOrder: this.dataOrder,
            deferredForLocalInteraction: false,
            estimatedItemSizePx: this.estimatedItemSizePx,
            hasJumpTarget: false,
            itemCount: this.renderedItems.length,
            layoutHeightPx: this.layoutReady ? this.element.clientHeight : 0,
            listRef: {
                scrollToIndex: ({ index }) => {
                    if (options.simulateScrollToIndexFailure === true) {
                        return {
                            catch: (onRejected: () => void) => {
                                onRejected();
                                return undefined;
                            },
                        };
                    }
                    this.writeScrollTop(this.targetScrollTopForItemBottom(index));
                    return undefined;
                },
                scrollToOffset: ({ offset }) => {
                    this.writeScrollTop(offset);
                },
            },
            setAlreadyApplied: (applied) => {
                this.initialBottomPinAlreadyApplied = applied;
            },
        });

        if (!result.ok) {
            return {
                ok: false,
                reason: mapSkipReason(result.reason),
            };
        }

        const targetIndex = result.plan.targetIndex;
        const targetItem = this.renderedItems[targetIndex];
        if (!targetItem) {
            return { ok: false, reason: 'empty' };
        }

        return {
            method: options.simulateScrollToIndexFailure === true
                ? 'estimated-offset-fallback'
                : 'scroll-to-index',
            ok: true,
            targetIndex,
            targetItemId: targetItem.id,
            targetScrollTop: this.element.scrollTop,
        };
    }

    public applyWebLocalHeightChange(params: Readonly<{
        growthPx: number;
        mode: WebLocalHeightMode;
    }>): Readonly<{
        echoIsGenuineUserMovement: boolean;
        targetScrollTop: number;
    }> {
        const previousScrollTop = this.element.scrollTop;
        const previousScrollHeight = this.element.scrollHeight;
        this.element.scrollHeight += normalizeNonNegative(params.growthPx);
        const targetScrollTop = params.mode === 'follow-bottom'
            ? resolveWebTranscriptMaxScrollTop(this.metrics())
            : previousScrollTop + Math.max(0, this.element.scrollHeight - previousScrollHeight);
        this.observation.recordProgrammaticScrollTopWrite({
            element: this.element as unknown as HTMLElement,
            targetScrollTop,
        });
        const movement = this.observation.observeGenuineScrollMovement({
            distanceFromBottom: getWebTranscriptDistanceFromBottom(this.metrics()),
            fallbackObservedScrollTop: null,
            isTrusted: true,
            metrics: this.metrics(),
            pinThresholdPx: 72,
            sustainFrames: 2,
        });
        return {
            echoIsGenuineUserMovement: movement.isGenuineUserMovement,
            targetScrollTop: this.element.scrollTop,
        };
    }

    private contentHeightPx(): number {
        return this.renderedItems.reduce((sum, item) => sum + normalizeNonNegative(item.heightPx), 0) + this.footerHeightPx;
    }

    private syncScrollHeight(): void {
        this.element.scrollHeight = this.contentHeightPx();
        this.element.scrollTop = this.clampScrollTop(this.element.scrollTop);
    }

    private targetScrollTopForItemBottom(index: number): number {
        let bottom = 0;
        for (let i = 0; i <= index && i < this.renderedItems.length; i += 1) {
            bottom += normalizeNonNegative(this.renderedItems[i]?.heightPx ?? 0);
        }
        return bottom - this.element.clientHeight;
    }

    private writeScrollTop(value: number): void {
        this.element.scrollTop = this.clampScrollTop(value);
    }

    private metrics(): WebTranscriptScrollMetrics {
        return {
            clientHeight: this.element.clientHeight,
            element: this.element as unknown as HTMLElement,
            scrollHeight: this.element.scrollHeight,
            scrollTop: this.element.scrollTop,
        };
    }

    private clampScrollTop(value: number): number {
        const maxScrollTop = Math.max(0, this.element.scrollHeight - this.element.clientHeight);
        return Math.max(0, Math.min(normalizeNonNegative(value), maxScrollTop));
    }
}

export function createSidechainShellRuntimeModel(
    options: SidechainShellRuntimeModelOptions,
): SidechainShellRuntimeModel {
    return new SidechainShellRuntimeModel(options);
}

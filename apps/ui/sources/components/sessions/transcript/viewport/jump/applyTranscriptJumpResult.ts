import type { TranscriptJumpResult, TranscriptJumpStrategy } from './transcriptJumpTargetTypes';

export type ApplyTranscriptJumpResultAdapters = Readonly<{
    scrollToIndex?: (params: Readonly<{
        index: number;
        target: TranscriptJumpStrategy['target'];
        seq: number | null;
        routeMessageId: string | null;
    }>) => boolean | void | Promise<boolean | void>;
    renderTargetWindow?: (params: Readonly<{
        target: TranscriptJumpStrategy['target'];
        targetSeq: number;
        direction: 'older' | 'newer' | null;
    }>) => { windowId: string } | { status: 'stale' } | null | Promise<{ windowId: string } | { status: 'stale' } | null>;
    pageTowardTarget?: (params: Readonly<{
        target: TranscriptJumpStrategy['target'];
        targetSeq: number;
        direction: 'older' | 'newer';
        nearestIndex: number;
        nearestSeq: number;
    }>) => TranscriptJumpResult | Promise<TranscriptJumpResult>;
}>;

export async function applyTranscriptJumpResult(params: Readonly<{
    strategy: TranscriptJumpStrategy;
    adapters: ApplyTranscriptJumpResultAdapters;
}>): Promise<TranscriptJumpResult> {
    switch (params.strategy.status) {
        case 'scroll-mounted':
            if (!params.adapters.scrollToIndex) return { status: 'not-found', reason: 'unsupported' };
            const applied = await params.adapters.scrollToIndex({
                index: params.strategy.index,
                target: params.strategy.target,
                seq: params.strategy.seq,
                routeMessageId: params.strategy.routeMessageId,
            });
            if (applied === false) return { status: 'not-found', reason: 'unavailable' };
            return { status: 'scrolled', target: params.strategy.target };
        case 'page-nearby':
            if (!params.adapters.pageTowardTarget) return { status: 'not-found', reason: 'unsupported' };
            return params.adapters.pageTowardTarget({
                target: params.strategy.target,
                targetSeq: params.strategy.targetSeq,
                direction: params.strategy.direction,
                nearestIndex: params.strategy.nearestIndex,
                nearestSeq: params.strategy.nearestSeq,
            });
        case 'render-target-window': {
            if (!params.adapters.renderTargetWindow) return { status: 'not-found', reason: 'unsupported' };
            const rendered = await params.adapters.renderTargetWindow({
                target: params.strategy.target,
                targetSeq: params.strategy.targetSeq,
                direction: params.strategy.direction,
            });
            if (!rendered) return { status: 'not-found', reason: 'unavailable' };
            if ('status' in rendered && rendered.status === 'stale') return { status: 'aborted' };
            if (!('windowId' in rendered)) return { status: 'not-found', reason: 'unavailable' };
            return {
                status: 'window-rendered',
                target: params.strategy.target,
                windowId: rendered.windowId,
            };
        }
        case 'resolved-only':
            return {
                status: 'resolved-only',
                target: params.strategy.target,
                routeMessageId: params.strategy.routeMessageId,
                seq: params.strategy.seq,
            };
        case 'not-found':
            return { status: 'not-found', reason: params.strategy.reason };
        case 'deferred':
            return { status: 'not-found', reason: 'unsupported' };
        case 'aborted':
            return { status: 'aborted' };
    }
}

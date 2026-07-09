import type {
    TranscriptJumpScope,
    TranscriptJumpStrategy,
    TranscriptJumpTarget,
    TranscriptJumpTargetIndexResult,
} from './transcriptJumpTargetTypes';

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    return Math.trunc(value);
}

function seqFromTarget(target: TranscriptJumpTarget): number | null {
    return target.kind === 'seq' ? normalizeSeq(target.seq) : normalizeSeq(target.seqHint);
}

function isInvalidTarget(target: TranscriptJumpTarget): boolean {
    if (target.kind === 'seq') return normalizeSeq(target.seq) === null;
    return typeof target.routeMessageId !== 'string' || target.routeMessageId.length === 0;
}

export function resolveTranscriptJumpStrategy(params: Readonly<{
    target: TranscriptJumpTarget;
    scope: TranscriptJumpScope;
    targetIndex: TranscriptJumpTargetIndexResult;
    mode: 'mounted-list' | 'resolve-only';
    nearbySeqThreshold: number;
    canRenderTargetWindow: boolean;
    sidechainExecution?: 'available' | 'defer';
    aborted?: boolean;
}>): TranscriptJumpStrategy {
    if (params.aborted) {
        return { status: 'aborted', target: params.target };
    }

    if (isInvalidTarget(params.target)
        || (params.targetIndex.status === 'not-found' && params.targetIndex.reason === 'invalid-target')) {
        return { status: 'not-found', target: params.target, reason: 'invalid-target' };
    }

    if (params.scope.kind === 'sidechain' && params.sidechainExecution === 'defer') {
        return {
            status: 'deferred',
            target: params.target,
            reason: 'sidechain-executor-unavailable',
        };
    }

    if (params.mode === 'resolve-only') {
        if (params.target.kind === 'route-message-id') {
            return {
                status: 'resolved-only',
                target: params.target,
                routeMessageId: params.target.routeMessageId,
                seq: normalizeSeq(params.target.seqHint),
            };
        }
        if (params.targetIndex.status === 'found' && params.targetIndex.routeMessageId) {
            return {
                status: 'resolved-only',
                target: params.target,
                routeMessageId: params.targetIndex.routeMessageId,
                seq: params.targetIndex.seq,
            };
        }
        return { status: 'not-found', target: params.target, reason: 'unavailable' };
    }

    if (params.targetIndex.status === 'found') {
        return {
            status: 'scroll-mounted',
            target: params.target,
            index: params.targetIndex.index,
            seq: params.targetIndex.seq,
            routeMessageId: params.targetIndex.routeMessageId,
        };
    }

    if (params.targetIndex.status === 'nearest') {
        const distance = Math.abs(params.targetIndex.seq - params.targetIndex.targetSeq);
        const nearbySeqThreshold = Math.max(0, Math.trunc(params.nearbySeqThreshold));
        if (distance > nearbySeqThreshold && params.canRenderTargetWindow) {
            return {
                status: 'render-target-window',
                target: params.target,
                direction: null,
                targetSeq: params.targetIndex.targetSeq,
            };
        }
        return {
            status: 'scroll-mounted',
            target: params.target,
            index: params.targetIndex.index,
            seq: params.targetIndex.seq,
            routeMessageId: null,
        };
    }

    if (params.targetIndex.status === 'unresolved') {
        const distance = Math.abs(params.targetIndex.nearestSeq - params.targetIndex.targetSeq);
        const nearbySeqThreshold = Math.max(0, Math.trunc(params.nearbySeqThreshold));
        if (distance <= nearbySeqThreshold) {
            return {
                status: 'page-nearby',
                target: params.target,
                direction: params.targetIndex.direction,
                targetSeq: params.targetIndex.targetSeq,
                nearestIndex: params.targetIndex.nearestIndex,
                nearestSeq: params.targetIndex.nearestSeq,
            };
        }
        if (params.canRenderTargetWindow) {
            return {
                status: 'render-target-window',
                target: params.target,
                direction: params.targetIndex.direction,
                targetSeq: params.targetIndex.targetSeq,
            };
        }
        return { status: 'not-found', target: params.target, reason: 'unavailable' };
    }

    const targetSeq = seqFromTarget(params.target);
    if (params.canRenderTargetWindow && targetSeq != null) {
        return {
            status: 'render-target-window',
            target: params.target,
            direction: null,
            targetSeq,
        };
    }

    return { status: 'not-found', target: params.target, reason: params.targetIndex.reason };
}

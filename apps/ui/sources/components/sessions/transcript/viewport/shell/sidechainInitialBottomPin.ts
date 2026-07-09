import {
    performSidechainIndexCommand,
    type SidechainListCommandRef,
} from '@/components/sessions/transcript/viewport/driver/sidechainListCommands';
import type { TranscriptListShellDataOrder } from './transcriptListShellCapabilities';

export type SidechainInitialBottomPinSkipReason =
    | 'already-applied'
    | 'empty'
    | 'jump-target'
    | 'local-interaction'
    | 'not-ready';

export type SidechainInitialBottomPinPlan =
    | Readonly<{ ok: false; reason: SidechainInitialBottomPinSkipReason }>
    | Readonly<{
        ok: true;
        targetIndex: number;
    }>;

export type SidechainInitialBottomPinListRef = SidechainListCommandRef;

export type SidechainInitialBottomPinRequestResult =
    | Readonly<{ ok: false; reason: SidechainInitialBottomPinSkipReason }>
    | Readonly<{
        applied: boolean;
        ok: true;
        plan: Extract<SidechainInitialBottomPinPlan, { ok: true }>;
    }>;

export function resolveSidechainInitialBottomPinPlan(params: Readonly<{
    alreadyApplied: boolean;
    contentHeightPx: number;
    dataOrder: TranscriptListShellDataOrder;
    deferredForLocalInteraction: boolean;
    estimatedItemSizePx: number;
    hasJumpTarget: boolean;
    itemCount: number;
    layoutHeightPx: number;
}>): SidechainInitialBottomPinPlan {
    if (params.hasJumpTarget) return { ok: false, reason: 'jump-target' };
    if (params.alreadyApplied) return { ok: false, reason: 'already-applied' };
    if (params.deferredForLocalInteraction) return { ok: false, reason: 'local-interaction' };
    if (!Number.isFinite(params.itemCount) || params.itemCount <= 0) {
        return { ok: false, reason: 'empty' };
    }
    if (
        !Number.isFinite(params.layoutHeightPx) ||
        params.layoutHeightPx <= 0 ||
        !Number.isFinite(params.contentHeightPx) ||
        params.contentHeightPx <= 0
    ) {
        return { ok: false, reason: 'not-ready' };
    }

    const targetIndex = params.dataOrder === 'newest-first'
        ? 0
        : Math.trunc(params.itemCount) - 1;
    return {
        ok: true,
        targetIndex,
    };
}

export function applySidechainInitialBottomPin(params: Readonly<{
    estimatedItemSizePx: number;
    listRef: SidechainInitialBottomPinListRef | null | undefined;
    plan: SidechainInitialBottomPinPlan;
}>): boolean {
    if (!params.plan.ok) return false;
    return performSidechainIndexCommand({
        animated: false,
        estimatedItemSizePx: params.estimatedItemSizePx,
        listRef: params.listRef,
        targetIndex: params.plan.targetIndex,
        viewPosition: 1,
    });
}

export function applySidechainInitialBottomPinRequest(params: Readonly<{
    alreadyApplied: boolean;
    contentHeightPx: number;
    dataOrder: TranscriptListShellDataOrder;
    deferredForLocalInteraction: boolean;
    estimatedItemSizePx: number;
    hasJumpTarget: boolean;
    itemCount: number;
    layoutHeightPx: number;
    listRef: SidechainInitialBottomPinListRef | null | undefined;
    setAlreadyApplied: (applied: boolean) => void;
}>): SidechainInitialBottomPinRequestResult {
    const plan = resolveSidechainInitialBottomPinPlan({
        alreadyApplied: params.alreadyApplied,
        contentHeightPx: params.contentHeightPx,
        dataOrder: params.dataOrder,
        deferredForLocalInteraction: params.deferredForLocalInteraction,
        estimatedItemSizePx: params.estimatedItemSizePx,
        hasJumpTarget: params.hasJumpTarget,
        itemCount: params.itemCount,
        layoutHeightPx: params.layoutHeightPx,
    });
    if (!plan.ok) return plan;

    params.setAlreadyApplied(true);
    return {
        applied: applySidechainInitialBottomPin({
            estimatedItemSizePx: params.estimatedItemSizePx,
            listRef: params.listRef,
            plan,
        }),
        ok: true,
        plan,
    };
}

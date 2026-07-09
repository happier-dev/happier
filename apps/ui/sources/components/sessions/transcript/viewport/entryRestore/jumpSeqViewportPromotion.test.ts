import { describe, expect, it } from 'vitest';

import { resolveJumpSeqViewportPromotion } from './jumpSeqViewportPromotion';
import type { SessionViewportAnchorSnapshot } from '@/sync/sync';

function createMetrics(): Parameters<typeof resolveJumpSeqViewportPromotion>[0]['metrics'] {
    const element = {
        getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 }),
        querySelectorAll: () => [],
        querySelector: () => null,
    } as unknown as HTMLElement;
    return {
        element,
        scrollTop: 9_000,
        scrollHeight: 17_000,
        clientHeight: 400,
    } as never;
}

function anchorWithSeq(seq: number): SessionViewportAnchorSnapshot {
    return {
        kind: 'message',
        itemId: `it-${seq}`,
        messageId: `m-${seq}`,
        itemOffsetPx: 60,
        seq,
    } as unknown as SessionViewportAnchorSnapshot;
}

const baseParams = {
    currentSessionId: 'session-1',
    distanceFromBottom: 7_000,
    pendingSeq: 331,
    pendingSessionId: 'session-1',
    pinThresholdPx: 40,
    scrollOffsetPx: 9_000,
};

describe('resolveJumpSeqViewportPromotion anchor validity', () => {
    it('keeps a near-target anchor: a landed viewport anchors on a NEIGHBOR row, not the exact seq', () => {
        // Live RG4 evidence: after a correct 331 landing the first visible anchor row is a
        // nearby seq (329/330). Rejecting it as stale drops the whole promotion and leaves a
        // stale pinned bottom-follow state committed mid-landing (pill dead, anchor never
        // persisted).
        const result = resolveJumpSeqViewportPromotion({
            ...baseParams,
            metrics: createMetrics(),
            requireRestorableAnchor: true,
            resolveAnchorSeq: (anchor) => (anchor as { seq?: number } | null)?.seq ?? null,
            stampAnchor: () => anchorWithSeq(329),
        });

        expect(result.status).toBe('promote');
        expect(result.status === 'promote' && (result.state.anchor as { seq?: number } | null)?.seq).toBe(329);
    });

    it('drops a far-from-target anchor (wrong-space capture) but keeps the released classification', () => {
        const result = resolveJumpSeqViewportPromotion({
            ...baseParams,
            metrics: createMetrics(),
            requireRestorableAnchor: true,
            resolveAnchorSeq: (anchor) => (anchor as { seq?: number } | null)?.seq ?? null,
            stampAnchor: () => anchorWithSeq(410),
        });

        // A wrong-space capture must not promote at all (neither anchor nor viewport
        // classification) and must keep the pending promotion armed for a later capture.
        expect(result.status).toBe('wrong-space-anchor');
    });

    it('classifies a far anchor as wrong-space even when a restorable anchor is not required', () => {
        const result = resolveJumpSeqViewportPromotion({
            ...baseParams,
            metrics: createMetrics(),
            resolveAnchorSeq: (anchor) => (anchor as { seq?: number } | null)?.seq ?? null,
            stampAnchor: () => anchorWithSeq(410),
        });

        expect(result.status).toBe('wrong-space-anchor');
    });
});

/**
 * Automatic bottom-follow suppression for a reader who PARKED away from the live tail.
 *
 * The reported symptom is "I scroll, the scroll ENDS, and then it moves back". Every
 * input-recency predicate in this corridor — `isLive`'s 320ms continuation window and the 250ms
 * auto-pin delay — is FALSE by then, so no event window of any length can express the fact that
 * has to hold: the reader left the live tail under their own hand and has not come back. That is
 * STATE, owned by `createTranscriptUserScrollIntentOwner`, and it does not decay.
 *
 * `applyAuthorizedBottomFollowWrite` is this host's single choke point for every automatic write
 * (here it issues a FORCED `pin-bottom`, so an unauthorized fire moves the reader by exactly how
 * far they had scrolled up). The suppression is a decision NOT to write — never a window, cover or
 * delay that hides movement.
 */
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { createTranscriptUserScrollIntentOwner } from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';
import { useTranscriptBottomFollowHost } from './useTranscriptBottomFollowHost';

type BottomFollowHostDeps = Parameters<typeof useTranscriptBottomFollowHost>[0];

const PIN_THRESHOLD_PX = 72;

function createRef<T>(current: T): { current: T } {
    return { current };
}

function buildDeps(userScrollIntent: ReturnType<typeof createTranscriptUserScrollIntentOwner>) {
    const executeViewportCommand = vi.fn(() => true);
    const authorizeImmediateBottomFollowWriteRef = createRef<
        (writer: string, reason: string) => boolean
    >(() => false);
    const deps = {
        applyFollowBottomIntentTakeoverApplyEffects: vi.fn(),
        applyNativeExplicitJumpConfirmationEffects: vi.fn(),
        authorizeImmediateBottomFollowWriteRef,
        commitBottomFollowModeState: vi.fn(),
        commitExplicitReturnToLiveTailState: vi.fn(),
        commitScrollPinState: vi.fn(),
        currentBottomFollowModeStateRef: createRef({ dragSession: null, mode: 'following' as const }),
        executeViewportCommand,
        followBottomIntentKey: null,
        invalidateViewportAnchorCapture: vi.fn(),
        isPinnedRef: createRef(true),
        latestCommittedActivityKey: 'activity-1',
        lifecycleHost: {
            clearNativeExplicitJumpConfirmation: vi.fn(),
            getMountSettleSnapshot: vi.fn(() => ({ isMountSettleActive: false })),
            observeNativeScrollConfirmation: vi.fn(() => ({
                consumed: false,
                entrySettleEffects: [],
                explicitJumpEffects: [],
            })),
            planFollowBottomIntentTakeover: vi.fn(() => ({
                followBottomIntentTakeoverEffects: [],
                state: { bottomFollowState: { dragSession: null, mode: 'following' as const } },
            })),
        },
        nativeMountSettleDeadlineReachedRef: createRef(false),
        pinEnabled: true,
        pinThresholdPx: PIN_THRESHOLD_PX,
        // The real command shape matters: an unauthorized write is a forced pin-bottom.
        resolveViewportCommand: vi.fn((input: unknown) => input),
        scrollPinRef: createRef({ isPinned: true, lastActivityKey: null, newActivityCount: 0 }),
        sessionId: 's1',
        tryPinToBottomDom: vi.fn(() => true),
        userScrollIntent,
        wantsPinnedRef: createRef(true),
    } as unknown as BottomFollowHostDeps;
    return { authorizeImmediateBottomFollowWriteRef, deps, executeViewportCommand };
}

async function runAutomaticFollowWrite(
    userScrollIntent: ReturnType<typeof createTranscriptUserScrollIntentOwner>,
): Promise<{ pinWrites: number; unmount: () => Promise<void> }> {
    const { authorizeImmediateBottomFollowWriteRef, deps, executeViewportCommand } =
        buildDeps(userScrollIntent);
    const hook = await renderHook(
        (next: BottomFollowHostDeps) => useTranscriptBottomFollowHost(next),
        { initialProps: deps },
    );
    executeViewportCommand.mockClear();
    authorizeImmediateBottomFollowWriteRef.current('automatic-live-tail', 'content-size-change');
    const pinWrites = executeViewportCommand.mock.calls.filter(
        (call) => (call as unknown[])[0] != null
            && ((call as unknown[])[0] as { type?: string }).type === 'pin-bottom',
    ).length;
    return { pinWrites, unmount: () => hook.unmount() };
}

describe('automatic bottom-follow suppression while the reader is parked', () => {
    it('does not re-pin the live tail seconds after the reader parked away from it', async () => {
        const nowMs = 100_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const userScrollIntent = createTranscriptUserScrollIntentOwner();
        // The reader wheels up; the frame they land on measures 300px from the live tail.
        userScrollIntent.recordInput({ atMs: nowMs - 5_000, direction: -1 });
        userScrollIntent.observeDistanceFromLiveTail({
            atMs: nowMs - 5_000,
            distanceFromLiveTailPx: 300,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });
        // Then they STOP and read for five seconds. Every recency window has expired.
        expect(userScrollIntent.isLive(nowMs)).toBe(false);

        const { pinWrites, unmount } = await runAutomaticFollowWrite(userScrollIntent);

        expect(pinWrites).toBe(0);
        await unmount();
        vi.restoreAllMocks();
    });

    it('still follows the live tail for a reader who stopped inside the pin band', async () => {
        const nowMs = 100_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const userScrollIntent = createTranscriptUserScrollIntentOwner();
        userScrollIntent.recordInput({ atMs: nowMs - 5_000, direction: -1 });
        // Inside the band: they are at the live tail, so following it is what they asked for.
        // This paired negative keeps the parked guard from being a blanket suppression.
        userScrollIntent.observeDistanceFromLiveTail({
            atMs: nowMs - 5_000,
            distanceFromLiveTailPx: 40,
            pinThresholdPx: PIN_THRESHOLD_PX,
        });

        const { pinWrites, unmount } = await runAutomaticFollowWrite(userScrollIntent);

        expect(pinWrites).toBe(1);
        await unmount();
        vi.restoreAllMocks();
    });
});

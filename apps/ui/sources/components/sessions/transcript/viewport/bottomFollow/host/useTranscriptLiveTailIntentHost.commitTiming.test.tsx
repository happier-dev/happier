import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { resolveJumpToBottomAffordanceState } from '@/components/sessions/transcript/scroll/jumpToBottomAffordanceState';
import { useTranscriptLiveTailIntentHost } from './useTranscriptLiveTailIntentHost';
import { createTranscriptUserScrollIntentOwner } from '@/components/sessions/transcript/viewport/driver/userScrollIntentOwner';

type Host = ReturnType<typeof useTranscriptLiveTailIntentHost>;
type HostDeps = Parameters<typeof useTranscriptLiveTailIntentHost>[0];

function createRef<T>(current: T): { current: T } {
    return { current };
}

function createDeps(
    sessionId: string,
    emitViewportChange: ReturnType<typeof vi.fn>,
): HostDeps {
    return {
        commitBottomFollowModeState: vi.fn(),
        commitJumpToBottomDistanceForVisibilityRef: createRef(vi.fn()),
        commitScrollPinEvent: vi.fn(),
        commitScrollPinState: vi.fn(),
        emitViewportChange,
        isPinnedRef: createRef(true),
        lastPinOffsetForIntentRef: createRef(0),
        userScrollIntent: createTranscriptUserScrollIntentOwner(),
        lifecycleHost: {
            planExplicitReturnToLiveTail: vi.fn(),
        },
        scrollPinRef: createRef({ isPinned: true, newActivityCount: 0 }),
        sessionId,
        transcriptScrollPinEnabled: true,
        wantsPinnedRef: createRef(true),
    } as unknown as HostDeps;
}

function Harness(props: Readonly<{
    apiRef: { current: Host | null };
    deps: HostDeps;
}>) {
    const host = useTranscriptLiveTailIntentHost(props.deps);
    React.useLayoutEffect(() => {
        props.apiRef.current = host;
    }, [host, props.apiRef]);
    return null;
}

describe('useTranscriptLiveTailIntentHost commit timing', () => {
    it('keeps the return affordance visible across repeated far-target command landings', async () => {
        const sessionId = 'session-repeat-jump';
        let distanceFromBottom = 0;
        let scrollPin = {
            isPinned: true,
            lastActivityKey: null,
            newActivityCount: 0,
        };
        const baseDeps = createDeps(sessionId, vi.fn(() => true));
        const scrollPinRef = baseDeps.scrollPinRef;
        baseDeps.commitJumpToBottomDistanceForVisibilityRef.current = vi.fn((nextDistance: number) => {
            distanceFromBottom = nextDistance;
        });
        const commitScrollPinState = vi.fn((nextState) => {
            scrollPin = nextState;
            scrollPinRef.current = nextState;
        });
        const commitScrollPinEvent = vi.fn((event) => {
            if (event.type !== 'rendererAtEnd') return;
            scrollPin = {
                ...scrollPin,
                isPinned: event.enabled && event.isAtEnd,
            };
            scrollPinRef.current = scrollPin;
        });
        const planExplicitReturnToLiveTail: HostDeps['lifecycleHost']['planExplicitReturnToLiveTail'] = vi.fn(() => ({
            explicitReturnEffects: [
                {
                    sessionId,
                    type: 'apply-explicit-return-clear-user-scroll-intent',
                },
                {
                    distanceFromLiveTailPx: 0,
                    isPinned: true,
                    sessionId,
                    type: 'apply-explicit-return-to-live-tail-viewport',
                },
            ],
            lifecycleEffects: [],
            state: {
                bottomFollowState: {
                    dragSession: null,
                    mode: 'following',
                },
                fingerDown: false,
                followMode: 'following',
                gesturePhase: 'settled',
                sessionId,
            },
            viewportEffects: [],
        } as const));
        const deps = {
            ...baseDeps,
            commitScrollPinEvent,
            commitScrollPinState,
            lifecycleHost: {
                planExplicitReturnToLiveTail,
            },
        } satisfies HostDeps;
        const apiRef = { current: null as Host | null };
        let tree!: renderer.ReactTestRenderer;

        const commitFarTargetPromotion = (nextDistance: number) => {
            // This is the jump host's committed semantic promotion. A subsequent renderer
            // callback must not reinterpret the end of its local window as the global tail.
            deps.isPinnedRef.current = false;
            deps.wantsPinnedRef.current = false;
            scrollPin = {
                ...scrollPin,
                isPinned: false,
            };
            deps.scrollPinRef.current = scrollPin;
            distanceFromBottom = nextDistance;
        };
        const readAffordance = (hasMoreNewerBeyondRenderedWindow: boolean) =>
            resolveJumpToBottomAffordanceState({
                distanceFromBottom,
                enabled: true,
                hasMoreNewerBeyondRenderedWindow,
                isPinned: scrollPin.isPinned,
                minNewActivityCount: 1,
                newActivityCount: 0,
                revealThresholdPx: 1_000,
            });
        const rendererFollowingAtLocalWindowEnd = {
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        } as const;

        await act(async () => {
            tree = renderer.create(<Harness apiRef={apiRef} deps={deps} />);
        });

        commitFarTargetPromotion(50_281);
        apiRef.current!.handleRendererAtEndChange(
            rendererFollowingAtLocalWindowEnd,
            { cause: 'command' },
        );
        // The first landing is protected by target-window mode, which masks a stale pin.
        expect(readAffordance(true).isVisible).toBe(true);

        apiRef.current!.commitExplicitReturnToLiveTailState('jump-to-bottom');
        expect(deps.isPinnedRef.current).toBe(true);
        expect(scrollPin.isPinned).toBe(true);
        expect(readAffordance(false).isVisible).toBe(false);

        commitFarTargetPromotion(101_709);
        expect(deps.isPinnedRef.current).toBe(false);
        expect(scrollPin.isPinned).toBe(false);
        apiRef.current!.handleRendererAtEndChange(
            rendererFollowingAtLocalWindowEnd,
            { cause: 'command' },
        );

        // The repeat landing has no target-window override. The committed far distance and
        // released pin must survive the renderer's command-attributed physical-end callback.
        expect(distanceFromBottom).toBe(101_709);
        expect(deps.isPinnedRef.current).toBe(false);
        expect(scrollPin.isPinned).toBe(false);
        expect(readAffordance(false).isVisible).toBe(true);

        await act(async () => {
            tree.unmount();
        });
    });
});

describe('useTranscriptLiveTailIntentHost explicit-return distance refresh', () => {
    // Live-measured affordance geometry from the three SAFE remote-dev sessions where
    // "Jump to bottom" never disappeared after being used (revealThresholdPx 127, viewport
    // height 319). At those numbers a stale distance defeats BOTH gates in
    // resolveJumpToBottomAffordanceState with the same wrong value — the pin early return is
    // skipped because the distance contradicts the pin claim, and the standard reveal fires —
    // so the assertion is on the affordance the reader sees, not on the raw committed number.
    const REVEAL_THRESHOLD_PX = 127;
    const VIEWPORT_HEIGHT_PX = 319;

    function createExplicitReturnHarness(sessionId: string) {
        const baseDeps = createDeps(sessionId, vi.fn(() => true));
        const state = {
            committedDistance: 0,
            scrollPin: { isPinned: true, lastActivityKey: null as string | null, newActivityCount: 0 },
        };
        baseDeps.commitJumpToBottomDistanceForVisibilityRef.current = vi.fn((nextDistance: number) => {
            state.committedDistance = nextDistance;
        });
        const deps = {
            ...baseDeps,
            commitScrollPinEvent: vi.fn((event: { type: string; enabled: boolean; isAtEnd: boolean }) => {
                if (event.type !== 'rendererAtEnd') return;
                state.scrollPin = { ...state.scrollPin, isPinned: event.enabled && event.isAtEnd };
                baseDeps.scrollPinRef.current = state.scrollPin;
            }),
            commitScrollPinState: vi.fn((next: typeof state.scrollPin) => {
                state.scrollPin = next;
                baseDeps.scrollPinRef.current = next;
            }),
            lifecycleHost: {
                planExplicitReturnToLiveTail: vi.fn(() => ({
                    explicitReturnEffects: [
                        { sessionId, type: 'apply-explicit-return-clear-user-scroll-intent' },
                        {
                            distanceFromLiveTailPx: 0,
                            isPinned: true,
                            sessionId,
                            type: 'apply-explicit-return-to-live-tail-viewport',
                        },
                    ],
                    lifecycleEffects: [],
                    state: {
                        automaticPinAuthority: true,
                        bottomFollowState: { dragSession: null, mode: 'following' },
                        fingerDown: false,
                        followMode: 'following',
                        gesturePhase: 'settled',
                        sessionId,
                    },
                    viewportEffects: [],
                } as const)),
            },
        } as unknown as HostDeps;
        const readAffordance = () => resolveJumpToBottomAffordanceState({
            distanceFromBottom: state.committedDistance,
            enabled: true,
            hasMoreNewerBeyondRenderedWindow: false,
            isPinned: state.scrollPin.isPinned,
            minNewActivityCount: 1,
            newActivityCount: 0,
            revealThresholdPx: REVEAL_THRESHOLD_PX,
            viewportHeightPx: VIEWPORT_HEIGHT_PX,
        });
        return { deps, readAffordance, state };
    }

    it('replaces the renderer detach sentinel with the reader real distance', async () => {
        // Shape 1 of 2: the reader entered at the tail and scrolled up, so the last producer to
        // write the pill distance was the renderer detach callback with its MAX_SAFE_INTEGER
        // sentinel. A jump must not leave that behind.
        const { deps, readAffordance, state } = createExplicitReturnHarness('session-jump-sentinel');
        const apiRef = { current: null as Host | null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(<Harness apiRef={apiRef} deps={deps} />);
        });

        // Produced, not assigned: the reader's own wheel is the only cause the detach
        // producer accepts, and this is what arms the sentinel in production.
        apiRef.current!.handleRendererAtEndChange({
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        }, { cause: 'user' });
        expect(state.committedDistance).toBe(Number.MAX_SAFE_INTEGER);
        expect(readAffordance().isVisible).toBe(true);

        apiRef.current!.commitExplicitReturnToLiveTailState('jump-to-bottom');

        // The renderer's own post-jump at-end fact is command-attributed end to end, so it is
        // refused by resolveRendererAtEndViewportChange before the detach producer's distance
        // commit. The explicit return is the only owner that can describe where the reader is.
        apiRef.current!.handleRendererAtEndChange({
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        }, { cause: 'command' });

        expect(state.committedDistance).toBe(0);
        expect(readAffordance().isVisible).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });

    it('replaces a restored entry anchor distance with the reader real distance', async () => {
        // Shape 2 of 2: the reader opened straight into a restored detached entry, so the last
        // producer was the entry-restore host writing the durable anchor distance (3412) through
        // this same shared ref (useTranscriptSessionEntryLifecycle). The detach sentinel never
        // ran, and the latched anchor distance survived the jump just as the sentinel did.
        const { deps, readAffordance, state } = createExplicitReturnHarness('session-jump-entry-restore');
        const apiRef = { current: null as Host | null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(<Harness apiRef={apiRef} deps={deps} />);
        });

        deps.commitJumpToBottomDistanceForVisibilityRef.current(3412);
        expect(readAffordance().isVisible).toBe(true);

        apiRef.current!.commitExplicitReturnToLiveTailState('jump-to-bottom');

        expect(state.committedDistance).toBe(0);
        expect(readAffordance().isVisible).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });
});

describe('useTranscriptLiveTailIntentHost live-tail parking release', () => {
    it('releases the reader parked position on an explicit return to the live tail', async () => {
        // O1: the parked position is durable STATE with no timer — while it holds, every
        // automatic bottom-follow write is refused at `applyAuthorizedBottomFollowWrite`. The
        // deliberate return (jump-to-bottom / follow-bottom intent) is the reader's consent to
        // be followed again, so it MUST clear it here. If it does not, a reader who scrolled up
        // and then pressed jump-to-bottom lands at the tail and is never followed again for the
        // life of the mount.
        const sessionId = 'session-parked-jump';
        const deps = createDeps(sessionId, vi.fn(() => true));
        (deps.lifecycleHost.planExplicitReturnToLiveTail as ReturnType<typeof vi.fn>)
            .mockImplementation(() => ({
                explicitReturnEffects: [
                    { sessionId, type: 'apply-explicit-return-clear-user-scroll-intent' },
                    {
                        distanceFromLiveTailPx: 0,
                        isPinned: true,
                        sessionId,
                        type: 'apply-explicit-return-to-live-tail-viewport',
                    },
                ],
                lifecycleEffects: [],
                state: {
                    automaticPinAuthority: true,
                    bottomFollowState: { dragSession: null, mode: 'following' },
                    fingerDown: false,
                    followMode: 'following',
                    gesturePhase: 'settled',
                    sessionId,
                },
                viewportEffects: [],
            }));
        const apiRef = { current: null as Host | null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(<Harness apiRef={apiRef} deps={deps} />);
        });

        // The reader wheels up and the landing frame measures them 900px from the tail.
        deps.userScrollIntent.recordInput({ atMs: Date.now(), direction: -1 });
        deps.userScrollIntent.observeDistanceFromLiveTail({
            atMs: Date.now(),
            distanceFromLiveTailPx: 900,
            pinThresholdPx: 72,
        });
        expect(deps.userScrollIntent.isParkedAwayFromLiveTail()).toBe(true);

        apiRef.current!.commitExplicitReturnToLiveTailState('jump-to-bottom');

        expect(deps.userScrollIntent.isParkedAwayFromLiveTail()).toBe(false);
        expect(deps.userScrollIntent.parkedDistanceFromLiveTailPx()).toBeNull();

        await act(async () => {
            tree.unmount();
        });
    });
});

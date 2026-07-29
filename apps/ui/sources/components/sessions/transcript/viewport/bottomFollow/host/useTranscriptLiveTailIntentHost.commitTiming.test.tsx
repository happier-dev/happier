import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { resolveJumpToBottomAffordanceState } from '@/components/sessions/transcript/scroll/jumpToBottomAffordanceState';
import { useTranscriptLiveTailIntentHost } from './useTranscriptLiveTailIntentHost';

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
        lastUserScrollIntentAtMsRef: createRef(0),
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
        distanceFromBottom = 0;
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

import * as React from 'react';
import { useCommittedTranscriptRef } from '@/components/sessions/transcript/viewport/lifecycle/host/useCommittedTranscriptRef';

import { sync } from '@/sync/sync';
import type { TranscriptViewportChangeState } from '@/components/sessions/transcript/chatListTypes';
import { resolveRendererAtEndViewportChange } from '@/components/sessions/transcript/scroll/rendererAtEndViewportChange';
import type {
    TranscriptBottomFollowModeState,
    TranscriptScrollPinEvent,
    TranscriptScrollPinState,
} from '@/components/sessions/transcript/scroll/transcriptBottomFollowMode';
import type { TranscriptLifecycleHost } from '@/components/sessions/transcript/viewport/lifecycle/lifecycleHost';
import type { TranscriptRendererAtEndState } from '@/components/sessions/transcript/viewport/shell/renderer/types';

type MutableRef<T> = { current: T };

type LiveTailIntentHostDeps = Readonly<{
    commitBottomFollowModeState(next: TranscriptBottomFollowModeState): void;
    commitJumpToBottomDistanceForVisibilityRef: MutableRef<(distanceFromBottom: number) => void>;
    commitScrollPinEvent(event: TranscriptScrollPinEvent): void;
    commitScrollPinState(next: TranscriptScrollPinState): void;
    emitViewportChange(state: TranscriptViewportChangeState): boolean;
    isPinnedRef: MutableRef<boolean>;
    lastPinOffsetForIntentRef: MutableRef<number | null>;
    lastUserScrollIntentAtMsRef: MutableRef<number>;
    lifecycleHost: Pick<TranscriptLifecycleHost, 'planExplicitReturnToLiveTail'>;
    scrollPinRef: MutableRef<TranscriptScrollPinState>;
    sessionId: string;
    transcriptScrollPinEnabled: boolean;
    wantsPinnedRef: MutableRef<boolean>;
}>;

export function useTranscriptLiveTailIntentHost(deps: LiveTailIntentHostDeps) {
    const depsRef = React.useRef(deps);
    useCommittedTranscriptRef(depsRef, deps);
    const handleRendererAtEndChange = React.useCallback((
        state: TranscriptRendererAtEndState,
        context: Readonly<{ cause: 'user' | 'layout' | 'command' }>,
    ): void => {
        const current = depsRef.current;
        const viewportChange = resolveRendererAtEndViewportChange(state, context);
        if (!viewportChange) return;
        const distanceFromLiveTailPx = state.isFollowing ? 0 : Number.MAX_SAFE_INTEGER;
        current.isPinnedRef.current = state.isFollowing;
        current.wantsPinnedRef.current = state.isFollowing;
        current.lastPinOffsetForIntentRef.current = distanceFromLiveTailPx;
        current.commitBottomFollowModeState({
            dragSession: null,
            mode: state.isFollowing ? 'following' : 'released',
        });
        current.commitJumpToBottomDistanceForVisibilityRef.current(distanceFromLiveTailPx);
        current.commitScrollPinEvent({
            type: 'rendererAtEnd',
            enabled: current.transcriptScrollPinEnabled,
            isAtEnd: state.isFollowing,
        });
        current.emitViewportChange(viewportChange);
    }, []);

    const commitExplicitReturnToLiveTailState = React.useCallback((
        intent: 'jump-to-bottom' | 'follow-bottom-intent',
    ) => {
        const current = depsRef.current;
        current.wantsPinnedRef.current = true;
        current.isPinnedRef.current = true;
        const plan = current.lifecycleHost.planExplicitReturnToLiveTail({
            intent,
            sessionId: current.sessionId,
        });
        current.commitBottomFollowModeState(plan.state.bottomFollowState);
        for (const effect of plan.explicitReturnEffects) {
            if (effect.sessionId !== current.sessionId) continue;
            if (effect.type === 'apply-explicit-return-clear-user-scroll-intent') {
                current.lastUserScrollIntentAtMsRef.current = Number.NEGATIVE_INFINITY;
                continue;
            }
            current.commitScrollPinState({ ...current.scrollPinRef.current, isPinned: effect.isPinned, newActivityCount: 0 });
            const emitted = current.emitViewportChange({
                isPinned: effect.isPinned,
                offsetY: effect.distanceFromLiveTailPx,
                shouldRestoreViewport: false,
            });
            if (!emitted) sync.markSessionLiveTailIntent(current.sessionId);
        }
    }, []);

    return { commitExplicitReturnToLiveTailState, handleRendererAtEndChange };
}

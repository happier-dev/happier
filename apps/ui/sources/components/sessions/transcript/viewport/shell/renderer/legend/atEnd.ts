import type { LegendListState } from '@legendapp/list/react-native';

import type { WebTranscriptScrollMetrics } from '@/components/sessions/transcript/webTranscriptScrollMetrics';
import type { TranscriptRendererAtEndState, TranscriptViewportMutationCause } from '../types';
import {
    LEGEND_USER_INPUT_DETACH_WINDOW_MS,
    LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS,
} from './heldIntent';

export function readLegendAtEndState(state: LegendListState | undefined): TranscriptRendererAtEndState | null {
    if (!state) return null;
    return {
        isAtEnd: state.isAtEnd === true,
        isFollowing: state.isWithinMaintainScrollAtEndThreshold === true,
        isNearEnd: state.isNearEnd === true,
        isWithinMaintainScrollAtEndThreshold: state.isWithinMaintainScrollAtEndThreshold === true,
    };
}

export function resolveLegendRendererAtEndStateFromWebMetrics(params: Readonly<{
    metrics: Pick<WebTranscriptScrollMetrics, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;
    maintainScrollAtEndThreshold: number;
}>): TranscriptRendererAtEndState {
    const distanceFromBottom = Math.max(
        0,
        params.metrics.scrollHeight - params.metrics.clientHeight - params.metrics.scrollTop,
    );
    const thresholdRatio = Number.isFinite(params.maintainScrollAtEndThreshold)
        ? Math.max(0, params.maintainScrollAtEndThreshold)
        : 0;
    const thresholdPx = thresholdRatio * Math.max(0, params.metrics.clientHeight);
    return {
        isAtEnd: distanceFromBottom <= 1,
        isFollowing: distanceFromBottom <= thresholdPx,
        isNearEnd: distanceFromBottom <= thresholdPx,
        isWithinMaintainScrollAtEndThreshold: distanceFromBottom <= thresholdPx,
    };
}

// Native semantic cause classification for at-end publications (S-G/S-I/S-K, 2026-07-11).
// Web scroll-driven publications consume the exact WebDom movement fact instead.
// The previous one-shot pending-cause consumption misattributed every flip that did not
// land exactly on the first post-input scroll event: a Chromium smooth-scroll continuation
// reaching the tail published 'layout' (the live-tail intent never reached sync and a
// stale persisted detached anchor survived — S-G), a mid-drag threshold exit published
// 'layout' (wantsPinned stayed true and the native older-load follow gate never opened —
// S-I), and a NEVER-consumed 'user' (wheel at the clamp produces no scroll event) leaked
// into a growth-driven follow-loss flip minutes later (false user detach during a giant
// streaming commit — S-K). Classification is evidence-windowed instead:
// - 'command' pending stays authoritative (one-shot, consumed by its own scroll event);
// - a flip without physical offset movement is renderer/layout-caused geometry, never user;
// - a flip INTO following counts as user within the full input-detach evidence window
//   (physically reaching the tail within seconds of user scroll input IS the user's tail
//   arrival — misattribution is harmless because it only re-affirms live-tail intent);
// - a flip OUT of following (detach — deletes/creates persistence state) needs strict
//   evidence: a live drag/momentum phase, the fresh one-shot 'user', or input within the
//   tight write-suppression margin (smooth-scroll continuation of a genuine wheel detach).
export function resolveLegendNativeAtEndPublicationCause(params: Readonly<{
    dragOrMomentumLive: boolean;
    isFollowing: boolean;
    offsetMoved: boolean;
    pendingCause: TranscriptViewportMutationCause;
    scrollIntentAgeMs: number;
}>): TranscriptViewportMutationCause {
    if (params.pendingCause === 'command') return 'command';
    if (!params.offsetMoved) return 'layout';
    const evidenceLive = params.dragOrMomentumLive
        || params.scrollIntentAgeMs <= LEGEND_USER_INPUT_DETACH_WINDOW_MS;
    if (!evidenceLive) return 'layout';
    if (params.isFollowing) return 'user';
    if (params.dragOrMomentumLive || params.pendingCause === 'user') return 'user';
    return params.scrollIntentAgeMs <= LEGEND_USER_SCROLL_WRITE_SUPPRESSION_MS ? 'user' : 'layout';
}

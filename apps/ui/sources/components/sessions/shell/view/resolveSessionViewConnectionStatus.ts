import type { SessionConnectedServicesAuthSwitchRestartState } from '@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch';
import type { SessionAwarenessPresentationStateV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';

import type { SessionGuardComposerState } from './resolveSessionGuardComposerState';

export type SessionViewConnectionStatus = Readonly<{
    text: string;
    color: string;
    dotColor: string;
    isPulsing: boolean;
    /** A guard stop is coming: the row counts down to it (a leaf ticks, not the screen). */
    countdownTo?: number;
    /** The one action the row offers for the guard's warning. */
    guardAction?: 'keep_running';
    /** Which guard moment the line shows; a change cross-fades the line (plan 50 GM). */
    transitionKey?: 'warning' | 'stopped' | 'waking';
    /** The longer explanation behind a short line, read on hover/focus and by assistive tech. */
    detail?: string;
    /** The Provider binding's recovery, including beside a current request, when the viewer can take it. */
    providerBindingAction?: SessionViewProviderBindingAction;
    /** The pending queue's one recovery, when its waiting state won the line. */
    pendingQueueAction?: SessionViewPendingQueueAction;
    /** An inactive Session can resume even when there is no queued input. */
    inactiveAction?: 'resume';
}>;

export type SessionViewPendingQueueAction = 'resume' | 'retry' | 'process_when_online' | 'keep_queued';

/**
 * Queued input waiting on this Session to start (`resolvePendingActivationBanner` keeps the fact; the
 * composer's line owns how it reads). Its offline kinds already name the machine, so it outranks the
 * machine-cannot-serve line.
 */
export type SessionViewPendingQueueLine = Readonly<{
    text: string;
    detail?: string;
    /** Null when the queue offers no recovery the viewer can take. */
    action: SessionViewPendingQueueAction | null;
    color: string;
}>;

export type SessionViewProviderBindingAction = 'restart' | 'choose-model' | 'retry';

/** The session's Provider binding no longer matches what it runs on (changed, unavailable, refused, unreachable). */
export type SessionViewProviderBindingLine = Readonly<{
    text: string;
    detail?: string;
    /** Null when the viewer cannot take the recovery (view-only, or a turn is running). */
    action: SessionViewProviderBindingAction | null;
    /** "Needs you": the attention ink. */
    color: string;
}>;

export function resolveSessionViewConnectionStatus(input: Readonly<{
    connectedServicesRestartState: SessionConnectedServicesAuthSwitchRestartState;
    restartingText: string;
    switchFailedText: string;
    inactiveStatusText: string | null;
    /** Current write, native-resume and reachable-machine facts from the Session owner. */
    inactiveResumeAvailable?: boolean;
    /** Why the Session is inactive and what to do, read on the line rather than in a card beside it. */
    inactiveDetail?: string | null;
    sessionStatusResuming: boolean;
    /** The canonical presented Session state (`presentSessionAwarenessV1`). */
    sessionStatusState: SessionAwarenessPresentationStateV1;
    sessionStatusText: string;
    sessionStatusColor: string;
    sessionStatusDotColor: string;
    sessionStatusPulsing: boolean;
    /** The guard's word for this Session (warning, stopped, waking), with the attention and quiet inks. */
    guard?: Readonly<{ state: SessionGuardComposerState | null; attentionColor: string; quietColor: string }>;
    /** The machine or runtime cannot serve this Session (`isAskHappierStatusOfferState`); that cause outranks the binding. */
    sessionUnservable?: boolean;
    providerBinding?: SessionViewProviderBindingLine | null;
    /**
     * The transcript's queued input, stated here rather than as a header over the queue: its waiting
     * state as the line, or its size ("2 queued") after an ordinary status.
     */
    pendingQueue?: Readonly<{ line: SessionViewPendingQueueLine | null; countText: string | null }> | null;
}>): SessionViewConnectionStatus | null {
    const guard = input.guard?.state ?? null;
    // A restart or a failed account switch is the more urgent fact; otherwise the guard's word leads.
    const restartActive = input.connectedServicesRestartState?.status === 'restarting'
        || input.connectedServicesRestartState?.status === 'pending_confirmation'
        || input.connectedServicesRestartState?.status === 'failed';
    if (guard && input.guard && !restartActive) {
        if (guard.kind === 'warning') {
            return { text: guard.text, color: input.guard.attentionColor, dotColor: input.guard.attentionColor, isPulsing: false,
                countdownTo: guard.countdownTo, guardAction: guard.action, transitionKey: 'warning' };
        }
        if (guard.kind === 'stopped') {
            return { text: guard.text, color: input.sessionStatusColor, dotColor: input.guard.quietColor, isPulsing: false, transitionKey: 'stopped' };
        }
        return { text: guard.text, color: input.sessionStatusColor, dotColor: input.sessionStatusDotColor, isPulsing: true, transitionKey: 'waking' };
    }
    const restartPending = input.connectedServicesRestartState?.status === 'restarting'
        || input.connectedServicesRestartState?.status === 'pending_confirmation';
    const queueLine = input.pendingQueue?.line ?? null;
    if (queueLine && !restartActive && !input.sessionStatusResuming) {
        return {
            text: queueLine.text,
            ...(queueLine.detail ? { detail: queueLine.detail } : {}),
            color: queueLine.color,
            dotColor: queueLine.color,
            isPulsing: false,
            ...(queueLine.action ? { pendingQueueAction: queueLine.action } : {}),
        };
    }
    const queueCountText = input.pendingQueue?.countText ?? null;
    // One line, highest-priority cause first: a restart or failed switch, the guard, resuming, queued
    // input waiting on this Session to start (above), a Session the machine cannot serve and a request waiting on the person right now all outrank the
    // binding; the binding outranks inactive and ordinary status, and speaks even before the runtime
    // has been observed.
    const binding = input.providerBinding ?? null;
    const sessionNeedsPersonNow = input.sessionStatusState === 'permission_required'
        || input.sessionStatusState === 'action_required';
    if (binding && !restartActive && !input.sessionStatusResuming && input.sessionUnservable !== true && !sessionNeedsPersonNow) {
        return {
            text: binding.text,
            ...(binding.detail ? { detail: binding.detail } : {}),
            color: binding.color,
            dotColor: binding.color,
            isPulsing: false,
            ...(binding.action ? { providerBindingAction: binding.action } : {}),
        };
    }
    // Inactive recovery wording explains missing reachability; it must not replace the
    // canonical presenter's more specific failure, current request or process-terminal fact.
    const inactiveStatusText = input.sessionStatusState === 'disconnected' || input.sessionStatusState === 'unknown'
        ? input.inactiveStatusText : null;
    // Before the runtime has been observed there is no status to state: the line stays empty
    // rather than reading "unknown". A restart, a failed switch, an inactive Session or queued
    // input is a real fact and still speaks.
    if (
        input.sessionStatusState === 'unknown'
        && !restartPending
        && input.connectedServicesRestartState?.status !== 'failed'
        && !inactiveStatusText
    ) {
        return queueCountText
            ? { text: queueCountText, color: input.sessionStatusColor, dotColor: input.sessionStatusDotColor, isPulsing: false }
            : null;
    }
    const showsInactive = !restartPending
        && input.connectedServicesRestartState?.status !== 'failed'
        && !input.sessionStatusResuming
        && Boolean(inactiveStatusText);
    const statusText = restartPending
        ? input.restartingText
        : input.connectedServicesRestartState?.status === 'failed'
            ? input.switchFailedText
            : input.sessionStatusResuming
                ? input.sessionStatusText
                : (inactiveStatusText || input.sessionStatusText);
    return {
        // The queue's size rides the ordinary status. A restart or failed switch keeps its own words,
        // and resuming speaks alone: the resume is what delivers the queue.
        text: queueCountText && !restartActive && !input.sessionStatusResuming ? `${statusText} · ${queueCountText}` : statusText,
        ...(showsInactive && input.inactiveDetail ? { detail: input.inactiveDetail } : {}),
        ...(!restartActive && !input.sessionStatusResuming && input.sessionUnservable !== true && sessionNeedsPersonNow && binding?.action
            ? { providerBindingAction: binding.action, detail: binding.detail ?? binding.text } : {}),
        ...(!restartActive && !input.sessionStatusResuming && !sessionNeedsPersonNow && input.inactiveResumeAvailable
            ? { inactiveAction: 'resume' as const } : {}),
        color: input.sessionStatusColor,
        dotColor: input.sessionStatusDotColor,
        isPulsing: restartPending
            || input.sessionStatusPulsing,
    };
}

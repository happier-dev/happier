import type { VoiceControlAction, VoiceControlId }
    from '@/components/voice/controls/VoiceControls';

// Re-exported so lab modules keep one import site for lab vocabulary. The
// canonical owner is the controls module; this is an alias, not a second source.
export type { VoiceControlAction, VoiceControlId };
import type { VoiceEnergyDirection } from '@/components/voice/light/useVoiceEnergy';
import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';

import type { VoiceLightStop } from '@/components/voice/light/voiceLightTokens';

/**
 * The state vocabulary the Voice design lab renders.
 *
 * Every entry declares its `basis`, and the lab renders that basis on screen:
 *
 *   - `model`     — `resolveVoiceSurfaceState` returns this exact value today.
 *                   A concept rendering it is truthful right now.
 *   - `derivable` — the signal already exists on the wire; only the projection
 *                   into the view model is missing. Shipping it is a projection
 *                   change, not a protocol change. `source` names the signal.
 *   - `proposed`  — no signal exists anywhere. A concept may render it only with
 *                   a visible PROPOSED marker.
 *
 * Keeping the three apart is the highest-value output of this exercise. A voice
 * UI that says "Codex is editing SessionView.tsx" without a delegation
 * projection is the one lie that ends trust the first time it is wrong — and
 * the `derivable` list tells us exactly which projections to build.
 */
export type VoiceLabStateBasis = 'model' | 'derivable' | 'proposed';

export type VoiceLabStateId =
    | 'unavailable'
    | 'ready'
    | 'preparing'
    | 'connecting'
    | 'listening'
    | 'user_speaking'
    | 'transcribing'
    | 'thinking'
    | 'speaking'
    | 'interrupted'
    | 'working'
    | 'work_rejected'
    | 'attention'
    | 'permission_required'
    | 'permission_revoked'
    | 'reconnecting'
    | 'degraded'
    | 'error'
    | 'ended';

/** Where the light energy travels. This is what makes state legible without colour. */

export type VoiceLabStateSpec = Readonly<{
    id: VoiceLabStateId;
    basis: VoiceLabStateBasis;
    /** The production `VoiceSurfaceState` this resolves to today, when one exists. */
    modelState: VoiceSurfaceState | null;
    /** Qualification displayed beside the current production projection. */
    modelNote?: string;
    /** For `derivable`: the signal that already exists and is being discarded. */
    source?: string;
    /** Short label. Sentence case, no trailing punctuation. */
    label: string;
    /** The one line the presence says about itself. Warm, specific, honest. */
    caption: string | null;
    /** Primary light stop. */
    stop: VoiceLightStop;
    /** Secondary stop for the terminator. */
    stopSecondary: VoiceLightStop;
    /** Where energy travels. */
    direction: VoiceEnergyDirection;
    /** 0..1 resting luminosity of the presence in this state. */
    luminosity: number;
    /** Whether the synthetic mic/voice envelope should drive amplitude. */
    energized: boolean;
    /** Screen-reader announcement. Never relies on the visual. */
    announcement: string;
}>;

export const VOICE_LAB_STATES: readonly VoiceLabStateSpec[] = [
    {
        id: 'unavailable',
        basis: 'model',
        modelState: 'idle',
        modelNote: 'idle (controlsDisabled)',
        label: 'Unavailable',
        caption: 'Pick a session to talk about',
        stop: 'cool',
        stopSecondary: 'cool',
        direction: 'none',
        luminosity: 0.06,
        energized: false,
        announcement: 'Voice unavailable. Select a session to start.',
    },
    {
        id: 'ready',
        basis: 'model',
        modelState: 'idle',
        label: 'Ready',
        caption: 'Ready when you are',
        stop: 'cool',
        stopSecondary: 'violet',
        direction: 'none',
        luminosity: 0.18,
        energized: false,
        announcement: 'Voice ready.',
    },
    {
        id: 'preparing',
        basis: 'derivable',
        modelState: 'connecting',
        source: 'runtime state `acquiring_mic` — collapsed into `connecting` by deriveLocalVoiceSessionSnapshot',
        label: 'Preparing',
        caption: 'Warming up the microphone',
        stop: 'cool',
        stopSecondary: 'violet',
        direction: 'orbit',
        luminosity: 0.3,
        energized: false,
        announcement: 'Preparing microphone.',
    },
    {
        id: 'connecting',
        basis: 'model',
        modelState: 'connecting',
        label: 'Connecting',
        // The provider is named by the provider affordance beside this, so the
        // caption does not hardcode one.
        caption: 'Opening the audio channel',
        stop: 'cool',
        stopSecondary: 'violet',
        direction: 'orbit',
        luminosity: 0.4,
        energized: false,
        announcement: 'Connecting.',
    },
    {
        id: 'listening',
        basis: 'model',
        modelState: 'listening',
        label: 'Listening',
        // The second line answers the question the first line raises: listening
        // *about what*. Restating the status word there wastes the only other
        // line the sidebar has.
        caption: 'happier/dev · leeroy-mbp',
        stop: 'cool',
        stopSecondary: 'violet',
        direction: 'inward',
        luminosity: 0.55,
        energized: true,
        announcement: 'Listening.',
    },
    {
        id: 'user_speaking',
        basis: 'derivable',
        modelState: 'listening',
        source: 'provider/local VAD events exist, but no provider-neutral semantic speaking fact reaches the surface yet',
        label: 'You’re speaking',
        caption: 'Hearing you',
        stop: 'violet',
        stopSecondary: 'cool',
        direction: 'inward',
        luminosity: 0.78,
        energized: true,
        announcement: 'Hearing you.',
    },
    {
        id: 'transcribing',
        basis: 'model',
        modelState: 'transcribing',
        label: 'Transcribing',
        caption: 'Turning that into text',
        stop: 'violet',
        stopSecondary: 'cool',
        direction: 'inward',
        luminosity: 0.5,
        energized: false,
        announcement: 'Transcribing.',
    },
    {
        id: 'thinking',
        basis: 'model',
        modelState: 'thinking',
        label: 'Considering',
        caption: 'Thinking it through',
        stop: 'violet',
        stopSecondary: 'deep',
        direction: 'orbit',
        luminosity: 0.62,
        energized: false,
        announcement: 'Considering.',
    },
    {
        id: 'speaking',
        basis: 'model',
        modelState: 'speaking',
        label: 'Speaking',
        caption: 'happier/dev · leeroy-mbp',
        stop: 'warm',
        stopSecondary: 'blush',
        direction: 'outward',
        luminosity: 0.92,
        energized: true,
        announcement: 'Happier is speaking.',
    },
    {
        id: 'interrupted',
        basis: 'model',
        modelState: 'interrupted',
        label: 'Interrupted',
        caption: 'Go ahead',
        stop: 'blush',
        stopSecondary: 'violet',
        direction: 'inward',
        luminosity: 0.5,
        energized: true,
        announcement: 'Interrupted. Go ahead.',
    },
    {
        id: 'working',
        basis: 'proposed',
        modelState: null,
        label: 'Working',
        caption: 'Codex is editing SessionView.tsx',
        stop: 'deep',
        stopSecondary: 'violet',
        direction: 'deep',
        luminosity: 0.44,
        energized: false,
        announcement: 'Codex is working in the session.',
    },
    {
        id: 'work_rejected',
        basis: 'proposed',
        modelState: null,
        label: 'Session busy',
        caption: 'That session is already running a turn',
        stop: 'warm',
        stopSecondary: 'deep',
        direction: 'hold',
        luminosity: 0.4,
        energized: false,
        announcement: 'The session is busy. The request was not started.',
    },
    {
        id: 'attention',
        basis: 'proposed',
        modelState: null,
        label: 'Needs you',
        caption: 'Approval needed in Inbox',
        stop: 'warm',
        stopSecondary: 'blush',
        direction: 'hold',
        luminosity: 0.72,
        energized: false,
        announcement: 'Approval needed. Open Inbox.',
    },
    {
        id: 'permission_required',
        basis: 'model',
        modelState: 'permission_required',
        label: 'Microphone blocked',
        caption: 'Happier needs microphone access',
        stop: 'warm',
        stopSecondary: 'blush',
        direction: 'hold',
        luminosity: 0.55,
        energized: false,
        announcement: 'Microphone permission required.',
    },
    {
        id: 'permission_revoked',
        basis: 'derivable',
        modelState: 'error',
        modelNote: 'error (loses the permission framing)',
        source: 'error kind `mic_permission_revoked` — presented as a generic error today',
        label: 'Microphone was turned off',
        caption: 'Access was revoked mid-conversation',
        stop: 'warm',
        stopSecondary: 'blush',
        direction: 'hold',
        luminosity: 0.5,
        energized: false,
        announcement: 'Microphone access was revoked during the conversation.',
    },
    {
        id: 'reconnecting',
        basis: 'model',
        modelState: 'reconnecting',
        label: 'Reconnecting',
        caption: 'Lost the relay — retrying',
        stop: 'violet',
        stopSecondary: 'cool',
        direction: 'unsettled',
        luminosity: 0.38,
        energized: false,
        announcement: 'Reconnecting.',
    },
    {
        id: 'degraded',
        basis: 'derivable',
        modelState: 'idle',
        modelNote: 'idle (a recoverable notice renders as neutral idle today)',
        source: 'errorPresentation `notice` — 7 kinds incl. mic_plateau, transport_disconnect, stt_timeout, tts_failed',
        label: 'Degraded',
        caption: 'Audio only — transcript unavailable',
        stop: 'violet',
        stopSecondary: 'deep',
        direction: 'unsettled',
        luminosity: 0.42,
        energized: true,
        announcement: 'Running degraded. Transcript unavailable.',
    },
    {
        id: 'error',
        basis: 'model',
        modelState: 'error',
        label: 'Couldn’t connect',
        caption: 'The agent isn’t signed in on leeroy-mbp',
        stop: 'warm',
        stopSecondary: 'blush',
        direction: 'none',
        luminosity: 0.3,
        energized: false,
        announcement: 'Voice error. The agent is not signed in.',
    },
    {
        id: 'ended',
        basis: 'derivable',
        modelState: 'connecting',
        source: 'runtime state `ending` — collapsed into `connecting`, so teardown looks identical to startup',
        label: 'Voice ended',
        caption: 'Voice ended — Codex is still working',
        stop: 'deep',
        stopSecondary: 'cool',
        direction: 'deep',
        luminosity: 0.22,
        energized: false,
        announcement: 'Voice ended. Codex is still working in the session.',
    },
];

export const VOICE_LAB_STATE_BY_ID: Readonly<Record<VoiceLabStateId, VoiceLabStateSpec>> =
    Object.fromEntries(VOICE_LAB_STATES.map((s) => [s.id, s])) as Record<VoiceLabStateId, VoiceLabStateSpec>;

/**
 * Provider capability, because the control matrix is **not universal**.
 *
 * Read from the shipped voice provider registry. This is the single most
 * important truthfulness constraint in the whole exploration: a concept
 * captioned "Codex Live" that offers Interrupt or Cancel response is showing
 * controls that provider cannot honour. The correct treatment is **absent**,
 * not disabled-with-a-tooltip, and never silently mapped onto End Voice.
 */
export type VoiceLabProviderId = 'happier.agent.codex/realtime-codex' | 'happier.voice.openai/realtime-openai' | 'local_conversation';

export type VoiceLabProviderSpec = Readonly<{
    id: VoiceLabProviderId;
    label: string;
    /** `capabilities.cancelResponse === 'immediate'` in the registry. */
    cancelResponse: boolean;
    /** Registry capability, additionally downgraded when the adapter has no `bargeIn` fn. */
    bargeIn: boolean;
    note: string;
}>;

export const VOICE_LAB_PROVIDERS: readonly VoiceLabProviderSpec[] = [
    {
        id: 'happier.agent.codex/realtime-codex',
        label: 'Codex Live',
        cancelResponse: false,
        bargeIn: false,
        note: 'interruptionPolicy: disabled — neither Interrupt nor Cancel response may render',
    },
    {
        id: 'happier.voice.openai/realtime-openai',
        label: 'OpenAI Realtime',
        cancelResponse: true,
        bargeIn: true,
        note: 'interruptionPolicy: client_two_stage — both controls are truthful',
    },
    {
        id: 'local_conversation',
        label: 'Local voice',
        cancelResponse: true,
        bargeIn: true,
        note: 'barge-in follows the tts.bargeInEnabled setting',
    },
];

export const VOICE_LAB_PROVIDER_BY_ID: Readonly<Record<VoiceLabProviderId, VoiceLabProviderSpec>> =
    Object.fromEntries(VOICE_LAB_PROVIDERS.map((p) => [p.id, p])) as Record<VoiceLabProviderId, VoiceLabProviderSpec>;

/**
 * The controls, and the exact states in which each is truthful.
 *
 * Two rules every concept here must hold:
 *
 *  - **End Voice stays reachable in every connected state.** Rendering only
 *    the recovery button while `canRecover` would strand a user in a
 *    recoverable error on a live session with no way to stop it, so recovery is
 *    an addition beside the transport and never a replacement for it.
 *  - **Return to session is session-variant only** (`getVoiceAgentSessionTeleport
 *    Availability`). It must never appear in a sidebar concept.
 */
export type VoiceControlSpec = VoiceControlAction & Readonly<{
    states: readonly VoiceLabStateId[];
    /** True when this control depends on a signal the model does not expose yet. */
    proposed?: boolean;
    /** Provider capability this control requires, if any. */
    requires?: 'cancelResponse' | 'bargeIn';
    /** Only meaningful in the in-session variant. */
    sessionVariantOnly?: boolean;
}>;

/** Every state in which a live session exists — End Voice must be reachable in all of them. */
const CONNECTED_STATES: readonly VoiceLabStateId[] = [
    'listening', 'user_speaking', 'transcribing', 'thinking', 'speaking',
    'interrupted', 'degraded', 'reconnecting',
];

const ACTIVE_STATES: readonly VoiceLabStateId[] = [
    'listening', 'user_speaking', 'transcribing', 'thinking', 'speaking', 'interrupted', 'degraded',
];

export const VOICE_LAB_CONTROLS: readonly VoiceControlSpec[] = [
    {
        id: 'start',
        label: 'Start Voice',
        weight: 'primary',
        states: ['ready'],
    },
    {
        id: 'end',
        label: 'End Voice',
        weight: 'terminal',
        // Every connected state, plus the transitional and error-with-live-session
        // ones. Never removed by a recovery branch.
        states: [...CONNECTED_STATES, 'connecting', 'preparing', 'working', 'attention', 'permission_revoked'],
    },
    {
        id: 'mute',
        label: 'Mute',
        weight: 'secondary',
        states: ACTIVE_STATES,
    },
    {
        id: 'bargeIn',
        label: 'Interrupt',
        weight: 'primary',
        states: ['speaking'],
        requires: 'bargeIn',
    },
    {
        id: 'cancelTurn',
        label: 'Cancel response',
        weight: 'secondary',
        states: ['thinking', 'speaking'],
        requires: 'cancelResponse',
    },
    {
        id: 'stopCodingTurn',
        label: 'Stop coding turn',
        weight: 'secondary',
        states: ['working'],
        proposed: true,
    },
    {
        id: 'openConversation',
        label: 'Open conversation',
        weight: 'secondary',
        states: [...ACTIVE_STATES, 'working', 'ended'],
    },
    {
        id: 'openPermission',
        label: 'Open Inbox',
        weight: 'primary',
        states: ['attention'],
        proposed: true,
    },
    {
        id: 'returnToSession',
        label: 'Go to session',
        weight: 'contextual',
        states: ['working', 'ended', 'work_rejected'],
        sessionVariantOnly: true,
    },
    {
        id: 'retry',
        label: 'Retry',
        weight: 'primary',
        states: ['error', 'reconnecting', 'permission_required', 'permission_revoked', 'degraded'],
    },
];

/**
 * Resolve the truthful control set.
 *
 * Provider capability and surface variant are inputs, not decoration: a control
 * the provider cannot honour is omitted entirely, and "Go to session" exists
 * only where the teleport target does.
 */
export function controlsForState(
    state: VoiceLabStateId,
    provider: VoiceLabProviderSpec,
    isSessionVariant: boolean,
): readonly VoiceControlSpec[] {
    return VOICE_LAB_CONTROLS.filter((c) => {
        if (!c.states.includes(state)) return false;
        if (c.requires && !provider[c.requires]) return false;
        if (c.sessionVariantOnly && !isSessionVariant) return false;
        return true;
    });
}

/** A transcript line. Provenance is restrained: one word, never a badge farm. */
export type VoiceLabEntryKind = 'spoken-user' | 'spoken-assistant' | 'work' | 'permission' | 'result';

export type VoiceLabEntry = Readonly<{
    id: string;
    kind: VoiceLabEntryKind;
    text: string;
    /** Shown as a quiet provenance word, not a coloured pill. */
    provenance: string | null;
    /** Partial transcripts render provisionally and are never treated as final. */
    provisional?: boolean;
    at: string;
}>;

/** Realistic content. A voice UI reviewed on lorem ipsum is not reviewed. */
export const VOICE_LAB_TRANSCRIPT: readonly VoiceLabEntry[] = [
    {
        id: 'e1',
        kind: 'spoken-user',
        text: 'What’s left on the sidebar voice work?',
        provenance: null,
        at: '09:41',
    },
    {
        id: 'e2',
        kind: 'spoken-assistant',
        text: 'Two things. The activity panel still shows a raw count, and the mic badge reads as an error at rest. Want me to take the mic badge?',
        provenance: null,
        at: '09:41',
    },
    {
        id: 'e3',
        kind: 'spoken-user',
        text: 'Yeah, do that one in the dev branch.',
        provenance: null,
        at: '09:42',
    },
    {
        id: 'e4',
        kind: 'work',
        text: 'Editing VoiceSurfaceHeader.tsx',
        provenance: 'Working in happier/dev',
        at: '09:42',
    },
    {
        id: 'e5',
        kind: 'permission',
        text: 'Write apps/ui/sources/components/voice/surface/VoiceSurfaceHeader.tsx',
        provenance: 'Approval needed',
        at: '09:42',
    },
    {
        id: 'e6',
        kind: 'result',
        text: 'Replaced the slashed-mic glyph with a resting state. 1 file changed.',
        provenance: 'Completed in happier/dev',
        at: '09:43',
    },
    {
        id: 'e7',
        kind: 'spoken-assistant',
        text: 'Done — the badge rests instead of reading as muted. Want the activity count next?',
        provenance: null,
        at: '09:43',
    },
];

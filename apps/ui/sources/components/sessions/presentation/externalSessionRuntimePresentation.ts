import {
    readExternalAgentObservationSessionState,
} from '@happier-dev/agents';
import type { ExternalSessionActivityV1 } from '@happier-dev/protocol';

export type ExternalAgentPresentationState =
    | 'working'
    | 'waiting'
    | 'retrying'
    | 'idle'
    | 'recentlyActive'
    | 'unknown';

export type ExternalAgentObservationPresentationInput = Readonly<{
    state: ExternalAgentPresentationState;
    observedAtMs: number;
    expiresAtMs: number | null;
}>;

export type ExternalSessionRuntimePresentation = Readonly<{
    controlConnectivity: 'connected' | 'offline';
    detachedActivity: 'active' | 'idle' | 'unknown';
    externalAgent: Readonly<{
        state: ExternalAgentPresentationState;
        labelKey:
            | 'status.workingExternally'
            | 'status.needsInputExternally'
            | 'status.retryingExternally'
            | 'status.ready'
            | 'status.recentlyActive'
            | 'status.externalStatusUnknown';
        tone: 'live' | 'attention' | 'warning' | 'ready' | 'muted';
        indicator: 'working' | 'action' | 'ready' | 'none';
        nextExpiryAtMs: number | null;
    }>;
}>;

const EXTERNAL_AGENT_PRESENTATION_BY_STATE = {
    working: { labelKey: 'status.workingExternally', tone: 'live', indicator: 'working' },
    waiting: { labelKey: 'status.needsInputExternally', tone: 'attention', indicator: 'action' },
    retrying: { labelKey: 'status.retryingExternally', tone: 'warning', indicator: 'action' },
    idle: { labelKey: 'status.ready', tone: 'ready', indicator: 'ready' },
    recentlyActive: { labelKey: 'status.recentlyActive', tone: 'muted', indicator: 'none' },
    unknown: { labelKey: 'status.externalStatusUnknown', tone: 'muted', indicator: 'none' },
} as const satisfies Record<ExternalAgentPresentationState, Readonly<{
    labelKey: ExternalSessionRuntimePresentation['externalAgent']['labelKey'];
    tone: ExternalSessionRuntimePresentation['externalAgent']['tone'];
    indicator: ExternalSessionRuntimePresentation['externalAgent']['indicator'];
}>>;

const UNKNOWN_EXTERNAL_AGENT_PRESENTATION_INPUT: ExternalAgentObservationPresentationInput = {
    state: 'unknown',
    observedAtMs: 0,
    expiresAtMs: null,
};

export function resolveExternalSessionCandidateActivityPresentation(
    activity: ExternalSessionActivityV1 | undefined,
): ExternalSessionRuntimePresentation['externalAgent'] {
    const state: ExternalAgentPresentationState = activity === 'running'
        ? 'working'
        : activity === 'active_recently'
            ? 'recentlyActive'
            : activity === 'idle'
                ? 'idle'
                : 'unknown';
    const presentation = EXTERNAL_AGENT_PRESENTATION_BY_STATE[state];
    return {
        state,
        labelKey: presentation.labelKey,
        tone: presentation.tone,
        indicator: presentation.indicator,
        nextExpiryAtMs: null,
    };
}

export function readExternalAgentObservationPresentationInput(
    metadata: unknown,
): ExternalAgentObservationPresentationInput {
    const metadataRecord = metadata && typeof metadata === 'object'
        ? metadata as Readonly<Record<string, unknown>>
        : {};
    const observation = readExternalAgentObservationSessionState(metadataRecord).value;
    if (!observation) {
        return UNKNOWN_EXTERNAL_AGENT_PRESENTATION_INPUT;
    }
    return {
        state: observation.status,
        observedAtMs: observation.observedAtMs ?? 0,
        expiresAtMs: observation.expiresAtMs ?? null,
    };
}

export function resolveExternalAgentPresentationState(
    observation: ExternalAgentObservationPresentationInput,
    nowMs: number,
): Readonly<{
    state: ExternalAgentPresentationState;
    nextExpiryAtMs: number | null;
}> {
    const expiresAtMs = Number.isFinite(observation.expiresAtMs) && (observation.expiresAtMs ?? 0) > 0
        ? observation.expiresAtMs
        : null;
    if (observation.state === 'unknown' || expiresAtMs === null || expiresAtMs <= nowMs) {
        return { state: 'unknown', nextExpiryAtMs: null };
    }
    return { state: observation.state, nextExpiryAtMs: expiresAtMs };
}

export function resolveExternalSessionRuntimePresentation(input: Readonly<{
    controlConnectivity: ExternalSessionRuntimePresentation['controlConnectivity'];
    detachedActivity: ExternalSessionRuntimePresentation['detachedActivity'];
    externalAgent: ExternalAgentObservationPresentationInput;
    nowMs: number;
}>): ExternalSessionRuntimePresentation {
    const resolved = resolveExternalAgentPresentationState(input.externalAgent, input.nowMs);
    const presentation = EXTERNAL_AGENT_PRESENTATION_BY_STATE[resolved.state];
    return {
        controlConnectivity: input.controlConnectivity,
        detachedActivity: input.detachedActivity,
        externalAgent: {
            state: resolved.state,
            labelKey: presentation.labelKey,
            tone: presentation.tone,
            indicator: presentation.indicator,
            nextExpiryAtMs: resolved.nextExpiryAtMs,
        },
    };
}

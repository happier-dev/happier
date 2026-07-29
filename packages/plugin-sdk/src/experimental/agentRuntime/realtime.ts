import type { AgentSessionRuntime } from '../../agentRuntime/session.js';
import type { PluginDiagnosticData } from '../../diagnostics.js';
import type { Disposable } from '../../lifecycle.js';

export type AgentSessionRealtimeAvailability =
    | Readonly<{
        status: 'available';
        transport: 'webrtc';
      }>
    | Readonly<{
        status: 'unavailable';
        reason:
            | 'authentication_required'
            | 'session_unavailable'
            | 'unsupported_runtime'
            | 'update_required'
            | 'feature_unavailable';
        diagnostic: PluginDiagnosticData;
      }>;

export type AgentSessionRealtimeStartInput = Readonly<{
    transport: Readonly<{
        kind: 'webrtc';
        offerSdp: string;
    }>;
}>;

export type AgentSessionRealtimeLifecycleEvent = Readonly<{
    kind: 'terminal';
    reason:
        | 'stopped'
        | 'upstream_closed'
        | 'agent_session_disposed'
        | 'aborted'
        | 'error';
    diagnostic?: PluginDiagnosticData;
}>;

export type AgentSessionRealtimeStopResult =
    | Readonly<{ status: 'stopped' | 'already_stopped' | 'aborted' }>
    | Readonly<{
        status: 'unavailable';
        diagnostic: PluginDiagnosticData;
      }>;

export interface AgentSessionRealtimeHandle extends Disposable {
    stop(
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionRealtimeStopResult>;
    watch(
        listener: (event: AgentSessionRealtimeLifecycleEvent) => void,
    ): Disposable;
    dispose(): void | Promise<void>;
}

export type AgentSessionRealtimeStartResult =
    | Readonly<{
        status: 'started';
        transport: Readonly<{
            kind: 'webrtc';
            answerSdp: string;
        }>;
        handle: AgentSessionRealtimeHandle;
      }>
    | Readonly<{ status: 'busy' | 'aborted' }>
    | Readonly<{
        status: 'unavailable' | 'failed';
        diagnostic: PluginDiagnosticData;
      }>;

export type PluginVoiceAgentSessionRealtimeService = Readonly<{
    inspect(
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionRealtimeAvailability>;
    start(
        input: AgentSessionRealtimeStartInput,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionRealtimeStartResult>;
}>;

export interface AgentSessionRealtimeConversation {
    inspect(
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionRealtimeAvailability>;
    start(
        input: AgentSessionRealtimeStartInput,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentSessionRealtimeStartResult>;
}

export interface ExperimentalAgentSessionRealtimeRuntime extends AgentSessionRuntime {
    readonly realtimeConversation: AgentSessionRealtimeConversation;
}

/**
 * Validates the extension only after a normalized contribution declaration has explicitly
 * selected `experimental_agent_session_realtime`. It is not an ambient capability probe.
 */
export function assertExperimentalAgentSessionRealtimeRuntime(
    value: unknown,
): ExperimentalAgentSessionRealtimeRuntime {
    if (!value || typeof value !== 'object') {
        throw new TypeError('Malformed experimental Agent session realtime runtime');
    }
    const runtime = value as Partial<ExperimentalAgentSessionRealtimeRuntime>;
    const realtime = runtime.realtimeConversation;
    if (
        typeof runtime.send !== 'function'
        || typeof runtime.watch !== 'function'
        || typeof runtime.dispose !== 'function'
        || !realtime
        || typeof realtime.inspect !== 'function'
        || typeof realtime.start !== 'function'
    ) {
        throw new TypeError('Malformed experimental Agent session realtime runtime');
    }
    return runtime as ExperimentalAgentSessionRealtimeRuntime;
}

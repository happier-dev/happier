import { logger } from '@/ui/logger';
import type { DaemonVoiceInferenceEndpointDecision } from '@happier-dev/protocol/daemon/voiceInference';

type VoiceLatencyPhase =
  | Readonly<{ phase: 'agent_dispatch' | 'agent_settled' | 'first_speakable_segment' | 'synthesis_started' | 'synthesis_first_audio_ready' }>
  | Readonly<{ phase: 'agent_first_text'; source: 'delta' | 'snapshot' }>
  | Readonly<{ phase: 'native_tool_start' | 'native_tool_end'; toolName: string }>
  | (Readonly<{ phase: 'endpoint_decided'; sequence: number }> & DaemonVoiceInferenceEndpointDecision);

export type VoiceLatencyTrace = (event: VoiceLatencyPhase) => void;

/** Use the existing QA latency opt-in and file log, never the audio artifact store. */
export function createVoiceLatencyTrace(ids: Readonly<{
  streamId?: string;
  requestId?: string;
}>): VoiceLatencyTrace | undefined {
  if (process.env.HAPPIER_WEB_LATENCY_TRACE !== '1') return;
  return (event) => {
    try {
      logger.debugLocalFile('[Voice] Latency phase', {
        ...ids,
        monotonicMs: performance.now(),
        timeOriginMs: performance.timeOrigin,
        ...event,
        pid: process.pid,
      });
    } catch { /* A diagnostic sink cannot affect the turn. */ }
  };
}

export function recordVoiceEndpointDecision(
  input: Readonly<{ requestId: string; streamId?: string; sequence: number; endpointRule: DaemonVoiceInferenceEndpointDecision['endpointRule'] }>,
  observedAt = { monotonicMs: performance.now(), timeOriginMs: performance.timeOrigin },
): DaemonVoiceInferenceEndpointDecision {
  const decision = { endpointRule: input.endpointRule, ...observedAt };
  createVoiceLatencyTrace({ requestId: input.requestId, ...(input.streamId ? { streamId: input.streamId } : {}) })?.({
    phase: 'endpoint_decided', sequence: input.sequence, ...decision,
  });
  return decision;
}

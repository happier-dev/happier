import { logger } from '@/ui/logger';

type VoiceLatencyPhase =
  | Readonly<{ phase: 'agent_dispatch' | 'agent_settled' | 'first_speakable_segment' | 'synthesis_started' | 'synthesis_first_audio_ready' }>
  | Readonly<{ phase: 'agent_first_text'; source: 'delta' | 'snapshot' }>
  | Readonly<{ phase: 'native_tool_start' | 'native_tool_end'; toolName: string }>
  | Readonly<{ phase: 'endpoint_decided'; endpointRule: 'unreported_by_recognizer'; sequence: number }>;

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
        ...event,
        monotonicMs: performance.now(),
        timeOriginMs: performance.timeOrigin,
        pid: process.pid,
      });
    } catch { /* A diagnostic sink cannot affect the turn. */ }
  };
}

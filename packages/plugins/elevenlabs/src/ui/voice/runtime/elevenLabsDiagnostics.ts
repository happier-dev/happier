import type { BundledVoiceProviderDiagnosticEvent } from '@happier-dev/bundled-voice-runtime-contract';

const MAX_DIAGNOSTIC_DEPTH = 6;
const MAX_DIAGNOSTIC_NODES = 64;
const MAX_DIAGNOSTIC_KEYS_PER_NODE = 64;
const SENSITIVE_CONTENT_KEY = /(text|message|transcript|content|reply|utterance)/i;

function readEventType(
  payload: unknown,
): BundledVoiceProviderDiagnosticEvent['eventType'] {
  try {
    if (!payload || typeof payload !== 'object') return 'unknown';
    const type = (payload as Readonly<{ type?: unknown }>).type;
    if (typeof type !== 'string') return 'unknown';
    switch (type) {
      case 'agent_chat_response_part':
      case 'agent_response':
      case 'agent_response_correction':
      case 'agent_tool_response':
      case 'audio':
      case 'client_tool_call':
      case 'conversation_initiation_metadata':
      case 'elevenlabs.connect':
      case 'elevenlabs.mode':
      case 'elevenlabs.status':
      case 'guardrail_triggered':
      case 'interruption':
      case 'user_transcript':
        return type;
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

function classifyPayload(payload: unknown): BundledVoiceProviderDiagnosticEvent['redactionClass'] {
  if (typeof payload === 'string') return 'transcript_redacted';
  if (!payload || typeof payload !== 'object') return 'control';

  const queue: Array<Readonly<{ value: object; depth: number }>> = [{ value: payload, depth: 0 }];
  const seen = new Set<object>();
  let cursor = 0;
  let truncated = false;

  try {
    while (cursor < queue.length) {
      if (seen.size >= MAX_DIAGNOSTIC_NODES) {
        truncated = true;
        break;
      }
      const current = queue[cursor];
      cursor += 1;
      if (!current || seen.has(current.value)) continue;
      seen.add(current.value);

      let keysRead = 0;
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        if (keysRead >= MAX_DIAGNOSTIC_KEYS_PER_NODE) {
          truncated = true;
          break;
        }
        keysRead += 1;
        if (key.length > 64) truncated = true;
        if (SENSITIVE_CONTENT_KEY.test(key.slice(0, 64))) return 'transcript_redacted';

        const value = (current.value as Record<string, unknown>)[key];
        if (!value || typeof value !== 'object') continue;
        if (current.depth >= MAX_DIAGNOSTIC_DEPTH) {
          truncated = true;
          continue;
        }
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  } catch {
    return 'unknown_redacted';
  }

  return truncated ? 'unknown_redacted' : 'control';
}

export function createElevenLabsProviderDiagnosticEvent(
  payload: unknown,
): BundledVoiceProviderDiagnosticEvent {
  return Object.freeze({
    providerId: 'realtime_elevenlabs',
    eventType: readEventType(payload),
    // The decoded provider event does not retain an authoritative wire byte count.
    payloadBytes: null,
    redactionClass: classifyPayload(payload),
  });
}

export function createElevenLabsDiagnostics(input: Readonly<{
  appendSystem: (message: string) => void;
  appendProviderEvent: (event: BundledVoiceProviderDiagnosticEvent) => void;
  appendError: (reason: string) => void;
}>) {
  return Object.freeze({
    connected(): void {
      input.appendSystem('Realtime ElevenLabs session connected');
    },
    disconnected(): void {
      input.appendSystem('Realtime ElevenLabs session disconnected');
    },
    providerEvent(payload: unknown): void {
      input.appendProviderEvent(createElevenLabsProviderDiagnosticEvent(payload));
    },
    error(reason: string): void {
      input.appendError(reason);
    },
  });
}

export type ElevenLabsDiagnostics = ReturnType<typeof createElevenLabsDiagnostics>;

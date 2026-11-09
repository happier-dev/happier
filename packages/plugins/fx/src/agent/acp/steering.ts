import { Buffer } from 'node:buffer';
import type { AgentAcpInFlightSteerDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function metadata(value: unknown): Record<string, unknown> | null {
  return record(record(record(value)?._meta)?.fx);
}

// FX 0.0.14 (1a070af32cdf), src/acp/server.zig handleSteeringPrompt /
// steeringPromptText and libfx_steering.zig: text only, at most 64 KiB in UTF-8.
// Captured wire frames: E-fx-live-probe.md §3, 2026-10-27.
export const FX_ACP_STEERING = Object.freeze({
  method: 'session/prompt',
  isSupported: capabilities => metadata(capabilities)?.steering === true,
  buildParams({ providerSessionId, content }) {
    let bytes = 0;
    for (const block of content) {
      const text = record(block);
      if (text?.type !== 'text' || typeof text.text !== 'string') return null;
      if (bytes > 0) bytes += 1; // FX joins noninitial text with a newline.
      bytes += Buffer.byteLength(text.text, 'utf8');
      if (bytes > 64 * 1024) return null;
    }
    if (bytes === 0) return null;
    return { sessionId: providerSessionId, prompt: [...content], _meta: { fx: { steer: true } } };
  },
  isAccepted: response => metadata(response)?.steering === 'absorbed',
  isRejected: response => metadata(response)?.steering === 'dropped',
} satisfies AgentAcpInFlightSteerDefinition);

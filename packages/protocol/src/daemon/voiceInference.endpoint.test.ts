import { describe, expect, it } from 'vitest';
import { DaemonVoiceInferenceSttStreamChunkResponseSchema, DaemonVoiceInferenceSttStreamFinishResponseSchema } from './voiceInference.js';

describe('stream endpoint diagnostics wire compatibility', () => {
  it.each(['endpoint', 'final'] as const)('accepts earlier %s events and preserves a daemon observation', type => {
    const parse = (endpointDecision?: unknown) => {
      const events = [{ type, seq: 0, ...(type === 'endpoint' ? { transcript: 'heard', reason: 'vad' } : { text: 'heard' }),
        ...(endpointDecision ? { endpointDecision } : {}) }];
      const response = { ok: true, streamId: 'stream-endpoint', generation: 0, ackSeq: 0, events };
      return type === 'endpoint'
        ? DaemonVoiceInferenceSttStreamChunkResponseSchema.parse(response)
        : DaemonVoiceInferenceSttStreamFinishResponseSchema.parse({ ...response, finalText: 'heard' });
    };
    const earlier = parse();
    expect(earlier.ok && earlier.events[0]?.endpointDecision).toBeUndefined();
    const decision = { endpointRule: type === 'endpoint' ? 'unreported_by_recognizer' : 'input_finished_by_client',
      monotonicMs: 120, timeOriginMs: 1_700_000_000_000 };
    const observed = parse(decision);
    expect(observed.ok && observed.events[0]?.endpointDecision).toEqual(decision);
    expect(() => parse({ ...decision, endpointRule: 'private arbitrary text' })).toThrow();
    expect(() => parse({ ...decision, monotonicMs: Number.NaN })).toThrow();
  });
});

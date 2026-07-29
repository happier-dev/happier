import { describe, expect, it } from 'vitest';

import { deriveVoiceAgentTurnLocalId, readVoiceAgentTurnPayloadFromMeta } from './voiceAgentTurnLocalId.js';

describe('voiceAgentTurnLocalId', () => {
  it('derives a stable provisional localId for pre-commit voice turns', async () => {
    const module = await import('./voiceAgentTurnLocalId.js');
    const provisionalDeriver = (module as Record<string, unknown>)['deriveVoiceAgentTurnProvisionalLocalId'];

    expect(typeof provisionalDeriver).toBe('function');
    expect((provisionalDeriver as (input: {
      transcriptSessionId: string;
      role: 'user' | 'assistant';
      sequence: number;
    }) => string)({
      transcriptSessionId: 'carrier-s1',
      role: 'user',
      sequence: 2,
    })).toBe('voice-turn-provisional:carrier-s1:user:2');
  });

  it('derives a stable committed localId from voice turn metadata', () => {
    expect(deriveVoiceAgentTurnLocalId({
      epoch: 7,
      role: 'assistant',
      ts: 123,
      voiceAgentId: 'va_1',
    })).toBe('voice-turn:va_1:7:assistant:123');
  });

  it('incorporates available run and stream identity into newer stable turn ids', () => {
    expect(deriveVoiceAgentTurnLocalId({
      epoch: 7,
      role: 'assistant',
      ts: 123,
      voiceAgentId: 'va_1',
      runId: 'run_1',
      streamId: 'stream_1',
      requestId: 'request_1',
    })).toBe('voice-turn:va_1:run_1:stream_1:request_1:7:assistant:123');
  });

  it('reads a voice turn payload from happier metadata envelopes', () => {
    expect(readVoiceAgentTurnPayloadFromMeta({
      happier: {
        kind: 'voice_agent_turn.v1',
        payload: {
          v: 1,
          epoch: 11,
          role: 'user',
          ts: 456,
          voiceAgentId: 'va_2',
        },
      },
    })).toEqual({
      v: 1,
      epoch: 11,
      role: 'user',
      ts: 456,
      voiceAgentId: 'va_2',
    });
  });
});

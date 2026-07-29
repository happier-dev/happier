import { describe, expect, it } from 'vitest';

import {
  VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
  VoiceMediaAgentRealtimeFrameV1Schema,
  AgentRealtimeApplicationAuthorityFactsV1Schema,
  VoiceMediaApplicationAuthorityV1Schema,
  VoiceMediaApplicationKindV1Schema,
  createAgentRealtimeApplicationAuthorityV1,
  decodeVoiceMediaAgentRealtimeFrameV1,
  encodeVoiceMediaAgentRealtimeFrameV1,
  verifyAgentRealtimeApplicationAuthorityV1,
} from './voiceMediaV1.js';

describe('voice media v1', () => {
  it('admits only the two approved application kinds and binds an opaque attempt plus authority digest', () => {
    expect(VoiceMediaApplicationKindV1Schema.options).toEqual([
      'speech_transcription',
      'agent_realtime',
    ]);
    expect(VoiceMediaApplicationAuthorityV1Schema.parse({
      v: 1,
      applicationKind: 'agent_realtime',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
    })).toEqual({
      v: 1,
      applicationKind: 'agent_realtime',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
    });
    expect(VoiceMediaApplicationAuthorityV1Schema.safeParse({
      v: 1,
      applicationKind: 'speech_transcription',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
      sessionId: 'raw-session-id-must-not-enter-the-carrier',
    }).success).toBe(false);
  });

  it('derives Agent realtime authority from the exact Happier session, Agent generation, and attempt-scoped bridge', () => {
    const facts = AgentRealtimeApplicationAuthorityFactsV1Schema.parse({
      v: 1,
      happierSessionId: 'session-1',
      agentRef: {
        pluginId: 'happier.agent.codex',
        localId: 'codex',
      },
      agentGeneration: 'registry:7',
      sessionBridgeId: 'bridge-attempt-1',
      applicationAttemptId: 'attempt-1',
    });
    const authority = createAgentRealtimeApplicationAuthorityV1(facts);

    expect(authority).toEqual({
      v: 1,
      applicationKind: 'agent_realtime',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest:
        'sha256:d3975a1554ce6ff0a2af7312fbce0548f586b4474a72d6ba04b112fe96ab878c',
    });
    expect(verifyAgentRealtimeApplicationAuthorityV1({
      authority,
      facts,
    })).toBe(true);
    expect(verifyAgentRealtimeApplicationAuthorityV1({
      authority,
      facts: { ...facts, happierSessionId: 'session-2' },
    })).toBe(false);
    expect(verifyAgentRealtimeApplicationAuthorityV1({
      authority,
      facts: {
        ...facts,
        agentRef: { ...facts.agentRef, localId: 'another-agent' },
      },
    })).toBe(false);
    expect(verifyAgentRealtimeApplicationAuthorityV1({
      authority,
      facts: { ...facts, agentGeneration: 'registry:8' },
    })).toBe(false);
    expect(verifyAgentRealtimeApplicationAuthorityV1({
      authority,
      facts: { ...facts, sessionBridgeId: 'bridge-attempt-2' },
    })).toBe(false);
  });

  it('round-trips binary Agent input/output PCM and rejects inconsistent sample metadata', () => {
    const input = {
      v: 1 as const,
      kind: 'input_audio' as const,
      applicationSequence: 4,
      format: VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
      samplesPerChannel: 3,
      payload: new Uint8Array([1, 2, 3, 4, 5, 6]),
    };
    expect(decodeVoiceMediaAgentRealtimeFrameV1(encodeVoiceMediaAgentRealtimeFrameV1(input))).toEqual(input);

    const output = {
      v: 1 as const,
      kind: 'output_audio' as const,
      applicationSequence: 7,
      upstreamItemId: 'item-1',
      format: VOICE_MEDIA_AGENT_REALTIME_PCM_FORMAT_V1,
      samplesPerChannel: 2,
      payload: new Uint8Array([1, 2, 3, 4]),
    };
    expect(decodeVoiceMediaAgentRealtimeFrameV1(encodeVoiceMediaAgentRealtimeFrameV1(output))).toEqual(output);
    expect(VoiceMediaAgentRealtimeFrameV1Schema.safeParse({
      ...output,
      samplesPerChannel: 3,
    }).success).toBe(false);
    expect(VoiceMediaAgentRealtimeFrameV1Schema.safeParse({
      ...output,
      format: { ...output.format, sampleRateHz: 48_000 },
    }).success).toBe(false);
  });

  it('keeps input acceptance and output queue acceptance as distinct application credits', () => {
    expect(VoiceMediaAgentRealtimeFrameV1Schema.parse({
      v: 1,
      kind: 'input_accepted',
      applicationSequence: 11,
      acceptedBytes: 640,
    })).toMatchObject({ kind: 'input_accepted', applicationSequence: 11 });
    expect(VoiceMediaAgentRealtimeFrameV1Schema.parse({
      v: 1,
      kind: 'output_accepted',
      applicationSequence: 12,
      acceptedBytes: 960,
    })).toMatchObject({ kind: 'output_accepted', applicationSequence: 12 });
  });

  it('carries bounded typed delegation activity without forwarding provider-native bags', () => {
    expect(VoiceMediaAgentRealtimeFrameV1Schema.parse({
      v: 1,
      kind: 'activity',
      applicationSequence: 13,
      activity: 'delegation_requested',
      upstreamItemId: 'item-1',
    })).toMatchObject({ kind: 'activity', activity: 'delegation_requested' });
    expect(VoiceMediaAgentRealtimeFrameV1Schema.safeParse({
      v: 1,
      kind: 'activity',
      applicationSequence: 13,
      activity: 'provider_native_event',
      data: { arbitrary: true },
    }).success).toBe(false);
  });
});

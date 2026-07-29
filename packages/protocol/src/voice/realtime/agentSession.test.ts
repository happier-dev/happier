import { describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_REALTIME_SDP_MAX_BYTES,
  AgentSessionRealtimeInspectRequestV1Schema,
  AgentSessionRealtimeInspectResultV1Schema,
  AgentSessionRealtimeStartRequestV1Schema,
  AgentSessionRealtimeStartResultV1Schema,
  AgentSessionRealtimeStopRequestV1Schema,
  AgentSessionRealtimeWatchRequestV1Schema,
  AgentSessionRealtimeWatchResultV1Schema,
} from './agentSession.js';

describe('Agent-session realtime Voice control contracts', () => {
  const exactSdp = 'é'.repeat(AGENT_SESSION_REALTIME_SDP_MAX_BYTES / 2);
  const oversizedSdp = `${exactSdp}x`;
  const selection = {
    v: 1,
    provider: { pluginId: 'happier.agent.codex', localId: 'realtime-codex' },
  } as const;

  it('accepts only an exact declaration selection, opaque attempt id, and bounded WebRTC offer', () => {
    expect(AgentSessionRealtimeInspectRequestV1Schema.parse(selection)).toEqual(selection);
    const start = {
      ...selection,
      applicationAttemptId: 'attempt-1',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    } as const;
    expect(AgentSessionRealtimeStartRequestV1Schema.parse(start)).toMatchObject({
      provider: selection.provider,
      applicationAttemptId: 'attempt-1',
      transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
    });
    expect(AgentSessionRealtimeStartRequestV1Schema.safeParse({
      ...start,
      transport: { kind: 'host_pcm' },
    }).success).toBe(false);
  });

  it('forbids caller-selected session, thread, generation, credential, grant, prompt, and upstream RPC fields', () => {
    for (const forbidden of ['sessionId', 'threadId', 'generation', 'apiKey', 'grant', 'prompt', 'method']) {
      expect(AgentSessionRealtimeStartRequestV1Schema.safeParse({
        ...selection,
        applicationAttemptId: 'attempt-1',
        transport: { kind: 'webrtc', offerSdp: 'v=0\r\n' },
        [forbidden]: 'caller-controlled',
      }).success).toBe(false);
    }
  });

  it('preserves authentication-required separately from lifecycle session unavailability', () => {
    expect(AgentSessionRealtimeInspectResultV1Schema.parse({
      ok: false,
      status: 'unavailable',
      code: 'agent_realtime_authentication_required',
      message: 'Connect the selected Agent account.',
      reason: 'authentication_required',
    })).toMatchObject({
      status: 'unavailable',
      reason: 'authentication_required',
    });
  });

  it('returns bounded WebRTC answer and retained terminal lifecycle facts without media authority', () => {
    expect(AgentSessionRealtimeStartResultV1Schema.parse({
      ok: true,
      status: 'started',
      transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
    })).toEqual({
      ok: true,
      status: 'started',
      transport: { kind: 'webrtc', answerSdp: 'v=0\r\n' },
    });
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse({
      ok: true,
      status: 'started',
      transport: { kind: 'host_pcm' },
    }).success).toBe(false);
    const attempt = { ...selection, applicationAttemptId: 'attempt-1' };
    expect(AgentSessionRealtimeStopRequestV1Schema.parse(attempt)).toEqual(attempt);
    expect(AgentSessionRealtimeWatchRequestV1Schema.parse(attempt)).toEqual(attempt);
    expect(AgentSessionRealtimeWatchResultV1Schema.parse({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    })).toEqual({
      ok: true,
      status: 'terminal',
      event: { kind: 'terminal', reason: 'upstream_closed' },
    });
  });

  it('enforces the canonical UTF-8 byte ceiling exactly for offer and answer SDP', () => {
    expect(new TextEncoder().encode(exactSdp).byteLength)
      .toBe(AGENT_SESSION_REALTIME_SDP_MAX_BYTES);
    expect(new TextEncoder().encode(oversizedSdp).byteLength)
      .toBe(AGENT_SESSION_REALTIME_SDP_MAX_BYTES + 1);
    const start = {
      ...selection,
      applicationAttemptId: 'attempt-byte-boundary',
      transport: { kind: 'webrtc' as const, offerSdp: exactSdp },
    };
    expect(AgentSessionRealtimeStartRequestV1Schema.safeParse(start).success).toBe(true);
    expect(AgentSessionRealtimeStartRequestV1Schema.safeParse({
      ...start,
      transport: { kind: 'webrtc', offerSdp: oversizedSdp },
    }).success).toBe(false);

    const result = {
      ok: true as const,
      status: 'started' as const,
      transport: { kind: 'webrtc' as const, answerSdp: exactSdp },
    };
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse(result).success).toBe(true);
    expect(AgentSessionRealtimeStartResultV1Schema.safeParse({
      ...result,
      transport: { kind: 'webrtc', answerSdp: oversizedSdp },
    }).success).toBe(false);
  });
});

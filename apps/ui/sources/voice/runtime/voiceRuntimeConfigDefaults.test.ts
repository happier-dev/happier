import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKCHANNEL_GATE } from '@/voice/runtime/input/resolveBackchannelDecision';
import { DEFAULT_TURN_POLICY } from '@/voice/runtime/input/turnPolicyMachine';
import { DEFAULT_TEXTUAL_ECHO_GUARD } from '@/voice/runtime/echo/textualEchoGuard';

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from './voiceRuntimeConfigDefaults';

describe('voiceRuntimeConfigDefaults', () => {
  it('aligns daemon TTS default codec with the active wav controller contract', () => {
    expect(VOICE_RUNTIME_CONFIG_DEFAULTS.daemonInference.tts.defaultCodec).toEqual({
      codec: 'wav',
      mimeType: 'audio/wav',
    });
  });

  it('owns the turn-taking endpoint / backchannel / echo thresholds as the single source of truth', () => {
    expect(VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking).toEqual({
      endpointHysteresis: { confirmMs: 800, silenceMs: 700 },
      backchannelGate: {
        maxWords: 3,
        maxDurationMs: 700,
        protectedHeadMs: 800,
        minConfidence: null,
      },
      textualEchoGuard: { overlapThreshold: 0.7, justStartedGuardMs: 200 },
    });
  });

  it('feeds the endpoint / backchannel / echo module defaults from the canonical owner (no drift)', () => {
    expect(DEFAULT_TURN_POLICY).toEqual(VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.endpointHysteresis);
    expect(DEFAULT_BACKCHANNEL_GATE).toEqual(VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.backchannelGate);
    expect(DEFAULT_TEXTUAL_ECHO_GUARD).toEqual(VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.textualEchoGuard);
  });

  it('owns the realtime reconnect/inbound-watchdog knobs as the single source of truth (no call-site magic numbers)', () => {
    const realtime = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime;
    // Bounded-backoff reconnect: positive base/cap with a capped exponential
    // growth and a finite retry budget before non-recoverable surfacing.
    expect(realtime.reconnect.baseBackoffMs).toBeGreaterThan(0);
    expect(realtime.reconnect.maxBackoffMs).toBeGreaterThanOrEqual(realtime.reconnect.baseBackoffMs);
    expect(realtime.reconnect.backoffFactor).toBeGreaterThanOrEqual(1);
    expect(realtime.reconnect.maxRetries).toBeGreaterThan(0);
    // Inbound stall watchdog timeout is a positive window.
    expect(realtime.inboundWatchdog.stallTimeoutMs).toBeGreaterThan(0);
  });
});

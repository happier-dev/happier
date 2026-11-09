import { describe, expect, it } from 'vitest';

import { readClaudeProviderEvent } from './providerEvents.js';

// One provider id that is simultaneously padded, multi-line and base64-ish, so a
// reader that trims, splits or re-encodes it is caught by the same assertion.
const RAW_PROVIDER_ID = '  provider\nses/AB+cd==  ';

describe('Claude provider event parsing', () => {
  it('accepts ordinary progress and validates the optional native retry projection', () => {
    const progress = { kind: 'turn-progress', sessionId: 'happy-session', turnId: 'turn-1', emittedAtMs: 1 };
    expect(readClaudeProviderEvent(progress)).toEqual(progress);
    expect(readClaudeProviderEvent({ ...progress, retry: { attempt: 2, reason: 'rate_limited' } }))
      .toEqual({ ...progress, retry: { attempt: 2, reason: 'rate_limited' } });
    for (const retry of [
      { attempt: 0, reason: 'unknown' }, { attempt: 1.5, reason: 'unknown' },
      { attempt: Number.MAX_SAFE_INTEGER + 1, reason: 'unknown' },
      { attempt: 1, reason: 'unexpected' }, { attempt: 1, reason: 'unknown', message: 'native prose' },
    ]) expect(readClaudeProviderEvent({ ...progress, retry })).toBeNull();
  });

  it('publishes the provider session id Claude minted, byte for byte', () => {
    const event = readClaudeProviderEvent({
      kind: 'session-id-publish',
      sessionId: 'happy-session',
      emittedAtMs: 1,
      publishedSessionId: RAW_PROVIDER_ID,
      source: 'claude-agent-sdk',
    });

    expect(event).not.toBeNull();
    expect(event?.kind).toBe('session-id-publish');
    expect(event && 'publishedSessionId' in event ? event.publishedSessionId : null)
      .toBe(RAW_PROVIDER_ID);
  });

  it('rejects a blank provider session id instead of publishing an empty identity', () => {
    expect(readClaudeProviderEvent({
      kind: 'session-id-publish',
      sessionId: 'happy-session',
      emittedAtMs: 1,
      publishedSessionId: '   \n  ',
      source: 'claude-agent-sdk',
    })).toBeNull();
  });

  it('keeps the observed agent turn id exact', () => {
    const observed = readClaudeProviderEvent({
      kind: 'turn-agent-id-observed',
      sessionId: 'happy-session',
      emittedAtMs: 3,
      turnId: 'turn-1',
      agentTurnId: RAW_PROVIDER_ID,
    });
    expect(observed && 'agentTurnId' in observed ? observed.agentTurnId : null)
      .toBe(RAW_PROVIDER_ID);
  });

  it('bounds the native session log path on the raw value it would read', () => {
    const base = {
      kind: 'session-id-publish' as const,
      sessionId: 'happy-session',
      emittedAtMs: 4,
      publishedSessionId: 'claude-1',
      source: 'claude-agent-sdk',
    };

    expect(readClaudeProviderEvent({
      ...base,
      nativeSessionLogPath: `${'a'.repeat(4_096)}  `,
    })).toBeNull();
    expect(readClaudeProviderEvent({
      ...base,
      nativeSessionLogPath: 'a'.repeat(4_096),
    })).not.toBeNull();
  });

  it('still canonicalizes the Happier-owned session id', () => {
    const event = readClaudeProviderEvent({
      kind: 'session-id-publish',
      sessionId: '  happy-session  ',
      emittedAtMs: 5,
      publishedSessionId: 'claude-1',
      source: 'claude-agent-sdk',
    });

    expect(event?.sessionId).toBe('happy-session');
  });
});

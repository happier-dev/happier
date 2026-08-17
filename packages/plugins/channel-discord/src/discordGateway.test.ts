import { describe, expect, it } from 'vitest';

import {
  DISCORD_IDENTIFY_LIMIT_PER_24_HOURS,
  calculateDiscordReconnectDelayMs,
  createDiscordGatewaySession,
  normalizeDiscordGatewayUrl,
} from './discordGateway.js';

const NOW = 1_700_000_000_000;

function gatewayBotLimit(overrides: Partial<Readonly<{
  total: number;
  remaining: number;
  resetAfterMs: number;
  maxConcurrency: number;
  observedAtMs: number;
}>> = {}) {
  return {
    total: DISCORD_IDENTIFY_LIMIT_PER_24_HOURS,
    remaining: DISCORD_IDENTIFY_LIMIT_PER_24_HOURS,
    resetAfterMs: 24 * 60 * 60 * 1_000,
    maxConcurrency: 1,
    observedAtMs: NOW,
    ...overrides,
  };
}

describe('Discord Gateway receive-progress owner', () => {
  it('normalizes only Gateway URLs admitted by the declared Discord WebSocket origin', () => {
    expect(normalizeDiscordGatewayUrl('wss://gateway.discord.gg')).toBe(
      'wss://gateway.discord.gg/?v=10&encoding=json',
    );
    expect(normalizeDiscordGatewayUrl('wss://gateway.discord.gg:444/?v=9')).toBeNull();
    expect(normalizeDiscordGatewayUrl('wss://token@gateway.discord.gg/?v=10')).toBeNull();
    expect(normalizeDiscordGatewayUrl('wss://gateway.discord.gg/?v=10#fragment')).toBeNull();
    expect(normalizeDiscordGatewayUrl('wss://gateway.discord.gg/?compress=zlib-stream&v=9&encoding=etf')).toBe(
      'wss://gateway.discord.gg/?v=10&encoding=json',
    );
  });

  it('returns an authenticated Dispatch effect while retaining receive progress separately from Channels admission', () => {
    const session = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
    });

    expect(session.onFrame({
      op: 0,
      s: 73,
      t: 'MESSAGE_CREATE',
      d: { id: 'message-a' },
    }, NOW)).toEqual([{
      kind: 'dispatch',
      sequence: 73,
      event: 'MESSAGE_CREATE',
      payload: { id: 'message-a' },
    }]);
    expect(session.snapshot().lastDispatchSequence).toBe(73);
  });

  it('uses the last received Dispatch sequence for both heartbeat and Resume, without a Channels checkpoint input', () => {
    const session = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-a',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 41,
      },
      initialHeartbeatDelayMs: 0,
    });

    expect(session.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW)).toEqual([
      { kind: 'scheduleHeartbeat', afterMs: 0 },
      {
        kind: 'send',
        payload: {
          op: 6,
          d: { token: 'bot-token', session_id: 'session-a', seq: 41 },
        },
      },
    ]);

    session.onFrame({ op: 0, s: 73, t: 'MESSAGE_CREATE', d: { id: 'message-a' } }, NOW);
    expect(session.onHeartbeatTimer()).toEqual([
      { kind: 'send', payload: { op: 1, d: 73 } },
      { kind: 'scheduleHeartbeat', afterMs: 45_000 },
    ]);

    const replacement = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: session.snapshot().sessionStartLimit,
      resume: session.snapshot().resume ?? undefined,
      initialHeartbeatDelayMs: 0,
    });
    expect(replacement.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW)).toContainEqual({
      kind: 'send',
      payload: {
        op: 6,
        d: { token: 'bot-token', session_id: 'session-a', seq: 73 },
      },
    });
  });

  it('reports an explicit history gap and closes when a received Dispatch cannot enter durable admission', () => {
    const session = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
    });

    expect(session.markAdmissionLost()).toEqual([
      { kind: 'historyGap', reason: 'applicationAdmissionLost' },
      { kind: 'disconnect', reason: 'applicationAdmissionLost' },
    ]);
  });

  it('turns an invalid non-resumable session into a history gap rather than a false liveness claim', () => {
    const session = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-a',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 41,
      },
    });

    expect(session.onFrame({ op: 9, d: false }, NOW)).toEqual([
      { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
      { kind: 'disconnect', reason: 'invalidSession' },
      { kind: 'reconnect', canResume: false, minDelayMs: 1_000, maxDelayMs: 5_000 },
    ]);
    expect(session.snapshot().resume).toBeNull();
  });

  it('clears expired-session Dispatch progress before a fresh Identify heartbeat', () => {
    const invalidSession = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-a',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 41,
      },
      initialHeartbeatDelayMs: 0,
    });
    const sessionTimedOut = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-b',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 73,
      },
      initialHeartbeatDelayMs: 0,
    });

    invalidSession.onFrame({ op: 9, d: false }, NOW);
    sessionTimedOut.onClose({ code: 4_009 });

    expect(invalidSession.snapshot()).toMatchObject({
      resume: null,
      lastDispatchSequence: null,
    });
    expect(sessionTimedOut.snapshot()).toMatchObject({
      resume: null,
      lastDispatchSequence: null,
    });
    expect(invalidSession.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW)).toContainEqual({
      kind: 'send',
      payload: {
        op: 2,
        d: expect.objectContaining({ token: 'bot-token', intents: 4_608 }),
      },
    });
    expect(invalidSession.onHeartbeatTimer()).toEqual([
      { kind: 'send', payload: { op: 1, d: null } },
      { kind: 'scheduleHeartbeat', afterMs: 45_000 },
    ]);
  });

  it('fails closed at Discord’s 1,000 IDENTIFY-per-day limit and bounds reconnect backoff', () => {
    const exhausted = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit({ remaining: 0 }),
    });

    expect(exhausted.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW)).toContainEqual({
      kind: 'blocked',
      reason: 'identifyLimit',
      retryAtMs: NOW + (24 * 60 * 60 * 1_000),
    });
    expect(calculateDiscordReconnectDelayMs(0)).toBe(1_000);
    expect(calculateDiscordReconnectDelayMs(5)).toBe(30_000);
    expect(calculateDiscordReconnectDelayMs(50)).toBe(30_000);
  });

  it('uses authoritative Get Gateway Bot remaining/reset_after facts instead of fabricating a local renewed budget', () => {
    const exhausted = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit({ remaining: 0, maxConcurrency: 2 }),
    });
    const expiredSnapshot = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit({
        observedAtMs: NOW - (24 * 60 * 60 * 1_000),
        resetAfterMs: 1,
        remaining: 1,
      }),
    });

    expect(exhausted.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW)).toContainEqual({
      kind: 'blocked',
      reason: 'identifyLimit',
      retryAtMs: NOW + (24 * 60 * 60 * 1_000),
    });
    expect(expiredSnapshot.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW)).toContainEqual({
      kind: 'blocked',
      reason: 'sessionStartLimitRefreshRequired',
      retryAtMs: NOW - ((24 * 60 * 60 * 1_000) - 1),
    });
    const permitted = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit({ remaining: 1, maxConcurrency: 2 }),
    });
    expect(permitted.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW)).toContainEqual({
      kind: 'send',
      payload: {
        op: 2,
        d: {
          token: 'bot-token',
          intents: 4_608,
          properties: { os: 'happier', browser: 'happier', device: 'happier' },
        },
      },
    });
    expect(permitted.snapshot().sessionStartLimit).toMatchObject({ remaining: 0, maxConcurrency: 2 });
  });

  it('reconnects with the current Resume state after a missed heartbeat acknowledgement', () => {
    const session = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-a',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 41,
      },
    });

    session.onFrame({ op: 10, d: { heartbeat_interval: 45_000 } }, NOW);
    session.onHeartbeatTimer();
    expect(session.onHeartbeatTimer()).toEqual([
      { kind: 'disconnect', reason: 'heartbeatAckMissing' },
      { kind: 'reconnect', canResume: true, minDelayMs: 1_000, maxDelayMs: 30_000 },
    ]);
  });

  it('treats documented Gateway close codes as resumable, reset-required, or terminal', () => {
    const resumable = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-a',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 41,
      },
    });
    const newSessionRequired = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-a',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 41,
      },
    });
    const sessionTimeout = createDiscordGatewaySession({
      token: 'bot-token',
      intents: 4_608,
      sessionStartLimit: gatewayBotLimit(),
      resume: {
        sessionId: 'session-a',
        resumeGatewayUrl: 'wss://gateway.discord.gg',
        lastDispatchSequence: 41,
      },
    });

    expect(resumable.onClose({ code: 4_000 })).toEqual([
      { kind: 'reconnect', canResume: true, minDelayMs: 1_000, maxDelayMs: 30_000 },
    ]);
    expect(newSessionRequired.onClose({ code: 4_007 })).toEqual([
      { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
      { kind: 'reconnect', canResume: false, minDelayMs: 1_000, maxDelayMs: 30_000 },
    ]);
    expect(sessionTimeout.onClose({ code: 4_009 })).toEqual([
      { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
      { kind: 'reconnect', canResume: false, minDelayMs: 1_000, maxDelayMs: 30_000 },
    ]);
    for (const [code, reason] of [
      [4_004, 'authenticationFailed'],
      [4_010, 'invalidShard'],
      [4_011, 'shardingRequired'],
      [4_012, 'invalidApiVersion'],
      [4_013, 'invalidIntents'],
      [4_014, 'disallowedIntents'],
    ] as const) {
      const terminal = createDiscordGatewaySession({
        token: 'bot-token',
        intents: 4_608,
        sessionStartLimit: gatewayBotLimit(),
      });
      expect(terminal.onClose({ code })).toEqual([{ kind: 'terminal', reason }]);
    }
  });
});

import type { ConversationTransportFactReportInputV1 } from '@happier-dev/channels-protocol/v1';

/**
 * Provider-owned Discord Gateway receive progress. This module deliberately
 * has no Channels checkpoint or admission state: Gateway heartbeats and
 * Resume are governed only by Discord Dispatch receipt.
 */

export const DISCORD_IDENTIFY_LIMIT_PER_24_HOURS = 1_000;
export const DISCORD_IDENTIFY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type DiscordGatewayResumeState = Readonly<{
  sessionId: string;
  resumeGatewayUrl: string;
  lastDispatchSequence: number;
}>;

/** Authoritative `GET /gateway/bot` session_start_limit evidence. */
export type DiscordGatewaySessionStartLimit = Readonly<{
  total: number;
  remaining: number;
  resetAfterMs: number;
  maxConcurrency: number;
  observedAtMs: number;
}>;

/** The reconnect window Discord applies to one kind of disconnect. */
export type DiscordGatewayReconnectDelayBounds = Readonly<{
  minDelayMs: number;
  maxDelayMs: number;
}>;

export type DiscordGatewayEffect =
  | Readonly<{ kind: 'send'; payload: Readonly<{ op: number; d: unknown }> }>
  | Readonly<{ kind: 'dispatch'; sequence: number; event: string; payload: unknown }>
  | Readonly<{ kind: 'scheduleHeartbeat'; afterMs: number }>
  | Readonly<{
      kind: 'disconnect';
      reason: 'heartbeatAckMissing' | 'invalidSession' | 'serverRequestedReconnect' | 'applicationAdmissionLost';
    }>
  | Extract<ConversationTransportFactReportInputV1['fact'], Readonly<{ kind: 'historyGap' }>>
  | (Readonly<{ kind: 'reconnect'; canResume: boolean }> & DiscordGatewayReconnectDelayBounds)
  | Readonly<{ kind: 'blocked'; reason: 'identifyLimit' | 'sessionStartLimitRefreshRequired'; retryAtMs: number }>
  | Readonly<{
      kind: 'terminal';
      reason: 'authenticationFailed' | 'invalidShard' | 'shardingRequired' | 'invalidApiVersion' | 'invalidIntents' | 'disallowedIntents';
    }>;

export type DiscordGatewaySnapshot = Readonly<{
  lastDispatchSequence: number | null;
  resume: DiscordGatewayResumeState | null;
  awaitingHeartbeatAck: boolean;
  sessionStartLimit: DiscordGatewaySessionStartLimit;
}>;

export type DiscordGatewaySession = Readonly<{
  onFrame(frame: unknown, nowMs: number): readonly DiscordGatewayEffect[];
  onHeartbeatTimer(): readonly DiscordGatewayEffect[];
  onClose(close: Readonly<{ code: number }>): readonly DiscordGatewayEffect[];
  markAdmissionLost(): readonly DiscordGatewayEffect[];
  snapshot(): DiscordGatewaySnapshot;
}>;

type JsonRecord = Readonly<Record<string, unknown>>;

const DISCORD_RECONNECT_MIN_DELAY_MS = 1_000;
const DISCORD_RECONNECT_MAX_DELAY_MS = 30_000;
const DISCORD_INVALID_SESSION_RECONNECT_MIN_DELAY_MS = 1_000;
const DISCORD_INVALID_SESSION_RECONNECT_MAX_DELAY_MS = 5_000;

/**
 * The window that applies when the socket ends without the session emitting a
 * `reconnect` effect — a transport error or an unparseable frame. Discord
 * states no shorter bound for those, so they use the generic reconnect window.
 */
export const DISCORD_DEFAULT_RECONNECT_DELAY_BOUNDS: DiscordGatewayReconnectDelayBounds = Object.freeze({
  minDelayMs: DISCORD_RECONNECT_MIN_DELAY_MS,
  maxDelayMs: DISCORD_RECONNECT_MAX_DELAY_MS,
});

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Gateway Bot and READY both carry provider-owned socket targets. Keep their
 * admission and canonical protocol parameters in one Discord-local owner
 * before asking the host to open either target.
 */
export function normalizeDiscordGatewayUrl(value: unknown): string | null {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : null;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'wss:'
      || parsed.hostname !== 'gateway.discord.gg'
      || parsed.port !== ''
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
    ) {
      return null;
    }
    // This provider parses uncompressed JSON only. The host-constrained
    // Gateway URL supplies the authority/path; this provider owns every
    // wire-format query parameter and must not retain an upstream compression
    // or unrecognized mode.
    parsed.search = '';
    parsed.searchParams.set('v', '10');
    parsed.searchParams.set('encoding', 'json');
    return parsed.toString();
  } catch {
    return null;
  }
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function copyResumeState(value: DiscordGatewayResumeState | undefined): DiscordGatewayResumeState | null {
  if (!value) return null;
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId.trim() : null;
  const resumeGatewayUrl = normalizeDiscordGatewayUrl(value.resumeGatewayUrl);
  if (!sessionId || !resumeGatewayUrl || !Number.isSafeInteger(value.lastDispatchSequence) || value.lastDispatchSequence < 0) {
    throw new Error('Discord Gateway resume state is invalid.');
  }
  return {
    sessionId,
    resumeGatewayUrl,
    lastDispatchSequence: value.lastDispatchSequence,
  };
}

function copySessionStartLimit(value: DiscordGatewaySessionStartLimit): DiscordGatewaySessionStartLimit {
  if (
    !Number.isSafeInteger(value.total)
    || value.total <= 0
    || !Number.isSafeInteger(value.remaining)
    || value.remaining < 0
    || value.remaining > value.total
    || !Number.isSafeInteger(value.resetAfterMs)
    || value.resetAfterMs <= 0
    || !Number.isSafeInteger(value.maxConcurrency)
    || value.maxConcurrency <= 0
    || !Number.isSafeInteger(value.observedAtMs)
    || !Number.isSafeInteger(value.observedAtMs + value.resetAfterMs)
  ) {
    throw new Error('Discord Gateway session_start_limit is invalid.');
  }
  return { ...value };
}

function copySnapshot(input: Readonly<{
  lastDispatchSequence: number | null;
  resume: DiscordGatewayResumeState | null;
  awaitingHeartbeatAck: boolean;
  sessionStartLimit: DiscordGatewaySessionStartLimit;
}>): DiscordGatewaySnapshot {
  return {
    lastDispatchSequence: input.lastDispatchSequence,
    resume: input.resume ? { ...input.resume } : null,
    awaitingHeartbeatAck: input.awaitingHeartbeatAck,
    sessionStartLimit: { ...input.sessionStartLimit },
  };
}

function helloHeartbeatInterval(frame: unknown): number | null {
  if (!isRecord(frame) || frame.op !== 10 || !isRecord(frame.d)) return null;
  const interval = readNonNegativeInteger(frame.d.heartbeat_interval);
  return interval !== null && interval > 0 ? interval : null;
}

function readGatewayOpcode(frame: unknown): number | null {
  return isRecord(frame) && typeof frame.op === 'number' && Number.isSafeInteger(frame.op) ? frame.op : null;
}

function clampInitialHeartbeatDelay(requestedDelayMs: number, intervalMs: number): number {
  if (!Number.isFinite(requestedDelayMs)) return 0;
  return Math.min(intervalMs - 1, Math.max(0, Math.floor(requestedDelayMs)));
}

export function createDiscordGatewaySession(input: Readonly<{
  token: string;
  intents: number;
  sessionStartLimit: DiscordGatewaySessionStartLimit;
  resume?: DiscordGatewayResumeState;
  initialHeartbeatDelayMs?: number;
}>): DiscordGatewaySession {
  const token = input.token.trim();
  if (!token) throw new Error('Discord bot token is required.');
  if (!Number.isSafeInteger(input.intents) || input.intents < 0) {
    throw new Error('Discord Gateway intents must be a non-negative integer.');
  }

  let resume = copyResumeState(input.resume);
  let lastDispatchSequence = resume?.lastDispatchSequence ?? null;
  let awaitingHeartbeatAck = false;
  let heartbeatIntervalMs: number | null = null;
  // This is the authoritative Gateway Bot snapshot. The socket worker does
  // not recreate a 24-hour budget after its local clock reaches reset_after;
  // it must fetch a fresh snapshot before another IDENTIFY.
  let sessionStartLimit = copySessionStartLimit(input.sessionStartLimit);

  function sendHeartbeat(): DiscordGatewayEffect {
    awaitingHeartbeatAck = true;
    return { kind: 'send', payload: { op: 1, d: lastDispatchSequence } };
  }

  function startGatewaySession(nowMs: number): readonly DiscordGatewayEffect[] {
    if (resume) {
      return [{
        kind: 'send',
        payload: {
          op: 6,
          d: {
            token,
            session_id: resume.sessionId,
            seq: resume.lastDispatchSequence,
          },
        },
      }];
    }

    const resetAtMs = sessionStartLimit.observedAtMs + sessionStartLimit.resetAfterMs;
    if (nowMs >= resetAtMs) {
      return [{ kind: 'blocked', reason: 'sessionStartLimitRefreshRequired', retryAtMs: resetAtMs }];
    }
    if (sessionStartLimit.remaining === 0) {
      return [{ kind: 'blocked', reason: 'identifyLimit', retryAtMs: resetAtMs }];
    }
    sessionStartLimit = { ...sessionStartLimit, remaining: sessionStartLimit.remaining - 1 };
    return [{
      kind: 'send',
      payload: {
        op: 2,
        d: {
          token,
          intents: input.intents,
          properties: { os: 'happier', browser: 'happier', device: 'happier' },
        },
      },
    }];
  }

  function recordDispatch(frame: JsonRecord): boolean {
    const sequence = readNonNegativeInteger(frame.s);
    if (sequence === null) return false;
    lastDispatchSequence = sequence;

    if (resume) {
      resume = { ...resume, lastDispatchSequence: sequence };
    }

    if (frame.t !== 'READY' || !isRecord(frame.d)) return false;
    const sessionId = typeof frame.d.session_id === 'string' && frame.d.session_id.trim()
      ? frame.d.session_id.trim()
      : null;
    const resumeGatewayUrl = normalizeDiscordGatewayUrl(frame.d.resume_gateway_url);
    if (!sessionId || !resumeGatewayUrl) {
      discardResumeState();
      return true;
    }
    resume = { sessionId, resumeGatewayUrl, lastDispatchSequence: sequence };
    return false;
  }

  function discardResumeState(): void {
    resume = null;
    lastDispatchSequence = null;
  }

  return {
    onFrame(frame, nowMs) {
      if (!Number.isSafeInteger(nowMs)) throw new Error('Discord Gateway frame time must be a safe integer.');
      const opcode = readGatewayOpcode(frame);
      if (opcode === null) throw new Error('Discord Gateway frame is invalid.');

      if (opcode === 0 && isRecord(frame)) {
        const invalidReadyResume = recordDispatch(frame);
        if (invalidReadyResume) {
          return [{ kind: 'historyGap', reason: 'providerHistoryUnavailable' }];
        }
        const sequence = readNonNegativeInteger(frame.s);
        const event = typeof frame.t === 'string' && frame.t.trim() ? frame.t : null;
        return sequence === null || event === null
          ? []
          : [{ kind: 'dispatch', sequence, event, payload: frame.d }];
      }
      if (opcode === 10) {
        const heartbeatInterval = helloHeartbeatInterval(frame);
        if (heartbeatInterval === null) throw new Error('Discord Gateway Hello is invalid.');
        heartbeatIntervalMs = heartbeatInterval;
        const requestedDelay = input.initialHeartbeatDelayMs ?? Math.floor(Math.random() * heartbeatInterval);
        return [
          { kind: 'scheduleHeartbeat', afterMs: clampInitialHeartbeatDelay(requestedDelay, heartbeatInterval) },
          ...startGatewaySession(nowMs),
        ];
      }
      if (opcode === 1) return [sendHeartbeat()];
      if (opcode === 11) {
        awaitingHeartbeatAck = false;
        return [];
      }
      if (opcode === 7) {
        awaitingHeartbeatAck = false;
        return [
          { kind: 'disconnect', reason: 'serverRequestedReconnect' },
          {
            kind: 'reconnect',
            canResume: resume !== null,
            minDelayMs: DISCORD_RECONNECT_MIN_DELAY_MS,
            maxDelayMs: DISCORD_RECONNECT_MAX_DELAY_MS,
          },
        ];
      }
      if (opcode === 9 && isRecord(frame)) {
        const canResume = frame.d === true && resume !== null;
        if (!canResume) discardResumeState();
        awaitingHeartbeatAck = false;
        return [
          ...(canResume ? [] : [{ kind: 'historyGap', reason: 'providerHistoryUnavailable' } satisfies DiscordGatewayEffect]),
          { kind: 'disconnect', reason: 'invalidSession' },
          {
            kind: 'reconnect',
            canResume,
            minDelayMs: DISCORD_INVALID_SESSION_RECONNECT_MIN_DELAY_MS,
            maxDelayMs: DISCORD_INVALID_SESSION_RECONNECT_MAX_DELAY_MS,
          },
        ];
      }
      return [];
    },

    onHeartbeatTimer() {
      if (heartbeatIntervalMs === null) {
        throw new Error('Discord Gateway heartbeat timer fired before Hello.');
      }
      if (awaitingHeartbeatAck) {
        awaitingHeartbeatAck = false;
        return [
          { kind: 'disconnect', reason: 'heartbeatAckMissing' },
          {
            kind: 'reconnect',
            canResume: resume !== null,
            minDelayMs: DISCORD_RECONNECT_MIN_DELAY_MS,
            maxDelayMs: DISCORD_RECONNECT_MAX_DELAY_MS,
          },
        ];
      }
      return [
        sendHeartbeat(),
        { kind: 'scheduleHeartbeat', afterMs: heartbeatIntervalMs },
      ];
    },

    onClose(close) {
      if (!Number.isSafeInteger(close.code)) throw new Error('Discord Gateway close code is invalid.');
      awaitingHeartbeatAck = false;
      switch (close.code) {
        case 4_004:
          discardResumeState();
          return [{ kind: 'terminal', reason: 'authenticationFailed' }];
        case 4_010:
          discardResumeState();
          return [{ kind: 'terminal', reason: 'invalidShard' }];
        case 4_011:
          discardResumeState();
          return [{ kind: 'terminal', reason: 'shardingRequired' }];
        case 4_012:
          discardResumeState();
          return [{ kind: 'terminal', reason: 'invalidApiVersion' }];
        case 4_013:
          discardResumeState();
          return [{ kind: 'terminal', reason: 'invalidIntents' }];
        case 4_014:
          discardResumeState();
          return [{ kind: 'terminal', reason: 'disallowedIntents' }];
        case 4_007:
        case 4_009:
          discardResumeState();
          return [
            { kind: 'historyGap', reason: 'providerHistoryUnavailable' },
            {
              kind: 'reconnect',
              canResume: false,
              minDelayMs: DISCORD_RECONNECT_MIN_DELAY_MS,
              maxDelayMs: DISCORD_RECONNECT_MAX_DELAY_MS,
            },
          ];
        default:
          return [{
            kind: 'reconnect',
            canResume: resume !== null,
            minDelayMs: DISCORD_RECONNECT_MIN_DELAY_MS,
            maxDelayMs: DISCORD_RECONNECT_MAX_DELAY_MS,
          }];
      }
    },

    markAdmissionLost() {
      resume = null;
      awaitingHeartbeatAck = false;
      return [
        { kind: 'historyGap', reason: 'applicationAdmissionLost' },
        { kind: 'disconnect', reason: 'applicationAdmissionLost' },
      ];
    },

    snapshot() {
      return copySnapshot({ lastDispatchSequence, resume, awaitingHeartbeatAck, sessionStartLimit });
    },
  };
}

/**
 * Discord does not use one reconnect window for every disconnect: an Invalid
 * Session must be re-identified inside a much shorter window than a generic
 * reconnect. Every `reconnect` effect therefore carries the bounds that apply
 * to the disconnect that produced it, and the backoff below is computed from
 * those bounds rather than from a module constant the caller cannot see.
 */
export function calculateDiscordReconnectDelayMs(
  attempt: number,
  bounds: DiscordGatewayReconnectDelayBounds,
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error('Discord Gateway reconnect attempt must be a non-negative integer.');
  }
  if (
    !Number.isSafeInteger(bounds.minDelayMs)
    || bounds.minDelayMs <= 0
    || !Number.isSafeInteger(bounds.maxDelayMs)
    || bounds.maxDelayMs < bounds.minDelayMs
  ) {
    throw new Error('Discord Gateway reconnect delay bounds are invalid.');
  }
  return Math.min(bounds.maxDelayMs, bounds.minDelayMs * (2 ** attempt));
}

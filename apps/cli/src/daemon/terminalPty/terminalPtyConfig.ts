import { parseBooleanEnv } from '@happier-dev/protocol';
import type { TerminalPtySessionManagerConfig } from './terminalPtySessionManager';

export type DaemonTerminalPtyConfig = Readonly<{
  enabled: boolean;
  sessionManager: TerminalPtySessionManagerConfig;
  readDefaults: Readonly<{
    maxBytes: number;
    maxEvents: number;
  }>;
}>;

function parseIntEnv(raw: unknown, fallback: number, bounds: Readonly<{ min: number; max: number }>): number {
  const value = String(raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const coerced = Math.trunc(parsed);
  return Math.min(bounds.max, Math.max(bounds.min, coerced));
}

export function readDaemonTerminalPtyConfig(env: NodeJS.ProcessEnv): DaemonTerminalPtyConfig {
  const enabled = parseBooleanEnv(env.HAPPIER_DAEMON_TERMINAL_ENABLED, true);

  const maxSessions = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_MAX_SESSIONS, 20, { min: 1, max: 100 });
  const idleTimeoutMs = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_IDLE_TIMEOUT_MS, 30 * 60_000, {
    min: 10_000,
    max: 24 * 60 * 60_000,
  });
  const bufferMaxBytes = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_BUFFER_MAX_BYTES, 1_000_000, {
    min: 64_000,
    max: 50_000_000,
  });
  const bufferMaxEvents = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_BUFFER_MAX_EVENTS, 5000, { min: 256, max: 100_000 });
  const urlParseBufferLimit = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_URL_PARSE_BUFFER_LIMIT, 32_768, {
    min: 1024,
    max: 1_000_000,
  });
  const maxWriteChunkBytes = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_MAX_WRITE_CHUNK_BYTES, 16_384, {
    min: 256,
    max: 1_000_000,
  });

  const defaultCols = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_DEFAULT_COLS, 80, { min: 2, max: 500 });
  const defaultRows = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_DEFAULT_ROWS, 24, { min: 2, max: 500 });

  const readDefaultMaxBytes = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_READ_DEFAULT_MAX_BYTES, 64 * 1024, {
    min: 1024,
    max: 5 * 1024 * 1024,
  });
  const readDefaultMaxEvents = parseIntEnv(env.HAPPIER_DAEMON_TERMINAL_READ_DEFAULT_MAX_EVENTS, 512, { min: 1, max: 4096 });

  return {
    enabled,
    sessionManager: {
      maxSessions,
      idleTimeoutMs,
      bufferMaxBytes,
      bufferMaxEvents,
      urlParseBufferLimit,
      maxWriteChunkBytes,
      defaultCols,
      defaultRows,
    },
    readDefaults: { maxBytes: readDefaultMaxBytes, maxEvents: readDefaultMaxEvents },
  };
}

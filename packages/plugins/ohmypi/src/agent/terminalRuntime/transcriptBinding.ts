import { constants, readlinkSync, realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  TerminalRuntimeTranscriptBindingRequestV1,
  TerminalRuntimeTranscriptBindingV1,
} from '@happier-dev/plugin-sdk';

import { resolveOhMyPiTerminalRuntimeBreadcrumb } from './breadcrumb.js';

type LegacyOhMyPiTerminalBindingRequest = Readonly<{
  cwd?: unknown;
  env?: NodeJS.ProcessEnv;
  terminalId?: string | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
}>;

type OhMyPiTerminalTranscriptBinding = TerminalRuntimeTranscriptBindingV1 & Readonly<{
  providerId: 'ohMyPi';
  remoteSessionId: string;
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveNodeTtyPath(): string | null {
  for (const candidate of ['/proc/self/fd/0', '/dev/fd/0', '/dev/stdin']) {
    try {
      const linked = readlinkSync(candidate);
      if (linked.startsWith('/dev/')) {
        return linked;
      }
    } catch {
      // Try the next terminal path candidate.
    }

    try {
      const resolved = realpathSync(candidate);
      if (resolved.startsWith('/dev/') && resolved !== '/dev/fd/0') {
        return resolved;
      }
    } catch {
      // Try the next terminal path candidate.
    }
  }
  return null;
}

function resolveTerminalId(params: Readonly<{
  env: NodeJS.ProcessEnv;
  terminalId?: string | null;
}>): string | null {
  const explicit = params.terminalId?.trim();
  if (explicit) return explicit;

  if (process.stdin.isTTY === true) {
    const ttyPath = resolveNodeTtyPath();
    if (ttyPath?.startsWith('/dev/')) {
      return ttyPath.slice(5).replace(/\//g, '-');
    }
  }

  const kittyId = params.env.KITTY_WINDOW_ID?.trim();
  if (kittyId) return `kitty-${kittyId}`;

  const tmuxPane = params.env.TMUX_PANE?.trim();
  if (tmuxPane) return `tmux-${tmuxPane}`;

  const terminalSessionId = params.env.TERM_SESSION_ID?.trim();
  if (terminalSessionId) return `apple-${terminalSessionId}`;

  const wtSession = params.env.WT_SESSION?.trim();
  if (wtSession) return `wt-${wtSession}`;

  return null;
}

function resolveRequestEnv(
  request: TerminalRuntimeTranscriptBindingRequestV1 | LegacyOhMyPiTerminalBindingRequest,
): NodeJS.ProcessEnv {
  return (request as LegacyOhMyPiTerminalBindingRequest).env ?? process.env;
}

function resolveRequestCwd(
  request: TerminalRuntimeTranscriptBindingRequestV1 | LegacyOhMyPiTerminalBindingRequest,
): string | null {
  const legacyCwd = readString((request as LegacyOhMyPiTerminalBindingRequest).cwd);
  if (legacyCwd) return legacyCwd;

  const metadata = readRecord((request as TerminalRuntimeTranscriptBindingRequestV1).metadata);
  const terminalRuntimeMetadata = readRecord(metadata?.terminalRuntime);
  return readString(metadata?.cwd)
    ?? readString(metadata?.directory)
    ?? readString(metadata?.workingDirectory)
    ?? readString(terminalRuntimeMetadata?.cwd)
    ?? readString(terminalRuntimeMetadata?.directory)
    ?? null;
}

function resolveRequestTerminalId(
  request: TerminalRuntimeTranscriptBindingRequestV1 | LegacyOhMyPiTerminalBindingRequest,
  env: NodeJS.ProcessEnv,
): string | null {
  const legacyTerminalId = readString((request as LegacyOhMyPiTerminalBindingRequest).terminalId);
  if (legacyTerminalId) return legacyTerminalId;

  const metadata = readRecord((request as TerminalRuntimeTranscriptBindingRequestV1).metadata);
  const terminalRuntimeMetadata = readRecord(metadata?.terminalRuntime);
  return readString(metadata?.terminalId)
    ?? readString(terminalRuntimeMetadata?.terminalId)
    ?? resolveTerminalId({ env });
}

function resolveTimeoutMs(
  request: TerminalRuntimeTranscriptBindingRequestV1 | LegacyOhMyPiTerminalBindingRequest,
  env: NodeJS.ProcessEnv,
): number {
  const explicit = readNumber((request as LegacyOhMyPiTerminalBindingRequest).timeoutMs);
  const raw = Number.parseInt(
    String(explicit ?? env.HAPPIER_OH_MY_PI_TERMINAL_RUNTIME_BIND_TIMEOUT_MS ?? ''),
    10,
  );
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5_000;
  return Math.max(50, Math.min(60_000, configured));
}

function resolvePollIntervalMs(
  request: TerminalRuntimeTranscriptBindingRequestV1 | LegacyOhMyPiTerminalBindingRequest,
  env: NodeJS.ProcessEnv,
): number {
  const explicit = readNumber((request as LegacyOhMyPiTerminalBindingRequest).pollIntervalMs);
  const raw = Number.parseInt(
    String(explicit ?? env.HAPPIER_OH_MY_PI_TERMINAL_RUNTIME_BIND_POLL_INTERVAL_MS ?? ''),
    10,
  );
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 100;
  return Math.max(10, Math.min(5_000, configured));
}

async function waitForFile(filePath: string, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      // Keep polling until the deadline expires.
    }

    if (Date.now() >= deadline) break;
    await delay(pollIntervalMs);
  }

  return false;
}

export async function resolveOhMyPiTerminalRuntimeTranscriptBinding(
  request: TerminalRuntimeTranscriptBindingRequestV1 | LegacyOhMyPiTerminalBindingRequest,
): Promise<OhMyPiTerminalTranscriptBinding | null> {
  const env = resolveRequestEnv(request);
  const cwd = resolveRequestCwd(request);
  if (!cwd) return null;

  const breadcrumb = resolveOhMyPiTerminalRuntimeBreadcrumb({
    cwd,
    env,
    terminalId: resolveRequestTerminalId(request, env),
  });
  if (!breadcrumb) return null;

  const didMaterialize = await waitForFile(
    breadcrumb.sessionFilePath,
    resolveTimeoutMs(request, env),
    resolvePollIntervalMs(request, env),
  );
  if (!didMaterialize) return null;

  return {
    providerId: 'ohMyPi',
    source: {
      kind: 'ohMyPiAgentDir',
      agentDir: breadcrumb.agentDir,
    },
    providerSessionId: breadcrumb.remoteSessionId,
    remoteSessionId: breadcrumb.remoteSessionId,
  };
}

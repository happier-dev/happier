import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunGetRequestSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { callSessionRpc } from '@/sessionControl/sessionRpc';
import { readIntFlagValue } from '@/sessionControl/argvFlags';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalStatus(status: unknown): status is 'succeeded' | 'failed' | 'cancelled' | 'timeout' {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'timeout';
}

export async function cmdSessionRunWait(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  if (!idOrPrefix || !runId) {
    throw new Error('Usage: happier session run wait <session-id-or-prefix> <run-id> [--timeout <seconds>] [--json]');
  }

  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout');
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? Math.min(3600, timeoutSecondsRaw)
      : 300;

  const pollIntervalRaw = (process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS ?? '').trim();
  const pollIntervalParsed = pollIntervalRaw ? Number.parseInt(pollIntervalRaw, 10) : NaN;
  const pollIntervalMs = Number.isFinite(pollIntervalParsed) && pollIntervalParsed > 0 ? Math.min(60_000, pollIntervalParsed) : 1_000;

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_wait', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_wait',
        error: { code: resolved.code, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      });
      return;
    }
    throw new Error(resolved.code);
  }
  const sessionId = resolved.sessionId;

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_wait', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const request = ExecutionRunGetRequestSchema.parse({ runId });
  const method = `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`;

  const deadlineMs = Date.now() + timeoutSeconds * 1000;
  while (Date.now() <= deadlineMs) {
    const res = await callSessionRpc({ token: credentials.token, sessionId, ctx, method, request });
    const status = (res as any)?.run?.status;
    if (isTerminalStatus(status)) {
      if (json) {
        printJsonEnvelope({ ok: true, kind: 'session_run_wait', data: { sessionId, runId, status } });
        return;
      }
      console.log(chalk.green('✓'), `run finished: ${status}`);
      return;
    }
    await sleep(pollIntervalMs);
  }

  if (json) {
    printJsonEnvelope({ ok: false, kind: 'session_run_wait', error: { code: 'timeout' } });
    return;
  }
  throw new Error('timeout');
}

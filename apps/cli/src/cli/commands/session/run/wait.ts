import chalk from 'chalk';

import type { Credentials } from '@/persistence';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { waitForExecutionRun } from '@/session/services/executionRuns';

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

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_wait',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const result = await waitForExecutionRun({
    token: credentials.token,
    sessionId,
    mode,
    ctx,
    runId,
    timeoutMs: timeoutSeconds * 1000,
    pollIntervalMs,
  });

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_wait',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_wait', data: { sessionId, runId, status: result.status } });
    return;
  }
  console.log(chalk.green('✓'), `run finished: ${result.status}`);
}

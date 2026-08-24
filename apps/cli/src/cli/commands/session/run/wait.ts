import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunWait(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', runId = ''] = readCommandPositionals(argv, { startIndex: 2, valueFlags: ['--timeout'] });
  if (!idOrPrefix || !runId) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runWait}`);
  }

  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout', { min: 1 });
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? timeoutSecondsRaw
      : null;

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_wait', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_wait', error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) } });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const sessionId = sessionTarget.sessionId;
  const actionRes = await executor.execute(
    'execution.run.wait',
    { sessionId, runId, ...(timeoutSeconds !== null ? { timeoutSeconds } : {}) },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_wait',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  const result = normalized.data as any;
  const status = result && typeof result === 'object' ? String(result.status ?? '') : '';
  if (!status) {
    throw new Error('execution_run_wait_failed');
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_wait', data: { sessionId, runId, status } });
    return;
  }
  console.log(chalk.green('✓'), `run finished: ${status}`);
}

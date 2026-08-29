import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunStopRequestSchema, ExecutionRunStopResponseSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunStop(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', runId = ''] = readCommandPositionals(argv, { startIndex: 2 });

  if (!idOrPrefix || !runId) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStop}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_stop', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const request = ExecutionRunStopRequestSchema.parse({ runId });
  const executor = createCliActionExecutorFromCredentials({ credentials });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_stop', error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) } });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const sessionId = sessionTarget.sessionId;

  const actionRes = await executor.execute(
    'execution.run.stop',
    { sessionId, ...request },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_stop',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }
  ExecutionRunStopResponseSchema.parse(normalized.data);

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_stop', data: { sessionId, runId, stopped: true } });
    return;
  }

  console.log(chalk.green('✓'), 'stopped run');
}

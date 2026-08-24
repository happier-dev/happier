import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunTurnStreamCancelRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunStreamCancel(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', runId = '', streamId = ''] = readCommandPositionals(argv, { startIndex: 2 });

  if (!idOrPrefix || !runId || !streamId) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStreamCancel}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_stream_cancel', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_stream_cancel',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;
  const request = ExecutionRunTurnStreamCancelRequestSchema.parse({ runId, streamId });
  const actionResult = await executor.execute(
    'execution.run.stream.cancel',
    { sessionId, ...request },
    {
      surface: credentials.credentialProvenance === 'api_token' ? 'cli' : 'rpc',
      defaultSessionId: sessionId,
    },
  );
  const result = normalizeActionExecuteResult(actionResult);

  if (!result.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_stream_cancel',
        error: { code: result.errorCode, ...(result.errorMessage ? { message: result.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(result.errorMessage ?? result.errorCode);
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_stream_cancel', data: { sessionId, runId, streamId, cancelled: true } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream cancelled');
}

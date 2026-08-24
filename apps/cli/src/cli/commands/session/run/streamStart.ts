import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunTurnStreamStartRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunStreamStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', runId = '', message = ''] = readCommandPositionals(argv, { startIndex: 2 });
  const resume = hasFlag(argv, '--resume');

  if (!idOrPrefix || !runId || !message) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStreamStart}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_stream_start', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_stream_start',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;
  const request = ExecutionRunTurnStreamStartRequestSchema.parse({ runId, message, ...(resume ? { resume: true } : {}) });
  const actionResult = await executor.execute(
    'execution.run.stream.start',
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
        kind: 'session_run_stream_start',
        error: { code: result.errorCode, ...(result.errorMessage ? { message: result.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(result.errorMessage ?? result.errorCode);
  }

  const payload = unwrapCliActionSuccessPayload(result.data);
  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_stream_start', data: { sessionId, runId, ...(payload as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream started');
  await writeJsonStdout(payload, { pretty: true });
}

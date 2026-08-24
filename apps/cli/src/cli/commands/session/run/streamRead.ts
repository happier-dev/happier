import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunTurnStreamReadRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunStreamRead(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', runId = '', streamId = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--cursor', '--max-events', '--maxEvents'],
  });
  const cursor = readIntFlagValue(argv, '--cursor', { min: 0 });
  const maxEvents = readIntFlagValue(argv, '--max-events', { min: 1, max: 256 })
    ?? readIntFlagValue(argv, '--maxEvents', { min: 1, max: 256 });

  if (!idOrPrefix || !runId || !streamId || cursor === null) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStreamRead}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_stream_read', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_stream_read',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;
  const request = ExecutionRunTurnStreamReadRequestSchema.parse({
    runId,
    streamId,
    cursor,
    ...(typeof maxEvents === 'number' && Number.isFinite(maxEvents) && maxEvents > 0 ? { maxEvents } : {}),
  });
  const actionResult = await executor.execute(
    'execution.run.stream.read',
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
        kind: 'session_run_stream_read',
        error: { code: result.errorCode, ...(result.errorMessage ? { message: result.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(result.errorMessage ?? result.errorCode);
  }

  const payload = unwrapCliActionSuccessPayload(result.data);
  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_stream_read', data: { sessionId, runId, ...(payload as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream read');
  await writeJsonStdout(payload, { pretty: true });
}

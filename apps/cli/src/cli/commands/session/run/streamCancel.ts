import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunTurnStreamCancelRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { cancelExecutionRunStream } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

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

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
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
  const result = sessionTarget.mode === 'plain'
    ? await cancelExecutionRunStream({
        token: credentials.token,
        sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        request,
      })
    : await cancelExecutionRunStream({
        token: credentials.token,
        sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        request,
      });

  if (!result.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_stream_cancel',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_stream_cancel', data: { sessionId, runId, streamId, cancelled: true } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream cancelled');
}

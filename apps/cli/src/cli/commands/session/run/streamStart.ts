import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunTurnStreamStartRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { startExecutionRunStream } from '@/session/services/executionRuns';

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

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
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
  const result = sessionTarget.mode === 'plain'
    ? await startExecutionRunStream({
        token: credentials.token,
        sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        request,
      })
    : await startExecutionRunStream({
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
        kind: 'session_run_stream_start',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_stream_start', data: { sessionId, runId, ...(result.data as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream started');
  await writeJsonStdout(result.data, { pretty: true });
}

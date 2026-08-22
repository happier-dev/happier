import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunTurnStreamReadRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { readExecutionRunStream } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

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

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
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
  const result = sessionTarget.mode === 'plain'
    ? await readExecutionRunStream({
        token: credentials.token,
        sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
        request,
      })
    : await readExecutionRunStream({
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
        kind: 'session_run_stream_read',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_stream_read', data: { sessionId, runId, ...(result.data as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream read');
  await writeJsonStdout(result.data, { pretty: true });
}

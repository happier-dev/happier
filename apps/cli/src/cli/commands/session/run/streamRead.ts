import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunTurnStreamReadRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { readExecutionRunStream } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

export async function cmdSessionRunStreamRead(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  const streamId = String(argv[4] ?? '').trim();
  const cursor = readIntFlagValue(argv, '--cursor');
  const maxEvents = readIntFlagValue(argv, '--max-events') ?? readIntFlagValue(argv, '--maxEvents');

  if (!idOrPrefix || !runId || !streamId || cursor === null) {
    throw new Error(
      'Usage: happier session run stream-read <session-id-or-prefix> <run-id> <stream-id> --cursor <n> [--max-events <n>] [--json]',
    );
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_stream_read', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_stream_read',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const request = ExecutionRunTurnStreamReadRequestSchema.parse({
    runId,
    streamId,
    cursor,
    ...(typeof maxEvents === 'number' && Number.isFinite(maxEvents) && maxEvents > 0 ? { maxEvents } : {}),
  });
  const result = await readExecutionRunStream({ token: credentials.token, sessionId, mode, ctx, request });

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_stream_read',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_stream_read', data: { sessionId, runId, ...(result.data as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream read');
  console.log(JSON.stringify(result.data, null, 2));
}

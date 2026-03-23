import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunTurnStreamCancelRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { cancelExecutionRunStream } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

export async function cmdSessionRunStreamCancel(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  const streamId = String(argv[4] ?? '').trim();

  if (!idOrPrefix || !runId || !streamId) {
    throw new Error('Usage: happier session run stream-cancel <session-id-or-prefix> <run-id> <stream-id> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_stream_cancel', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_stream_cancel',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const request = ExecutionRunTurnStreamCancelRequestSchema.parse({ runId, streamId });
  const result = await cancelExecutionRunStream({ token: credentials.token, sessionId, mode, ctx, request });

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_stream_cancel',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_stream_cancel', data: { sessionId, runId, streamId, cancelled: true } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream cancelled');
}

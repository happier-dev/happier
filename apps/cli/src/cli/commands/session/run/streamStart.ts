import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunTurnStreamStartRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { startExecutionRunStream } from '@/session/services/executionRuns';

export async function cmdSessionRunStreamStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  const message = String(argv[4] ?? '').trim();
  const resume = hasFlag(argv, '--resume');

  if (!idOrPrefix || !runId || !message) {
    throw new Error('Usage: happier session run stream-start <session-id-or-prefix> <run-id> <message> [--resume] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_stream_start', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_stream_start',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const request = ExecutionRunTurnStreamStartRequestSchema.parse({ runId, message, ...(resume ? { resume: true } : {}) });
  const result = await startExecutionRunStream({ token: credentials.token, sessionId, mode, ctx, request });

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_stream_start',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_stream_start', data: { sessionId, runId, ...(result.data as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream started');
  console.log(JSON.stringify(result.data, null, 2));
}

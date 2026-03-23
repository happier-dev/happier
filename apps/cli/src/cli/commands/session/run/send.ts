import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunSendRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { sendExecutionRunMessage } from '@/session/services/executionRuns';

export async function cmdSessionRunSend(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  const message = String(argv[4] ?? '').trim();
  const resume = hasFlag(argv, '--resume');

  if (!idOrPrefix || !runId || !message) {
    throw new Error('Usage: happier session run send <session-id-or-prefix> <run-id> <message> [--resume] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_send', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_send',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const request = ExecutionRunSendRequestSchema.parse({
    runId,
    message,
    delivery: 'steer_if_supported',
    ...(resume ? { resume: true } : {}),
  });
  const result = await sendExecutionRunMessage({ token: credentials.token, sessionId, mode, ctx, request });

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_send',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_send', data: { sessionId, runId, sent: true } });
    return;
  }

  console.log(chalk.green('✓'), 'sent to run');
}

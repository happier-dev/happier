import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunSendRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

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

  const request = ExecutionRunSendRequestSchema.parse({
    runId,
    message,
    delivery: 'steer_if_supported',
    ...(resume ? { resume: true } : {}),
  });

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'execution.run.send',
    { sessionId: idOrPrefix, ...request },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_send',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_send', data: { sessionId: idOrPrefix, runId, sent: true } });
    return;
  }

  console.log(chalk.green('✓'), 'sent to run');
}

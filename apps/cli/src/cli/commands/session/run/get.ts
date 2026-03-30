import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunGetRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunGet(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const includeStructured = hasFlag(argv, '--include-structured') || hasFlag(argv, '--includeStructured');
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();

  if (!idOrPrefix || !runId) {
    throw new Error('Usage: happier session run get <session-id-or-prefix> <run-id> [--include-structured] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_get', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const request = ExecutionRunGetRequestSchema.parse({
    runId,
    ...(includeStructured ? { includeStructured: true } : {}),
  });

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'execution.run.get',
    { sessionId: idOrPrefix, ...request },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_get',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  const result = normalized.data as any;
  const runPayload = result && typeof result === 'object' && result.ok === true ? result.data : null;

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_get', data: { sessionId: idOrPrefix, ...(runPayload as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'execution run fetched');
  console.log(JSON.stringify(runPayload, null, 2));
}

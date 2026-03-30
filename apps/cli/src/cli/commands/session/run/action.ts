import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunActionRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunAction(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  const actionId = String(argv[4] ?? '').trim();
  const rawInput = readFlagValue(argv, '--input-json');
  let input: unknown = undefined;

  if (!idOrPrefix || !runId || !actionId) {
    throw new Error('Usage: happier session run action <session-id-or-prefix> <run-id> <action-id> [--input-json <json>] [--json]');
  }
  if (rawInput !== null) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      if (json) {
        printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'execution_run_invalid_action_input' } });
        return;
      }
      throw new Error('Invalid --input-json');
    }
  }
  if (rawInput === null && argv.includes('--input-json')) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'execution_run_invalid_action_input' } });
      return;
    }
    throw new Error('Invalid --input-json');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const request = ExecutionRunActionRequestSchema.parse({ runId, actionId, input });

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'execution.run.action',
    { sessionId: idOrPrefix, ...request },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_action',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  const result = normalized.data as any;
  const runPayload = result && typeof result === 'object' && result.ok === true ? result.data : null;

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_run_action',
      data: { sessionId: idOrPrefix, runId, actionId, ...(runPayload as any) },
    });
    return;
  }

  console.log(chalk.green('✓'), 'run action executed');
  console.log(JSON.stringify(runPayload, null, 2));
}

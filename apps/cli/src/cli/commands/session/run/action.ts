import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunActionRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

export async function cmdSessionRunAction(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', runId = '', actionId = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--input-json'],
  });
  const rawInput = readFlagValue(argv, '--input-json');
  let input: unknown = undefined;

  if (!idOrPrefix || !runId || !actionId) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runAction}`);
  }
  if (rawInput !== null) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      if (json) {
        await printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'execution_run_invalid_action_input' } });
        return;
      }
      throw new Error('Invalid --input-json');
    }
  }
  if (rawInput === null && argv.includes('--input-json')) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'execution_run_invalid_action_input' } });
      return;
    }
    throw new Error('Invalid --input-json');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const request = ExecutionRunActionRequestSchema.parse({ runId, actionId, input });
  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) } });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const sessionId = sessionTarget.sessionId;

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'execution.run.action',
    { sessionId, ...request },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_action',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  const runPayload = unwrapCliActionSuccessPayload(normalized.data);

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_run_action',
      data: { sessionId, runId, actionId, ...(runPayload as any) },
    });
    return;
  }

  console.log(chalk.green('✓'), 'run action executed');
  await writeJsonStdout(runPayload, { pretty: true });
}

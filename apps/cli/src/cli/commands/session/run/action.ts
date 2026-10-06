import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { ExecutionRunActionRequestSchema } from '@happier-dev/protocol/execution/runs/index';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { assertSessionCommandArguments } from '@/cli/commands/session/shared/assertSessionCommandArguments';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { cmd, fail } from '@happier-dev/cli-common/output';

export async function cmdSessionRunAction(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  // The whole argv — the fixed outer Action's three positionals and its one
  // structured inner-input field — is validated before any credential read, so
  // an unknown flag or surplus argument can never reach execution silently.
  assertSessionCommandArguments(argv, {
    usage: `Usage: ${SESSION_HELP_LINES.runAction}`,
    startIndex: 2,
    booleanFlags: ['--json'],
    valueFlags: ['--input-json'],
    maxPositionals: 3,
  });
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

  // The fixed outer Action's own schema decides the request before any
  // credential is read, so a malformed request never reaches execution.
  const parsedRequest = ExecutionRunActionRequestSchema.safeParse({ runId, actionId, input });
  if (!parsedRequest.success) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'execution_run_invalid_action_input' } });
      return;
    }
    throw new Error(`Usage: ${SESSION_HELP_LINES.runAction}`);
  }
  const request = parsedRequest.data;

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) } });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const sessionId = sessionTarget.sessionId;

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

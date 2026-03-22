import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunActionRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { executeExecutionRunAction } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

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

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_action',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const request = ExecutionRunActionRequestSchema.parse({ runId, actionId, input });
  const result = await executeExecutionRunAction({ token: credentials.token, sessionId, mode, ctx, request });

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_action',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_run_action',
      data: { sessionId, runId, actionId, ...(result.data as any) },
    });
    return;
  }

  console.log(chalk.green('✓'), 'run action executed');
  console.log(JSON.stringify(result.data, null, 2));
}

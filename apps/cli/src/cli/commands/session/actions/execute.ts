import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import type { ActionId } from '@happier-dev/protocol';

function parseInputJsonOrThrow(raw: string | null): unknown {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const err = new Error(error instanceof Error ? error.message : 'Invalid --input-json');
    (err as Error & { code?: string }).code = 'invalid_arguments';
    throw err;
  }
}

export async function cmdSessionActionsExecute(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const actionId = String(argv[3] ?? '').trim();
  if (!idOrPrefix || !actionId) {
    throw new Error('Usage: happier session actions execute <session-id-or-prefix> <action-id> [--input-json <json>] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_actions_execute', error: { code: 'not_authenticated' } });
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
        kind: 'session_actions_execute',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }

  const executor = createCliActionExecutor({
    token: credentials.token,
    credentials,
    sessionId: sessionTarget.sessionId,
    ctx: sessionTarget.ctx,
    mode: sessionTarget.mode,
    rawSession: sessionTarget.rawSession,
  });
  const input = parseInputJsonOrThrow(readFlagValue(argv, '--input-json'));
  const result = await executor.execute(
    actionId as ActionId,
    input,
    { defaultSessionId: sessionTarget.sessionId, surface: 'cli' },
  );

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_actions_execute',
        error: { code: result.errorCode, ...(result.error ? { message: result.error } : {}) },
      });
      return;
    }
    throw new Error(result.error);
  }

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_actions_execute',
      data: {
        sessionId: sessionTarget.sessionId,
        actionId,
        result: result.result,
      },
    });
    return;
  }

  console.log(chalk.green('✓'), 'action executed');
  console.log(JSON.stringify({ sessionId: sessionTarget.sessionId, actionId, result: result.result }, null, 2));
}

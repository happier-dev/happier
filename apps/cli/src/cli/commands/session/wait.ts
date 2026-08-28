import chalk from 'chalk';

import { ok } from '@happier-dev/cli-common/output';
import type { PublicActionResultById } from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readFlagValue, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  type NormalizedCliActionExecuteResult,
} from './shared/normalizeActionExecuteResult';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';
import { assertSessionCommandArguments } from './shared/assertSessionCommandArguments';

const SESSION_WAIT_USAGE = `Usage: ${SESSION_HELP_LINES.wait}`;

export function resolveSessionWaitTimeoutSeconds(argv: readonly string[]): number {
  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout', { min: 1 });
  return typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
    ? Math.min(3600, timeoutSecondsRaw)
    : 300;
}

export async function executeSessionWaitAction(params: Readonly<{
  executor: ReturnType<typeof createCliActionExecutorFromCredentials>;
  sessionId: string;
  timeoutSeconds: number;
}>): Promise<NormalizedCliActionExecuteResult> {
  return normalizeActionExecuteResult(await params.executor.execute(
    'session.wait.idle',
    { sessionId: params.sessionId, timeoutSeconds: params.timeoutSeconds },
    { surface: 'cli', defaultSessionId: null },
  ));
}

export function printSessionWaitSuccess(): void {
  console.log(ok('Session idle'));
}

export async function cmdSessionWait(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  assertSessionCommandArguments(argv, {
    usage: SESSION_WAIT_USAGE,
    startIndex: 1,
    booleanFlags: ['--json'],
    valueFlags: ['--timeout', '--machine-id'],
    maxPositionals: 1,
  });
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, { startIndex: 1, valueFlags: ['--timeout', '--machine-id'] });
  if (!idOrPrefix) {
    throw new Error(SESSION_WAIT_USAGE);
  }

  const timeoutSeconds = resolveSessionWaitTimeoutSeconds(argv);
  const machineId = readFlagValue(argv, '--machine-id');

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_wait', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({
    credentials,
    ...(machineId !== null ? { machineId } : {}),
  });
  const normalized = await executeSessionWaitAction({
    executor,
    sessionId: idOrPrefix,
    timeoutSeconds,
  });
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_wait',
        error: {
          code: normalized.errorCode,
          ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
        },
      });
      return;
    }
    throw new Error(normalized.errorCode);
  }

  const result = normalized.data as PublicActionResultById['session.wait.idle'];
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_wait', json, result })) {
    return;
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_wait', data: { sessionId: result.sessionId, idle: true, observedAt: result.observedAt } });
    return;
  }
  printSessionWaitSuccess();
}

import chalk from 'chalk';

import { ok } from '@happier-dev/cli-common/output';

import type { StoredCredentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';
import { assertSessionCommandArguments } from './shared/assertSessionCommandArguments';

export async function cmdSessionWait(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  assertSessionCommandArguments(argv, {
    usage: 'Usage: happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]',
    startIndex: 1,
    booleanFlags: ['--json'],
    valueFlags: ['--timeout'],
    maxPositionals: 1,
  });
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, { startIndex: 1, valueFlags: ['--timeout'] });
  if (!idOrPrefix) {
    throw new Error('Usage: happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]');
  }

  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout', { min: 1 });
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? Math.min(3600, timeoutSecondsRaw)
      : 300;

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_wait', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.wait.idle',
    { sessionId: idOrPrefix, timeoutSeconds },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
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

  const result = normalized.data as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_wait', json, result })) {
    return;
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_wait', data: { sessionId: result.sessionId, idle: true, observedAt: result.observedAt } });
    return;
  }
  console.log(ok('Session idle'));
}

import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { waitForSessionIdle } from '@/session/services/waitForSessionIdle';

export async function cmdSessionWait(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]');
  }

  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout');
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? Math.min(3600, timeoutSecondsRaw)
      : 300;

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_wait', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const result = await waitForSessionIdle({
    credentials,
    idOrPrefix,
    timeoutMs: timeoutSeconds * 1000,
  });
  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_wait',
        error: { code: result.code, ...(result.candidates ? { candidates: result.candidates } : {}) },
      });
      return;
    }
    throw new Error(result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_wait', data: { sessionId: result.sessionId, idle: true, observedAt: result.observedAt } });
    return;
  }
  console.log(chalk.green('✓'), 'session idle');
  console.log(JSON.stringify({ sessionId: result.sessionId, idle: true, observedAt: result.observedAt }, null, 2));
}

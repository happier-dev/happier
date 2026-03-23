import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { setSessionTitle } from '@/session/services/setSessionTitle';

export async function cmdSessionSetTitle(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  const title = String(argv[2] ?? '').trim();
  if (!idOrPrefix || !title) {
    throw new Error('Usage: happier session set-title <session-id-or-prefix> <title> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_set_title', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const result = await setSessionTitle({ credentials, idOrPrefix, title });
  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_set_title',
        error: { code: result.code, ...(result.candidates ? { candidates: result.candidates } : {}) },
      });
      return;
    }
    throw new Error(result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_set_title', data: { sessionId: result.sessionId, title } });
    return;
  }
  console.log(chalk.green('✓'), `title set for ${result.sessionId}`);
}

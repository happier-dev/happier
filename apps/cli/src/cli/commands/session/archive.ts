import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { setSessionArchivedState } from '@/session/services/setSessionArchivedState';

export async function cmdSessionArchive(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session archive <session-id-or-prefix> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_archive', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const result = await setSessionArchivedState({
    credentials,
    idOrPrefix,
    archived: true,
  });
  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_archive',
        error: { code: result.code, ...(result.candidates ? { candidates: result.candidates } : {}) },
      });
      return;
    }
    throw new Error(result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_archive', data: { sessionId: result.sessionId, archivedAt: result.archivedAt } });
    return;
  }

  console.log(chalk.green('✓'), `archived ${result.sessionId}`);
}

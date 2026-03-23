import chalk from 'chalk';

import { parsePermissionIntentAlias, type PermissionIntent } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { setSessionPermissionMode } from '@/session/services/setSessionPermissionMode';

function parseIntentOrThrow(raw: string): PermissionIntent {
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) {
    const err = new Error(`Invalid permission mode: ${raw}`);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return parsed;
}

export async function cmdSessionSetPermissionMode(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  const rawMode = String(argv[2] ?? '').trim();
  if (!idOrPrefix || !rawMode) {
    throw new Error('Usage: happier session set-permission-mode <session-id-or-prefix> <mode> [--json]');
  }

  const intent = parseIntentOrThrow(rawMode);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_set_permission_mode', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const updatedAt = Date.now();
  const result = await setSessionPermissionMode({
    credentials,
    idOrPrefix,
    permissionMode: intent,
    updatedAt,
  });
  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_set_permission_mode',
        error: { code: result.code, ...(result.candidates ? { candidates: result.candidates } : {}) },
      });
      return;
    }
    throw new Error(result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_set_permission_mode', data: { sessionId: result.sessionId, permissionMode: intent, updatedAt } });
    return;
  }

  console.log(chalk.green('✓'), `permission mode set for ${result.sessionId}: ${intent}`);
}

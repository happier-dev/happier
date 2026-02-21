import chalk from 'chalk';

import { parsePermissionIntentAlias, type PermissionIntent } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/sessionControl/updateSessionMetadataWithRetry';
import { computeNextPermissionIntentMetadata } from '@happier-dev/agents';

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

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_set_permission_mode',
        error: { code: resolved.code, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      });
      return;
    }
    throw new Error(resolved.code);
  }
  const sessionId = resolved.sessionId;

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_set_permission_mode', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const updatedAt = Date.now();
  await updateSessionMetadataWithRetry({
    token: credentials.token,
    credentials,
    sessionId,
    rawSession,
    updater: (metadata) =>
      computeNextPermissionIntentMetadata({
        metadata,
        permissionMode: intent,
        permissionModeUpdatedAt: updatedAt,
      }),
  });

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_set_permission_mode', data: { sessionId, permissionMode: intent, updatedAt } });
    return;
  }

  console.log(chalk.green('✓'), `permission mode set for ${sessionId}: ${intent}`);
}


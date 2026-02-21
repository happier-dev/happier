import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/sessionControl/updateSessionMetadataWithRetry';

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

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_set_title',
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
      printJsonEnvelope({ ok: false, kind: 'session_set_title', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  await updateSessionMetadataWithRetry({
    token: credentials.token,
    credentials,
    sessionId,
    rawSession,
    updater: (metadata) => ({ ...metadata, summary: { text: title, updatedAt: Date.now() } }),
  });

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_set_title', data: { sessionId, title } });
    return;
  }
  console.log(chalk.green('✓'), `title set for ${sessionId}`);
}

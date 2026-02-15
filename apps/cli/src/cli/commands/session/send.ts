import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { fetchSessionById, commitSessionEncryptedMessage } from '@/sessionControl/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials, encryptSessionPayload } from '@/sessionControl/sessionEncryptionContext';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { hasFlag } from '@/sessionControl/argvFlags';

export async function cmdSessionSend(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  const message = String(argv[2] ?? '').trim();
  const wait = hasFlag(argv, '--wait');

  if (!idOrPrefix || !message) {
    throw new Error('Usage: happier session send <session-id-or-prefix> <message> [--wait] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'not_authenticated' } });
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
        kind: 'session_send',
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
      printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const localId = randomUUID();
  const ciphertext = encryptSessionPayload({
    ctx,
    payload: {
      role: 'user',
      content: { type: 'text', text: message },
      meta: { sentFrom: 'cli', source: 'cli' },
    },
  });

  await commitSessionEncryptedMessage({
    token: credentials.token,
    sessionId,
    ciphertext,
    localId,
  });

  if (wait) {
    // The full implementation waits for idle via socket updates. That is implemented in `session wait`.
    // For `send --wait` we intentionally route through the same command logic once available.
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_send', data: { sessionId, localId, waited: false } });
    return;
  }

  console.log(chalk.green('✓'), 'message sent');
  console.log(JSON.stringify({ sessionId, localId }, null, 2));
}


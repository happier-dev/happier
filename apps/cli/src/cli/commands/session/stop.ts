import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { createSessionScopedSocket } from '@/api/session/sockets';

export async function cmdSessionStop(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[1] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session stop <session-id-or-prefix> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_stop', error: { code: 'not_authenticated' } });
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
        kind: 'session_stop',
        error: { code: resolved.code, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      });
      return;
    }
    throw new Error(resolved.code);
  }
  const sessionId = resolved.sessionId;

  const socket = createSessionScopedSocket({ token: credentials.token, sessionId });

  const timeoutMs = 10_000;
  const waitForConnect = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  socket.connect();
  await waitForConnect;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    // socket.io supports ACK callbacks; our typed socket surface doesn't model it here.
    (socket as any).emit('session-end', { sid: sessionId, time: Date.now() }, () => {
      clearTimeout(timer);
      resolve();
    });
  });

  try {
    socket.disconnect();
    socket.close();
  } catch {
    // ignore
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_stop', data: { sessionId, stopped: true } });
    return;
  }

  console.log(chalk.green('✓'), 'stop requested');
}

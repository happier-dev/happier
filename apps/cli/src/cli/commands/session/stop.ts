import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { createSessionScopedSocket } from '@/api/session/sockets';
import { resolveSessionControlSocketAckTimeoutMs, resolveSessionControlSocketConnectTimeoutMs } from '@/sessionControl/sessionControlTimeouts';
import { waitForSocketConnect } from '@/sessionControl/waitForSocketConnect';

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

  const connectTimeoutMs = resolveSessionControlSocketConnectTimeoutMs();
  const connectPromise = waitForSocketConnect(socket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
  socket.connect();
  await connectPromise;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), resolveSessionControlSocketAckTimeoutMs());
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

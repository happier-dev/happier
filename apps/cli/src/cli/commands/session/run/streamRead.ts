import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunTurnStreamReadRequestSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { callSessionRpc } from '@/sessionControl/sessionRpc';
import { readIntFlagValue } from '@/sessionControl/argvFlags';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';

export async function cmdSessionRunStreamRead(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  const streamId = String(argv[4] ?? '').trim();
  const cursor = readIntFlagValue(argv, '--cursor');
  const maxEvents = readIntFlagValue(argv, '--max-events') ?? readIntFlagValue(argv, '--maxEvents');

  if (!idOrPrefix || !runId || !streamId || cursor === null) {
    throw new Error(
      'Usage: happier session run stream-read <session-id-or-prefix> <run-id> <stream-id> --cursor <n> [--max-events <n>] [--json]',
    );
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_stream_read', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_stream_read',
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
      printJsonEnvelope({ ok: false, kind: 'session_run_stream_read', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const request = ExecutionRunTurnStreamReadRequestSchema.parse({
    runId,
    streamId,
    cursor,
    ...(typeof maxEvents === 'number' && Number.isFinite(maxEvents) && maxEvents > 0 ? { maxEvents } : {}),
  });
  const method = `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ}`;
  const result = await callSessionRpc({ token: credentials.token, sessionId, ctx, method, request });

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_stream_read', data: { sessionId, runId, ...(result as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'run stream read');
  console.log(JSON.stringify(result, null, 2));
}


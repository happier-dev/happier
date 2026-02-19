import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunGetRequestSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { callSessionRpc } from '@/sessionControl/sessionRpc';
import { hasFlag } from '@/sessionControl/argvFlags';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';

export async function cmdSessionRunGet(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const includeStructured = hasFlag(argv, '--include-structured') || hasFlag(argv, '--includeStructured');
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();

  if (!idOrPrefix || !runId) {
    throw new Error('Usage: happier session run get <session-id-or-prefix> <run-id> [--include-structured] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_get', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_get',
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
      printJsonEnvelope({ ok: false, kind: 'session_run_get', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const request = ExecutionRunGetRequestSchema.parse({
    runId,
    ...(includeStructured ? { includeStructured: true } : {}),
  });

  const method = `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`;
  const result = await callSessionRpc({
    token: credentials.token,
    sessionId,
    ctx,
    method,
    request,
  });

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_get', data: { sessionId, ...(result as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'execution run fetched');
  console.log(JSON.stringify(result, null, 2));
}

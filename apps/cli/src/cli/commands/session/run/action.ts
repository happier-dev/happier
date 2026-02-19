import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunActionRequestSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { callSessionRpc } from '@/sessionControl/sessionRpc';
import { readJsonFlagValue } from '@/sessionControl/argvFlags';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';

export async function cmdSessionRunAction(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();
  const actionId = String(argv[4] ?? '').trim();
  const input = readJsonFlagValue(argv, '--input-json');

  if (!idOrPrefix || !runId || !actionId) {
    throw new Error('Usage: happier session run action <session-id-or-prefix> <run-id> <action-id> --input-json <json> [--json]');
  }
  if (input === null) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'execution_run_invalid_action_input' } });
      return;
    }
    throw new Error('Invalid --input-json');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_action',
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
      printJsonEnvelope({ ok: false, kind: 'session_run_action', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const request = ExecutionRunActionRequestSchema.parse({ runId, actionId, input });
  const method = `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_ACTION}`;
  const result = await callSessionRpc({ token: credentials.token, sessionId, ctx, method, request });

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_run_action',
      data: { sessionId, runId, actionId, ...(result as any) },
    });
    return;
  }

  console.log(chalk.green('✓'), 'run action executed');
  console.log(JSON.stringify(result, null, 2));
}

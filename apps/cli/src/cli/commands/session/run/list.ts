import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunListRequestSchema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { callSessionRpc } from '@/sessionControl/sessionRpc';

export async function cmdSessionRunList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const sessionId = String(argv[2] ?? '').trim();
  if (!sessionId) {
    throw new Error('Usage: happier session run list <session-id> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_list', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_list', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const request = ExecutionRunListRequestSchema.parse({});
  const method = `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}`;
  const result = await callSessionRpc({
    token: credentials.token,
    sessionId,
    ctx,
    method,
    request,
  });

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_list', data: { sessionId, ...(result as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'execution runs listed');
  console.log(JSON.stringify(result, null, 2));
}


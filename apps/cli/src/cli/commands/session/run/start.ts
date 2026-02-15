import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import {
  ExecutionRunStartRequestSchema,
  type ExecutionRunIntent,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { callSessionRpc } from '@/sessionControl/sessionRpc';
import { readFlagValue } from '@/sessionControl/argvFlags';

function defaultPermissionModeForIntent(intent: ExecutionRunIntent): string {
  if (intent === 'delegate') return 'workspace_write';
  return 'read_only';
}

function defaultRunClassForIntent(intent: ExecutionRunIntent): 'bounded' | 'long_lived' {
  if (intent === 'voice_agent') return 'long_lived';
  return 'bounded';
}

function defaultIoModeForIntent(intent: ExecutionRunIntent): 'request_response' | 'streaming' {
  if (intent === 'voice_agent') return 'streaming';
  return 'request_response';
}

export async function cmdSessionRunStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const sessionId = String(argv[2] ?? '').trim();
  if (!sessionId) {
    throw new Error('Usage: happier session run start <session-id> --intent <intent> --backend <backendId> [--json]');
  }

  const intent = (readFlagValue(argv, '--intent') ?? '').trim() as ExecutionRunIntent;
  const backendId = (readFlagValue(argv, '--backend') ?? '').trim();
  const instructions = readFlagValue(argv, '--instructions') ?? undefined;

  if (!intent || !backendId) {
    throw new Error('Usage: happier session run start <session-id> --intent <intent> --backend <backendId> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_start', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_start', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);

  const permissionMode = (readFlagValue(argv, '--permission-mode') ?? '').trim() || defaultPermissionModeForIntent(intent);
  const retentionPolicy = (readFlagValue(argv, '--retention') ?? '').trim() || 'ephemeral';
  const runClass = ((readFlagValue(argv, '--run-class') ?? '').trim() as any) || defaultRunClassForIntent(intent);
  const ioMode = ((readFlagValue(argv, '--io-mode') ?? '').trim() as any) || defaultIoModeForIntent(intent);

  const request = ExecutionRunStartRequestSchema.parse({
    intent,
    backendId,
    ...(instructions ? { instructions } : {}),
    permissionMode,
    retentionPolicy,
    runClass,
    ioMode,
  });

  const method = `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`;
  const result = await callSessionRpc({
    token: credentials.token,
    sessionId,
    ctx,
    method,
    request,
  });

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_run_start',
      data: { sessionId, ...(result as any), intent, backendId },
    });
    return;
  }

  console.log(chalk.green('✓'), 'execution run started');
  console.log(JSON.stringify(result, null, 2));
}


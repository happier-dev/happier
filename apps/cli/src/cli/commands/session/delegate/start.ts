import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { createSessionControlActionExecutor } from '@/sessionControl/createSessionControlActionExecutor';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { readFlagValue } from '@/sessionControl/argvFlags';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export async function cmdSessionDelegateStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session delegate start <session-id-or-prefix> --backends <id1,id2> --instructions <text> [--json]');
  }

  const backendsRaw = readFlagValue(argv, '--backends') ?? readFlagValue(argv, '--backend');
  const backendIds = splitCsv(backendsRaw);
  const instructions = readFlagValue(argv, '--instructions') ?? '';

  const permissionMode = readFlagValue(argv, '--permission-mode') ?? undefined;
  const retentionPolicy = readFlagValue(argv, '--retention') ?? undefined;
  const runClass = readFlagValue(argv, '--run-class') ?? undefined;
  const ioMode = readFlagValue(argv, '--io-mode') ?? undefined;

  if (backendIds.length === 0 || !instructions.trim()) {
    throw new Error('Usage: happier session delegate start <session-id> --backends <id1,id2> --instructions <text> [--json]');
  }

  const input = {
    backendIds,
    instructions,
    ...(permissionMode ? { permissionMode } : null),
    ...(retentionPolicy ? { retentionPolicy } : null),
    ...(runClass ? { runClass } : null),
    ...(ioMode ? { ioMode } : null),
  };

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_delegate_start', error: { code: 'not_authenticated' } });
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
        kind: 'session_delegate_start',
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
      printJsonEnvelope({ ok: false, kind: 'session_delegate_start', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);

  const executor = createSessionControlActionExecutor({ token: credentials.token, sessionId, ctx });
  const started = await executor.execute('delegate.start', input, { defaultSessionId: sessionId });

  if (!started.ok) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_delegate_start', error: { code: started.errorCode } });
      return;
    }
    console.error(chalk.red('Error:'), started.errorCode);
    process.exit(1);
  }

  const results = (started.result as any)?.results ?? [];

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_delegate_start',
      data: { sessionId, results },
    });
    return;
  }

  console.log(chalk.green('✓'), 'delegate started');
  console.log(JSON.stringify({ sessionId, results }, null, 2));
}

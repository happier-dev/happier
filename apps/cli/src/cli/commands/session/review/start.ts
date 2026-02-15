import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { createSessionControlActionExecutor } from '@/sessionControl/createSessionControlActionExecutor';

import { fetchSessionById } from '@/sessionControl/sessionsHttp';
import { wantsJson, printJsonEnvelope } from '@/sessionControl/jsonOutput';
import { resolveSessionEncryptionContextFromCredentials } from '@/sessionControl/sessionEncryptionContext';
import { readFlagValue } from '@/sessionControl/argvFlags';

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export async function cmdSessionReviewStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const sessionId = String(argv[2] ?? '').trim();
  if (!sessionId) {
    throw new Error('Usage: happier session review start <session-id> --engines <id1,id2> --instructions <text> [--json]');
  }

  const enginesRaw = readFlagValue(argv, '--engines') ?? readFlagValue(argv, '--engine');
  const engineIds = splitCsv(enginesRaw);
  const instructions = readFlagValue(argv, '--instructions') ?? '';

  const changeType = readFlagValue(argv, '--change-type') ?? undefined;
  const baseBranch = readFlagValue(argv, '--base-branch') ?? undefined;
  const baseCommit = readFlagValue(argv, '--base-commit') ?? undefined;
  const coderabbitConfigFiles = splitCsv(readFlagValue(argv, '--coderabbit-config'));
  const permissionMode = readFlagValue(argv, '--permission-mode') ?? undefined;

  if (engineIds.length === 0 || !instructions.trim()) {
    throw new Error('Usage: happier session review start <session-id> --engines <id1,id2> --instructions <text> [--json]');
  }

  const base = (() => {
    if (baseCommit) return { kind: 'commit', baseCommit };
    if (baseBranch) return { kind: 'branch', baseBranch };
    return undefined;
  })();

  const input: any = {
    engineIds,
    instructions,
    ...(changeType ? { changeType } : null),
    ...(base ? { base } : null),
    ...(permissionMode ? { permissionMode } : null),
  };

  if (coderabbitConfigFiles.length > 0) {
    input.engines = {
      ...(input.engines ?? null),
      coderabbit: { configFiles: coderabbitConfigFiles },
    };
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_review_start', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_review_start', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);

  const executor = createSessionControlActionExecutor({ token: credentials.token, sessionId, ctx });
  const started = await executor.execute('review.start', input, { defaultSessionId: sessionId });

  if (!started.ok) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_review_start', error: { code: started.errorCode } });
      return;
    }
    console.error(chalk.red('Error:'), started.errorCode);
    process.exit(1);
  }

  const results = (started.result as any)?.results ?? [];

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_review_start',
      data: { sessionId, results },
    });
    return;
  }

  console.log(chalk.green('✓'), 'review started');
  console.log(JSON.stringify({ sessionId, results }, null, 2));
}

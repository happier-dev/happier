import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { SESSION_HELP_LINES } from '../shared/sessionCommandUsage';
import { normalizeSessionStartActionResults } from '../shared/sessionStartActionResults';

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export async function cmdSessionReviewStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--engines', '--engine', '--instructions', '--change-type', '--base-branch', '--base-commit', '--permission-mode'],
  });
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.reviewStart}`);
  }

  const enginesRaw = readFlagValue(argv, '--engines') ?? readFlagValue(argv, '--engine');
  const engineIds = splitCsv(enginesRaw);
  const instructions = readFlagValue(argv, '--instructions') ?? '';

  const changeType = readFlagValue(argv, '--change-type') ?? undefined;
  const baseBranch = readFlagValue(argv, '--base-branch') ?? undefined;
  const baseCommit = readFlagValue(argv, '--base-commit') ?? undefined;
  const permissionMode = readFlagValue(argv, '--permission-mode') ?? undefined;

  if (engineIds.length === 0 || !instructions.trim()) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.reviewStart}`);
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

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_review_start', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  await ensureCliActionPolicySettings(credentials);

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_review_start',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;

  const executor = sessionTarget.mode === 'plain'
    ? createCliActionExecutor({
        token: credentials.token,
        credentials,
        sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
      })
    : createCliActionExecutor({
        token: credentials.token,
        credentials,
        sessionId,
        mode: sessionTarget.mode,
        ctx: sessionTarget.ctx,
      });
  const started = await executor.execute('review.start', input, { defaultSessionId: sessionId });
  const normalized = normalizeSessionStartActionResults(started);

  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_review_start',
        error: {
          code: normalized.errorCode,
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
          ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
        },
      });
      return;
    }
    console.error(chalk.red('Error:'), normalized.errorMessage ?? normalized.errorCode);
    process.exit(1);
  }

  const results = normalized.results;

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_review_start',
      data: { sessionId, results },
    });
    return;
  }

  console.log(chalk.green('✓'), 'review started');
  await writeJsonStdout({ sessionId, results }, { pretty: true });
}

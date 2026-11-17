import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import { parseWorkflowActionCliInput } from '@/cli/actions/workflowActionInput';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { invalidCommandArguments } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '../shared/sessionCommandUsage';
import { normalizeSessionStartActionResults } from '../shared/sessionStartActionResults';
import { cmd, fail } from '@happier-dev/cli-common/output';

function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * Retained workflow (plan §10.2): the Session selector, the `--engines` list and
 * the `--base-branch`/`--base-commit` shorthand are workflow options; every
 * `review.start` field goes through the shared compiled field parser and the
 * Action's own schema.
 */
export async function cmdSessionReviewStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const usage = `Usage: ${SESSION_HELP_LINES.reviewStart}`;
  const args = parseWorkflowActionCliInput(argv, {
    actionId: 'review.start',
    usage,
    startIndex: 2,
    maxPositionals: 1,
    workflowValueFlags: ['--engines', '--engine', '--base-branch', '--base-commit'],
    workflowOwnedFields: ['sessionId', 'reviewers', 'base'],
  });
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = args.positionals;
  if (!idOrPrefix.trim()) throw invalidCommandArguments(usage, 'Missing Session.');

  const engineIds = splitCsv(args.readWorkflowValue('--engines') ?? args.readWorkflowValue('--engine'));
  if (engineIds.length === 0 && !args.supplies('reviewers')) throw invalidCommandArguments(usage, 'Provide --engines or reviewers in --input-json.');
  if (!args.supplies('instructions')) throw invalidCommandArguments(usage, 'Missing --instructions.');
  const baseCommit = args.readWorkflowValue('--base-commit');
  const baseBranch = args.readWorkflowValue('--base-branch');
  const base = baseCommit
    ? { kind: 'commit', baseCommit }
    : baseBranch
      ? { kind: 'branch', baseBranch }
      : undefined;
  const composed = args.compose({
    ...(engineIds.length > 0 ? { reviewers: engineIds.map((engineId) => ({ kind: 'engine', engineId })) } : {}),
    ...(base ? { base } : {}),
  });
  if (!composed.ok) throw invalidCommandArguments(usage, composed.message);

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_review_start', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
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

  const started = await executor.execute('review.start', composed.input, {
    defaultSessionId: sessionId,
  });
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
    console.error(fail(normalized.errorMessage ?? normalized.errorCode));
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

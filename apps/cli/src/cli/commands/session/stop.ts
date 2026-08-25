import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';
import { assertSessionCommandArguments } from './shared/assertSessionCommandArguments';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';

const SESSION_STOP_USAGE = `Usage: ${SESSION_HELP_LINES.stop}`;

export async function cmdSessionStop(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  assertSessionCommandArguments(argv, {
    usage: SESSION_STOP_USAGE,
    startIndex: 1,
    booleanFlags: ['--json'],
    valueFlags: ['--machine-id'],
    maxPositionals: 1,
  });
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, { startIndex: 1, valueFlags: ['--machine-id'] });
  if (!idOrPrefix) {
    throw new Error(SESSION_STOP_USAGE);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_stop', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const machineId = readFlagValue(argv, '--machine-id');
  const executor = createCliActionExecutorFromCredentials({
    credentials,
    ...(machineId !== null ? { machineId } : {}),
  });
  const actionRes = await executor.execute(
    'session.stop',
    { sessionId: idOrPrefix },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_stop',
        error: { code: normalized.errorCode, ...(normalized.candidates ? { candidates: normalized.candidates } : {}), ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorCode);
  }

  const result = normalized.data as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_stop', json, result })) {
    return;
  }
  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_stop',
      data: {
        sessionId: result.sessionId,
        stopped: result.stopped,
        ...(result.stopOutcome ? { stopOutcome: result.stopOutcome } : {}),
      },
    });
    return;
  }

  if (result.stopped) {
    console.log(chalk.green('✓'), 'session stopped');
    return;
  }

  // A confirmed stop with nothing to signal. Before the stop owner could name
  // this state it fell through to "stop could not be confirmed", which told the
  // user an already-stopped Session was indeterminate.
  if (result.stopOutcome?.status === 'already_stopped') {
    console.log(chalk.green('✓'), 'session already stopped');
    return;
  }

  if (result.stopOutcome?.status === 'stopped_projection_unconfirmed') {
    console.log(chalk.yellow('!'), 'session stopped; status update not yet observed');
    return;
  }

  if (result.stopOutcome?.status === 'stopped_cleanup_incomplete') {
    console.log(chalk.yellow('!'), 'session stopped; local cleanup could not be completed');
    return;
  }

  console.log(chalk.yellow('!'), 'stop could not be confirmed');
}

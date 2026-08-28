import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import {
  hasBackendTargetSelectionFromCsv,
  resolveBackendTargetKeysFromCsv,
} from '../shared/normalizeBackendTargetKeys';
import { SESSION_HELP_LINES } from '../shared/sessionCommandUsage';
import { normalizeSessionStartActionResults } from '../shared/sessionStartActionResults';
import { assertSessionCommandArguments } from '../shared/assertSessionCommandArguments';

export async function cmdSessionPlanStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  assertSessionCommandArguments(argv, {
    usage: `Usage: ${SESSION_HELP_LINES.planStart}`,
    startIndex: 2,
    booleanFlags: ['--json'],
    valueFlags: ['--backends', '--backend', '--instructions', '--permission-mode', '--retention', '--run-class', '--io-mode', '--machine-id'],
    maxPositionals: 1,
  });
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--backends', '--backend', '--instructions', '--permission-mode', '--retention', '--run-class', '--io-mode', '--machine-id'],
  });
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.planStart}`);
  }

  const backendsRaw = readFlagValue(argv, '--backends') ?? readFlagValue(argv, '--backend');
  const instructions = readFlagValue(argv, '--instructions') ?? '';

  const permissionMode = readFlagValue(argv, '--permission-mode') ?? undefined;
  const retentionPolicy = readFlagValue(argv, '--retention') ?? undefined;
  const runClass = readFlagValue(argv, '--run-class') ?? undefined;
  const ioMode = readFlagValue(argv, '--io-mode') ?? undefined;
  const machineId = readFlagValue(argv, '--machine-id');

  if (!hasBackendTargetSelectionFromCsv(backendsRaw) || !instructions.trim()) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.planStart}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_plan_start', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const executor = createCliActionExecutorFromCredentials({
    credentials,
    ...(machineId !== null ? { machineId } : {}),
  });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_plan_start',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;

  const backendTargetKeys = await resolveBackendTargetKeysFromCsv({
    value: backendsRaw,
    actionId: 'subagents.plan.start',
    sessionId,
    executor,
  });
  const input = {
    backendTargetKeys,
    instructions,
    ...(permissionMode ? { permissionMode } : null),
    ...(retentionPolicy ? { retentionPolicy } : null),
    ...(runClass ? { runClass } : null),
    ...(ioMode ? { ioMode } : null),
  };
  const started = await executor.execute('subagents.plan.start', input, { defaultSessionId: sessionId });
  const normalized = normalizeSessionStartActionResults(started);

  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_plan_start',
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
      kind: 'session_plan_start',
      data: { sessionId, results },
    });
    return;
  }

  console.log(chalk.green('✓'), 'plan started');
  await writeJsonStdout({ sessionId, results }, { pretty: true });
}

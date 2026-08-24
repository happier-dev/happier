import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import {
  ExecutionRunListRequestSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunStatusSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readFlagValue, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { parseProtocolEnumFlag } from '@/cli/commands/shared/parseProtocolEnumFlag';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { assertSessionCommandArguments } from '@/cli/commands/session/shared/assertSessionCommandArguments';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  assertSessionCommandArguments(argv, {
    usage: `Usage: ${SESSION_HELP_LINES.runList}`,
    startIndex: 2,
    booleanFlags: ['--json'],
    valueFlags: ['--agent', '--status', '--limit'],
    allowMissingValueFlags: ['--agent', '--status', '--limit'],
    maxPositionals: 1,
  });
  const [idOrPrefix = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--agent', '--status', '--limit'],
  });
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runList}`);
  }
  const limit = readIntFlagValue(argv, '--limit', { min: 1, max: 200 });
  const agentRaw = (readFlagValue(argv, '--agent') ?? '').trim();
  const backendTarget = agentRaw ? parseSingleBackendTargetFromFlag(agentRaw) : undefined;
  if (hasFlag(argv, '--agent') && !backendTarget) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runList}`);
  }
  const statusRaw = (readFlagValue(argv, '--status') ?? '').trim();
  const status = hasFlag(argv, '--status')
    ? parseProtocolEnumFlag({
        flag: '--status',
        rawValue: statusRaw,
        schema: ExecutionRunStatusSchema,
      })
    : undefined;

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_list', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const request = ExecutionRunListRequestSchema.parse({
    ...(backendTarget ? { backendTarget } : {}),
    ...(status ? { status } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  });

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const sessionTarget = await executor.resolveSessionTarget(idOrPrefix);
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_list',
        error: {
          code: sessionTarget.code,
          ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
        },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;

  const normalized = normalizeActionExecuteResult(await executor.execute(
    'execution.run.list',
    request,
    { surface: 'cli', defaultSessionId: sessionId },
  ));
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_list',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  const runPayload = ExecutionRunListResponseSchema.parse(unwrapCliActionSuccessPayload(normalized.data));

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_list', data: { sessionId, ...runPayload } });
    return;
  }

  console.log(chalk.green('✓'), 'execution runs listed');
  await writeJsonStdout(runPayload, { pretty: true });
}

import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import {
  ExecutionRunStatusSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readFlagValue, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/parseSingleBackendTargetFromFlag';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import {
  formatProtocolEnumUsage,
  parseProtocolEnumFlag,
} from '@/cli/commands/shared/parseProtocolEnumFlag';

const EXECUTION_RUN_STATUS_USAGE = formatProtocolEnumUsage(ExecutionRunStatusSchema);

export const SESSION_RUN_LIST_USAGE = `happier session run list <session-id-or-prefix-or-tag> [--backend <backend-target>] [--status <${EXECUTION_RUN_STATUS_USAGE}>] [--limit <count>] [--json]`;

export async function cmdSessionRunList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--backend', '--status', '--limit'],
  });
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_RUN_LIST_USAGE}`);
  }
  const limit = readIntFlagValue(argv, '--limit', { min: 1, max: 200 });
  const backendRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  const backendTarget = backendRaw ? parseSingleBackendTargetFromFlag(backendRaw) : undefined;
  if (hasFlag(argv, '--backend') && !backendTarget) {
    throw new Error(`Usage: ${SESSION_RUN_LIST_USAGE}`);
  }
  const statusRaw = (readFlagValue(argv, '--status') ?? '').trim();
  const status = hasFlag(argv, '--status')
    ? parseProtocolEnumFlag({ flag: '--status', rawValue: statusRaw, schema: ExecutionRunStatusSchema })
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

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_list',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const sessionId = sessionTarget.sessionId;

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'execution.run.list',
    {
      sessionId,
      ...(backendTarget ? { backendTarget } : {}),
      ...(status ? { status } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
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

  const result = normalized.data as any;
  const runPayload = result && typeof result === 'object' && result.ok === true ? result.data : null;

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_run_list', data: { sessionId, ...(runPayload as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'execution runs listed');
  await writeJsonStdout(runPayload, { pretty: true });
}

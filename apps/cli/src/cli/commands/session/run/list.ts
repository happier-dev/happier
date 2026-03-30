import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import {
  ExecutionRunStatusSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/parseSingleBackendTargetFromFlag';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';

export async function cmdSessionRunList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session run list <session-id-or-prefix> [--backend <backend-target>] [--status <status>] [--limit <count>] [--json]');
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

  const backendRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  const backendTarget = backendRaw ? parseSingleBackendTargetFromFlag(backendRaw) : undefined;
  if (backendRaw && !backendTarget) {
    throw new Error('Usage: happier session run list <session-id-or-prefix> [--backend <backend-target>] [--status <status>] [--limit <count>] [--json]');
  }
  const statusRaw = (readFlagValue(argv, '--status') ?? '').trim();
  const status = statusRaw ? ExecutionRunStatusSchema.parse(statusRaw) : undefined;
  const limit = readIntFlagValue(argv, '--limit');
  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'execution.run.list',
    {
      sessionId: idOrPrefix,
      ...(backendTarget ? { backendTarget } : {}),
      ...(status ? { status } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
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
    printJsonEnvelope({ ok: true, kind: 'session_run_list', data: { sessionId: idOrPrefix, ...(runPayload as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'execution runs listed');
  console.log(JSON.stringify(runPayload, null, 2));
}

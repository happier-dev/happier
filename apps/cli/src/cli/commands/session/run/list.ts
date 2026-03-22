import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import {
  ExecutionRunListRequestSchema,
  ExecutionRunStatusSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { listExecutionRuns } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/parseSingleBackendTargetFromFlag';

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

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_list',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const backendRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  const backendTarget = backendRaw ? parseSingleBackendTargetFromFlag(backendRaw) : undefined;
  if (backendRaw && !backendTarget) {
    throw new Error('Usage: happier session run list <session-id-or-prefix> [--backend <backend-target>] [--status <status>] [--limit <count>] [--json]');
  }
  const statusRaw = (readFlagValue(argv, '--status') ?? '').trim();
  const status = statusRaw ? ExecutionRunStatusSchema.parse(statusRaw) : undefined;
  const limit = readIntFlagValue(argv, '--limit');
  const request = ExecutionRunListRequestSchema.parse({
    ...(backendTarget ? { backendTarget } : {}),
    ...(status ? { status } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  });
  const result = await listExecutionRuns({
    token: credentials.token,
    sessionId,
    mode,
    ctx,
    request,
  });

  if (!result.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_list',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_list', data: { sessionId, ...(result.data as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'execution runs listed');
  console.log(JSON.stringify(result.data, null, 2));
}

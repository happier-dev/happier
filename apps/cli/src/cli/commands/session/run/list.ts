import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import {
  ExecutionRunListRequestSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunStatusSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue, readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { listExecutionRuns } from '@/session/services/executionRuns';

export async function cmdSessionRunList(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runList}`);
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
    throw new Error(`Usage: ${SESSION_HELP_LINES.runList}`);
  }
  const statusRaw = (readFlagValue(argv, '--status') ?? '').trim();
  const status = statusRaw ? ExecutionRunStatusSchema.parse(statusRaw) : undefined;
  const limit = readIntFlagValue(argv, '--limit');

  const request = ExecutionRunListRequestSchema.parse({
    ...(backendTarget ? { backendTarget } : {}),
    ...(status ? { status } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  });

  const transport = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!transport.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_run_list',
        error: {
          code: transport.code,
          ...(transport.sessionId ? { sessionId: transport.sessionId } : {}),
          ...(transport.candidates ? { candidates: transport.candidates } : {}),
        },
      });
      return;
    }
    throw new Error(transport.code);
  }

  const result = await listExecutionRuns({
    token: credentials.token,
    sessionId: transport.sessionId,
    mode: transport.mode,
    ctx: transport.ctx,
    request,
    skipLiveRpc: transport.rawSession.active === false,
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

  const runPayload = ExecutionRunListResponseSchema.parse(result.data);

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_list', data: { sessionId: transport.sessionId, ...runPayload } });
    return;
  }

  console.log(chalk.green('✓'), 'execution runs listed');
  console.log(JSON.stringify(runPayload, null, 2));
}

import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { ExecutionRunGetRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { getExecutionRun } from '@/session/services/executionRuns';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';

export async function cmdSessionRunGet(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const includeStructured = hasFlag(argv, '--include-structured') || hasFlag(argv, '--includeStructured');
  const idOrPrefix = String(argv[2] ?? '').trim();
  const runId = String(argv[3] ?? '').trim();

  if (!idOrPrefix || !runId) {
    throw new Error('Usage: happier session run get <session-id-or-prefix> <run-id> [--include-structured] [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_get', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_get',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;
  const request = ExecutionRunGetRequestSchema.parse({
    runId,
    ...(includeStructured ? { includeStructured: true } : {}),
  });
  const result = await getExecutionRun({
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
        kind: 'session_run_get',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    printJsonEnvelope({ ok: true, kind: 'session_run_get', data: { sessionId, ...(result.data as any) } });
    return;
  }

  console.log(chalk.green('✓'), 'execution run fetched');
  console.log(JSON.stringify(result.data, null, 2));
}

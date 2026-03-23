import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import {
  type ExecutionRunIntent,
  ExecutionRunStartRequestSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue } from '@/cli/commands/shared/argvFlags';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import {
  defaultIoModeForExecutionRunIntent,
  defaultPermissionModeForExecutionRunIntent,
  defaultRunClassForExecutionRunIntent,
} from '@/session/services/executionRunStartDefaults';
import { startExecutionRun } from '@/session/services/executionRuns';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/parseSingleBackendTargetFromFlag';

export async function cmdSessionRunStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error('Usage: happier session run start <session-id-or-prefix> --intent <intent> --backend <backend-target> [--json]');
  }

  const intent = (readFlagValue(argv, '--intent') ?? '').trim() as ExecutionRunIntent;
  const backendTargetRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  const instructions = readFlagValue(argv, '--instructions') ?? undefined;

  if (!intent || !backendTargetRaw) {
    throw new Error('Usage: happier session run start <session-id> --intent <intent> --backend <backend-target> [--json]');
  }

  const backendTarget = parseSingleBackendTargetFromFlag(backendTargetRaw);
  if (!backendTarget) {
    throw new Error('Usage: happier session run start <session-id> --intent <intent> --backend <backend-target> [--json]');
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_run_start', error: { code: 'not_authenticated' } });
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
        kind: 'session_run_start',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId, ctx, mode } = sessionTarget;

  const permissionMode = (readFlagValue(argv, '--permission-mode') ?? '').trim() || defaultPermissionModeForExecutionRunIntent(intent);
  const retentionPolicy = (readFlagValue(argv, '--retention') ?? '').trim() || 'ephemeral';
  const runClass = ((readFlagValue(argv, '--run-class') ?? '').trim() as any) || defaultRunClassForExecutionRunIntent(intent);
  const ioMode = ((readFlagValue(argv, '--io-mode') ?? '').trim() as any) || defaultIoModeForExecutionRunIntent(intent);

  const request = ExecutionRunStartRequestSchema.parse({
    intent,
    backendTarget,
    ...(instructions ? { instructions } : {}),
    permissionMode,
    retentionPolicy,
    runClass,
    ioMode,
  });

  const result = await startExecutionRun({
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
        kind: 'session_run_start',
        error: { code: result.code, ...(result.message ? { message: result.message } : {}) },
      });
      return;
    }
    throw new Error(result.message ?? result.code);
  }

  if (json) {
    const backendId = backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : backendTarget.backendId;
    printJsonEnvelope({
      ok: true,
      kind: 'session_run_start',
      data: { sessionId, ...(result.data as any), intent, backendId, backendTarget },
    });
    return;
  }

  console.log(chalk.green('✓'), 'execution run started');
  console.log(JSON.stringify(result.data, null, 2));
}

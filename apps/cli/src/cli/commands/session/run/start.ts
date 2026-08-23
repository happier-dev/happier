import chalk from 'chalk';

import type { StoredCredentials } from '@/persistence';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
  ExecutionRunStartRequestSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { parseProtocolEnumFlag } from '@/cli/commands/shared/parseProtocolEnumFlag';
import { assertSessionCommandArguments } from '@/cli/commands/session/shared/assertSessionCommandArguments';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import {
  defaultIoModeForExecutionRunIntent,
  defaultPermissionModeForExecutionRunIntent,
  defaultRetentionPolicyForExecutionRunIntent,
  defaultRunClassForExecutionRunIntent,
} from '@/session/services/executionRunStartDefaults';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { resolveConcreteCompatBackendTargetRefs } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

export async function cmdSessionRunStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  assertSessionCommandArguments(argv, {
    usage: `Usage: ${SESSION_HELP_LINES.runStart}`,
    startIndex: 2,
    booleanFlags: ['--json'],
    valueFlags: ['--intent', '--agent', '--instructions', '--permission-mode', '--retention', '--run-class', '--io-mode'],
    allowMissingValueFlags: ['--intent', '--agent', '--instructions', '--permission-mode', '--retention', '--run-class', '--io-mode'],
    maxPositionals: 1,
  });
  const [idOrPrefix = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--intent', '--agent', '--instructions', '--permission-mode', '--retention', '--run-class', '--io-mode'],
  });
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
  }

  const intentRaw = (readFlagValue(argv, '--intent') ?? '').trim();
  const backendTargetRaw = (readFlagValue(argv, '--agent') ?? '').trim();
  const instructions = readFlagValue(argv, '--instructions') ?? undefined;

  if (!intentRaw || !backendTargetRaw) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
  }

  const intent = parseProtocolEnumFlag({
    flag: '--intent',
    rawValue: intentRaw,
    schema: ExecutionRunIntentSchema,
  });

  const backendTarget = parseSingleBackendTargetFromFlag(backendTargetRaw);
  if (!backendTarget) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
  }
  const resolvedBackendTarget = resolveConcreteCompatBackendTargetRefs(backendTarget);
  if (!resolvedBackendTarget) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
  }

  const retentionRaw = readFlagValue(argv, '--retention');
  const retentionPolicy = parseProtocolEnumFlag({
    flag: '--retention',
    rawValue: retentionRaw
      ?? (hasFlag(argv, '--retention') ? '' : defaultRetentionPolicyForExecutionRunIntent(intent)),
    schema: ExecutionRunRetentionPolicySchema,
  });
  const runClassRaw = readFlagValue(argv, '--run-class');
  const runClass = parseProtocolEnumFlag({
    flag: '--run-class',
    rawValue: runClassRaw
      ?? (hasFlag(argv, '--run-class') ? '' : defaultRunClassForExecutionRunIntent(intent)),
    schema: ExecutionRunClassSchema,
  });
  const ioModeRaw = readFlagValue(argv, '--io-mode');
  const ioMode = parseProtocolEnumFlag({
    flag: '--io-mode',
    rawValue: ioModeRaw
      ?? (hasFlag(argv, '--io-mode') ? '' : defaultIoModeForExecutionRunIntent(intent)),
    schema: ExecutionRunIoModeSchema,
  });

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_start', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  await ensureCliActionPolicySettings(credentials);

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_start',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }
  const { sessionId } = sessionTarget;

  const permissionMode = (readFlagValue(argv, '--permission-mode') ?? '').trim() || defaultPermissionModeForExecutionRunIntent(intent);

  const request = ExecutionRunStartRequestSchema.parse({
    intent,
    backendTarget: resolvedBackendTarget.backendTargetV2,
    ...(instructions ? { instructions } : {}),
    permissionMode,
    retentionPolicy,
    runClass,
    ioMode,
  });

  const executor = sessionTarget.mode === 'plain'
    ? createCliActionExecutor({
        token: credentials.token,
        credentials,
        sessionId,
        ctx: sessionTarget.ctx,
        mode: sessionTarget.mode,
      })
    : createCliActionExecutor({
        token: credentials.token,
        credentials,
        sessionId,
        ctx: sessionTarget.ctx,
        mode: sessionTarget.mode,
      });
  const actionRes = await executor.execute(
    'execution.run.start',
    { sessionId, ...request },
    { surface: 'cli', defaultSessionId: sessionId },
  );
  const normalized = normalizeActionExecuteResult(actionRes);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_start',
        error: { code: normalized.errorCode, ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}) },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  const runPayload = unwrapCliActionSuccessPayload(normalized.data);

  if (json) {
    const backendId = request.backendTarget.backendId;
    await printJsonEnvelope({
      ok: true,
      kind: 'session_run_start',
      data: { sessionId, ...(runPayload as any), intent, backendId, backendTarget: request.backendTarget },
    });
    return;
  }

  console.log(chalk.green('✓'), 'execution run started');
  await writeJsonStdout(runPayload, { pretty: true });
}

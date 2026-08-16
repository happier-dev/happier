import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import {
  ExecutionRunClassSchema,
  ExecutionRunIntentSchema,
  ExecutionRunIoModeSchema,
  ExecutionRunRetentionPolicySchema,
  ExecutionRunStartRequestSchema,
} from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import {
  defaultIoModeForExecutionRunIntent,
  defaultPermissionModeForExecutionRunIntent,
  defaultRunClassForExecutionRunIntent,
} from '@/session/services/executionRunStartDefaults';
import { parseSingleBackendTargetFromFlag } from '@/cli/commands/session/shared/parseSingleBackendTargetFromFlag';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import {
  formatProtocolEnumUsage,
  parseProtocolEnumFlag,
} from '@/cli/commands/shared/parseProtocolEnumFlag';

const EXECUTION_RUN_INTENT_USAGE = formatProtocolEnumUsage(ExecutionRunIntentSchema);
const EXECUTION_RUN_RETENTION_USAGE = formatProtocolEnumUsage(ExecutionRunRetentionPolicySchema);
const EXECUTION_RUN_CLASS_USAGE = formatProtocolEnumUsage(ExecutionRunClassSchema);
const EXECUTION_RUN_IO_MODE_USAGE = formatProtocolEnumUsage(ExecutionRunIoModeSchema);

export const SESSION_RUN_START_USAGE = `happier session run start <session-id-or-prefix-or-tag> --intent <${EXECUTION_RUN_INTENT_USAGE}> --backend <backend-target> [--instructions <text>] [--permission-mode <mode>] [--retention <${EXECUTION_RUN_RETENTION_USAGE}>] [--run-class <${EXECUTION_RUN_CLASS_USAGE}>] [--io-mode <${EXECUTION_RUN_IO_MODE_USAGE}>] [--json]`;

export async function cmdSessionRunStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: [
      '--intent', '--backend', '--instructions', '--permission-mode', '--retention', '--run-class', '--io-mode',
    ],
  });
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_RUN_START_USAGE}`);
  }

  const intentRaw = (readFlagValue(argv, '--intent') ?? '').trim();
  const backendTargetRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  const instructions = readFlagValue(argv, '--instructions') ?? undefined;

  if (!intentRaw || !backendTargetRaw) {
    throw new Error(`Usage: ${SESSION_RUN_START_USAGE}`);
  }

  const intent = parseProtocolEnumFlag({
    flag: '--intent',
    rawValue: intentRaw,
    schema: ExecutionRunIntentSchema,
  });

  const backendTarget = parseSingleBackendTargetFromFlag(backendTargetRaw);
  if (!backendTarget) {
    throw new Error(`Usage: ${SESSION_RUN_START_USAGE}`);
  }

  const permissionMode = (readFlagValue(argv, '--permission-mode') ?? '').trim()
    || defaultPermissionModeForExecutionRunIntent(intent);
  const retentionRaw = readFlagValue(argv, '--retention');
  const retentionPolicy = parseProtocolEnumFlag({
    flag: '--retention',
    rawValue: retentionRaw ?? (hasFlag(argv, '--retention') ? '' : 'ephemeral'),
    schema: ExecutionRunRetentionPolicySchema,
  });
  const runClassRaw = readFlagValue(argv, '--run-class');
  const runClass = parseProtocolEnumFlag({
    flag: '--run-class',
    rawValue: runClassRaw ?? (hasFlag(argv, '--run-class') ? '' : defaultRunClassForExecutionRunIntent(intent)),
    schema: ExecutionRunClassSchema,
  });
  const ioModeRaw = readFlagValue(argv, '--io-mode');
  const ioMode = parseProtocolEnumFlag({
    flag: '--io-mode',
    rawValue: ioModeRaw ?? (hasFlag(argv, '--io-mode') ? '' : defaultIoModeForExecutionRunIntent(intent)),
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

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_run_start',
        error: { code: resolved.code, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) },
      });
      return;
    }
    throw new Error(resolved.code);
  }
  const sessionId = resolved.sessionId;

  const rawSession = await fetchSessionById({ token: credentials.token, sessionId });
  if (!rawSession) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_run_start', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const request = ExecutionRunStartRequestSchema.parse({
    intent,
    backendTarget,
    ...(instructions ? { instructions } : {}),
    permissionMode,
    retentionPolicy,
    runClass,
    ioMode,
  });

  const ctx = resolveSessionEncryptionContextFromCredentials(credentials, rawSession);
  const mode = resolveSessionStoredContentEncryptionMode(rawSession);
  const executor = createCliActionExecutor({ token: credentials.token, credentials, sessionId, ctx, mode });
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

  const result = normalized.data as any;
  const runPayload = result && typeof result === 'object' && result.ok === true ? result.data : null;

  if (json) {
    const backendId = backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : backendTarget.backendId;
    await printJsonEnvelope({ ok: true, kind: 'session_run_start', data: { sessionId, ...(runPayload as any), intent, backendId, backendTarget } });
    return;
  }

  console.log(chalk.green('✓'), 'execution run started');
  await writeJsonStdout(runPayload, { pretty: true });
}

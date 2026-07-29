import chalk from 'chalk';

import type { Credentials } from '@/persistence';
import { type ExecutionRunIntent, ExecutionRunStartRequestSchema } from '@happier-dev/protocol';

import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readFlagValue } from '@/cli/commands/shared/argvFlags';
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
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';

export async function cmdSessionRunStart(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  if (!idOrPrefix) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
  }

  const intent = (readFlagValue(argv, '--intent') ?? '').trim() as ExecutionRunIntent;
  const backendTargetRaw = (readFlagValue(argv, '--backend') ?? '').trim();
  const instructions = readFlagValue(argv, '--instructions') ?? undefined;

  if (!intent || !backendTargetRaw) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
  }

  const backendTarget = parseSingleBackendTargetFromFlag(backendTargetRaw);
  if (!backendTarget) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
  }
  const resolvedBackendTarget = resolveConcreteCompatBackendTargetRefs(backendTarget);
  if (!resolvedBackendTarget) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.runStart}`);
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

  await ensureCliActionPolicySettings(credentials);

  const resolved = await resolveSessionIdOrPrefix({ credentials, idOrPrefix });
  if (!resolved.ok) {
    if (json) {
      printJsonEnvelope({
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
      printJsonEnvelope({ ok: false, kind: 'session_run_start', error: { code: 'session_not_found', sessionId } });
      return;
    }
    console.error(chalk.red('Error:'), `Session not found: ${sessionId}`);
    process.exit(1);
  }

  const permissionMode = (readFlagValue(argv, '--permission-mode') ?? '').trim() || defaultPermissionModeForExecutionRunIntent(intent);
  const retentionPolicy = (readFlagValue(argv, '--retention') ?? '').trim() || defaultRetentionPolicyForExecutionRunIntent(intent);
  const runClass = ((readFlagValue(argv, '--run-class') ?? '').trim() as any) || defaultRunClassForExecutionRunIntent(intent);
  const ioMode = ((readFlagValue(argv, '--io-mode') ?? '').trim() as any) || defaultIoModeForExecutionRunIntent(intent);

  const request = ExecutionRunStartRequestSchema.parse({
    intent,
    backendTarget: resolvedBackendTarget.backendTargetV2,
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
      printJsonEnvelope({
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
    printJsonEnvelope({
      ok: true,
      kind: 'session_run_start',
      data: { sessionId, ...(runPayload as any), intent, backendId, backendTarget: request.backendTarget },
    });
    return;
  }

  console.log(chalk.green('✓'), 'execution run started');
  console.log(JSON.stringify(runPayload, null, 2));
}

import chalk from 'chalk';

import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { PermissionIntent } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag, readIntFlagValue, readFlagValue, readFlagValueUnlessFlagToken } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';

const SESSION_SEND_USAGE = 'Usage: happier session send <session-id-or-prefix> <message|--message <text>|--prompt <text>> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]';
const AMBIGUOUS_MESSAGE_USAGE = 'Provide the message either positionally or with --message/--prompt, not both.';

function parsePermissionIntentOrThrow(raw: string): PermissionIntent {
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) {
    const err = new Error(`Invalid permission mode: ${raw}`);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  return parsed;
}

function readSessionSendSuccessResult(value: unknown): Readonly<{
  sessionId: unknown;
  localId: unknown;
  waited: unknown;
}> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    sessionId: record.sessionId,
    localId: record.localId,
    waited: record.waited,
  };
}

export async function cmdSessionSend(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefixRaw = String(argv[1] ?? '').trim();
  const idOrPrefix = idOrPrefixRaw && !idOrPrefixRaw.startsWith('-') ? idOrPrefixRaw : '';
  const positionalMessageRaw = String(argv[2] ?? '').trim();
  const positionalMessage = positionalMessageRaw && !positionalMessageRaw.startsWith('-') ? positionalMessageRaw : '';
  const hasMessageFlag = hasFlag(argv, '--message');
  const hasPromptFlag = hasFlag(argv, '--prompt');
  const messageFlag = readFlagValueUnlessFlagToken(argv, '--message');
  const promptFlag = readFlagValueUnlessFlagToken(argv, '--prompt');
  if (positionalMessage && (hasMessageFlag || hasPromptFlag)) {
    const err = new Error(AMBIGUOUS_MESSAGE_USAGE);
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  if (messageFlag && promptFlag) {
    const err = new Error('Provide the message with --message or --prompt, not both.');
    (err as any).code = 'invalid_arguments';
    throw err;
  }
  const message = positionalMessage || messageFlag || promptFlag || '';
  const wait = hasFlag(argv, '--wait');
  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout');
  const permissionModeFlag = (readFlagValue(argv, '--permission-mode') ?? '').trim();
  const modelFlagRaw = readFlagValue(argv, '--model');
  const hasModelFlag = modelFlagRaw !== null;
  const modelFlag = typeof modelFlagRaw === 'string' ? modelFlagRaw.trim() : '';
  const timeoutSeconds =
    typeof timeoutSecondsRaw === 'number' && Number.isFinite(timeoutSecondsRaw) && timeoutSecondsRaw > 0
      ? Math.min(3600, timeoutSecondsRaw)
      : 300;

  if (!idOrPrefix || !message) {
    const err = new Error(SESSION_SEND_USAGE);
    (err as any).code = 'invalid_arguments';
    throw err;
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const permissionModeOverride = permissionModeFlag ? parsePermissionIntentOrThrow(permissionModeFlag) : undefined;
  const modelOverride =
    hasModelFlag
      ? (() => {
          if (!modelFlag) {
            const err = new Error('Invalid --model');
            (err as any).code = 'invalid_arguments';
            throw err;
          }
          return modelFlag === 'default' ? null : modelFlag;
        })()
      : undefined;

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.message.send',
    {
      sessionId: idOrPrefix,
      message,
      ...(permissionModeOverride ? { permissionModeOverride } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      ...(wait ? { wait: true } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_send',
        error: {
          code: normalized.errorCode,
          ...(normalized.candidates ? { candidates: normalized.candidates } : {}),
          ...(normalized.errorMessage ? { message: normalized.errorMessage } : {}),
        },
      });
      return;
    }
    throw new Error(normalized.errorMessage ?? normalized.errorCode);
  }

  const result = unwrapCliActionSuccessPayload(normalized.data);
  if (tryHandleApprovalRequestCreated({ envelopeKind: 'session_send', json, result })) {
    return;
  }
  const sendResult = readSessionSendSuccessResult(result);

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_send',
      data: {
        sessionId: sendResult.sessionId,
        localId: sendResult.localId,
        waited: sendResult.waited,
      },
    });
    return;
  }

  console.log(chalk.green('✓'), 'message sent');
  console.log(JSON.stringify({ sessionId: sendResult.sessionId, localId: sendResult.localId }, null, 2));
}

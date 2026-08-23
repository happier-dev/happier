import chalk from 'chalk';

import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { PermissionIntent } from '@happier-dev/agents';
import { ok } from '@happier-dev/cli-common/output';

import type { StoredCredentials } from '@/persistence';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readIntFlagValue, readFlagValue, readFlagValueUnlessFlagToken } from '@/cli/commands/shared/argvFlags';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from './shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from './shared/tryHandleApprovalRequestCreated';
import { assertSessionCommandArguments } from './shared/assertSessionCommandArguments';
import { readProviderConnectionFlag } from './shared/readProviderConnectionFlag';

const SESSION_SEND_USAGE = 'Usage: happier session send <session-id-or-prefix> <message|--message <text>|--prompt <text>> [--permission-mode <mode>] [--model <model-id>] [--provider-connection <id|native>] [--local-id <id>] [--wait] [--timeout <seconds>] [--json]';
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
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  assertSessionCommandArguments(argv, {
    usage: SESSION_SEND_USAGE,
    startIndex: 1,
    booleanFlags: ['--wait', '--json'],
    valueFlags: ['--message', '--prompt', '--permission-mode', '--model', '--provider-connection', '--local-id', '--timeout'],
    maxPositionals: 2,
  });
  const json = wantsJson(argv);
  const [idOrPrefix = '', positionalMessage = ''] = readCommandPositionals(argv, {
    startIndex: 1,
    valueFlags: ['--message', '--prompt', '--permission-mode', '--model', '--provider-connection', '--local-id', '--timeout'],
  });
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
  const timeoutSecondsRaw = readIntFlagValue(argv, '--timeout', { min: 1 });
  const permissionModeFlag = (readFlagValue(argv, '--permission-mode') ?? '').trim();
  const modelFlagRaw = readFlagValue(argv, '--model');
  const hasModelFlag = modelFlagRaw !== null;
  const modelFlag = typeof modelFlagRaw === 'string' ? modelFlagRaw.trim() : '';
  const providerConnectionId = readProviderConnectionFlag(argv);
  // The durable input identity a caller retains across an ambiguous send. The
  // pending queue is keyed by it, so resubmitting rejoins the existing input
  // instead of queueing a second message. `assertSessionCommandArguments`
  // already rejected a missing or flag-shaped value above.
  const localIdFlag = readFlagValueUnlessFlagToken(argv, '--local-id');
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
      await printJsonEnvelope({ ok: false, kind: 'session_send', error: { code: 'not_authenticated' } });
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
  // The Action contract binds an exact Provider connection only to a concrete
  // model id; refuse locally instead of sending an input the Action rejects.
  if (providerConnectionId !== undefined
    && providerConnectionId !== null
    && typeof modelOverride !== 'string') {
    const err = new Error('--provider-connection requires --model <model-id>');
    (err as any).code = 'invalid_arguments';
    throw err;
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const actionRes = await executor.execute(
    'session.message.send',
    {
      sessionId: idOrPrefix,
      message,
      ...(permissionModeOverride ? { permissionModeOverride } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
      ...(localIdFlag ? { localId: localIdFlag } : {}),
      ...(wait ? { wait: true } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
    },
    { surface: 'cli', defaultSessionId: null },
  );
  const normalized = normalizeActionExecuteResult(actionRes as any);
  if (!normalized.ok) {
    if (json) {
      await printJsonEnvelope({
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
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_send', json, result })) {
    return;
  }
  const sendResult = readSessionSendSuccessResult(result);

  if (json) {
    await printJsonEnvelope({
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

  // The localId is this message's stable identity. Printing it lets a human
  // retry `session send --local-id <id>` after an ambiguous failure and rejoin
  // the same durable input instead of queueing a second message.
  console.log(ok(
    typeof sendResult.localId === 'string' && sendResult.localId.length > 0
      ? `Message sent (local id ${sendResult.localId})`
      : 'Message sent',
  ));
}

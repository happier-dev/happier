import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import type { Credentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { hasFlag, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { actionAcceptsContextualSessionId, type ActionId } from '@happier-dev/protocol';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';

function parseInputJsonOrThrow(raw: string | null): unknown {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const err = new Error(error instanceof Error ? error.message : 'Invalid --input-json');
    (err as Error & { code?: string }).code = 'invalid_arguments';
    throw err;
  }
}

function hasSpawnNonce(details: unknown): boolean {
  return Boolean(details && typeof details === 'object'
    && (details as { accepted?: unknown }).accepted === true
    && typeof (details as { spawnNonce?: unknown }).spawnNonce === 'string'
    && (details as { spawnNonce: string }).spawnNonce.trim());
}

function isInputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withResolvedSessionInput(actionId: string, input: unknown, sessionId: string): unknown {
  if (!actionAcceptsContextualSessionId(actionId) || !isInputRecord(input)) return input;
  return {
    ...input,
    sessionId,
  };
}

export async function cmdSessionActionsExecute(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const idOrPrefix = String(argv[2] ?? '').trim();
  const actionId = String(argv[3] ?? '').trim();
  const actionRequestId = (readFlagValue(argv, '--action-request-id') ?? '').trim();
  if (actionRequestId && (actionRequestId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(actionRequestId))) {
    throw new Error('Invalid --action-request-id.');
  }
  const effectiveActionRequestId = actionRequestId || (actionId === 'session.spawn_new' ? randomUUID() : '');
  const resumeActionRequest = hasFlag(argv, '--resume-action-request');
  if (resumeActionRequest && !actionRequestId) {
    throw new Error('Invalid --resume-action-request without --action-request-id.');
  }
  if (!idOrPrefix || !actionId) {
    throw new Error(`Usage: ${SESSION_HELP_LINES.actionsExecute}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_actions_execute', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  await ensureCliActionPolicySettings(credentials);

  const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
  if (!sessionTarget.ok) {
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_actions_execute',
        error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
      });
      return;
    }
    throw new Error(sessionTarget.code);
  }

  const executor = createCliActionExecutor({
    token: credentials.token,
    credentials,
    sessionId: sessionTarget.sessionId,
    ctx: sessionTarget.ctx,
    mode: sessionTarget.mode,
    rawSession: sessionTarget.rawSession,
  });
  const input = withResolvedSessionInput(
    actionId,
    parseInputJsonOrThrow(readFlagValue(argv, '--input-json')),
    sessionTarget.sessionId,
  );
  const actionRes = await executor.execute(
    actionId as ActionId,
    input,
    {
      defaultSessionId: sessionTarget.sessionId,
      surface: 'cli',
      ...(effectiveActionRequestId ? { actionRequestId: effectiveActionRequestId } : {}),
      ...(resumeActionRequest ? { resumeActionRequest: true } : {}),
    },
  );
  const result = normalizeActionExecuteResult(actionRes);

  if (!result.ok) {
    const isAmbiguousSpawn = hasSpawnNonce(result.details);
    if (json) {
      printJsonEnvelope({
        ok: false,
        kind: 'session_actions_execute',
        error: {
          code: result.errorCode,
          ...(result.errorMessage ? { message: result.errorMessage } : {}),
          ...(result.candidates ? { candidates: result.candidates } : {}),
          ...(result.details !== undefined ? { details: result.details } : {}),
          ...(isAmbiguousSpawn && effectiveActionRequestId
            ? { actionRequestId: effectiveActionRequestId }
            : {}),
        },
      });
      return;
    }
    const retryHint = isAmbiguousSpawn && effectiveActionRequestId
      ? ` Retry with --action-request-id ${effectiveActionRequestId} --resume-action-request.`
      : '';
    throw Object.assign(new Error(`${result.errorMessage ?? result.errorCode}${retryHint}`), {
      ...(result.details !== undefined ? { details: result.details } : {}),
    });
  }

  const successPayload = unwrapCliActionSuccessPayload(result.data);

  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'session_actions_execute',
      data: {
        sessionId: sessionTarget.sessionId,
        actionId,
        result: successPayload,
      },
    });
    return;
  }

  console.log(chalk.green('✓'), 'action executed');
  console.log(JSON.stringify({ sessionId: sessionTarget.sessionId, actionId, result: successPayload }, null, 2));
}

import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { getActionContextualDefaults, type ActionId } from '@happier-dev/protocol';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import {
  normalizeActionExecuteResult,
  unwrapCliActionSuccessPayload,
} from '@/cli/commands/session/shared/normalizeActionExecuteResult';

type CliActionExecutorLike = Pick<ReturnType<typeof createCliActionExecutor>, 'execute'>;
type CliActionExecutorParams = Parameters<typeof createCliActionExecutor>[0];

function withResolvedSessionInput(actionId: string, input: unknown, sessionId: string): unknown {
  if (
    getActionContextualDefaults(actionId)?.sessionId !== 'current_session'
    || !input
    || typeof input !== 'object'
    || Array.isArray(input)
  ) {
    return input;
  }
  return { ...input, sessionId };
}

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

export async function cmdSessionActionsExecute(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const [idOrPrefix = '', actionId = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--input-json', '--action-request-id'],
  });
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
      await printJsonEnvelope({ ok: false, kind: 'session_actions_execute', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  const usesApiToken = credentials.credentialProvenance === 'api_token';
  let sessionId: string;
  let executor: CliActionExecutorLike;
  if (usesApiToken) {
    // A PAT intentionally carries no Account E2EE material. Resolve only the
    // selector through the public Action transport, then let the daemon that
    // owns the Session execute the requested Action through that same adapter.
    const patExecutor = createCliActionExecutorFromCredentials({ credentials });
    const sessionTarget = await patExecutor.resolveSessionTarget(idOrPrefix);
    if (!sessionTarget.ok) {
      if (json) {
        await printJsonEnvelope({
          ok: false,
          kind: 'session_actions_execute',
          error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
        });
        return;
      }
      throw new Error(sessionTarget.code);
    }
    sessionId = sessionTarget.sessionId;
    executor = patExecutor;
  } else {
    await ensureCliActionPolicySettings(credentials);

    const sessionTarget = await resolveSessionTransportContext({ credentials, idOrPrefix });
    if (!sessionTarget.ok) {
      if (json) {
        await printJsonEnvelope({
          ok: false,
          kind: 'session_actions_execute',
          error: { code: sessionTarget.code, ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}) },
        });
        return;
      }
      throw new Error(sessionTarget.code);
    }
    sessionId = sessionTarget.sessionId;
    const executorParams: CliActionExecutorParams = sessionTarget.mode === 'plain'
      ? {
          token: credentials.token,
          credentials,
          sessionId,
          ctx: null,
          mode: 'plain',
          rawSession: sessionTarget.rawSession,
        }
      : {
          token: credentials.token,
          credentials,
          sessionId,
          ctx: sessionTarget.ctx,
          mode: 'e2ee',
          rawSession: sessionTarget.rawSession,
        };
    executor = createCliActionExecutor(executorParams);
  }
  const input = withResolvedSessionInput(
    actionId,
    parseInputJsonOrThrow(readFlagValue(argv, '--input-json')),
    sessionId,
  );
  const actionRes = await executor.execute(
    actionId as ActionId,
    input,
    {
      defaultSessionId: sessionId,
      surface: 'cli',
      ...(effectiveActionRequestId ? { actionRequestId: effectiveActionRequestId } : {}),
      ...(resumeActionRequest ? { resumeActionRequest: true } : {}),
    },
  );
  const result = normalizeActionExecuteResult(actionRes);

  if (!result.ok) {
    const isAmbiguousSpawn = hasSpawnNonce(result.details);
    if (json) {
      await printJsonEnvelope({
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
    await printJsonEnvelope({
      ok: true,
      kind: 'session_actions_execute',
      data: {
        sessionId,
        actionId,
        result: successPayload,
      },
    });
    return;
  }

  console.log(chalk.green('✓'), 'action executed');
  await writeJsonStdout({ sessionId, actionId, result: successPayload }, { pretty: true });
}

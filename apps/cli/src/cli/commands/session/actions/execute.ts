import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import type { Credentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readFlagValue } from '@/cli/commands/shared/argvFlags';
import type { ActionId } from '@happier-dev/protocol';

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
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
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
    throw new Error('Usage: happier session actions execute <session-id-or-prefix> <action-id> [--input-json <json>] [--action-request-id <id>] [--resume-action-request] [--json]');
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

  const executor = createCliActionExecutor({
    token: credentials.token,
    credentials,
    sessionId: sessionTarget.sessionId,
    ctx: sessionTarget.ctx,
    mode: sessionTarget.mode,
    rawSession: sessionTarget.rawSession,
  });
  const input = parseInputJsonOrThrow(readFlagValue(argv, '--input-json'));
  const result = await executor.execute(
    actionId as ActionId,
    input,
    {
      defaultSessionId: sessionTarget.sessionId,
      surface: 'cli',
      ...(effectiveActionRequestId ? { actionRequestId: effectiveActionRequestId } : {}),
      ...(resumeActionRequest ? { resumeActionRequest: true } : {}),
    },
  );

  if (!result.ok) {
    const isAmbiguousSpawn = hasSpawnNonce(result.details);
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_actions_execute',
        error: {
          code: result.errorCode,
          ...(result.error ? { message: result.error } : {}),
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
    throw Object.assign(new Error(`${result.error}${retryHint}`), {
      ...(result.details !== undefined ? { details: result.details } : {}),
    });
  }

  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'session_actions_execute',
      data: {
        sessionId: sessionTarget.sessionId,
        actionId,
        result: result.result,
      },
    });
    return;
  }

  console.log(chalk.green('✓'), 'action executed');
  await writeJsonStdout({ sessionId: sessionTarget.sessionId, actionId, result: result.result }, { pretty: true });
}

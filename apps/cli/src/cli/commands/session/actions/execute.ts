import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { hasFlag, readCommandPositionals, readFlagValue, readRawFlagValue } from '@/cli/commands/shared/argvFlags';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { assertSessionCommandArguments } from '@/cli/commands/session/shared/assertSessionCommandArguments';
import { ExternalActionRequestIdV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionContextualDefaults } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol';
import { ensureCliActionPolicySettings } from '@/session/actions/ensureCliActionPolicySettings';
import { configuration } from '@/configuration';
import {
  resolveServerHttpBaseUrl,
  runWithServerHttpBaseUrl,
} from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { cmd, fail } from '@happier-dev/cli-common/output';

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

function readFailureCandidates(details: unknown): readonly string[] | undefined {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const candidates = (details as Readonly<Record<string, unknown>>).candidates;
  if (!Array.isArray(candidates) || !candidates.every((candidate) => typeof candidate === 'string')) {
    return undefined;
  }
  return candidates;
}

export async function cmdSessionActionsExecute(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null> }>,
): Promise<void> {
  // Workflow flags and the Action's whole-input JSON are the complete grammar;
  // anything else fails here, before credentials or Session resolution.
  assertSessionCommandArguments(argv, {
    usage: `Usage: ${SESSION_HELP_LINES.actionsExecute}`,
    startIndex: 2,
    booleanFlags: ['--json', '--resume-action-request'],
    valueFlags: ['--input-json', '--action-request-id'],
    maxPositionals: 2,
  });
  const json = wantsJson(argv);
  const [idOrPrefix = '', actionId = ''] = readCommandPositionals(argv, {
    startIndex: 2,
    valueFlags: ['--input-json', '--action-request-id'],
  });
  const actionRequestId = readRawFlagValue(argv, '--action-request-id') ?? '';
  if (actionRequestId && !ExternalActionRequestIdV1Schema.safeParse(actionRequestId).success) {
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
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exit(1);
  }

  // Pin identity and transport together for the complete command. Session
  // selectors and current-access projection negotiation must never drift to a
  // subsequently selected ambient Home while this invocation is in flight.
  const serverId = configuration.activeServerId;
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const usesApiToken = credentials.credentialProvenance === 'api_token';
  let sessionId: string;
  let executor: CliActionExecutorLike;
  if (usesApiToken) {
    // A PAT intentionally carries no Account E2EE material. Resolve only the
    // selector through the public Action transport, then let the daemon that
    // owns the Session execute the requested Action through that same adapter.
    const patExecutor = createCliActionExecutorFromCredentials({
      credentials,
      serverId,
      serverApiUrl: serverHttpBaseUrl,
    });
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
    await runWithServerHttpBaseUrl(
      serverHttpBaseUrl,
      async () => await ensureCliActionPolicySettings(credentials),
    );

    const serverFeaturesSnapshot = await fetchServerFeaturesSnapshot({
      serverUrl: serverHttpBaseUrl,
      token: credentials.token,
    });
    const sessionTarget = await runWithServerHttpBaseUrl(
      serverHttpBaseUrl,
      async () => await resolveSessionTransportContext({
        credentials,
        idOrPrefix,
        serverFeaturesSnapshot,
      }),
    );
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
          serverId,
          serverHttpBaseUrl,
          sessionId,
          ctx: null,
          mode: 'plain',
          rawSession: sessionTarget.rawSession,
        }
      : {
          token: credentials.token,
          credentials,
          serverId,
          serverHttpBaseUrl,
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
  if (!actionRes.ok) {
    const candidates = readFailureCandidates(actionRes.details);
    const isAmbiguousSpawn = hasSpawnNonce(actionRes.details);
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_actions_execute',
        error: {
          code: actionRes.errorCode,
          message: actionRes.error,
          ...(candidates ? { candidates } : {}),
          ...(actionRes.details !== undefined ? { details: actionRes.details } : {}),
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
    throw Object.assign(new Error(`${actionRes.error}${retryHint}`), {
      ...(actionRes.details !== undefined ? { details: actionRes.details } : {}),
    });
  }

  const successPayload = actionRes.result;

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

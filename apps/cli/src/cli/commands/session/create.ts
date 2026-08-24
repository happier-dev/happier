import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { SessionSpawnNewResultV1Schema, type SessionSpawnNewInputV2 } from '@happier-dev/protocol';

import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { parseSessionCreateSpawnOptions } from './create/parseSessionCreateSpawnOptions';
import { normalizeSessionCreateSpawnRequest } from './create/normalizeSessionCreateSpawnRequest';
import {
  executeSessionWaitAction,
  printSessionWaitSuccess,
  resolveSessionWaitTimeoutSeconds,
} from './wait';
import { resolveConnectedServicesLaunchAuthWithInventory } from '@/cli/connectedServicesLaunchAuth';
import { resolveCatalogAgentConnectedServiceIds } from '@/agent/catalog/registry';

const SESSION_CREATE_USAGE = `Usage: ${SESSION_HELP_LINES.create}`;

function hasSpawnNonce(details: unknown): boolean {
  return Boolean(details && typeof details === 'object'
    && (details as { accepted?: unknown }).accepted === true
    && typeof (details as { spawnNonce?: unknown }).spawnNonce === 'string'
    && (details as { spawnNonce: string }).spawnNonce.trim());
}

async function resolveSessionCreateConnectedServices(params: Readonly<{
  executor: ReturnType<typeof createCliActionExecutorFromCredentials>;
  parsedOptions: ReturnType<typeof parseSessionCreateSpawnOptions>;
  input: SessionSpawnNewInputV2;
  agentId: string;
}>): Promise<SessionSpawnNewInputV2> {
  const intent = params.parsedOptions.connectedServicesAuthIntent;
  if (!intent || intent.kind === 'default') return params.input;

  const supportedServiceIds = resolveCatalogAgentConnectedServiceIds(params.agentId);
  if (supportedServiceIds.length === 0) {
    throw new Error('connected_service_auth_unsupported');
  }
  const connectedServices = await resolveConnectedServicesLaunchAuthWithInventory({
    intent,
    supportedServiceIds,
    listInventory: async () => {
      const inventoryResult = normalizeActionExecuteResult(await params.executor.execute(
        'sessions.spawn.connected_services.list',
        { agentId: params.agentId, includeUnavailable: false },
        { surface: 'cli', defaultSessionId: null },
      ));
      if (!inventoryResult.ok) {
        throw new Error(inventoryResult.errorMessage ?? inventoryResult.errorCode);
      }
      return inventoryResult.data ?? null;
    },
  });
  return connectedServices
    ? { ...params.input, connectedServices }
    : params.input;
}

export async function cmdSessionCreate(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<StoredCredentials | null>; signal?: AbortSignal }>,
): Promise<void> {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    throw new Error(SESSION_CREATE_USAGE);
  }
  const waitAfterCreation = hasFlag(argv, '--wait');
  const followAfterCreation = hasFlag(argv, '--follow');
  const jsonl = hasFlag(argv, '--jsonl');
  if (waitAfterCreation && followAfterCreation) {
    throw new Error('Choose only one of --wait or --follow.');
  }
  if (followAfterCreation && hasFlag(argv, '--json')) {
    throw new Error('--follow requires --jsonl instead of --json.');
  }
  if (jsonl && !followAfterCreation) {
    throw new Error('--jsonl requires --follow.');
  }
  const parsedOptions = parseSessionCreateSpawnOptions(argv);
  const { json, backendRaw, backendTargetKey, spawnAttemptId, resumeSpawnAttempt } = parsedOptions;
  const structuredCreationOutput = json || jsonl;
  const effectiveSpawnAttemptId = spawnAttemptId ?? randomUUID();

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (structuredCreationOutput) {
      await printJsonEnvelope({ ok: false, kind: 'session_create', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  if (backendRaw && !backendTargetKey) {
    throw new Error(SESSION_CREATE_USAGE);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  let actionRes;
  try {
    const normalizedSpawn = await normalizeSessionCreateSpawnRequest(parsedOptions.spawnRequest);
    const resolvedActionInput = await resolveSessionCreateConnectedServices({
      executor,
      parsedOptions,
      input: normalizedSpawn.input,
      agentId: normalizedSpawn.agentId,
    });
    actionRes = await executor.execute(
      'session.spawn_new',
      resolvedActionInput,
      {
        surface: 'cli',
        defaultSessionId: null,
        actionRequestId: effectiveSpawnAttemptId,
        ...(resumeSpawnAttempt ? { resumeActionRequest: true } : {}),
      },
    );
  } catch (error) {
    const mapped = mapUnknownErrorToControlError(error);
    if (structuredCreationOutput) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code: mapped.code,
          ...(mapped.message ? { message: mapped.message } : {}),
          ...(((error as { details?: unknown })?.details !== undefined) ? { details: (error as { details?: unknown }).details } : {}),
        },
      });
      return;
    }
    throw Object.assign(new Error(mapped.message ?? (error instanceof Error ? error.message : 'Failed to create session')), {
      code: mapped.code,
    });
  }

  const result = normalizeActionExecuteResult(actionRes);
  if (!result.ok) {
    const isAmbiguousSpawn = hasSpawnNonce(result.details);
    if (structuredCreationOutput) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code: result.errorCode,
          ...(result.errorMessage ? { message: result.errorMessage } : {}),
          ...(result.candidates ? { candidates: result.candidates } : {}),
          ...(result.details !== undefined ? { details: result.details } : {}),
          ...(isAmbiguousSpawn ? { spawnAttemptId: effectiveSpawnAttemptId } : {}),
        },
      });
      return;
    }
    const retryHint = isAmbiguousSpawn
      ? ` Retry with --spawn-attempt-id ${effectiveSpawnAttemptId} --resume-spawn-attempt.`
      : '';
    throw Object.assign(new Error(`${result.errorMessage ?? result.errorCode}${retryHint}`), {
      code: result.errorCode,
      ...(result.details !== undefined ? { details: result.details } : {}),
    });
  }
  const rawCreated = result.data;
  if (await tryHandleApprovalRequestCreated({
    envelopeKind: 'session_create',
    json: structuredCreationOutput,
    result: rawCreated,
  })) {
    return;
  }
  const parsedCreated = SessionSpawnNewResultV1Schema.safeParse(rawCreated);
  if (!parsedCreated.success) {
    throw new Error('session_create_failed');
  }
  const created = parsedCreated.data;
  if (created.type === 'error') {
    const code = created.code;
    if (structuredCreationOutput) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code,
          ...(created.retryable ? { retryable: true } : {}),
        },
      });
      return;
    }
    throw Object.assign(new Error(code), { code });
  }
  if (created.type === 'pending') {
    if (structuredCreationOutput) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code: 'session_create_pending',
          ...(created.retryWithSameCreationKey ? { retryWithSameCreationKey: true } : {}),
          outcome: created.outcome,
          spawnAttemptId: effectiveSpawnAttemptId,
        },
      });
      return;
    }
    // The spawn attempt id is this creation's stable retry identity. A human
    // run must see it too, or the only safe retry is unavailable to them.
    throw Object.assign(
      new Error(
        `session_create_pending Retry with --spawn-attempt-id ${effectiveSpawnAttemptId} --resume-spawn-attempt.`,
      ),
      { code: 'session_create_pending', spawnAttemptId: effectiveSpawnAttemptId },
    );
  }

  const output = {
    created: created.disposition === 'created',
    session: { id: created.sessionId },
  };

  if (waitAfterCreation) {
    const waitResult = await executeSessionWaitAction({
      executor,
      sessionId: created.sessionId,
      timeoutSeconds: resolveSessionWaitTimeoutSeconds(argv),
    });
    if (!waitResult.ok) {
      if (json) {
        await printJsonEnvelope({
          ok: false,
          kind: 'session_create',
          error: {
            code: waitResult.errorCode,
            ...(waitResult.candidates ? { candidates: waitResult.candidates } : {}),
            ...(waitResult.errorMessage ? { message: waitResult.errorMessage } : {}),
          },
        });
        return;
      }
      throw new Error(waitResult.errorMessage ?? waitResult.errorCode);
    }
    if (await tryHandleApprovalRequestCreated({
      envelopeKind: 'session_create',
      json,
      result: waitResult.data,
    })) {
      return;
    }
    if (json) {
      await printJsonEnvelope({ ok: true, kind: 'session_create', data: output });
      return;
    }
    printSessionWaitSuccess();
    return;
  }
  if (followAfterCreation) {
    if (jsonl) {
      await printJsonEnvelope({ ok: true, kind: 'session_create', data: output });
    }
    const { cmdSessionHistory } = await import('./history');
    await cmdSessionHistory([
      'history',
      created.sessionId,
      '--follow',
      ...(jsonl ? ['--jsonl'] : []),
    ], {
      ...deps,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return;
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_create', data: output });
    return;
  }

  console.log(chalk.green('✓'), 'session created');
  await writeJsonStdout(output, { pretty: true });
}

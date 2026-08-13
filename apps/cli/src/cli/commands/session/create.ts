import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { AGENTS_CORE, resolveAgentIdFromFlavor, type AgentId } from '@happier-dev/agents';
import { parseBackendTargetKey } from '@happier-dev/protocol';

import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import type { Credentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { parseSessionCreateSpawnOptions, SESSION_CREATE_USAGE } from './create/parseSessionCreateSpawnOptions';
import { resolveConnectedServicesLaunchAuthWithInventory } from '@/cli/connectedServicesLaunchAuth';

function hasSpawnNonce(details: unknown): boolean {
  return Boolean(details && typeof details === 'object'
    && (details as { accepted?: unknown }).accepted === true
    && typeof (details as { spawnNonce?: unknown }).spawnNonce === 'string'
    && (details as { spawnNonce: string }).spawnNonce.trim());
}

async function resolveSessionCreateConnectedServices(params: Readonly<{
  executor: ReturnType<typeof createCliActionExecutorFromCredentials>;
  parsedOptions: ReturnType<typeof parseSessionCreateSpawnOptions>;
}>): Promise<Record<string, unknown>> {
  const intent = params.parsedOptions.connectedServicesAuthIntent;
  if (!intent || intent.kind === 'default') return params.parsedOptions.actionInput;

  const targetAgentId = params.parsedOptions.backendTargetKey
    ? (() => {
        const target = parseBackendTargetKey(params.parsedOptions.backendTargetKey!);
        return target.kind === 'builtInAgent' ? target.agentId : null;
      })()
    : null;
  const agentId = resolveAgentIdFromFlavor(
    params.parsedOptions.actionInput.agentId
      ?? targetAgentId
      ?? params.parsedOptions.backendRaw,
  ) as AgentId | null;
  if (!agentId) throw new Error('connected_service_auth_unsupported');
  const supportedServiceIds = AGENTS_CORE[agentId].connectedServices?.supportedServiceIds ?? [];
  const connectedServices = await resolveConnectedServicesLaunchAuthWithInventory({
    intent,
    supportedServiceIds,
    listInventory: async () => {
      const inventoryResult = normalizeActionExecuteResult(await params.executor.execute(
        'sessions.spawn.connected_services.list',
        { agentId, includeUnavailable: false },
        { surface: 'cli', defaultSessionId: null },
      ));
      if (!inventoryResult.ok) {
        throw new Error(inventoryResult.errorMessage ?? inventoryResult.errorCode);
      }
      return inventoryResult.data ?? null;
    },
  });
  return connectedServices
    ? { ...params.parsedOptions.actionInput, connectedServices }
    : params.parsedOptions.actionInput;
}

export async function cmdSessionCreate(
  argv: string[],
  deps: Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>,
): Promise<void> {
  const json = wantsJson(argv);
  const parsedOptions = parseSessionCreateSpawnOptions(argv);
  const spawnAttemptId = parsedOptions.spawnAttemptId ?? randomUUID();
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    throw new Error(`Usage: ${SESSION_CREATE_USAGE}`);
  }

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      await printJsonEnvelope({ ok: false, kind: 'session_create', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
    process.exit(1);
  }

  if (parsedOptions.backendRaw && !parsedOptions.backendTargetKey) {
    throw new Error(`Usage: ${SESSION_CREATE_USAGE}`);
  }

  const executor = createCliActionExecutorFromCredentials({ credentials });
  let actionRes;
  try {
    const actionInput = await resolveSessionCreateConnectedServices({
      executor,
      parsedOptions,
    });
    actionRes = await executor.execute(
      'session.spawn_new',
      actionInput,
      {
        surface: 'cli',
        defaultSessionId: null,
        actionRequestId: spawnAttemptId,
        ...(parsedOptions.resumeSpawnAttempt ? { resumeActionRequest: true } : {}),
      },
    );
  } catch (error) {
    const mapped = mapUnknownErrorToControlError(error);
    if (json) {
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
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code: result.errorCode,
          ...(result.errorMessage ? { message: result.errorMessage } : {}),
          ...(result.candidates ? { candidates: result.candidates } : {}),
          ...(result.details !== undefined ? { details: result.details } : {}),
          ...(isAmbiguousSpawn ? { spawnAttemptId } : {}),
        },
      });
      return;
    }
    const retryHint = isAmbiguousSpawn
      ? ` Retry with --spawn-attempt-id ${spawnAttemptId} --resume-spawn-attempt.`
      : '';
    throw Object.assign(new Error(`${result.errorMessage ?? result.errorCode}${retryHint}`), {
      code: result.errorCode,
      ...(result.details !== undefined ? { details: result.details } : {}),
    });
  }
  const created = result.data as any;
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'session_create', json, result: created })) {
    return;
  }
  if (!created || typeof created !== 'object') {
    throw new Error('session_create_failed');
  }
  if (created.type === 'error') {
    const code = typeof created.errorCode === 'string' ? created.errorCode : 'session_create_failed';
    if (json) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          code,
          ...(typeof created.errorMessage === 'string' && created.errorMessage.trim().length > 0 ? { message: created.errorMessage } : {}),
          ...(typeof created.host === 'string' && created.host.trim().length > 0 ? { host: created.host } : {}),
        },
      });
      return;
    }
    throw Object.assign(new Error(code), { code });
  }

  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'session_create', data: { session: created.session, created: created.created } });
    return;
  }

  console.log(chalk.green('✓'), 'session created');
  await writeJsonStdout({ created: true, session: created.session }, { pretty: true });
}

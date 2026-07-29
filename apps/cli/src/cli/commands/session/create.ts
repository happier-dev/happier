import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { AGENTS_CORE, isAgentId } from '@happier-dev/agents';

import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import type { Credentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { parseSessionCreateSpawnOptions } from './create/parseSessionCreateSpawnOptions';
import { resolveConnectedServicesLaunchAuthWithInventory } from '@/cli/connectedServicesLaunchAuth';

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
}>): Promise<Record<string, unknown>> {
  const intent = params.parsedOptions.connectedServicesAuthIntent;
  if (!intent || intent.kind === 'default') return params.parsedOptions.actionInput;

  const rawAgentId = params.parsedOptions.actionInput.agentId;
  if (!isAgentId(rawAgentId)) throw new Error('connected_service_auth_unsupported');
  const supportedServiceIds = AGENTS_CORE[rawAgentId].connectedServices?.supportedServiceIds ?? [];
  const connectedServices = await resolveConnectedServicesLaunchAuthWithInventory({
    intent,
    supportedServiceIds,
    listInventory: async () => {
      const inventoryResult = normalizeActionExecuteResult(await params.executor.execute(
        'sessions.spawn.connected_services.list',
        { agentId: rawAgentId, includeUnavailable: false },
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
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    throw new Error(SESSION_CREATE_USAGE);
  }
  const parsedOptions = parseSessionCreateSpawnOptions(argv);
  const { json, backendRaw, backendTargetKey, spawnAttemptId, resumeSpawnAttempt, actionInput } = parsedOptions;
  const effectiveSpawnAttemptId = spawnAttemptId ?? randomUUID();

  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    if (json) {
      printJsonEnvelope({ ok: false, kind: 'session_create', error: { code: 'not_authenticated' } });
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
    const resolvedActionInput = await resolveSessionCreateConnectedServices({
      executor,
      parsedOptions,
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
    if (json) {
      printJsonEnvelope({
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
      printJsonEnvelope({
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
  const created = result.data as any;
  if (tryHandleApprovalRequestCreated({ envelopeKind: 'session_create', json, result: created })) {
    return;
  }
  if (!created || typeof created !== 'object') {
    throw new Error('session_create_failed');
  }
  if (created.type === 'error') {
    const code = typeof created.errorCode === 'string' ? created.errorCode : 'session_create_failed';
    if (json) {
      printJsonEnvelope({
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
    printJsonEnvelope({ ok: true, kind: 'session_create', data: { session: created.session, created: created.created } });
    return;
  }

  console.log(chalk.green('✓'), 'session created');
  console.log(JSON.stringify({ created: true, session: created.session }, null, 2));
}

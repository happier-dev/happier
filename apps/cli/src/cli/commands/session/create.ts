import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import {
  readSessionSpawnNewActionResultV1,
  SessionSpawnNewActionResultV1Schema,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { SessionSpawnNewActionAuthoringInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import { resolveConnectedServicesLaunchAuthWithInventory } from '@happier-dev/protocol/connect/resolveConnectedServicesLaunchAuthV1';

import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';

import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import type { StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { normalizeActionExecuteResult, normalizeCliActionThrownError, projectCliActionFailure, throwCliActionFailure } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { SESSION_HELP_LINES } from '@/cli/commands/session/shared/sessionCommandUsage';
import { parseSessionCreateSpawnOptions } from './create/parseSessionCreateSpawnOptions';
import { normalizeSessionCreateSpawnRequest } from './create/normalizeSessionCreateSpawnRequest';
import {
  executeSessionWaitAction,
  printSessionWaitSuccess,
  readSessionWaitTimeoutSecondsFlag,
} from './shared/sessionWaitAction';
import { cmd, fail } from '@happier-dev/cli-common/output';
import { logger } from '@/ui/logger';
import { confirmCliRequesterCredentialDisclosure } from '@/cli/actions/executeCommand';

const SESSION_CREATE_USAGE = `Usage: ${SESSION_HELP_LINES.create}`;

function hasSpawnNonce(details: unknown): boolean {
  return Boolean(details && typeof details === 'object'
    && (details as { accepted?: unknown }).accepted === true
    && typeof (details as { spawnNonce?: unknown }).spawnNonce === 'string'
    && (details as { spawnNonce: string }).spawnNonce.trim());
}

/** API tokens keep the released public Action preflight without borrowing stored Account custody. */
async function resolveApiTokenLaunchAuth(
  executor: ReturnType<typeof createCliActionExecutorFromCredentials>,
  input: SessionSpawnNewActionAuthoringInputV2,
  agentId: string,
): Promise<SessionSpawnNewActionAuthoringInputV2> {
  const { connectedServicesAuthIntent: intent, ...spawnInput } = input;
  if (!intent || intent.kind === 'default') return spawnInput;
  const connectedServices = await resolveConnectedServicesLaunchAuthWithInventory({
    intent,
    supportedServiceIds: resolveCatalogAgentConnectedAccountServiceIds(agentId),
    listInventory: async () => {
      const result = await executor.execute('sessions.spawn.connected_services.list',
        { agentId, includeUnavailable: false, includeDefaults: false }, { surface: 'cli', defaultSessionId: null });
      if (!result.ok) throwCliActionFailure(result);
      return result.result ?? null;
    },
  });
  return connectedServices ? { ...spawnInput, connectedServices } : spawnInput;
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
  const startupStartedAt = performance.now();
  let startupPhaseStartedAt = startupStartedAt;
  const recordStartupPhase = (phase: 'entered' | 'credentials' | 'normalization' | 'spawn_dispatch'): void => {
    const now = performance.now();
    try {
      logger.infoFile('[session-create] Startup phase', { phase, spawnAttemptId: effectiveSpawnAttemptId,
        durationMs: Math.round(now - startupPhaseStartedAt), elapsedMs: Math.round(now - startupStartedAt),
        processUptimeMs: Math.round(process.uptime() * 1000) });
    } catch { /* Diagnostics cannot change Session admission. */ }
    startupPhaseStartedAt = now;
  };
  recordStartupPhase('entered');

  const credentials = await deps.readCredentialsFn();
  recordStartupPhase('credentials');
  if (!credentials) {
    if (structuredCreationOutput) {
      await printJsonEnvelope({ ok: false, kind: 'session_create', error: { code: 'not_authenticated' } });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exit(1);
  }

  if (backendRaw && !backendTargetKey) {
    throw new Error(SESSION_CREATE_USAGE);
  }

  const spawnRequest = { ...parsedOptions.spawnRequest };
  const executor = createCliActionExecutorFromCredentials({
    credentials,
    externalActionClient: true,
    onRequesterSessionCredentialDisclosure: disclosure =>
      confirmCliRequesterCredentialDisclosure(disclosure, { json: structuredCreationOutput, ...(deps.signal ? { signal: deps.signal } : {}) }),
    ...(spawnRequest.machineId ? { machineId: spawnRequest.machineId } : {}),
  });
  if (!spawnRequest.machineId) {
    const machineTarget = await executor.resolveMachineTarget();
    if (!machineTarget.ok) {
      if (structuredCreationOutput) {
        await printJsonEnvelope({
          ok: false,
          kind: 'session_create',
          error: {
            code: machineTarget.code,
            ...(machineTarget.candidates ? { candidates: machineTarget.candidates } : {}),
            ...(machineTarget.details ? { details: machineTarget.details } : {}),
          },
        });
        return;
      }
      throw Object.assign(new Error(machineTarget.code), {
        code: machineTarget.code,
        ...(machineTarget.candidates ? { candidates: machineTarget.candidates } : {}),
        ...(machineTarget.details ? { details: machineTarget.details } : {}),
      });
    }
    spawnRequest.machineId = machineTarget.machineId;
  }
  let actionRes;
  try {
    const normalizedSpawn = await normalizeSessionCreateSpawnRequest(spawnRequest);
    recordStartupPhase('normalization');
    const input = credentials.credentialProvenance === 'api_token'
      ? await resolveApiTokenLaunchAuth(executor, normalizedSpawn.input, normalizedSpawn.agentId ?? DEFAULT_AGENT_ID)
      : normalizedSpawn.input;
    actionRes = await executor.execute(
      'session.spawn_new',
      input,
      {
        surface: 'cli',
        defaultSessionId: null,
        actionRequestId: effectiveSpawnAttemptId,
        ...(resumeSpawnAttempt ? { resumeActionRequest: true } : {}),
      },
    );
    recordStartupPhase('spawn_dispatch');
  } catch (error) {
    const failure = projectCliActionFailure(normalizeCliActionThrownError(error).failure);
    if (structuredCreationOutput) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: failure,
      });
      return;
    }
    const { message, ...failureMetadata } = failure;
    throw Object.assign(new Error(message ?? failure.code), failureMetadata);
  }

  const result = normalizeActionExecuteResult(actionRes);
  if (!result.ok) {
    const isAmbiguousSpawn = hasSpawnNonce(result.details);
    const failure = projectCliActionFailure(result);
    if (structuredCreationOutput) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error: {
          ...failure,
          ...(isAmbiguousSpawn ? { spawnAttemptId: effectiveSpawnAttemptId } : {}),
        },
      });
      return;
    }
    const retryHint = isAmbiguousSpawn
      ? ` Retry with --spawn-attempt-id ${effectiveSpawnAttemptId} --resume-spawn-attempt.`
      : '';
    const { message, ...failureMetadata } = failure;
    throw Object.assign(new Error(`${message ?? failure.code}${retryHint}`), failureMetadata);
  }
  const rawCreated = result.data;
  if (await tryHandleApprovalRequestCreated({
    envelopeKind: 'session_create',
    json: structuredCreationOutput,
    result: rawCreated,
  })) {
    return;
  }
  const parsedCreated = SessionSpawnNewActionResultV1Schema.safeParse(rawCreated);
  if (!parsedCreated.success) {
    throw new Error('session_create_failed');
  }
  const created = readSessionSpawnNewActionResultV1(parsedCreated.data);
  if (created.type === 'error') {
    const { type: _type, code, retryable, ...cause } = created;
    const error = { code, ...(retryable ? { retryable: true } : {}), ...cause };
    if (structuredCreationOutput) {
      await printJsonEnvelope({
        ok: false,
        kind: 'session_create',
        error,
      });
      return;
    }
    const launchError = 'launchError' in created ? created.launchError : undefined;
    const message = code === 'agent_signed_out'
      || (launchError?.code === 'CHILD_EXITED_BEFORE_WEBHOOK' && launchError.childExit)
      ? launchError?.message ?? code : code;
    throw Object.assign(new Error(message), error);
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
          ...(created.operation ? { operation: created.operation } : {}),
          spawnAttemptId: effectiveSpawnAttemptId,
        },
      });
      return;
    }
    // The spawn attempt id is this creation's stable retry identity. A human
    // run must see it too, or the only safe retry is unavailable to them.
    throw Object.assign(
      new Error(
        `session_create_pending Retry with --spawn-attempt-id ${effectiveSpawnAttemptId} --resume-spawn-attempt.${created.operation
          ? ` Operation: ${JSON.stringify(created.operation)}.` : ''}`,
      ),
      { code: 'session_create_pending', spawnAttemptId: effectiveSpawnAttemptId,
        ...(created.operation ? { operation: created.operation } : {}) },
    );
  }

  const output = {
    created: created.disposition === 'created',
    session: { id: created.sessionId },
    initialInput: created.initialInput,
  };

  if (waitAfterCreation) {
    const waitResult = await executeSessionWaitAction({
      executor,
      sessionId: created.sessionId,
      timeoutSeconds: readSessionWaitTimeoutSecondsFlag(argv),
    }).catch(error => ({ ok: false as const, ...normalizeCliActionThrownError(error).failure }));
    if (!waitResult.ok) {
      const failure = projectCliActionFailure(waitResult);
      if (json) {
        await printJsonEnvelope({
          ok: false,
          kind: 'session_create',
          error: failure,
        });
        return;
      }
      const { message, ...failureMetadata } = failure;
      throw Object.assign(new Error(message ?? failure.code), failureMetadata);
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
      initialFollowCursor: '0',
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

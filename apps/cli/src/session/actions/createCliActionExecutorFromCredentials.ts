import { importHistoricalSessionTranscript } from '@/session/transport/http/sessionsHttp';
import { createServerBackedSessionTranscriptStore } from '@/api/session/createServerBackedSessionTranscriptStore';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
  type SessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { resolveCurrentAccountMachineTarget } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { configuration } from '@/configuration';
import { requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import { resolveLiveDaemonExternalActionEndpoint } from '@/daemon/multiDaemon';
import {
  hasStoredSessionCredentialProvenance,
  readSettings,
  type StoredCredentials,
} from '@/persistence';
import {
  isFullSessionId,
  resolveSessionIdOrPrefixFromSessionList,
  type SessionSelectorListPage,
} from '@/session/query/resolveSessionId';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import {
  getActionSpec,
  PublicActionIdSchema,
  SessionListResultSchema,
  projectSessionSpawnNewApiRequest,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ActionExecutorDeps,
  type RuntimeActionExecute,
} from '@happier-dev/protocol';
import { ExternalActionMachineBootstrapListV1Schema } from '@happier-dev/protocol/actions';
import {
  connect,
  HappierActionError,
  type ActionTarget,
  type HappierMachine,
  type PublicActionInputById,
} from '@happier-dev/sdk';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import type {
  ResolveAutomationEventAdoptedDefinitionSetV1,
} from '@/plugins/runtime/automations/automationEventActionExecutor';
import type {
  RevalidatePluginActionCallerImmutableGeneration,
  RevalidatePluginActionCallerMaterialization,
} from '@/plugins/runtime/invocation/services/actionCaller';
import type { ComposerAttachmentSendPreparationRegistryV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import type {
  MachineActionDirectTargetTransport,
  SessionSpawnDirectTargetTransport,
} from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';

type CliActionExecutor = ReturnType<typeof createCliActionExecutor>;

type PatActionTransportPlan =
  | Readonly<{ kind: 'ready'; input: unknown; target?: ActionTarget }>
  | Readonly<{ kind: 'settled'; result: ActionExecuteResult }>;
type PatReadyActionTransportPlan = Extract<PatActionTransportPlan, Readonly<{ kind: 'ready' }>>;

type CliActionSessionTarget =
  | Readonly<{ ok: true; sessionId: string }>
  | Readonly<{ ok: false; code: string; candidates?: readonly string[] }>;
type CliActionMachineTarget =
  | Readonly<{ ok: true; machineId: string }>
  | Readonly<{ ok: false; code: string; candidates?: readonly string[] }>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readStoredSessionMachineList(value: unknown): readonly HappierMachine[] {
  const record = readRecord(value);
  const items = Array.isArray(record?.items) ? record.items : null;
  if (!items) throw new Error('invalid_machine_list_result');
  const parsed = ExternalActionMachineBootstrapListV1Schema.safeParse(items.map((item) => {
    const row = readRecord(item);
    return {
      id: row?.id,
      active: row?.active,
      revokedAt: row?.revokedAt,
      replacedByMachineId: row?.replacedByMachineId,
    };
  }));
  if (!parsed.success) throw new Error('invalid_machine_list_result');
  return Object.freeze(parsed.data.map((row) => Object.freeze(row)));
}

function readPatSessionListPage(value: unknown): SessionSelectorListPage {
  const parsed = SessionListResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_session_list_result');
  return {
    sessions: parsed.data.sessions.map((session) => ({
      id: session.id,
      ...(session.tag ? { tag: session.tag } : {}),
    })),
    nextCursor: parsed.data.nextCursor ?? null,
    hasNext: parsed.data.hasNext === true,
  };
}

function actionResolutionFailure(params: Readonly<{
  code: string;
  candidates?: readonly string[];
}>): ActionExecuteResult {
  // CLI Session commands historically expose selector candidates through their
  // existing nested Action-result normalization. Preserve that command contract
  // while the public Action request has not yet been admitted.
  return {
    ok: true,
    result: {
      ok: false,
      errorCode: params.code,
      error: params.code,
      ...(params.candidates && params.candidates.length > 0 ? { candidates: params.candidates } : {}),
    },
  };
}

function actionFailure(errorCode: string): ActionExecuteResult {
  return { ok: false, errorCode, error: errorCode };
}

function withExactSessionId(input: unknown, sessionId: string): unknown {
  const record = readRecord(input);
  return record ? { ...record, sessionId } : input;
}

async function resolveConfiguredMachineTarget(): Promise<ActionTarget | null> {
  const settings = await readSettings();
  const machineId = readNonEmptyString(settings.machineId);
  return machineId ? { kind: 'machine', machineId } : null;
}

async function resolveDaemonLocalActionMachineId(): Promise<string | null> {
  const endpoint = await resolveLiveDaemonExternalActionEndpoint(configuration.apiServerUrl);
  return endpoint?.machineId ?? null;
}

async function resolvePatMachineTarget(params: Readonly<{
  credentials: StoredCredentials;
  requestedMachineId?: string;
  signal?: AbortSignal;
}>): Promise<CliActionMachineTarget> {
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId();
  if (daemonLocalMachineId) {
    if (params.requestedMachineId !== undefined && params.requestedMachineId !== daemonLocalMachineId) {
      return { ok: false, code: 'target_unavailable' };
    }
    return { ok: true, machineId: daemonLocalMachineId };
  }

  if (params.requestedMachineId === undefined) {
    const configuredTarget = await resolveConfiguredMachineTarget();
    if (configuredTarget?.kind === 'machine') {
      return { ok: true, machineId: configuredTarget.machineId };
    }
  }

  const resolved = await resolveCurrentAccountMachineTarget({
    token: params.credentials.token,
    ...(params.requestedMachineId !== undefined ? { requestedMachineId: params.requestedMachineId } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (resolved.kind === 'selected') return { ok: true, machineId: resolved.target.machineId };
  if (resolved.kind === 'selection_required') {
    return { ok: false, code: 'machine_selection_required', candidates: resolved.candidates.map(({ machineId }) => machineId) };
  }
  return { ok: false, code: resolved.code };
}

async function resolvePatSessionTarget(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  machineId?: string;
  signal?: AbortSignal;
}>): Promise<CliActionSessionTarget> {
  if (isFullSessionId(params.idOrPrefix)) {
    return { ok: true, sessionId: params.idOrPrefix };
  }
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId();
  if (daemonLocalMachineId && params.machineId !== undefined && params.machineId !== daemonLocalMachineId) {
    return { ok: false, code: 'target_unavailable' };
  }
  const machineTarget = daemonLocalMachineId
    ? null
    : await resolvePatMachineTarget({
        credentials: params.credentials,
        ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
  if (machineTarget && !machineTarget.ok) return machineTarget;
  return await resolveSessionIdOrPrefixFromSessionList({
    idOrPrefix: params.idOrPrefix,
    ...(params.signal ? { signal: params.signal } : {}),
    listPage: async ({ limit, cursor, archivedOnly }) => {
      const client = connect({
        endpoint: configuration.apiServerUrl,
        token: params.credentials.token,
      });
      try {
        const result = await client.actions.execute(
          'session.list',
          {
            limit,
            archivedOnly,
            ...(cursor ? { cursor } : {}),
          },
          {
            ...(machineTarget ? { target: { kind: 'machine', machineId: machineTarget.machineId } } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
          },
        );
        return readPatSessionListPage(result);
      } finally {
        await client.close();
      }
    },
  });
}

function combineInvocationSignals(
  invocationSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!invocationSignal) return requestSignal;
  if (!requestSignal || requestSignal === invocationSignal) return invocationSignal;
  return AbortSignal.any([invocationSignal, requestSignal]);
}

async function resolvePatActionTransportPlan(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext | undefined;
  machineId?: string;
  invocationSignal?: AbortSignal;
}>): Promise<PatActionTransportPlan> {
  const publicActionId = PublicActionIdSchema.safeParse(params.actionId);
  if (!publicActionId.success) {
    return { kind: 'settled', result: actionFailure('unsupported') };
  }

  const spec = getActionSpec(publicActionId.data);
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId();
  if (daemonLocalMachineId && params.machineId !== undefined && params.machineId !== daemonLocalMachineId) {
    return { kind: 'settled', result: actionFailure('target_unavailable') };
  }
  if (publicActionId.data === 'session.spawn_new') {
    // The public API owns a distinct spawn-input projection: placement is
    // envelope metadata and daemon-local server identity must never cross this
    // boundary. Do not duplicate its projection in the CLI adapter.
    try {
      const projection = projectSessionSpawnNewApiRequest(params.input);
      return {
        kind: 'ready',
        input: projection.input,
        ...(daemonLocalMachineId ? {} : { target: projection.target }),
      };
    } catch {
      return { kind: 'settled', result: actionFailure('invalid_parameters') };
    }
  }
  const inputSessionId = readNonEmptyString(readRecord(params.input)?.sessionId);
  const signal = combineInvocationSignals(params.invocationSignal, params.context?.signal);
  // The generic Session command resolves its positional selector before
  // invoking this adapter; first-class CLI and MCP Actions carry `sessionId`.
  // In each case the selector remains this adapter's only Session-target input
  // and is resolved to the immutable Session id before crossing the API seam.
  const requestedSessionId = readNonEmptyString(params.context?.defaultSessionId)
    ?? (spec.executionPlacement === 'session' ? inputSessionId : null);
  if (requestedSessionId) {
    const resolved = await resolvePatSessionTarget({
      credentials: params.credentials,
      idOrPrefix: requestedSessionId,
      ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!resolved.ok) {
      return {
        kind: 'settled',
        result: actionResolutionFailure({
          code: resolved.code,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        }),
      };
    }
    return {
      kind: 'ready',
      ...(daemonLocalMachineId
        ? {}
        : params.machineId !== undefined
          ? { target: { kind: 'machine' as const, machineId: params.machineId } }
          : { target: { kind: 'session' as const, sessionId: resolved.sessionId } }),
      input: withExactSessionId(params.input, resolved.sessionId),
    };
  }

  if (spec.executionPlacement === 'session') {
    return { kind: 'settled', result: actionFailure('target_required') };
  }
  if (spec.executionPlacement === 'client') {
    return { kind: 'settled', result: actionFailure('placement_unavailable') };
  }

  if (daemonLocalMachineId) {
    return { kind: 'ready', input: params.input };
  }

  const target = await resolvePatMachineTarget({
    credentials: params.credentials,
    ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
    ...(signal ? { signal } : {}),
  });
  return target.ok
    ? { kind: 'ready', target: { kind: 'machine', machineId: target.machineId }, input: params.input }
    : { kind: 'settled', result: actionResolutionFailure(target) };
}

function createOneShotPatInvocation(runOnce: () => Promise<ActionExecuteResult>) {
  let resultPromise: Promise<ActionExecuteResult> | null = null;
  return Object.freeze({
    run: () => {
      resultPromise ??= Promise.resolve().then(runOnce);
      return resultPromise;
    },
  });
}

async function executePatPublicActionPlan(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  plan: PatReadyActionTransportPlan;
  context: ActionExecutorContext | undefined;
  invocationSignal?: AbortSignal;
}>): Promise<ActionExecuteResult> {
  const publicActionId = PublicActionIdSchema.parse(params.actionId);
  const client = connect({ endpoint: configuration.apiServerUrl, token: params.credentials.token });
  const signal = combineInvocationSignals(params.invocationSignal, params.context?.signal);
  try {
    // `createCliActionExecutor` accepts unknown because it is the canonical
    // Action owner. The daemon ingress validates the public input schema.
    const result = await client.actions.execute(
      publicActionId,
      params.plan.input as PublicActionInputById[typeof publicActionId],
      {
        ...(params.plan.target ? { target: params.plan.target } : {}),
        ...(params.context?.actionRequestId
          ? { requestId: params.context.actionRequestId }
          : {}),
        ...(signal ? { signal } : {}),
      },
    );
    return { ok: true, result };
  } catch (error) {
    if (error instanceof HappierActionError) {
      return {
        ok: false,
        errorCode: error.code,
        error: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function executePatPublicAction(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext | undefined;
  machineId?: string;
  invocationSignal?: AbortSignal;
}>): Promise<ActionExecuteResult> {
  const plan = await resolvePatActionTransportPlan(params);
  if (plan.kind === 'settled') return plan.result;
  return await executePatPublicActionPlan({
    actionId: params.actionId,
    credentials: params.credentials,
    plan,
    context: params.context,
    ...(params.invocationSignal ? { invocationSignal: params.invocationSignal } : {}),
  });
}

function shouldUsePatPublicActionTransport(
  credentials: StoredCredentials,
  _context: ActionExecutorContext | undefined,
): boolean {
  return credentials.credentialProvenance === 'api_token';
}

export function createCliActionExecutorFromCredentials(params: Readonly<{
  credentials: StoredCredentials;
  /** Explicit CLI machine selector for public Action transport. */
  machineId?: string;
  readCredentials?: () => Promise<StoredCredentials | null>;
  readRegisteredPromptAssetAdapters?: () => ReadonlyMap<string, PromptAssetAdapter>;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerImmutableGeneration?: RevalidatePluginActionCallerImmutableGeneration;
  runtimeActionExecute?: RuntimeActionExecute;
  /** Current committed contributed Action declarations for catalog discovery. */
  listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
  /** Daemon-owned execution bypasses its own authenticated control bridge. */
  pluginActionExecutionOwner?: 'daemon_control' | 'current_process';
  /** Root `happier actions` is a signed client of the daemon External Action API. */
  externalActionClient?: true;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  /** The committed plugin-runtime owner for the built-in `action.invoke` Action. */
  invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
  /** Exact daemon replay for API target-action approvals. */
  targetActionApprovalReplay?: ActionExecutorDeps['targetActionApprovalReplay'];
  /** The exact daemon external-session RPC owner for host-stamped API requests. */
  hostExternalSessionAction?: ActionExecutorDeps['hostExternalSessionAction'];
  /** Exact daemon-owned Session spawn transport; never a generic peer forwarder. */
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  /** In-process transport to the current daemon's canonical machine Action handlers. */
  machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
  machineAdmissionTransport?: NonNullable<
    Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
  >;
  /** Late-bound plugin-runtime Composer attachments for declared Session input. */
  resolveComposerAttachmentSendPreparation?: () => ComposerAttachmentSendPreparationRegistryV1 | null;
  sessionLogAccess?: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
  }>;
  /**
   * Daemon composition injects its process-lifetime registry so finite Action
   * requests can release leases retained by earlier requests.
   */
  transcriptFollowLeaseRegistry?: SessionTranscriptFollowLeaseRegistry;
}>): ReturnType<typeof createCliActionExecutor> & Readonly<{
  bindInvocation(signal: AbortSignal): ReturnType<typeof createCliActionExecutor>;
  listAccountMachines(signal?: AbortSignal): Promise<readonly HappierMachine[]>;
  resolveSessionTarget(idOrPrefix: string): Promise<CliActionSessionTarget>;
  resolveMachineTarget(): Promise<CliActionMachineTarget>;
}> {
  const createFollowLeaseRegistry = (): SessionTranscriptFollowLeaseRegistry => (
    params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      maxLeases: 16,
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    })
  );
  const createExecutor = (
    credentials: StoredCredentials,
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
  ): ReturnType<typeof createCliActionExecutor> => {
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
    const cryptoContext = ctx
      ? { mode: 'e2ee' as const, ctx }
      : { mode: 'plain' as const, ctx: null };

    return createCliActionExecutor({
      ...cryptoContext,
      accountServerActionDeps: createAccountServerActionDeps({ token: credentials.token }),
      token: credentials.token,
      credentials,
      ...(params.pluginActionExecutionOwner
        ? { pluginActionExecutionOwner: params.pluginActionExecutionOwner }
        : {}),
      sessionId: 'cli-global',
      ...(params.readRegisteredPromptAssetAdapters
        ? { readRegisteredPromptAssetAdapters: params.readRegisteredPromptAssetAdapters }
        : {}),
      ...(params.resolveAutomationEventAdoptedDefinitionSet
        ? { resolveAutomationEventAdoptedDefinitionSet: params.resolveAutomationEventAdoptedDefinitionSet }
        : {}),
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidatePluginActionCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerImmutableGeneration
        ? { revalidatePluginActionCallerImmutableGeneration: params.revalidatePluginActionCallerImmutableGeneration }
        : {}),
      ...(params.runtimeActionExecute
        ? { runtimeActionExecute: params.runtimeActionExecute }
        : {}),
      ...(params.invokeContributedAction
        ? { invokeContributedAction: params.invokeContributedAction }
        : {}),
      ...(params.targetActionApprovalReplay
        ? { targetActionApprovalReplay: params.targetActionApprovalReplay }
        : {}),
      ...(params.listContributedActionDefinitions
        ? { listContributedActionDefinitions: params.listContributedActionDefinitions }
        : {}),
      ...(params.hostExternalSessionAction
        ? { hostExternalSessionAction: params.hostExternalSessionAction }
        : {}),
      ...(params.sessionSpawnDirectTargetTransport
        ? { sessionSpawnDirectTargetTransport: params.sessionSpawnDirectTargetTransport }
        : {}),
      ...(params.machineActionDirectTargetTransport
        ? { machineActionDirectTargetTransport: params.machineActionDirectTargetTransport }
        : {}),
      ...(params.externalSessionPluginAdmissionOwner
        ? {
            externalSessionPluginAdmissionOwner:
              params.externalSessionPluginAdmissionOwner,
          }
        : {}),
      ...(params.machineAdmissionTransport
        ? { machineAdmissionTransport: params.machineAdmissionTransport }
        : {}),
      ...(params.resolveComposerAttachmentSendPreparation
        ? {
            resolveComposerAttachmentSendPreparation:
              params.resolveComposerAttachmentSendPreparation,
          }
        : {}),
      resolveTranscriptStore: async (sessionId) => {
        const transport = await resolveSessionTransportContext({
          credentials,
          idOrPrefix: sessionId,
        });
        if (!transport.ok) {
          throw Object.assign(new Error(transport.code), { code: transport.code });
        }
        return createServerBackedSessionTranscriptStore({
          token: credentials.token,
          sessionId: transport.sessionId,
          ctx: transport.ctx,
        });
      },
      transcriptFollowLeaseRegistry,
      writeTranscriptItems: async (sessionId: string, items: readonly SessionTranscriptActionItem[]) =>
        await importHistoricalSessionTranscript({
          token: credentials.token,
          sessionId,
          items,
        }),
      ...(params.sessionLogAccess ? { sessionLogAccess: params.sessionLogAccess } : {}),
    });
  };

  const createCredentialRefreshingExecutor = (
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
    invocationSignal?: AbortSignal,
  ): CliActionExecutor => {
    const readCurrentCredentials = async (): Promise<StoredCredentials | null> => params.readCredentials
      ? await params.readCredentials().catch(() => null)
      : params.credentials;
    const fixedExecutor = params.readCredentials
      ? null
      : shouldUsePatPublicActionTransport(params.credentials, undefined)
        ? null
        : createExecutor(params.credentials, transcriptFollowLeaseRegistry);
    return {
      prepare: async (...args) => {
        const credentials = await readCurrentCredentials();
        if (!credentials) {
          return {
            kind: 'settled' as const,
            result: { ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' },
          };
        }
        const [actionId, input, context] = args;
        if (shouldUsePatPublicActionTransport(credentials, context)) {
          const plan = await resolvePatActionTransportPlan({
            actionId,
            input,
            context,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
          });
          if (plan.kind === 'settled') {
            return { kind: 'settled' as const, result: plan.result };
          }
          return {
            kind: 'ready' as const,
            invocation: createOneShotPatInvocation(async () => await executePatPublicActionPlan({
              actionId,
              credentials,
              plan,
              context,
              ...(invocationSignal ? { invocationSignal } : {}),
            })),
          };
        }
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        await ensureCliActionPolicySettings(credentials);
        return await executor.prepare(...args);
      },
      execute: async (...args) => {
        const credentials = await readCurrentCredentials();
        if (!credentials) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        const [actionId, input, context] = args;
        if (params.externalActionClient && hasStoredSessionCredentialProvenance(credentials)) {
          const parsedActionId = PublicActionIdSchema.safeParse(actionId);
          if (!parsedActionId.success) return actionFailure('unsupported');
          const signal = combineInvocationSignals(invocationSignal, context?.signal);
          return await requestDaemonSignedRootActionExecution({
            actionId: parsedActionId.data,
            input,
            ...(params.machineId ? { targetMachineId: params.machineId } : {}),
            ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
          }, { ...(signal ? { signal } : {}) });
        }
        if (shouldUsePatPublicActionTransport(credentials, context)) {
          return await executePatPublicAction({
            actionId,
            input,
            context,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
          });
        }
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        await ensureCliActionPolicySettings(credentials);
        return await executor.execute(...args);
      },
    };
  };

  const executor = createCredentialRefreshingExecutor(createFollowLeaseRegistry());
  const resolveSessionTarget = async (idOrPrefix: string): Promise<CliActionSessionTarget> => {
    const credentials = params.readCredentials
      ? await params.readCredentials().catch(() => null)
      : params.credentials;
    if (!credentials) {
      return { ok: false, code: 'not_authenticated' };
    }
    if (shouldUsePatPublicActionTransport(credentials, { surface: 'cli' })) {
      return await resolvePatSessionTarget({
        credentials,
        idOrPrefix,
        ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
      });
    }
    const resolved = await resolveSessionTransportContext({ credentials, idOrPrefix });
    return resolved.ok
      ? { ok: true, sessionId: resolved.sessionId }
      : {
          ok: false,
          code: resolved.code,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        };
  };
  return Object.freeze({
    ...executor,
    async listAccountMachines(signal?: AbortSignal) {
      const credentials = params.readCredentials
        ? await params.readCredentials().catch(() => null)
        : params.credentials;
      if (!credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
      if (!shouldUsePatPublicActionTransport(credentials, { surface: 'cli' })) {
        const result = await executor.execute(
          'machines.list',
          { limit: 200 },
          { surface: 'cli', ...(signal ? { signal } : {}) },
        );
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        return readStoredSessionMachineList(result.result);
      }
      const client = connect({ endpoint: configuration.apiServerUrl, token: credentials.token });
      try {
        return await client.machines.list({ ...(signal ? { signal } : {}) });
      } finally {
        await client.close();
      }
    },
    resolveSessionTarget,
    async resolveMachineTarget() {
      const credentials = params.readCredentials
        ? await params.readCredentials().catch(() => null)
        : params.credentials;
      if (!credentials) return { ok: false as const, code: 'not_authenticated' };
      return await resolvePatMachineTarget({
        credentials,
        ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
      });
    },
    bindInvocation(signal: AbortSignal) {
      if (params.transcriptFollowLeaseRegistry) {
        return createCredentialRefreshingExecutor(params.transcriptFollowLeaseRegistry, signal);
      }
      const transcriptFollowLeaseRegistry = createFollowLeaseRegistry();
      const dispose = (): void => {
        void transcriptFollowLeaseRegistry.dispose().catch(() => undefined);
      };
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
      return createCredentialRefreshingExecutor(transcriptFollowLeaseRegistry, signal);
    },
  });
}

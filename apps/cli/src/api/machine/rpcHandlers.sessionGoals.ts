import {
  DaemonSessionGoalClearRequestV1Schema,
  DaemonSessionGoalGetRequestV1Schema,
  DaemonSessionGoalSetRequestV1Schema,
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  DaemonSessionSkillCatalogListRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
  DaemonSessionVendorPluginCatalogListRequestV1Schema,
  type ActionExecutorDeps,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  readStoredCredentials,
  type StoredCredentials,
} from '@/persistence';
import {
  createCliActionDeps,
  type CancelConnectedServiceRuntimeAuthRecovery,
  type CancelInactiveSessionUsageLimitRecoveryCheck,
  type ReadInactiveSessionUsageLimitRecovery,
  type ResumeInactiveSessionWhenUsageLimitReady,
  type RetryTemporaryThrottleNow,
  type ScheduleInactiveSessionUsageLimitRecoveryCheck,
} from '@/session/actions/createCliActionDeps';
import {
  resolveSessionTransportContext,
  type ResolveSessionTransportContextResult,
} from '@/session/services/resolveSessionTransportContext';
import {
  resolveUsageLimitRecoveryEnabled,
  usageLimitRecoveryDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';
import {
  buildUsageLimitRecoveryOperationError,
  normalizeUsageLimitRecoveryOperationResult,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';
import {
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter';
import { routeSessionUsageLimitRecoverySwitchAccountNow } from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoverySwitchAccountNow';
import type { DaemonUsageLimitRecoveryFieldMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  readQualifiedConnectedAccountGroupV4,
} from '@/api/client/qualifiedConnectedAccountApi';
import {
  resolveQualifiedConnectedAccountServiceForIngressServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import {
  tryDecryptSessionMetadata,
  type SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import type { RpcHandlerRegistrar } from '../rpc/types';

type RegisterMachineSessionGoalRpcHandlersDeps = Readonly<{
  readStoredCredentials?: () => Promise<StoredCredentials | null>;
  resolveSessionTransportContext?: typeof resolveSessionTransportContext;
  createCliActionDeps?: (
    params: Parameters<typeof createCliActionDeps>[0],
  ) => Pick<
    ActionExecutorDeps,
    | 'sessionGoalGet'
    | 'sessionGoalSet'
    | 'sessionGoalClear'
    | 'sessionUsageLimitWaitResumeEnable'
    | 'sessionUsageLimitWaitResumeCancel'
    | 'sessionUsageLimitCheckNow'
    | 'sessionUsageLimitSwitchAccountNow'
    | 'sessionUsageLimitConsumeResetCredit'
    | 'sessionVendorPluginCatalogList'
    | 'sessionSkillCatalogList'
  >;
  isUsageLimitRecoveryEnabled?: () => Promise<boolean> | boolean;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  readInactiveSessionUsageLimitRecovery?: ReadInactiveSessionUsageLimitRecovery;
  cancelConnectedServiceRuntimeAuthRecovery?: CancelConnectedServiceRuntimeAuthRecovery;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
  currentMachineId?: string;
  stageUsageLimitRecoveryMutation?: (input: Readonly<{
    mutation: DaemonUsageLimitRecoveryFieldMutation;
    rawSession: RawSessionRecord;
  }>) => Promise<void>;
}>;

type GoalOperation = 'get' | 'set' | 'clear';
type CatalogOperation = 'vendorPlugins' | 'skills';
type UsageLimitOperation = 'enable' | 'cancel' | 'checkNow' | 'switchAccountNow' | 'consumeResetCredit';

function invalidParameters(): Readonly<{ ok: false; errorCode: 'invalid_parameters'; error: 'invalid_parameters' }> {
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
}

function notAuthenticated(): Readonly<{ ok: false; errorCode: 'not_authenticated'; error: 'not_authenticated' }> {
  return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
}

function transportError(transport: Extract<ResolveSessionTransportContextResult, { ok: false }>): Readonly<{
  ok: false;
  errorCode: string;
  error: string;
  candidates?: string[];
  sessionId?: string;
}> {
  return {
    ok: false,
    errorCode: transport.code,
    error: transport.code,
    ...(transport.candidates ? { candidates: transport.candidates } : {}),
    ...(transport.sessionId ? { sessionId: transport.sessionId } : {}),
  };
}

async function resolveActionDeps(params: Readonly<{
  sessionId: string;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; actionDeps: ReturnType<NonNullable<RegisterMachineSessionGoalRpcHandlersDeps['createCliActionDeps']>> }>
  | Readonly<{ ok: false; result: unknown }>
> {
  const credentials = await (params.deps?.readStoredCredentials ?? readStoredCredentials)();
  if (!credentials) return { ok: false, result: notAuthenticated() };

  const transport = await (params.deps?.resolveSessionTransportContext ?? resolveSessionTransportContext)({
    credentials,
    idOrPrefix: params.sessionId,
  });
  if (!transport.ok) return { ok: false, result: transportError(transport) };
  const common = {
    token: credentials.token,
    credentials,
    sessionId: transport.sessionId,
    rawSession: transport.rawSession,
  };
  const actionDeps = transport.mode === 'plain'
    ? (params.deps?.createCliActionDeps ?? createCliActionDeps)({
        ...common,
        mode: transport.mode,
        ctx: transport.ctx,
      })
    : (params.deps?.createCliActionDeps ?? createCliActionDeps)({
        ...common,
        mode: transport.mode,
        ctx: transport.ctx,
      });
  return { ok: true, sessionId: transport.sessionId, actionDeps };
}

async function resolveLocalUsageLimitContext(params: Readonly<{
  sessionId: string;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<
  | Readonly<{
      ok: true;
      credentials: StoredCredentials;
      sessionId: string;
      rawSession: RawSessionRecord;
      metadata: Record<string, unknown> | null;
    }> & SessionStoredContentCryptoContext
  | Readonly<{ ok: false; result: unknown }>
> {
  const credentials = await (params.deps?.readStoredCredentials ?? readStoredCredentials)();
  if (!credentials) return { ok: false, result: notAuthenticated() };
  const transport = await (params.deps?.resolveSessionTransportContext ?? resolveSessionTransportContext)({
    credentials,
    idOrPrefix: params.sessionId,
  });
  if (!transport.ok) return { ok: false, result: transportError(transport) };
  if (transport.rawSession.active === true) {
    return {
      ok: false,
      result: buildUsageLimitRecoveryOperationError({
        errorCode: 'session_usage_limit_recovery_control_active_runner_owned',
        status: 'session_unreachable',
        sessionId: transport.sessionId,
      }),
    };
  }
  if (!params.deps?.stageUsageLimitRecoveryMutation) {
    return {
      ok: false,
      result: buildUsageLimitRecoveryOperationError({
        errorCode: 'daemon_usage_limit_recovery_custody_unavailable',
        status: 'unsupported',
        sessionId: transport.sessionId,
      }),
    };
  }
  const metadata = tryDecryptSessionMetadata({
    credentials,
    rawSession: transport.rawSession,
  });
  const base = {
    ok: true,
    credentials,
    sessionId: transport.sessionId,
    rawSession: transport.rawSession,
    metadata,
  } as const;
  return transport.mode === 'plain'
    ? { ...base, mode: transport.mode, ctx: transport.ctx }
    : { ...base, mode: transport.mode, ctx: transport.ctx };
}

function readRecoveryFromUsageLimitResult(result: unknown): SessionUsageLimitRecoveryV1 | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const metadata = (result as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    (metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1,
  );
  return parsed.success ? parsed.data : null;
}

async function isUsageLimitRecoveryEnabled(
  deps?: RegisterMachineSessionGoalRpcHandlersDeps,
): Promise<boolean> {
  if (typeof deps?.isUsageLimitRecoveryEnabled === 'function') {
    return await deps.isUsageLimitRecoveryEnabled();
  }
  return await resolveUsageLimitRecoveryEnabled();
}

async function executeGoalControl(params: Readonly<{
  operation: GoalOperation;
  raw: unknown;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  if (params.operation === 'get') {
    const parsed = DaemonSessionGoalGetRequestV1Schema.safeParse(params.raw);
    if (!parsed.success) return invalidParameters();
    const resolved = await resolveActionDeps({ sessionId: parsed.data.sessionId, deps: params.deps });
    if (!resolved.ok) return resolved.result;
    return resolved.actionDeps.sessionGoalGet
      ? await resolved.actionDeps.sessionGoalGet({ sessionId: resolved.sessionId })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
  }

  if (params.operation === 'clear') {
    const parsed = DaemonSessionGoalClearRequestV1Schema.safeParse(params.raw);
    if (!parsed.success) return invalidParameters();
    const resolved = await resolveActionDeps({ sessionId: parsed.data.sessionId, deps: params.deps });
    if (!resolved.ok) return resolved.result;
    return resolved.actionDeps.sessionGoalClear
      ? await resolved.actionDeps.sessionGoalClear({ sessionId: resolved.sessionId })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
  }

  const parsed = DaemonSessionGoalSetRequestV1Schema.safeParse(params.raw);
  if (!parsed.success) return invalidParameters();
  const resolved = await resolveActionDeps({ sessionId: parsed.data.sessionId, deps: params.deps });
  if (!resolved.ok) return resolved.result;
  if (!resolved.actionDeps.sessionGoalSet) {
    return { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
  }
  return await resolved.actionDeps.sessionGoalSet({
    sessionId: resolved.sessionId,
    ...(typeof parsed.data.objective === 'string' ? { objective: parsed.data.objective } : {}),
    ...(typeof parsed.data.status === 'string' ? { status: parsed.data.status } : {}),
    ...(Object.prototype.hasOwnProperty.call(parsed.data, 'tokenBudget') ? { tokenBudget: parsed.data.tokenBudget } : {}),
  });
}

async function executeCatalogControl(params: Readonly<{
  operation: CatalogOperation;
  raw: unknown;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  const parsed = params.operation === 'vendorPlugins'
    ? DaemonSessionVendorPluginCatalogListRequestV1Schema.safeParse(params.raw)
    : DaemonSessionSkillCatalogListRequestV1Schema.safeParse(params.raw);
  if (!parsed.success) return invalidParameters();

  const resolved = await resolveActionDeps({ sessionId: parsed.data.sessionId, deps: params.deps });
  if (!resolved.ok) return resolved.result;
  const request = {
    sessionId: resolved.sessionId,
    ...(typeof parsed.data.cwd === 'string' && parsed.data.cwd.trim().length > 0
      ? { cwd: parsed.data.cwd.trim() }
      : {}),
  };

  if (params.operation === 'vendorPlugins') {
    return resolved.actionDeps.sessionVendorPluginCatalogList
      ? await resolved.actionDeps.sessionVendorPluginCatalogList(request)
      : { unsupported: true, vendorPlugins: [], diagnostic: 'action_not_supported' };
  }
  return resolved.actionDeps.sessionSkillCatalogList
    ? await resolved.actionDeps.sessionSkillCatalogList(request)
    : { unsupported: true, skills: [], diagnostic: 'action_not_supported' };
}

async function executeUsageLimitControl(params: Readonly<{
  operation: UsageLimitOperation;
  raw: unknown;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  const parsed = params.operation === 'enable'
    ? SessionUsageLimitWaitResumeEnableRequestV1Schema.safeParse(params.raw)
    : params.operation === 'cancel'
      ? SessionUsageLimitWaitResumeCancelRequestV1Schema.safeParse(params.raw)
      : params.operation === 'consumeResetCredit'
        ? SessionUsageLimitConsumeResetCreditRequestV1Schema.safeParse(params.raw)
        : SessionUsageLimitCheckNowRequestV1Schema.safeParse(params.raw);
  if (!parsed.success) {
    return buildUsageLimitRecoveryOperationError({
      errorCode: 'invalid_parameters',
      status: 'malformed_response',
    });
  }
  if (!await isUsageLimitRecoveryEnabled(params.deps)) {
    return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), {
      sessionId: parsed.data.sessionId,
    });
  }
  const resolved = await resolveLocalUsageLimitContext({ sessionId: parsed.data.sessionId, deps: params.deps });
  if (!resolved.ok) {
    return normalizeUsageLimitRecoveryOperationResult(resolved.result, {
      sessionId: parsed.data.sessionId,
    });
  }

  const stageDaemonMutation = params.deps?.stageUsageLimitRecoveryMutation;
  if (!stageDaemonMutation) {
    return buildUsageLimitRecoveryOperationError({
      errorCode: 'daemon_usage_limit_recovery_custody_unavailable',
      status: 'unsupported',
      sessionId: resolved.sessionId,
    });
  }
  const stageUsageLimitRecoveryMutation = async (mutation: DaemonUsageLimitRecoveryFieldMutation) => {
    await stageDaemonMutation({ mutation, rawSession: resolved.rawSession });
  };
  const commonBase = {
    token: resolved.credentials.token,
    credentials: resolved.credentials,
    sessionId: resolved.sessionId,
    rawSession: resolved.rawSession,
    metadata: resolved.metadata,
    currentMachineId: params.deps?.currentMachineId ?? null,
    callLiveSessionRpc: async () => buildUsageLimitRecoveryOperationError({
      errorCode: 'session_usage_limit_recovery_control_active_runner_owned',
      status: 'session_unreachable',
      sessionId: resolved.sessionId,
    }),
    stageUsageLimitRecoveryMutation,
    resumePromptTierSources: {
      accountSettings: getActiveAccountSettingsSnapshot()?.settings ?? null,
      loadGroupPolicy: async (selectedAuth: SessionUsageLimitRecoveryV1['selectedAuth'] | null) => {
        if (selectedAuth?.kind !== 'group') return null;
        const service =
          resolveQualifiedConnectedAccountServiceForIngressServiceId(
            selectedAuth.serviceId,
          );
        if (!service) return null;
        return (await readQualifiedConnectedAccountGroupV4({
          token: resolved.credentials.token,
          group: {
            service,
            groupId: selectedAuth.groupId,
          },
        }))?.policy ?? null;
      },
    },
    ...(params.deps?.retryTemporaryThrottleNow
      ? { retryTemporaryThrottleNow: params.deps.retryTemporaryThrottleNow }
      : {}),
    ...(params.deps?.readInactiveSessionUsageLimitRecovery
      ? { readCurrentUsageLimitRecovery: params.deps.readInactiveSessionUsageLimitRecovery }
      : {}),
  } as const;
  const common = resolved.mode === 'plain'
    ? { ...commonBase, mode: resolved.mode, ctx: resolved.ctx }
    : { ...commonBase, mode: resolved.mode, ctx: resolved.ctx };

  let result: unknown;
  if (params.operation === 'enable') {
    const request = SessionUsageLimitWaitResumeEnableRequestV1Schema.parse(params.raw);
    result = await routeSessionUsageLimitRecoveryWaitResumeEnable({ ...common, request });
  } else if (params.operation === 'cancel') {
    const request = SessionUsageLimitWaitResumeCancelRequestV1Schema.parse(params.raw);
    result = await routeSessionUsageLimitRecoveryWaitResumeCancel({ ...common, request });
    const normalized = normalizeUsageLimitRecoveryOperationResult(result, { sessionId: resolved.sessionId });
    if (
      normalized.ok
      && request.issueFingerprint
      && typeof request.armedAtMs === 'number'
    ) {
      await params.deps?.cancelInactiveSessionUsageLimitRecoveryCheck?.({
        sessionId: resolved.sessionId,
        issueFingerprint: request.issueFingerprint,
        armedAtMs: request.armedAtMs,
        ...(request.runtimeAuthRecoveryAttemptId
          ? { runtimeAuthRecoveryAttemptId: request.runtimeAuthRecoveryAttemptId }
          : {}),
      });
      if (request.runtimeAuthRecoveryAttemptId) {
        await params.deps?.cancelConnectedServiceRuntimeAuthRecovery?.({
          sessionId: resolved.sessionId,
          attemptId: request.runtimeAuthRecoveryAttemptId,
        });
      }
    }
  } else {
    const request = params.operation === 'consumeResetCredit'
      ? SessionUsageLimitConsumeResetCreditRequestV1Schema.parse(params.raw)
      : SessionUsageLimitCheckNowRequestV1Schema.parse(params.raw);
    const effectiveSwitch = params.operation === 'switchAccountNow'
      || ('operation' in request && request.operation === 'switch_account_now');
    result = effectiveSwitch
      ? await routeSessionUsageLimitRecoverySwitchAccountNow({
          sessionId: resolved.sessionId,
          rawSession: resolved.rawSession,
          request: {
            sessionId: resolved.sessionId,
            ...(request.agentId ? { provider: request.agentId } : {}),
            ...(request.resumePromptMode ? { resumePromptMode: request.resumePromptMode } : {}),
          },
        })
      : await routeSessionUsageLimitRecoveryCheckNow({
          ...common,
          request: {
            ...request,
            ...(params.operation === 'consumeResetCredit' ? { operation: 'consume_reset_credit' as const } : {}),
          },
          ...(params.deps?.resumeInactiveSessionWhenUsageLimitReady
            ? { resumeInactiveSessionWhenReady: params.deps.resumeInactiveSessionWhenUsageLimitReady }
            : {}),
        });
  }

  const recovery = readRecoveryFromUsageLimitResult(result);
  if (recovery?.status === 'waiting') {
    await params.deps?.scheduleInactiveSessionUsageLimitRecoveryCheck?.({
      sessionId: resolved.sessionId,
      recovery,
      runCheckNow: async () => await executeUsageLimitControl({
        operation: 'checkNow',
        raw: {
          sessionId: resolved.sessionId,
          ...(recovery.resumePromptMode ? { resumePromptMode: recovery.resumePromptMode } : {}),
        },
        deps: params.deps,
      }),
    });
  }
  return normalizeUsageLimitRecoveryOperationResult(result, { sessionId: resolved.sessionId });
}

export function registerMachineSessionGoalRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): void {
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_GOAL_GET, async (raw: unknown) => (
    await executeGoalControl({ operation: 'get', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_GOAL_SET, async (raw: unknown) => (
    await executeGoalControl({ operation: 'set', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR, async (raw: unknown) => (
    await executeGoalControl({ operation: 'clear', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST, async (raw: unknown) => (
    await executeCatalogControl({ operation: 'vendorPlugins', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST, async (raw: unknown) => (
    await executeCatalogControl({ operation: 'skills', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, async (raw: unknown) => (
    await executeUsageLimitControl({ operation: 'enable', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, async (raw: unknown) => (
    await executeUsageLimitControl({ operation: 'cancel', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, async (raw: unknown) => (
    await executeUsageLimitControl({ operation: 'checkNow', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT, async (raw: unknown) => (
    await executeUsageLimitControl({ operation: 'consumeResetCredit', raw, deps: params.deps })
  ));
}

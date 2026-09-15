import {
  DaemonSessionGoalClearRequestV1Schema,
  DaemonSessionGoalGetRequestV1Schema,
  DaemonSessionGoalSetRequestV1Schema,
  DaemonSessionSkillCatalogListRequestV1Schema,
  DaemonSessionVendorPluginCatalogListRequestV1Schema,
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { readCredentials, type Credentials } from '@/persistence';
import {
  createCliActionDeps,
  type CancelConnectedServiceRuntimeAuthRecovery,
  type CancelInactiveSessionUsageLimitRecoveryCheck,
  type NotifyConnectedServiceRuntimeAuthFailure,
  type ResumeInactiveSessionWhenUsageLimitReady,
  type RetryTemporaryThrottleNow,
  type ReadTemporaryThrottleRecovery,
  type CancelTemporaryThrottleRecovery,
  type ScheduleInactiveSessionUsageLimitRecoveryCheck,
} from '@/session/actions/createCliActionDeps';
import {
  resolveSessionTransportContext,
  type ResolveSessionTransportContextResult,
} from '@/session/services/resolveSessionTransportContext';

import type { RpcHandlerRegistrar } from '../rpc/types';

type RegisterMachineSessionGoalRpcHandlersDeps = Readonly<{
  readCredentials?: () => Promise<Credentials | null>;
  resolveSessionTransportContext?: typeof resolveSessionTransportContext;
  createCliActionDeps?: (
    params: Parameters<typeof createCliActionDeps>[0],
  ) => Pick<
    ActionExecutorDeps,
    | 'sessionGoalGet'
    | 'sessionGoalSet'
    | 'sessionGoalClear'
    | 'sessionVendorPluginCatalogList'
    | 'sessionSkillCatalogList'
    | 'sessionUsageLimitWaitResumeEnable'
    | 'sessionUsageLimitWaitResumeCancel'
    | 'sessionUsageLimitCheckNow'
    | 'sessionUsageLimitSwitchAccountNow'
    | 'sessionUsageLimitConsumeResetCredit'
  >;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  cancelConnectedServiceRuntimeAuthRecovery?: CancelConnectedServiceRuntimeAuthRecovery;
  notifyConnectedServiceRuntimeAuthFailure?: NotifyConnectedServiceRuntimeAuthFailure;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
  readTemporaryThrottleRecovery?: ReadTemporaryThrottleRecovery;
  cancelTemporaryThrottleRecovery?: CancelTemporaryThrottleRecovery;
}>;

type GoalOperation = 'get' | 'set' | 'clear';
type CatalogOperation = 'vendorPlugins' | 'skills';
type UsageLimitRecoveryOperation = 'enable' | 'cancel' | 'checkNow' | 'switchAccountNow' | 'consumeResetCredit';

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

function readRequestSessionId(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as { sessionId?: unknown }).sessionId;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUsageLimitRecoveryMachineResult(params: Readonly<{
  sessionId?: string | null;
  result: unknown;
}>): unknown {
  return normalizeSessionUsageLimitRecoveryOperationResultV1(
    params.result,
    params.sessionId ? { sessionId: params.sessionId } : {},
  );
}

function invalidUsageLimitParameters(raw: unknown): unknown {
  return normalizeUsageLimitRecoveryMachineResult({
    sessionId: readRequestSessionId(raw),
    result: invalidParameters(),
  });
}

async function executeGoalControl(params: Readonly<{
  operation: GoalOperation;
  raw: unknown;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  if (params.operation === 'get') {
    const parsed = DaemonSessionGoalGetRequestV1Schema.safeParse(params.raw);
    if (!parsed.success) return invalidParameters();
    return await executeResolvedGoalControl({
      operation: 'get',
      sessionId: parsed.data.sessionId,
      deps: params.deps,
    });
  }
  if (params.operation === 'clear') {
    const parsed = DaemonSessionGoalClearRequestV1Schema.safeParse(params.raw);
    if (!parsed.success) return invalidParameters();
    return await executeResolvedGoalControl({
      operation: 'clear',
      sessionId: parsed.data.sessionId,
      deps: params.deps,
    });
  }
  const parsed = DaemonSessionGoalSetRequestV1Schema.safeParse(params.raw);
  if (!parsed.success) return invalidParameters();
  return await executeResolvedGoalControl({
    operation: 'set',
    sessionId: parsed.data.sessionId,
    request: parsed.data,
    deps: params.deps,
  });
}

async function executeResolvedGoalControl(params: Readonly<{
  operation: GoalOperation;
  sessionId: string;
  request?: Readonly<{
    objective?: string;
    status?: string;
  }>;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  const credentials = await (params.deps?.readCredentials ?? readCredentials)();
  if (!credentials) return notAuthenticated();

  const transport = await (params.deps?.resolveSessionTransportContext ?? resolveSessionTransportContext)({
    credentials,
    idOrPrefix: params.sessionId,
  });
  if (!transport.ok) return transportError(transport);

  const actionDeps = (params.deps?.createCliActionDeps ?? createCliActionDeps)({
    token: credentials.token,
    credentials,
    sessionId: transport.sessionId,
    rawSession: transport.rawSession,
    ctx: transport.ctx,
    mode: transport.mode,
  });

  if (params.operation === 'get') {
    return actionDeps.sessionGoalGet
      ? await actionDeps.sessionGoalGet({ sessionId: transport.sessionId })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
  }
  if (params.operation === 'clear') {
    return actionDeps.sessionGoalClear
      ? await actionDeps.sessionGoalClear({ sessionId: transport.sessionId })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
  }

  if (!actionDeps.sessionGoalSet) {
    return { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
  }
  const request = params.request ?? {};
  return await actionDeps.sessionGoalSet({
    sessionId: transport.sessionId,
    ...(typeof request.objective === 'string' ? { objective: request.objective } : {}),
    ...(typeof request.status === 'string' ? { status: request.status } : {}),
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
  return await executeResolvedCatalogControl({
    operation: params.operation,
    sessionId: parsed.data.sessionId,
    request: parsed.data,
    deps: params.deps,
  });
}

async function executeResolvedCatalogControl(params: Readonly<{
  operation: CatalogOperation;
  sessionId: string;
  request: Readonly<{ cwd?: string }>;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  const credentials = await (params.deps?.readCredentials ?? readCredentials)();
  if (!credentials) return notAuthenticated();

  const transport = await (params.deps?.resolveSessionTransportContext ?? resolveSessionTransportContext)({
    credentials,
    idOrPrefix: params.sessionId,
  });
  if (!transport.ok) return transportError(transport);

  const actionDeps = (params.deps?.createCliActionDeps ?? createCliActionDeps)({
    token: credentials.token,
    credentials,
    sessionId: transport.sessionId,
    rawSession: transport.rawSession,
    ctx: transport.ctx,
    mode: transport.mode,
  });
  const request = {
    sessionId: transport.sessionId,
    ...(typeof params.request.cwd === 'string' && params.request.cwd.trim().length > 0
      ? { cwd: params.request.cwd.trim() }
      : {}),
  };

  if (params.operation === 'vendorPlugins') {
    return actionDeps.sessionVendorPluginCatalogList
      ? await actionDeps.sessionVendorPluginCatalogList(request)
      : { unsupported: true, vendorPlugins: [], diagnostic: 'action_not_supported' };
  }
  return actionDeps.sessionSkillCatalogList
    ? await actionDeps.sessionSkillCatalogList(request)
    : { unsupported: true, skills: [], diagnostic: 'action_not_supported' };
}

async function executeUsageLimitRecoveryControl(params: Readonly<{
  operation: UsageLimitRecoveryOperation;
  raw: unknown;
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  if (params.operation === 'enable') {
    const parsed = SessionUsageLimitWaitResumeEnableRequestV1Schema.safeParse(params.raw);
    if (!parsed.success) return invalidUsageLimitParameters(params.raw);
    const remember = parsed.data.remember === true || parsed.data.rememberPreference === true;
    return await executeResolvedUsageLimitRecoveryControl({
      operation: 'enable',
      sessionId: parsed.data.sessionId,
      ...(typeof parsed.data.issueFingerprint === 'string' ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
      ...(remember ? { remember: true } : {}),
      ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
      deps: params.deps,
    });
  }
  if (params.operation === 'cancel') {
    const parsed = SessionUsageLimitWaitResumeCancelRequestV1Schema.safeParse(params.raw);
    if (!parsed.success) return invalidUsageLimitParameters(params.raw);
    return await executeResolvedUsageLimitRecoveryControl({
      operation: 'cancel',
      sessionId: parsed.data.sessionId,
      ...(Object.prototype.hasOwnProperty.call(parsed.data, 'issueFingerprint')
        ? { issueFingerprint: parsed.data.issueFingerprint }
        : {}),
      ...(typeof parsed.data.armedAtMs === 'number' ? { armedAtMs: parsed.data.armedAtMs } : {}),
      ...(typeof parsed.data.runtimeAuthRecoveryAttemptId === 'string'
        ? { runtimeAuthRecoveryAttemptId: parsed.data.runtimeAuthRecoveryAttemptId }
        : {}),
      deps: params.deps,
    });
  }

  const requestedOperation = params.raw && typeof params.raw === 'object'
    ? (params.raw as { operation?: unknown }).operation
    : undefined;
  if (requestedOperation === 'consume_reset_credit') {
    const parsed = SessionUsageLimitConsumeResetCreditRequestV1Schema.safeParse(params.raw);
    if (!parsed.success) return invalidUsageLimitParameters(params.raw);
    return await executeResolvedUsageLimitRecoveryControl({
      operation: 'consumeResetCredit',
      sessionId: parsed.data.sessionId,
      ...(typeof parsed.data.provider === 'string' ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
      deps: params.deps,
    });
  }

  const parsed = SessionUsageLimitCheckNowRequestV1Schema.safeParse(params.raw);
  if (!parsed.success) return invalidUsageLimitParameters(params.raw);
  const effectiveOperation = parsed.data.operation === 'switch_account_now'
    ? 'switchAccountNow'
    : params.operation;
  return await executeResolvedUsageLimitRecoveryControl({
    operation: effectiveOperation,
    sessionId: parsed.data.sessionId,
    ...(typeof parsed.data.provider === 'string' ? { provider: parsed.data.provider } : {}),
    ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
    deps: params.deps,
  });
}

async function executeResolvedUsageLimitRecoveryControl(params: Readonly<{
  operation: UsageLimitRecoveryOperation;
  sessionId: string;
  issueFingerprint?: string | null;
  armedAtMs?: number;
  runtimeAuthRecoveryAttemptId?: string;
  remember?: boolean;
  provider?: string;
  resumePromptMode?: 'standard' | 'off' | 'custom';
  deps?: RegisterMachineSessionGoalRpcHandlersDeps;
}>): Promise<unknown> {
  const credentials = await (params.deps?.readCredentials ?? readCredentials)();
  if (!credentials) {
    return normalizeUsageLimitRecoveryMachineResult({
      sessionId: params.sessionId,
      result: notAuthenticated(),
    });
  }

  const transport = await (params.deps?.resolveSessionTransportContext ?? resolveSessionTransportContext)({
    credentials,
    idOrPrefix: params.sessionId,
  });
  if (!transport.ok) {
    return normalizeUsageLimitRecoveryMachineResult({
      sessionId: transport.sessionId ?? params.sessionId,
      result: transportError(transport),
    });
  }

  const actionDeps = (params.deps?.createCliActionDeps ?? createCliActionDeps)({
    token: credentials.token,
    credentials,
    sessionId: transport.sessionId,
    rawSession: transport.rawSession,
    ctx: transport.ctx,
    mode: transport.mode,
    ...(params.deps?.resumeInactiveSessionWhenUsageLimitReady
      ? { resumeInactiveSessionWhenUsageLimitReady: params.deps.resumeInactiveSessionWhenUsageLimitReady }
      : {}),
    ...(params.deps?.scheduleInactiveSessionUsageLimitRecoveryCheck
      ? { scheduleInactiveSessionUsageLimitRecoveryCheck: params.deps.scheduleInactiveSessionUsageLimitRecoveryCheck }
      : {}),
    ...(params.deps?.cancelInactiveSessionUsageLimitRecoveryCheck
      ? { cancelInactiveSessionUsageLimitRecoveryCheck: params.deps.cancelInactiveSessionUsageLimitRecoveryCheck }
      : {}),
    ...(params.deps?.cancelConnectedServiceRuntimeAuthRecovery
      ? { cancelConnectedServiceRuntimeAuthRecovery: params.deps.cancelConnectedServiceRuntimeAuthRecovery }
      : {}),
    ...(params.deps?.notifyConnectedServiceRuntimeAuthFailure
      ? { notifyConnectedServiceRuntimeAuthFailure: params.deps.notifyConnectedServiceRuntimeAuthFailure }
      : {}),
    ...(params.deps?.retryTemporaryThrottleNow
      ? { retryTemporaryThrottleNow: params.deps.retryTemporaryThrottleNow }
      : {}),
    readTemporaryThrottleRecovery: params.deps?.readTemporaryThrottleRecovery,
    cancelTemporaryThrottleRecovery: params.deps?.cancelTemporaryThrottleRecovery,
  });

  if (params.operation === 'enable') {
    const result = actionDeps.sessionUsageLimitWaitResumeEnable
      ? await actionDeps.sessionUsageLimitWaitResumeEnable({
        sessionId: transport.sessionId,
        ...(typeof params.issueFingerprint === 'string' ? { issueFingerprint: params.issueFingerprint } : {}),
        ...(params.remember === true ? { remember: true } : {}),
        ...(params.resumePromptMode ? { resumePromptMode: params.resumePromptMode } : {}),
      })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
    return normalizeUsageLimitRecoveryMachineResult({ sessionId: transport.sessionId, result });
  }
  if (params.operation === 'cancel') {
    const result = actionDeps.sessionUsageLimitWaitResumeCancel
      ? await actionDeps.sessionUsageLimitWaitResumeCancel({
        sessionId: transport.sessionId,
        ...(params.issueFingerprint !== undefined ? { issueFingerprint: params.issueFingerprint } : {}),
        ...(typeof params.armedAtMs === 'number' ? { armedAtMs: params.armedAtMs } : {}),
        ...(typeof params.runtimeAuthRecoveryAttemptId === 'string'
          ? { runtimeAuthRecoveryAttemptId: params.runtimeAuthRecoveryAttemptId }
          : {}),
      })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
    return normalizeUsageLimitRecoveryMachineResult({ sessionId: transport.sessionId, result });
  }
  if (params.operation === 'switchAccountNow') {
    const result = actionDeps.sessionUsageLimitSwitchAccountNow
      ? await actionDeps.sessionUsageLimitSwitchAccountNow({
        sessionId: transport.sessionId,
        ...(typeof params.provider === 'string' ? { provider: params.provider } : {}),
        ...(params.resumePromptMode ? { resumePromptMode: params.resumePromptMode } : {}),
      })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
    return normalizeUsageLimitRecoveryMachineResult({ sessionId: transport.sessionId, result });
  }
  if (params.operation === 'consumeResetCredit') {
    const result = actionDeps.sessionUsageLimitConsumeResetCredit
      ? await actionDeps.sessionUsageLimitConsumeResetCredit({
        sessionId: transport.sessionId,
        ...(typeof params.provider === 'string' ? { provider: params.provider } : {}),
        ...(params.resumePromptMode ? { resumePromptMode: params.resumePromptMode } : {}),
      })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
    return normalizeUsageLimitRecoveryMachineResult({ sessionId: transport.sessionId, result });
  }
  const result = actionDeps.sessionUsageLimitCheckNow
    ? await actionDeps.sessionUsageLimitCheckNow({
      sessionId: transport.sessionId,
      ...(typeof params.provider === 'string' ? { provider: params.provider } : {}),
      ...(params.resumePromptMode ? { resumePromptMode: params.resumePromptMode } : {}),
    })
    : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' };
  return normalizeUsageLimitRecoveryMachineResult({ sessionId: transport.sessionId, result });
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
    await executeUsageLimitRecoveryControl({ operation: 'enable', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, async (raw: unknown) => (
    await executeUsageLimitRecoveryControl({ operation: 'cancel', raw, deps: params.deps })
  ));
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, async (raw: unknown) => (
    await executeUsageLimitRecoveryControl({ operation: 'checkNow', raw, deps: params.deps })
  ));
}

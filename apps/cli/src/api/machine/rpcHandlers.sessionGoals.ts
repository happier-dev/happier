import {
  DaemonSessionGoalClearRequestV1Schema,
  DaemonSessionGoalGetRequestV1Schema,
  DaemonSessionGoalSetRequestV1Schema,
  SessionUsageLimitCheckNowRequestV1Schema,
  DaemonSessionSkillCatalogListRequestV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
  DaemonSessionVendorPluginCatalogListRequestV1Schema,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { readCredentials, type Credentials } from '@/persistence';
import {
  createCliActionDeps,
  type CancelInactiveSessionUsageLimitRecoveryCheck,
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
    | 'sessionUsageLimitWaitResumeEnable'
    | 'sessionUsageLimitWaitResumeCancel'
    | 'sessionUsageLimitCheckNow'
    | 'sessionUsageLimitSwitchAccountNow'
    | 'sessionVendorPluginCatalogList'
    | 'sessionSkillCatalogList'
  >;
  isUsageLimitRecoveryEnabled?: () => Promise<boolean> | boolean;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
}>;

type GoalOperation = 'get' | 'set' | 'clear';
type CatalogOperation = 'vendorPlugins' | 'skills';
type UsageLimitOperation = 'enable' | 'cancel' | 'checkNow' | 'switchAccountNow';

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
  const credentials = await (params.deps?.readCredentials ?? readCredentials)();
  if (!credentials) return { ok: false, result: notAuthenticated() };

  const transport = await (params.deps?.resolveSessionTransportContext ?? resolveSessionTransportContext)({
    credentials,
    idOrPrefix: params.sessionId,
  });
  if (!transport.ok) return { ok: false, result: transportError(transport) };

  const actionDeps = (params.deps?.createCliActionDeps ?? createCliActionDeps)({
    token: credentials.token,
    credentials,
    sessionId: transport.sessionId,
    rawSession: transport.rawSession,
    ctx: transport.ctx,
    mode: transport.mode,
    resumeInactiveSessionWhenUsageLimitReady: params.deps?.resumeInactiveSessionWhenUsageLimitReady,
    scheduleInactiveSessionUsageLimitRecoveryCheck: params.deps?.scheduleInactiveSessionUsageLimitRecoveryCheck,
    cancelInactiveSessionUsageLimitRecoveryCheck: params.deps?.cancelInactiveSessionUsageLimitRecoveryCheck,
    retryTemporaryThrottleNow: params.deps?.retryTemporaryThrottleNow,
  });
  return { ok: true, sessionId: transport.sessionId, actionDeps };
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
  if (params.operation === 'checkNow' || params.operation === 'switchAccountNow') {
    const parsed = SessionUsageLimitCheckNowRequestV1Schema.safeParse(params.raw);
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
    const resolved = await resolveActionDeps({ sessionId: parsed.data.sessionId, deps: params.deps });
    if (!resolved.ok) {
      return normalizeUsageLimitRecoveryOperationResult(resolved.result, {
        sessionId: parsed.data.sessionId,
      });
    }
    const effectiveOperation = parsed.data.operation === 'switch_account_now'
      ? 'switchAccountNow'
      : params.operation;
    if (effectiveOperation === 'switchAccountNow') {
      return normalizeUsageLimitRecoveryOperationResult(resolved.actionDeps.sessionUsageLimitSwitchAccountNow
        ? await resolved.actionDeps.sessionUsageLimitSwitchAccountNow({
          sessionId: resolved.sessionId,
          ...(typeof parsed.data.provider === 'string' ? { provider: parsed.data.provider } : {}),
          ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
        })
        : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' }, {
        sessionId: resolved.sessionId,
      });
    }
    return normalizeUsageLimitRecoveryOperationResult(resolved.actionDeps.sessionUsageLimitCheckNow
      ? await resolved.actionDeps.sessionUsageLimitCheckNow({
        sessionId: resolved.sessionId,
        ...(typeof parsed.data.provider === 'string' ? { provider: parsed.data.provider } : {}),
        ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
      })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' }, {
      sessionId: resolved.sessionId,
    });
  }

  if (params.operation === 'cancel') {
    const parsed = SessionUsageLimitWaitResumeCancelRequestV1Schema.safeParse(params.raw);
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
    const resolved = await resolveActionDeps({ sessionId: parsed.data.sessionId, deps: params.deps });
    if (!resolved.ok) {
      return normalizeUsageLimitRecoveryOperationResult(resolved.result, {
        sessionId: parsed.data.sessionId,
      });
    }
    return normalizeUsageLimitRecoveryOperationResult(resolved.actionDeps.sessionUsageLimitWaitResumeCancel
      ? await resolved.actionDeps.sessionUsageLimitWaitResumeCancel({
        sessionId: resolved.sessionId,
        ...(parsed.data.issueFingerprint !== undefined ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
      })
      : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' }, {
      sessionId: resolved.sessionId,
    });
  }

  const parsed = SessionUsageLimitWaitResumeEnableRequestV1Schema.safeParse(params.raw);
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
  const resolved = await resolveActionDeps({ sessionId: parsed.data.sessionId, deps: params.deps });
  if (!resolved.ok) {
    return normalizeUsageLimitRecoveryOperationResult(resolved.result, {
      sessionId: parsed.data.sessionId,
    });
  }
  return normalizeUsageLimitRecoveryOperationResult(resolved.actionDeps.sessionUsageLimitWaitResumeEnable
    ? await resolved.actionDeps.sessionUsageLimitWaitResumeEnable({
      sessionId: resolved.sessionId,
      ...(parsed.data.issueFingerprint !== undefined ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
      ...((parsed.data.remember === true || parsed.data.rememberPreference === true) ? { remember: true } : {}),
      ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
    })
    : { ok: false, errorCode: 'action_not_supported', error: 'action_not_supported' }, {
    sessionId: resolved.sessionId,
  });
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
}

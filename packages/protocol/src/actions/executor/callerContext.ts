import { lazyZodSchema } from '../../lazyZodSchema.js';
import * as z from '../../zodRuntimePolicy.js';
import { ActionSurfaceSchema, type ActionSurfaces } from '../actionSpecs.js';
import type { ActionExecutorContext } from './types.js';
import { normalizeId } from './inputReading.js';
import { type ActionId } from '../actionIds.js';
import type { ActionExecuteFailure } from './types.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { assertNonEscalatingPermissionMode, resolveEffectivePermissionMode, resolveNearestPermissionModeAtOrBelow, type PermissionEscalationDecision } from '../permissionPrivilege.js';
import { SessionInputCausalPermissionAuthorityV1Schema, SessionInputSourceSessionV1Schema, type SessionInputCausalPermissionAuthorityV1 } from '../../sessions/messages/sessionInputAdmission.js';
import type { ExecutionRunCallOptions } from './executionRuns.js';

const ActionSurfaceKeySchema = lazyZodSchema(() => z.keyof(ActionSurfaceSchema));

export function parseActionSurfaceKey(value: unknown): keyof ActionSurfaces | null {
  const parsed = ActionSurfaceKeySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isAgentCaller(ctx: ActionExecutorContext): boolean {
  return ctx.surface === 'agent' || ctx.actionCaller?.kind === 'session';
}

export function normalizeActionCallerContext(ctx: ActionExecutorContext): ActionExecutorContext | null {
  if (ctx.actionCaller?.kind !== 'session') return ctx;
  // Session identity is host-authenticated provenance. Surface and focus cannot
  // turn that agent into the Account host or select another Session.
  const sessionId = normalizeId(ctx.actionCaller.sessionId);
  return sessionId ? { ...ctx, surface: 'agent', defaultSessionId: sessionId,
    actionCaller: { ...ctx.actionCaller, sessionId } } : null;
}

export function sessionAttestedContextCallerFailure(
  actionId: ActionId, input: unknown, ctx: ActionExecutorContext,
): ActionExecuteFailure | null {
  if (actionId !== 'session.spawn_new' || readRecord(input).attestedContext === undefined) return null;
  if (ctx.surface === 'plugin' && ctx.actionCaller?.kind === 'plugin'
    && normalizeId(ctx.actionCaller.pluginId)) return null;
  return { ok: false, errorCode: 'session_attested_context_forbidden', error: 'session_attested_context_forbidden' };
}

export function createPermissionPolicyResult(
  ctx: ActionExecutorContext,
  decision: Exclude<PermissionEscalationDecision, { ok: true }>,
): ActionExecuteFailure {
  const errorCode = decision.reason;
  return {
    ok: false,
    errorCode,
    error: errorCode,
    details: {
      reason: errorCode,
      surface: ctx.surface ?? null,
      requestedMode: decision.requestedMode,
      requestedOrdinal: decision.requestedOrdinal,
      callerMode: decision.callerMode,
      callerOrdinal: decision.callerOrdinal,
    },
  };
}

type AgentPermissionResolution =
  | Readonly<{
      ok: true;
      permissionDecision: PermissionEscalationDecision | null;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>
  | Readonly<{
      ok: false;
      error: ActionExecuteFailure;
    }>;

export function causalPermissionAuthorityFailure(): ActionExecuteFailure {
  return {
    ok: false,
    errorCode: 'causal_permission_authority_invalid',
    error: 'causal_permission_authority_invalid',
  };
}

function resolveAgentSessionInputSource(
  ctx: ActionExecutorContext,
  authority: SessionInputCausalPermissionAuthorityV1 | undefined,
): Readonly<{
  sourceSessionId: string;
  sourceTurnId: string;
  sourceInputId?: string;
  via: 'action' | 'mcp';
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1;
}> | null {
  if (!isAgentCaller(ctx) || !authority) return null;
  const parsed = SessionInputSourceSessionV1Schema.safeParse(ctx.sessionInputSource);
  if (!parsed.success) return null;
  const contextualSessionId = normalizeId(ctx.defaultSessionId);
  if (!contextualSessionId || parsed.data.sourceSessionId !== contextualSessionId) return null;
  return Object.freeze({
    ...parsed.data,
    causalPermissionAuthority: authority,
  });
}

type AgentEffectivePermissionResolution =
  | Readonly<{
      ok: true;
      effectiveCallerMode: string | null;
      causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
    }>
  | Readonly<{
      ok: false;
      error: ActionExecuteFailure;
    }>;

/**
 * Resolves the one host-stamped permission mode that an Agent Action may use.
 * When an active-turn authority is present, the immutable admitted ceiling is
 * intersected with the mutable current Session mode before any Action-specific
 * permission decision. A present but invalid authority never falls back to the
 * mutable mode.
 */
export function resolveAgentEffectivePermission(
  ctx: ActionExecutorContext,
  supportedModes?: readonly string[],
): AgentEffectivePermissionResolution {
  if (ctx.actionCaller?.kind === 'workflowRun') {
    const authorization = ctx.actionCaller.authorization;
    const admitted = authorization.admittedPermissionCeiling;
    const admittedDecision = supportedModes
      ? assertNonEscalatingPermissionMode({
          requestedMode: admitted,
          callerMode: admitted,
          supportedModes,
        })
      : null;
    if (admittedDecision && !admittedDecision.ok) {
      return { ok: false, error: causalPermissionAuthorityFailure() };
    }
    const causalPermissionAuthority = SessionInputCausalPermissionAuthorityV1Schema.safeParse({
      kind: 'admittedSessionInputV1',
      admittedPermissionCeiling: admitted,
      ...(authorization.sourceAuthority
        ? {
            sourceAuthority: {
              kind: 'mediatedExternal',
              ...authorization.sourceAuthority,
              admittedPermissionCeiling: admitted,
            },
          }
        : {}),
    });
    if (!causalPermissionAuthority.success) {
      return { ok: false, error: causalPermissionAuthorityFailure() };
    }
    return {
      ok: true,
      effectiveCallerMode: admittedDecision?.normalizedMode ?? admitted,
      causalPermissionAuthority: causalPermissionAuthority.data,
    };
  }
  if (!isAgentCaller(ctx)) {
    return { ok: true, effectiveCallerMode: null };
  }
  if (!Object.prototype.hasOwnProperty.call(ctx, 'causalPermissionAuthority') || ctx.causalPermissionAuthority === null) {
    return { ok: true, effectiveCallerMode: ctx.callerPermissionMode ?? 'default' };
  }

  const parsedAuthority = SessionInputCausalPermissionAuthorityV1Schema.safeParse(
    ctx.causalPermissionAuthority,
  );
  if (!parsedAuthority.success) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  const effective = resolveEffectivePermissionMode({
    currentMode: ctx.callerPermissionMode ?? 'default',
    admittedPermissionCeiling: parsedAuthority.data.admittedPermissionCeiling,
    supportedModes,
  });
  if (!effective.ok) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  return {
    ok: true,
    effectiveCallerMode: effective.effectiveMode,
    causalPermissionAuthority: parsedAuthority.data,
  };
}

export function resolveWorkflowActionContext(
  ctx: ActionExecutorContext,
): Readonly<
  | { ok: true; context: ActionExecutorContext }
  | { ok: false; error: ActionExecuteFailure }
> {
  const effective = resolveAgentEffectivePermission(ctx);
  if (!effective.ok) return effective;
  if (isAgentCaller(ctx) || ctx.actionCaller?.kind === 'workflowRun') {
    if (effective.effectiveCallerMode === null) {
      return { ok: false, error: causalPermissionAuthorityFailure() };
    }
    const { causalPermissionAuthority: _rawCausalPermissionAuthority, ...callerContext } = ctx;
    return {
      ok: true,
      context: Object.freeze({
        ...callerContext,
        callerPermissionMode: effective.effectiveCallerMode,
        ...(effective.causalPermissionAuthority
          ? { causalPermissionAuthority: effective.causalPermissionAuthority }
          : {}),
      }),
    };
  }
  // Non-Agent invocation authorities are authenticated and normalized by the
  // host before Action execution. Workflow input cannot carry this field.
  return {
    ok: true,
    context: Object.freeze({ ...ctx, callerPermissionMode: 'yolo' }),
  };
}

export function assertAgentPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes?: readonly string[],
): AgentPermissionResolution {
  const effective = resolveAgentEffectivePermission(ctx, supportedModes);
  if (!effective.ok) return effective;
  if (effective.effectiveCallerMode === null) {
    return { ok: true, permissionDecision: null };
  }
  const hasRequestedMode = typeof requestedMode === 'string' && requestedMode.trim().length > 0;
  return {
    ok: true,
    permissionDecision: hasRequestedMode
      ? assertNonEscalatingPermissionMode({
          requestedMode,
          callerMode: effective.effectiveCallerMode,
          supportedModes,
        })
      : resolveNearestPermissionModeAtOrBelow({
          requestedMode: undefined,
          callerMode: effective.effectiveCallerMode,
          supportedModes,
        }),
    ...(effective.causalPermissionAuthority
      ? { causalPermissionAuthority: effective.causalPermissionAuthority }
      : {}),
  };
}

export type SessionMessageSendAdmission =
  | Readonly<{
      ok: true;
      permissionModeOverride?: string;
      sessionInputSource?: NonNullable<ReturnType<typeof resolveAgentSessionInputSource>>;
    }>
  | Readonly<{
      ok: false;
      error: ActionExecuteFailure;
    }>;

/**
 * Resolves the host-owned Agent permission and source witness before either a
 * Session message is approved or dispatched. Approval may defer target/runtime
 * currentness, but it must not persist an invocation that already lacks valid
 * causal authority.
 */
export function resolveSessionMessageSendAdmission(
  ctx: ActionExecutorContext,
  permissionOverrideRaw: unknown,
): SessionMessageSendAdmission {
  const permissionResolution = assertAgentPermission(ctx, permissionOverrideRaw);
  if (!permissionResolution.ok) return permissionResolution;
  const permissionDecision = permissionResolution.permissionDecision;
  if (permissionDecision?.ok === false) {
    return { ok: false, error: createPermissionPolicyResult(ctx, permissionDecision) };
  }
  const hasPermissionModeOverride = typeof permissionOverrideRaw === 'string'
    && permissionOverrideRaw.trim().length > 0;
  const permissionModeOverride = hasPermissionModeOverride
    ? permissionDecision?.ok === true
      ? permissionDecision.normalizedMode
      : permissionOverrideRaw
    : undefined;
  const sessionInputSource = resolveAgentSessionInputSource(
    ctx,
    permissionResolution.causalPermissionAuthority,
  );
  if (ctx.actionCaller?.kind === 'workflowRun') {
    if (ctx.workflowSessionInput?.runId !== ctx.actionCaller.runId) {
      return { ok: false, error: causalPermissionAuthorityFailure() };
    }
  } else if (isAgentCaller(ctx) && ctx.actionCaller?.kind !== 'plugin' && !sessionInputSource) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  return {
    ok: true,
    ...(permissionModeOverride ? { permissionModeOverride } : {}),
    ...(sessionInputSource ? { sessionInputSource } : {}),
  };
}

/**
 * A Session-agent MCP call explicitly carries host-stamped active-turn
 * authority. That turn's immutable admission ceiling constrains the current
 * mutable Session mode before an execution run is started. Other Action
 * callers retain their existing paths; Action input cannot synthesize this
 * context field.
 */
export function resolveAgentExecutionRunPermission(
  ctx: ActionExecutorContext,
  requestedMode: unknown,
  supportedModes: readonly string[],
): AgentPermissionResolution {
  const resolved = assertAgentPermission(ctx, requestedMode, supportedModes);
  // The shared Session privilege check admits no-tools below the caller's
  // ceiling, but its read-only alias must not grant the Run read tools.
  return requestedMode === 'no_tools' && resolved.ok && resolved.permissionDecision?.ok
    ? { ...resolved, permissionDecision: { ...resolved.permissionDecision, requestedMode } }
    : resolved;
}

export function bindAgentExistingExecutionRunAuthority(
  ctx: ActionExecutorContext,
  opts: ExecutionRunCallOptions | undefined,
): Readonly<
  | { ok: true; opts: ExecutionRunCallOptions | undefined }
  | { ok: false; error: ActionExecuteFailure }
> {
  if (!isAgentCaller(ctx) && ctx.actionCaller?.kind !== 'workflowRun') return { ok: true, opts };
  if (
    ctx.actionCaller?.kind !== 'workflowRun'
    && !Object.prototype.hasOwnProperty.call(ctx, 'causalPermissionAuthority')
  ) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  const effective = resolveAgentEffectivePermission(ctx);
  if (!effective.ok) return effective;
  if (!effective.causalPermissionAuthority) {
    return { ok: false, error: causalPermissionAuthorityFailure() };
  }
  return {
    ok: true,
    opts: {
      ...(opts ?? {}),
      causalPermissionAuthority: effective.causalPermissionAuthority,
      ...(effective.effectiveCallerMode === null
        ? {}
        : { effectiveCallerPermissionMode: effective.effectiveCallerMode }),
    },
  };
}

import {
  SessionGoalClearRequestV1Schema,
  SessionConnectedServiceAuthApplyGenerationRequestV1Schema,
  SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
  SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema,
  SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
  SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema,
  SessionGoalGetRequestV1Schema,
  SessionGoalSetRequestV1Schema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  ReviewStartInputSchema,
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitRecoveryOperationResultV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
  SessionSkillCatalogListRequestV1Schema,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type SessionUsageLimitRecoveryV1,
  type SessionUsageLimitRecoveryOperationResultV1,
  type SessionConnectedServiceAuthApplyGenerationRequestV1,
  type SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
  SessionUsageLimitRecoveryV1Schema,
  SessionVendorPluginCatalogListRequestV1Schema,
  SessionWorkStateGetRequestV1Schema,
  SessionWorkStateV1Schema,
  SessionTerminalComposerClearRequestV1Schema,
  SessionTerminalComposerClearResultV1Schema,
  buildUnsupportedSessionTerminalComposerClearResult,
  readDisplayableSessionWorkStateV1,
  type SessionTerminalComposerClearRequestV1,
  type SessionTerminalComposerClearResultV1,
  SessionPendingInputInterruptAndRunRequestV1Schema,
  SessionPendingInputInterruptAndRunResultV1Schema,
  buildUnsupportedSessionPendingInputInterruptAndRunResult,
  type SessionPendingInputInterruptAndRunRequestV1,
  type SessionPendingInputInterruptAndRunResultV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { mergeUsageLimitRecoveryFieldIntoMetadata } from '@/session/usageLimitRecoveryControls/persistUsageLimitRecoveryFieldDurably';
import { hasSameUsageLimitRecoveryIdentity } from '@/session/usageLimitRecoveryControls/mergeUsageLimitRecoveryIntent';
import {
  resolveUsageLimitRecoveryFeatureEnabled,
  usageLimitRecoveryFeatureDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';

import type { Metadata } from '@/api/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

export type SessionRuntimeControls = {
  refreshGoal?: () => unknown;
  setGoal?: (
    objective: string | undefined,
    options?: Readonly<{
      status?: string;
    }>,
  ) => unknown;
  clearGoal?: () => unknown;
  listVendorPlugins?: (options?: Readonly<{ cwd?: string }>) => Promise<unknown>;
  listSkills?: (options?: Readonly<{ cwd?: string }>) => Promise<unknown>;
  startInlineReview?: (input: unknown) => Promise<unknown> | unknown;
  invalidateConnectedServiceAuthTransports?: () => Promise<unknown> | unknown;
  applyConnectedServiceAuthGeneration?: (
    request: Readonly<SessionConnectedServiceAuthApplyGenerationRequestV1>,
  ) => Promise<unknown> | unknown;
  readConnectedServiceRuntimeIdentity?: (
    request: Readonly<SessionConnectedServiceAuthReadRuntimeIdentityRequestV1>,
  ) => Promise<unknown> | unknown;
  wakePendingMaterialization?: () => void;
  isPendingMaterializationAvailable?: () => boolean;
  enableUsageLimitWaitResume?: (request: Readonly<{
    sessionId: string;
    issueFingerprint?: string;
    rememberPreference?: boolean;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>) => Promise<unknown> | unknown;
  cancelUsageLimitWaitResume?: (request: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    armedAtMs: number;
  }>) => Promise<unknown> | unknown;
  checkUsageLimitRecoveryNow?: (request: Readonly<{
    sessionId: string;
    provider?: string;
    operation?: 'check_now' | 'switch_account_now' | 'consume_reset_credit';
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>) => Promise<unknown> | unknown;
  clearTerminalComposer?: (
    request: Readonly<SessionTerminalComposerClearRequestV1>,
  ) => Promise<SessionTerminalComposerClearResultV1 | unknown> | SessionTerminalComposerClearResultV1 | unknown;
  interruptPendingInputAndRun?: (
    request: Readonly<SessionPendingInputInterruptAndRunRequestV1>,
  ) => Promise<SessionPendingInputInterruptAndRunResultV1 | unknown> | SessionPendingInputInterruptAndRunResultV1 | unknown;
  handleUserMessage?: (
    request: Readonly<{
      text: string;
      localId?: string;
      meta: Record<string, unknown>;
    }>,
  ) => Promise<Readonly<{ handled: false }> | Readonly<{ handled: true; result: unknown }> | void>
    | Readonly<{ handled: false }>
    | Readonly<{ handled: true; result: unknown }>
    | void;
};

function unsupported(method: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return {
    ok: false,
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  };
}

function invalidInput(): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
}

function invalidRuntimeControlResult(): Readonly<{ ok: false; errorCode: string; error: string }> {
  return {
    ok: false,
    errorCode: 'invalid_runtime_control_result',
    error: 'invalid_runtime_control_result',
  };
}

function readWorkState(getSessionMetadata?: (() => Metadata | null) | null): unknown {
  const metadata = getSessionMetadata?.();
  if (!metadata || typeof metadata !== 'object') return null;
  return readDisplayableSessionWorkStateV1((metadata as Record<string, unknown>).sessionWorkStateV1);
}

function readRuntimeControlErrorResult(value: unknown): Readonly<{ ok: false; errorCode: string; error: string }> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== 'string') return null;
  return {
    ok: false,
    error: record.error,
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : 'runtime_control_failed',
  };
}

function readCurrentGoalObjective(getSessionMetadata?: (() => Metadata | null) | null): string | null {
  const workState = readWorkState(getSessionMetadata);
  const parsed = SessionWorkStateV1Schema.safeParse(workState);
  if (!parsed.success) return null;

  const primary = parsed.data.primaryItemId
    ? parsed.data.items.find((item) => item.id === parsed.data.primaryItemId && item.kind === 'goal')
    : null;
  const goal = primary ?? parsed.data.items.find((item) => item.kind === 'goal') ?? null;
  const title = goal?.title.trim();
  return title ? title : null;
}

function readCatalogRuntimeOptions(rawCwd: string | undefined): Readonly<{ cwd?: string }> {
  const cwd = typeof rawCwd === 'string' ? rawCwd.trim() : '';
  return cwd.length > 0 ? { cwd } : {};
}

function buildUsageLimitRecoveryIntent(input: Readonly<{
  issueFingerprint?: string;
  nowMs: number;
}>): SessionUsageLimitRecoveryV1 {
  return SessionUsageLimitRecoveryV1Schema.parse({
    v: 1,
    status: 'waiting',
    issueFingerprint: input.issueFingerprint ?? `usage-limit:${input.nowMs}`,
    armedAtMs: input.nowMs,
    resetAtMs: null,
    nextCheckAtMs: null,
    attemptCount: 0,
    maxAttempts: 0,
    lastProbeError: null,
    resumePromptMode: 'standard',
    selectedAuth: { kind: 'native' },
  });
}

function readCurrentUsageLimitRecoveryIntent(metadata: Metadata | null | undefined): unknown {
  return metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>)[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]
    : undefined;
}

function writeUsageLimitRecoveryIntent(
  metadata: Metadata,
  intent: unknown,
): Metadata {
  const next: Record<string, unknown> = {
    ...metadata,
  };
  next[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY] = intent;
  return next as Metadata;
}

function normalizeUsageLimitRecoveryOperationResult(
  result: unknown,
  sessionId: string,
): SessionUsageLimitRecoveryOperationResultV1 {
  const normalized = normalizeSessionUsageLimitRecoveryOperationResultV1(result, { sessionId });
  if (normalized.ok) {
    return SessionUsageLimitRecoveryOperationResultV1Schema.parse(normalized);
  }
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse({
    ...normalized,
    sessionId: normalized.sessionId ?? sessionId,
  });
}

function normalizeTerminalComposerClearResult(
  result: unknown,
  sessionId: string,
): SessionTerminalComposerClearResultV1 {
  const parsed = SessionTerminalComposerClearResultV1Schema.safeParse(result);
  if (parsed.success) {
    return parsed.data.sessionId
      ? parsed.data
      : SessionTerminalComposerClearResultV1Schema.parse({ ...parsed.data, sessionId });
  }
  return SessionTerminalComposerClearResultV1Schema.parse({
    ok: false,
    status: 'clear_failed',
    sessionId,
    errorCode: 'invalid_runtime_control_result',
    error: 'invalid_runtime_control_result',
  });
}

function normalizePendingInputInterruptAndRunResult(
  result: unknown,
  request: SessionPendingInputInterruptAndRunRequestV1,
): SessionPendingInputInterruptAndRunResultV1 {
  const parsed = SessionPendingInputInterruptAndRunResultV1Schema.safeParse(result);
  if (parsed.success) {
    return SessionPendingInputInterruptAndRunResultV1Schema.parse({
      ...parsed.data,
      sessionId: parsed.data.sessionId ?? request.sessionId,
      localId: parsed.data.localId ?? request.localId,
    });
  }
  return SessionPendingInputInterruptAndRunResultV1Schema.parse({
    ok: false,
    status: 'interrupt_failed',
    sessionId: request.sessionId,
    localId: request.localId,
    errorCode: 'invalid_runtime_control_result',
    error: 'invalid_runtime_control_result',
  });
}

export function registerSessionControlHandlers(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    getSessionMetadata?: (() => Metadata | null) | null;
    updateSessionMetadata?: ((handler: (metadata: Metadata) => Metadata) => Promise<void> | void) | null;
    updateSessionMetadataWithResult?: (<TResult>(handler: (metadata: Metadata) => Readonly<{
      metadata: Metadata;
      result: TResult;
    }>) => Promise<TResult> | TResult) | null;
    sessionRuntimeControls?: SessionRuntimeControls | null;
    /**
     * QAE-1: propagates a SUCCESSFUL user wait-resume cancel to the daemon-side
     * durable recovery owners (runtime-auth recovery + inactive usage-limit
     * stores). Provider runtime controls and the local metadata fallback only
     * clear session-side state; without this propagation a daemon `waiting`
     * intent stays armed and resumes the session involuntarily at reset time.
     * Best-effort: notifier failures never fail the cancel itself.
     */
    notifyUsageLimitWaitResumeCancelled?: ((request: Readonly<{
      sessionId: string;
      attemptId: string;
    }>) => Promise<unknown> | unknown) | null;
  }>,
): void {
  let usageLimitRecoveryFeatureEnabledPromise: Promise<boolean> | null = null;
  const usageLimitRecoveryFeatureEnabled = async (): Promise<boolean> => {
    usageLimitRecoveryFeatureEnabledPromise ??= resolveUsageLimitRecoveryFeatureEnabled();
    return await usageLimitRecoveryFeatureEnabledPromise;
  };

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, async (raw: unknown) => {
    const parsed = SessionWorkStateGetRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_GET, async (raw: unknown) => {
    const parsed = SessionGoalGetRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.refreshGoal !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_GOAL_GET);
    }
    const result = readRuntimeControlErrorResult(await opts.sessionRuntimeControls.refreshGoal());
    if (result) return result;
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_SET, async (raw: unknown) => {
    const parsed = SessionGoalSetRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.setGoal !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_GOAL_SET);
    }
    const objective = parsed.data.objective ?? readCurrentGoalObjective(opts.getSessionMetadata) ?? undefined;
    const result = readRuntimeControlErrorResult(await opts.sessionRuntimeControls.setGoal(objective, {
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
    }));
    if (result) return result;
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR, async (raw: unknown) => {
    const parsed = SessionGoalClearRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.clearGoal !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR);
    }
    const result = readRuntimeControlErrorResult(await opts.sessionRuntimeControls.clearGoal());
    if (result) return result;
    return { workState: readWorkState(opts.getSessionMetadata) };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR, async (raw: unknown) => {
    const parsed = SessionTerminalComposerClearRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.clearTerminalComposer !== 'function') {
      return buildUnsupportedSessionTerminalComposerClearResult(
        parsed.data.sessionId,
        SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR,
      );
    }
    return normalizeTerminalComposerClearResult(
      await opts.sessionRuntimeControls.clearTerminalComposer(parsed.data),
      parsed.data.sessionId,
    );
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN, async (raw: unknown) => {
    const parsed = SessionPendingInputInterruptAndRunRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.interruptPendingInputAndRun !== 'function') {
      return buildUnsupportedSessionPendingInputInterruptAndRunResult(
        parsed.data.sessionId,
        parsed.data.localId,
        SESSION_RPC_METHODS.SESSION_PENDING_INPUT_INTERRUPT_AND_RUN,
      );
    }
    return normalizePendingInputInterruptAndRunResult(
      await opts.sessionRuntimeControls.interruptPendingInputAndRun(parsed.data),
      parsed.data,
    );
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE, async (raw: unknown) => {
    const parsed = ReviewStartInputSchema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.startInlineReview !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE);
    }
    return await opts.sessionRuntimeControls.startInlineReview(raw);
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS, async (raw: unknown) => {
    const parsed = SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.invalidateConnectedServiceAuthTransports !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS);
    }
    const result = readRuntimeControlErrorResult(
      await opts.sessionRuntimeControls.invalidateConnectedServiceAuthTransports(),
    );
    if (result) return result;
    return { ok: true };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION, async (raw: unknown) => {
    const parsed = SessionConnectedServiceAuthApplyGenerationRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.applyConnectedServiceAuthGeneration !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION);
    }
    const result = await opts.sessionRuntimeControls.applyConnectedServiceAuthGeneration(parsed.data);
    const output = SessionConnectedServiceAuthApplyGenerationResponseV1Schema.safeParse(result);
    return output.success ? output.data : invalidRuntimeControlResult();
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY, async (raw: unknown) => {
    const parsed = SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.readConnectedServiceRuntimeIdentity !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY);
    }
    const result = await opts.sessionRuntimeControls.readConnectedServiceRuntimeIdentity(parsed.data);
    const output = SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema.safeParse(result);
    return output.success ? output.data : invalidRuntimeControlResult();
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, async (raw: unknown) => {
    const parsed = SessionUsageLimitWaitResumeEnableRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    const request = {
      sessionId: parsed.data.sessionId,
      ...(typeof parsed.data.issueFingerprint === 'string' ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
      ...((parsed.data.remember === true || parsed.data.rememberPreference === true) ? { rememberPreference: true } : {}),
      ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
    };
    if (!await usageLimitRecoveryFeatureEnabled()) {
      return usageLimitRecoveryFeatureDisabledResult({ sessionId: request.sessionId });
    }
    // F1: without the runtime control there is no runner that can actually wait
    // and resume — fabricating a persisted `waiting` intent with null timing and
    // maxAttempts 0 reported a recovery that could never happen (RD-REC-4).
    // Return the honest typed `unsupported` result instead.
    if (typeof opts.sessionRuntimeControls?.enableUsageLimitWaitResume !== 'function') {
      return normalizeUsageLimitRecoveryOperationResult(
        unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE),
        request.sessionId,
      );
    }
    return normalizeUsageLimitRecoveryOperationResult(
      await opts.sessionRuntimeControls.enableUsageLimitWaitResume(request),
      request.sessionId,
    );
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, async (raw: unknown) => {
    const parsed = SessionUsageLimitWaitResumeCancelRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    const request = {
      sessionId: parsed.data.sessionId,
      ...(Object.prototype.hasOwnProperty.call(parsed.data, 'issueFingerprint')
        ? { issueFingerprint: parsed.data.issueFingerprint }
        : {}),
      ...(typeof parsed.data.armedAtMs === 'number' ? { armedAtMs: parsed.data.armedAtMs } : {}),
      ...(typeof parsed.data.runtimeAuthRecoveryAttemptId === 'string'
        ? { runtimeAuthRecoveryAttemptId: parsed.data.runtimeAuthRecoveryAttemptId }
        : {}),
    };
    if (!await usageLimitRecoveryFeatureEnabled()) {
      return usageLimitRecoveryFeatureDisabledResult({ sessionId: request.sessionId });
    }
    if (typeof request.issueFingerprint !== 'string' || typeof request.armedAtMs !== 'number') {
      return normalizeUsageLimitRecoveryOperationResult({
        ok: false,
        errorCode: 'usage_limit_recovery_attempt_identity_required',
        error: 'usage_limit_recovery_attempt_identity_required',
      }, request.sessionId);
    }
    const exactRequest = {
      sessionId: request.sessionId,
      issueFingerprint: request.issueFingerprint,
      armedAtMs: request.armedAtMs,
      ...(request.runtimeAuthRecoveryAttemptId
        ? { runtimeAuthRecoveryAttemptId: request.runtimeAuthRecoveryAttemptId }
        : {}),
    };
    // QAE-1: every SUCCESSFUL cancel must also reach the daemon recovery owners,
    // regardless of which path (provider runtime control or metadata fallback)
    // handled it — otherwise the daemon's durable waiting intent stays armed and
    // resumes the session involuntarily at the provider reset time.
    const propagateCancelToDaemon = async (
      result: SessionUsageLimitRecoveryOperationResultV1,
    ): Promise<SessionUsageLimitRecoveryOperationResultV1> => {
      if (
        result.ok !== true
        || typeof opts.notifyUsageLimitWaitResumeCancelled !== 'function'
        || typeof exactRequest.runtimeAuthRecoveryAttemptId !== 'string'
      ) {
        return result;
      }
      try {
        await opts.notifyUsageLimitWaitResumeCancelled({
          sessionId: exactRequest.sessionId,
          attemptId: exactRequest.runtimeAuthRecoveryAttemptId,
        });
      } catch {
        // Best-effort: daemon-side cancel propagation must not fail the user cancel.
      }
      return result;
    };
    if (typeof opts.sessionRuntimeControls?.cancelUsageLimitWaitResume !== 'function') {
      if (typeof opts.updateSessionMetadataWithResult !== 'function') {
        return normalizeUsageLimitRecoveryOperationResult(
          unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL),
          request.sessionId,
        );
      }
      const currentMetadata = opts.getSessionMetadata?.() ?? null;
      const current = SessionUsageLimitRecoveryV1Schema.safeParse(
        readCurrentUsageLimitRecoveryIntent(currentMetadata),
      );
      if (
        !current.success
        || !hasSameUsageLimitRecoveryIdentity(current.data, exactRequest)
      ) {
        return normalizeUsageLimitRecoveryOperationResult({
          ok: false,
          errorCode: 'usage_limit_recovery_attempt_superseded',
          error: 'usage_limit_recovery_attempt_superseded',
        }, request.sessionId);
      }
      const settlement = await Promise.resolve(opts.updateSessionMetadataWithResult((metadata) => {
          const latest = SessionUsageLimitRecoveryV1Schema.safeParse(readCurrentUsageLimitRecoveryIntent(metadata));
          if (
            !latest.success
            || !hasSameUsageLimitRecoveryIdentity(latest.data, exactRequest)
          ) return { metadata, result: 'superseded' as const };
          const merged = mergeUsageLimitRecoveryFieldIntoMetadata({
            latestMetadata: metadata,
            baseMetadata: currentMetadata ?? {},
            candidateMetadata: writeUsageLimitRecoveryIntent(metadata, {
              ...latest.data,
              status: 'cancelled',
            }),
            mode: 'cancel',
          }) as Metadata;
          const settled = SessionUsageLimitRecoveryV1Schema.safeParse(readCurrentUsageLimitRecoveryIntent(merged));
          const cancelledExactAttempt = settled.success
            && settled.data.status === 'cancelled'
            && hasSameUsageLimitRecoveryIdentity(settled.data, exactRequest);
          return {
            metadata: merged,
            result: cancelledExactAttempt ? 'cancelled' as const : 'superseded' as const,
          };
        })).catch(() => 'failed' as const);
      if (settlement !== 'cancelled') {
        return normalizeUsageLimitRecoveryOperationResult({
          ok: false,
          errorCode: settlement === 'superseded'
            ? 'usage_limit_recovery_attempt_superseded'
            : 'usage_limit_recovery_cancel_persistence_failed',
          error: settlement === 'superseded'
            ? 'usage_limit_recovery_attempt_superseded'
            : 'usage_limit_recovery_cancel_persistence_failed',
        }, request.sessionId);
      }
      return await propagateCancelToDaemon(normalizeUsageLimitRecoveryOperationResult({
        ok: true,
        status: 'cancelled',
        issueFingerprint: exactRequest.issueFingerprint,
      }, request.sessionId));
    }
    return await propagateCancelToDaemon(normalizeUsageLimitRecoveryOperationResult(
      await opts.sessionRuntimeControls.cancelUsageLimitWaitResume(exactRequest),
      request.sessionId,
    ));
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, async (raw: unknown) => {
    const parsed = SessionUsageLimitCheckNowRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (!await usageLimitRecoveryFeatureEnabled()) {
      return usageLimitRecoveryFeatureDisabledResult({ sessionId: parsed.data.sessionId });
    }
    if (typeof opts.sessionRuntimeControls?.checkUsageLimitRecoveryNow !== 'function') {
      return normalizeUsageLimitRecoveryOperationResult(
        unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW),
        parsed.data.sessionId,
      );
    }
    return normalizeUsageLimitRecoveryOperationResult(await opts.sessionRuntimeControls.checkUsageLimitRecoveryNow({
      sessionId: parsed.data.sessionId,
      ...(typeof parsed.data.provider === 'string' ? { provider: parsed.data.provider } : {}),
      ...(parsed.data.operation ? { operation: parsed.data.operation } : {}),
      ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
    }), parsed.data.sessionId);
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST, async (raw: unknown) => {
    const parsed = SessionVendorPluginCatalogListRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.listVendorPlugins !== 'function') {
      return { unsupported: true, vendorPlugins: [] };
    }
    return await opts.sessionRuntimeControls.listVendorPlugins(readCatalogRuntimeOptions(parsed.data.cwd));
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST, async (raw: unknown) => {
    const parsed = SessionSkillCatalogListRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.listSkills !== 'function') {
      return { unsupported: true, skills: [] };
    }
    return await opts.sessionRuntimeControls.listSkills(readCatalogRuntimeOptions(parsed.data.cwd));
  });
}

import {
  ReviewStartInputSchema,
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  SessionPendingMessageComposerAdmissionPrepareRequestV1Schema,
  SessionPendingMessageComposerAdmissionPrepareResponseV1Schema,
  SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema,
  SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema,
  SessionConnectedServiceAuthApplyGenerationRequestV1Schema,
  SessionConnectedServiceAuthApplyGenerationResponseV1Schema,
  SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema,
  SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema,
  SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema,
  SessionGoalClearRequestV1Schema,
  SessionGoalGetRequestV1Schema,
  SessionGoalSetRequestV1Schema,
  SessionPendingQueueWakeCapabilityRequestV1Schema,
  SessionPendingQueueWakeRequestV1Schema,
  SessionUsageLimitCheckNowRequestV1Schema,
  SessionUsageLimitConsumeResetCreditRequestV1Schema,
  SessionSkillCatalogListRequestV1Schema,
  SessionTerminalComposerClearRequestV1Schema,
  SessionTerminalComposerClearResultV1Schema,
  SessionUsageLimitWaitResumeCancelRequestV1Schema,
  SessionUsageLimitWaitResumeEnableRequestV1Schema,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  SessionVendorPluginCatalogListRequestV1Schema,
  SessionWorkStateGetRequestV1Schema,
  SessionWorkStateV1Schema,
  buildUnsupportedSessionTerminalComposerClearResult,
  SessionPendingInputInterruptAndRunRequestV1Schema,
  SessionPendingInputInterruptAndRunResultV1Schema,
  buildUnsupportedSessionPendingInputInterruptAndRunResult,
  readDisplayableSessionWorkStateV1,
  type SessionConnectedServiceAuthApplyGenerationRequestV1,
  type SessionConnectedServiceAuthReadRuntimeIdentityRequestV1,
  type ComposerContentHandleV1,
  type SessionPendingMessageComposerAdmissionAcceptedRequestV1,
  type SessionPendingMessageComposerAdmissionAbandonedRequestV1,
  SessionMediaMessageMetaV1Schema,
} from '@happier-dev/protocol';
import { readAdmittedHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/runtime';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Metadata } from '@/api/types';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  resolveUsageLimitRecoveryEnabled,
  usageLimitRecoveryDisabledResult,
} from '@/features/usageLimitRecoveryFeatureGate';
import {
  buildUsageLimitRecoveryOperationError,
  buildUsageLimitRecoveryOperationSuccess,
  normalizeUsageLimitRecoveryOperationResult,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryOperationResult';

export type SessionRuntimeControls = {
  refreshGoal?: () => unknown;
  setGoal?: (
    objective: string | undefined,
    options?: Readonly<{
      status?: string;
      tokenBudget?: number | null;
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
  enableUsageLimitWaitResume?: (request: Readonly<{
    sessionId: string;
    issueFingerprint?: string;
    rememberPreference?: boolean;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  }>) => Promise<unknown> | unknown;
  cancelUsageLimitWaitResume?: (request: Readonly<{
    sessionId: string;
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
  }>) => Promise<unknown> | unknown;
  checkUsageLimitRecoveryNow?: (request: Readonly<{
    sessionId: string;
    agentId?: string;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  }>) => Promise<unknown> | unknown;
  consumeUsageLimitResetCredit?: (request: Readonly<{
    sessionId: string;
    agentId?: string;
    issueFingerprint?: string;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
  }>) => Promise<unknown> | unknown;
  clearTerminalComposer?: (request: Readonly<{
    sessionId: string;
    expectedStateAtMs?: number;
  }>) => Promise<unknown> | unknown;
  interruptPendingInputAndRun?: (request: Readonly<{
    sessionId: string;
    localId: string;
    expectedStateAtMs?: number;
  }>) => Promise<unknown> | unknown;
  handleUserMessage?: (
    request: Readonly<{
      text: string;
      localId?: string;
      meta: Record<string, unknown>;
    }>,
  ) => Promise<Readonly<{ handled: false }> | Readonly<{ handled: true; result: unknown }>>
    | Readonly<{ handled: false }>
    | Readonly<{ handled: true; result: unknown }>;
  preparePendingMessageComposerAdmission?: (request: Readonly<{
    localId: string;
    text: string;
    meta: Record<string, unknown>;
  }>) => Promise<Readonly<{
    text: string;
    meta: Record<string, unknown>;
    stagedMediaHandles?: readonly ComposerContentHandleV1[];
    sessionMediaMetadata?: Readonly<{
      key: 'happier' | 'happierMedia';
      envelope: import('@happier-dev/protocol').SessionMediaMessageMetaV1;
    }>;
    sessionMediaCleanup?: Readonly<{
      workingDirectory: string;
      createdWorkspaceRelativePaths: readonly string[];
    }>;
  }>>;
  acceptPendingMessageComposerAdmission?: (
    request: SessionPendingMessageComposerAdmissionAcceptedRequestV1,
  ) => Promise<void> | void;
  abandonPendingMessageComposerAdmission?: (
    request: SessionPendingMessageComposerAdmissionAbandonedRequestV1,
  ) => Promise<void> | void;
};

function unsupported(method: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return {
    ok: false,
    errorCode: 'unsupported_session_runtime_method',
    error: `unsupported_session_runtime_method:${method}`,
  };
}

function pendingWakeUnavailable() {
  return { ok: false as const, error: 'pending_materialization_wake_unavailable' as const, errorCode: 'runtime_upgrade_required' as const };
}

function invalidInput(): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
}

function malformedRuntimeControlResult(): Readonly<{ ok: false; errorCode: string; error: string }> {
  return {
    ok: false,
    errorCode: 'malformed_runtime_control_result',
    error: 'malformed_runtime_control_result',
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

function readUsageLimitWaitResumeEnableRequest(raw: unknown): Readonly<{
  sessionId: string;
  issueFingerprint?: string;
  rememberPreference?: boolean;
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
}> | null {
  const parsed = SessionUsageLimitWaitResumeEnableRequestV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  const rememberPreference = parsed.data.remember === true || parsed.data.rememberPreference === true;
  return {
    sessionId: parsed.data.sessionId,
    ...(typeof parsed.data.issueFingerprint === 'string' ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
    ...(rememberPreference ? { rememberPreference: true } : {}),
    ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
  };
}

function readUsageLimitWaitResumeCancelRequest(raw: unknown): Readonly<{
  sessionId: string;
  issueFingerprint?: string | null;
  armedAtMs?: number;
  runtimeAuthRecoveryAttemptId?: string;
}> | null {
  const parsed = SessionUsageLimitWaitResumeCancelRequestV1Schema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    sessionId: parsed.data.sessionId,
    ...(parsed.data.issueFingerprint !== undefined ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
    ...(typeof parsed.data.armedAtMs === 'number' ? { armedAtMs: parsed.data.armedAtMs } : {}),
    ...(typeof parsed.data.runtimeAuthRecoveryAttemptId === 'string'
      ? { runtimeAuthRecoveryAttemptId: parsed.data.runtimeAuthRecoveryAttemptId }
      : {}),
  };
}

export function registerSessionControlHandlers(
  rpc: RpcHandlerRegistrar,
  opts: Readonly<{
    getSessionMetadata?: (() => Metadata | null) | null;
    sessionRuntimeControls?: SessionRuntimeControls | null;
    isUsageLimitRecoveryEnabled?: (() => Promise<boolean> | boolean) | null;
    notifyUsageLimitWaitResumeCancelled?: ((request: Readonly<{
      sessionId: string;
      attemptId: string;
    }>) => Promise<unknown> | unknown) | null;
  }>,
): void {
  const isUsageLimitRecoveryEnabled = async (): Promise<boolean> => {
    if (typeof opts.isUsageLimitRecoveryEnabled === 'function') {
      return await opts.isUsageLimitRecoveryEnabled();
    }
    return await resolveUsageLimitRecoveryEnabled();
  };

  rpc.registerHandler(
    SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1,
    async (raw: unknown) => {
      const parsed = SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.safeParse(raw);
      if (!parsed.success) return invalidInput();
      const prepare = opts.sessionRuntimeControls?.preparePendingMessageComposerAdmission;
      if (!prepare) return unsupported(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1);
      try {
        const prepared = await prepare({
          localId: parsed.data.localId,
          text: parsed.data.text,
          meta: { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: parsed.data.structuredInput },
        });
        const admitted = readAdmittedHappierStructuredInputV1FromMeta(prepared.meta);
        if (admitted.status !== 'admitted') {
          return { ok: false, error: 'composer_attachment_admission_invalid', errorCode: 'composer_attachment_admission_invalid' };
        }
        const explicitMediaMetadata = prepared.sessionMediaMetadata
          ? SessionMediaMessageMetaV1Schema.safeParse(prepared.sessionMediaMetadata.envelope)
          : null;
        const mediaMetadata = explicitMediaMetadata?.success
          ? {
              key: prepared.sessionMediaMetadata!.key,
              envelope: explicitMediaMetadata.data,
            }
          : Object.entries(prepared.meta)
              .filter(([key]) => key === 'happier' || key === 'happierMedia')
              .map(([key, value]) => {
                const envelope = SessionMediaMessageMetaV1Schema.safeParse(value);
                return envelope.success
                  ? { key: key as 'happier' | 'happierMedia', envelope: envelope.data }
                  : null;
              })
              .find((value): value is Readonly<{
                key: 'happier' | 'happierMedia';
                envelope: import('@happier-dev/protocol').SessionMediaMessageMetaV1;
              }> => value !== null);
        if ((prepared.stagedMediaHandles?.length ?? 0) > 0 && !mediaMetadata) {
          return {
            ok: false,
            error: 'composer_media_metadata_missing',
            errorCode: 'composer_media_metadata_missing',
          };
        }
        return SessionPendingMessageComposerAdmissionPrepareResponseV1Schema.parse({
          ok: true,
          text: prepared.text,
          structuredInput: admitted.structuredInput,
          stagedMediaHandles: prepared.stagedMediaHandles ?? [],
          ...(mediaMetadata ? { sessionMediaMetadata: mediaMetadata } : {}),
          ...(prepared.sessionMediaCleanup ? { sessionMediaCleanup: prepared.sessionMediaCleanup } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'composer_attachment_admission_failed';
        return { ok: false, error: message, errorCode: 'composer_attachment_admission_failed' };
      }
    },
  );

  rpc.registerHandler(
    SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1,
    async (raw: unknown) => {
      const parsed = SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema.safeParse(raw);
      if (!parsed.success) return invalidInput();
      const accept = opts.sessionRuntimeControls?.acceptPendingMessageComposerAdmission;
      if (!accept) return unsupported(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1);
      await accept(parsed.data);
      return { ok: true };
    },
  );

  rpc.registerHandler(
    SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1,
    async (raw: unknown) => {
      const parsed = SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema.safeParse(raw);
      if (!parsed.success) return invalidInput();
      const abandon = opts.sessionRuntimeControls?.abandonPendingMessageComposerAdmission;
      if (!abandon) return unsupported(SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ABANDONED_V1);
      await abandon(parsed.data);
      return { ok: true };
    },
  );

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
      ...(Object.prototype.hasOwnProperty.call(parsed.data, 'tokenBudget')
        ? { tokenBudget: parsed.data.tokenBudget ?? null }
        : {}),
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
    const result = SessionConnectedServiceAuthApplyGenerationResponseV1Schema.safeParse(
      await opts.sessionRuntimeControls.applyConnectedServiceAuthGeneration(parsed.data),
    );
    return result.success ? result.data : malformedRuntimeControlResult();
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY, async (raw: unknown) => {
    const parsed = SessionConnectedServiceAuthReadRuntimeIdentityRequestV1Schema.safeParse(raw);
    if (!parsed.success) return invalidInput();
    if (typeof opts.sessionRuntimeControls?.readConnectedServiceRuntimeIdentity !== 'function') {
      return unsupported(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY);
    }
    const result = SessionConnectedServiceAuthReadRuntimeIdentityResponseV1Schema.safeParse(
      await opts.sessionRuntimeControls.readConnectedServiceRuntimeIdentity(parsed.data),
    );
    return result.success ? result.data : malformedRuntimeControlResult();
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_MATERIALIZE_NEXT, async (raw: unknown) => {
    void raw;
    return { ok: true as const, didMaterialize: false as const, result: { type: 'deferred' as const, reason: 'runtime_upgrade_required' as const } };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1, async (raw: unknown) => {
    if (!SessionPendingQueueWakeCapabilityRequestV1Schema.safeParse(raw).success) return pendingWakeUnavailable();
    if (typeof opts.sessionRuntimeControls?.wakePendingMaterialization !== 'function') return pendingWakeUnavailable();
    return { ok: true as const, capability: 'pending_queue_wake_v1' as const, protocolVersion: 1 as const, method: SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1 };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_V1, async (raw: unknown) => {
    const parsed = SessionPendingQueueWakeRequestV1Schema.safeParse(raw);
    if (!parsed.success) return pendingWakeUnavailable();
    if (typeof opts.sessionRuntimeControls?.wakePendingMaterialization !== 'function') return pendingWakeUnavailable();
    opts.sessionRuntimeControls.wakePendingMaterialization();
    return { ok: true as const, result: 'wake_published' as const };
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
    const result = SessionTerminalComposerClearResultV1Schema.safeParse(
      await opts.sessionRuntimeControls.clearTerminalComposer({
        sessionId: parsed.data.sessionId,
        ...(parsed.data.expectedStateAtMs !== undefined
          ? { expectedStateAtMs: parsed.data.expectedStateAtMs }
          : {}),
      }),
    );
    if (result.success) return result.data;
    return {
      ...malformedRuntimeControlResult(),
      status: 'clear_failed',
      sessionId: parsed.data.sessionId,
    };
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
    const result = SessionPendingInputInterruptAndRunResultV1Schema.safeParse(
      await opts.sessionRuntimeControls.interruptPendingInputAndRun(parsed.data),
    );
    if (result.success) return result.data;
    return {
      ...malformedRuntimeControlResult(),
      status: 'interrupt_failed',
      sessionId: parsed.data.sessionId,
      localId: parsed.data.localId,
    };
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, async (raw: unknown) => {
    const request = readUsageLimitWaitResumeEnableRequest(raw);
    if (!request) {
      return buildUsageLimitRecoveryOperationError({
        errorCode: 'invalid_parameters',
        status: 'malformed_response',
      });
    }
    if (!await isUsageLimitRecoveryEnabled()) {
      return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), {
        sessionId: request.sessionId,
      });
    }
    if (typeof request.issueFingerprint !== 'string') {
      return buildUsageLimitRecoveryOperationError({
        errorCode: 'usage_limit_recovery_attempt_identity_required',
        status: 'unsupported',
      });
    }
    if (typeof opts.sessionRuntimeControls?.enableUsageLimitWaitResume !== 'function') {
      return normalizeUsageLimitRecoveryOperationResult(
        unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE),
        { sessionId: request.sessionId },
      );
    }
    return normalizeUsageLimitRecoveryOperationResult(
      await opts.sessionRuntimeControls.enableUsageLimitWaitResume(request),
      { sessionId: request.sessionId },
    );
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, async (raw: unknown) => {
    const request = readUsageLimitWaitResumeCancelRequest(raw);
    if (!request) {
      return buildUsageLimitRecoveryOperationError({
        errorCode: 'invalid_parameters',
        status: 'malformed_response',
      });
    }
    if (!await isUsageLimitRecoveryEnabled()) {
      return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), {
        sessionId: request.sessionId,
      });
    }
    if (typeof request.issueFingerprint !== 'string' || typeof request.armedAtMs !== 'number') {
      return buildUsageLimitRecoveryOperationError({
        errorCode: 'usage_limit_recovery_attempt_identity_required',
        status: 'unsupported',
      });
    }
    const exactRequest = {
      sessionId: request.sessionId,
      issueFingerprint: request.issueFingerprint,
      armedAtMs: request.armedAtMs,
      ...(request.runtimeAuthRecoveryAttemptId
        ? { runtimeAuthRecoveryAttemptId: request.runtimeAuthRecoveryAttemptId }
        : {}),
    };
    const propagateCancelToDaemon = async <T>(result: T): Promise<T> => {
      if (
        !result
        || typeof result !== 'object'
        || (result as { ok?: unknown }).ok !== true
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
        // Best-effort propagation must not turn a successful user cancel into a failure.
      }
      return result;
    };
    if (typeof opts.sessionRuntimeControls?.cancelUsageLimitWaitResume !== 'function') {
      return normalizeUsageLimitRecoveryOperationResult(
        unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL),
        { sessionId: request.sessionId },
      );
    }
    return await propagateCancelToDaemon(normalizeUsageLimitRecoveryOperationResult(
      await opts.sessionRuntimeControls.cancelUsageLimitWaitResume(exactRequest),
      { sessionId: request.sessionId },
    ));
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, async (raw: unknown) => {
    const parsed = SessionUsageLimitCheckNowRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      return buildUsageLimitRecoveryOperationError({
        errorCode: 'invalid_parameters',
        status: 'malformed_response',
      });
    }
    if (!await isUsageLimitRecoveryEnabled()) {
      return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), {
        sessionId: parsed.data.sessionId,
      });
    }
    if (typeof opts.sessionRuntimeControls?.checkUsageLimitRecoveryNow !== 'function') {
      return normalizeUsageLimitRecoveryOperationResult(
        unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW),
        { sessionId: parsed.data.sessionId },
      );
    }
    return normalizeUsageLimitRecoveryOperationResult(await opts.sessionRuntimeControls.checkUsageLimitRecoveryNow({
      sessionId: parsed.data.sessionId,
      ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
      ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
    }), { sessionId: parsed.data.sessionId });
  });

  rpc.registerHandler(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT, async (raw: unknown) => {
    const parsed = SessionUsageLimitConsumeResetCreditRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      return buildUsageLimitRecoveryOperationError({
        errorCode: 'invalid_parameters',
        status: 'malformed_response',
      });
    }
    if (!await isUsageLimitRecoveryEnabled()) {
      return normalizeUsageLimitRecoveryOperationResult(usageLimitRecoveryDisabledResult(), {
        sessionId: parsed.data.sessionId,
      });
    }
    if (typeof opts.sessionRuntimeControls?.consumeUsageLimitResetCredit !== 'function') {
      return normalizeUsageLimitRecoveryOperationResult(
        unsupported(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT),
        { sessionId: parsed.data.sessionId },
      );
    }
    return normalizeUsageLimitRecoveryOperationResult(await opts.sessionRuntimeControls.consumeUsageLimitResetCredit({
      sessionId: parsed.data.sessionId,
      ...(parsed.data.agentId ? { agentId: parsed.data.agentId } : {}),
      ...(parsed.data.issueFingerprint !== undefined ? { issueFingerprint: parsed.data.issueFingerprint } : {}),
      ...(parsed.data.resumePromptMode ? { resumePromptMode: parsed.data.resumePromptMode } : {}),
    }), { sessionId: parsed.data.sessionId });
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

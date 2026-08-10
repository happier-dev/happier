import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionUsageLimitRecoveryOperationResultV1Schema } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { updateSessionMetadataWithAckResult } from '@/api/session/stateUpdates';

const featureDecisionMocks = vi.hoisted(() => ({
  resolveCliFeatureDecisionForServer: vi.fn(async () => ({
    decision: { state: 'enabled' },
  })),
}));

vi.mock('@/features/featureDecisionService', () => ({
  resolveCliFeatureDecisionForServer: featureDecisionMocks.resolveCliFeatureDecisionForServer,
}));

import { registerSessionHandlers } from './registerSessionHandlers';

function createRegistrar(): { handlers: Map<string, RpcHandler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, RpcHandler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler);
      },
    },
  };
}

function parseUsageLimitResult(value: unknown) {
  return SessionUsageLimitRecoveryOperationResultV1Schema.parse(value);
}

describe('registerSessionHandlers session controls', () => {
  beforeEach(() => {
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockReset();
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
      decision: { state: 'enabled' },
    });
  });

  it('fails usage-limit recovery RPCs closed when the feature is disabled for the target server', async () => {
    featureDecisionMocks.resolveCliFeatureDecisionForServer.mockResolvedValue({
      decision: { state: 'disabled' },
    });
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true }));
    const updateSessionMetadata = vi.fn();

    registerSessionHandlers(registrar, process.cwd(), {
      updateSessionMetadata,
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
      rememberPreference: true,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
    expect(updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('routes goal RPCs to runtime goal controls and returns current work state', async () => {
    const { handlers, registrar } = createRegistrar();
    const refreshGoal = vi.fn(async () => {});
    const setGoal = vi.fn(async () => {});
    const clearGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };
    const metadata: Metadata & { sessionWorkStateV1: typeof workState } = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: workState,
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      sessionRuntimeControls: {
        refreshGoal,
        setGoal,
        clearGoal,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual({ workState });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
        objective: '  Ship native goal  ',
        status: 'paused',
        tokenBudget: 1200,
      }),
    ).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual({ workState });

    expect(refreshGoal).toHaveBeenCalledTimes(1);
    expect(setGoal).toHaveBeenCalledWith('Ship native goal', {
      status: 'paused',
      tokenBudget: 1200,
    });
    expect(clearGoal).toHaveBeenCalledTimes(1);
  });

  it('routes terminal composer clear RPCs to runtime controls with typed fallback statuses', async () => {
    const { handlers, registrar } = createRegistrar();
    const clearTerminalComposer = vi.fn(async () => ({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    }));
    const method = SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR;

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        clearTerminalComposer,
      },
    });

    await expect(handlers.get(method)?.({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    })).resolves.toEqual({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    });
    expect(clearTerminalComposer).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    });

    const { handlers: unsupportedHandlers, registrar: unsupportedRegistrar } = createRegistrar();
    registerSessionHandlers(unsupportedRegistrar, process.cwd(), {
      sessionRuntimeControls: {},
    });
    await expect(unsupportedHandlers.get(method)?.({ sessionId: 'sess_1' })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${method}`,
    });
  });

  it('routes catalog RPCs to runtime catalog controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const listVendorPlugins = vi.fn(async () => ({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    }));
    const listSkills = vi.fn(async () => ({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        listVendorPlugins,
        listSkills,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      supported: true,
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      supported: true,
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    });
    expect(listVendorPlugins).toHaveBeenCalledWith({ cwd: '/override' });
    expect(listSkills).toHaveBeenCalledWith({ cwd: '/override' });
  });

  it('routes inline review RPCs to runtime review controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const startInlineReview = vi.fn(async () => ({ ok: true, reviewTurnId: 'turn-review-native' }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        startInlineReview,
      },
    });

    const request = {
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE)?.(request)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(startInlineReview).toHaveBeenCalledWith(request);
  });

  it('routes connected-service auth invalidation RPCs to runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const invalidateConnectedServiceAuthTransports = vi.fn(async () => undefined);

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        invalidateConnectedServiceAuthTransports,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({ ok: true });

    expect(invalidateConnectedServiceAuthTransports).toHaveBeenCalledTimes(1);
  });

  it('routes usage-limit recovery RPCs to runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const checkUsageLimitRecoveryNow = vi.fn(async (request: unknown) => {
      if (
        request
        && typeof request === 'object'
        && (request as { operation?: unknown }).operation === 'switch_account_now'
      ) {
        return { ok: true, result: { status: 'switch_attempted', result: { status: 'observed_generation' } } };
      }
      return { ok: true, status: 'waiting' };
    });

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
    }))).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'openai-codex',
    }))).toEqual({
      ok: true,
      status: 'waiting',
      sessionId: 'sess_1',
    });
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'openai-codex',
      operation: 'switch_account_now',
      resumePromptMode: 'off',
    }))).toEqual({
      ok: true,
      status: 'switch_observed',
      sessionId: 'sess_1',
    });

    expect(enableUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    });
    expect(cancelUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      provider: 'openai-codex',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      provider: 'openai-codex',
      operation: 'switch_account_now',
      resumePromptMode: 'off',
    });
  });

  it('rejects blank usage-limit issue fingerprints before dispatching runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  // QAE-1: "Stop waiting" must reach the daemon recovery schedulers (runtime-auth
  // recovery store) regardless of whether the provider registers a cancel runtime
  // control. The session-side handler propagates every SUCCESSFUL cancel through
  // the injected daemon notifier; a daemon-side waiting intent left armed after a
  // user cancel resumes the session involuntarily at the provider reset time.
  it('propagates successful wait-resume cancels to the daemon recovery owner (runtime-control path)', async () => {
    const { handlers, registrar } = createRegistrar();
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        cancelUsageLimitWaitResume,
      },
      notifyUsageLimitWaitResumeCancelled,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    }))).toMatchObject({ ok: true, status: 'cancelled' });
    expect(notifyUsageLimitWaitResumeCancelled).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      attemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  it('propagates successful wait-resume cancels to the daemon recovery owner (no provider runtime control)', async () => {
    const { handlers, registrar } = createRegistrar();
    let metadata: Metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 0,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    } as Metadata;
    let metadataUpdateCalls = 0;
    const updateSessionMetadataWithResult = async <TResult>(handler: (value: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>) => {
      metadataUpdateCalls += 1;
      const update = handler(metadata);
      metadata = update.metadata;
      return update.result;
    };
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadataWithResult,
      notifyUsageLimitWaitResumeCancelled,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    }))).toMatchObject({ ok: true, status: 'cancelled' });
    expect(notifyUsageLimitWaitResumeCancelled).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      attemptId: 'runtime-auth-attempt:exact-1',
    });
    expect(metadataUpdateCalls).toBe(1);
  });

  it('does not let a delayed exact cancel for attempt A cancel newer attempt B', async () => {
    const { handlers, registrar } = createRegistrar();
    let metadata = {
      path: process.cwd(),
      sessionUsageLimitRecoveryV1: {
        v: 1 as const,
        status: 'waiting' as const,
        issueFingerprint: 'attempt-B',
        armedAtMs: 200,
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard' as const,
        selectedAuth: { kind: 'native' as const },
      },
    } as Metadata;
    let metadataUpdateCalls = 0;
    const updateSessionMetadataWithResult = async <TResult>(handler: (value: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>) => {
      metadataUpdateCalls += 1;
      const update = handler(metadata);
      metadata = update.metadata;
      return update.result;
    };
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));
    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadataWithResult,
      notifyUsageLimitWaitResumeCancelled,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'attempt-A',
      armedAtMs: 100,
    })).resolves.toMatchObject({ ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' });
    expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({
      issueFingerprint: 'attempt-B',
      armedAtMs: 200,
      status: 'waiting',
    });
    expect(metadataUpdateCalls).toBe(0);
    expect(notifyUsageLimitWaitResumeCancelled).not.toHaveBeenCalled();
  });

  it.each([
    { requestAttemptId: 'runtime-auth-attempt:a' },
    { requestAttemptId: undefined },
  ])('does not cancel same-tuple runtime B for mismatched or missing request id $requestAttemptId', async ({ requestAttemptId }) => {
    const { handlers, registrar } = createRegistrar();
    let metadata = {
      path: process.cwd(),
      sessionUsageLimitRecoveryV1: {
        v: 1 as const,
        status: 'waiting' as const,
        issueFingerprint: 'same-tuple',
        armedAtMs: 100,
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b',
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 3,
        lastProbeError: null,
        resumePromptMode: 'standard' as const,
        selectedAuth: { kind: 'native' as const },
      },
    } as Metadata;
    let metadataUpdateCalls = 0;
    const updateSessionMetadataWithResult = async <TResult>(handler: (value: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>) => {
      metadataUpdateCalls += 1;
      const update = handler(metadata);
      metadata = update.metadata;
      return update.result;
    };
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));
    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadataWithResult,
      notifyUsageLimitWaitResumeCancelled,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'same-tuple',
      armedAtMs: 100,
      ...(requestAttemptId ? { runtimeAuthRecoveryAttemptId: requestAttemptId } : {}),
    })).resolves.toMatchObject({ ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' });
    expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({ status: 'waiting', runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b' });
    expect(metadataUpdateCalls).toBe(0);
    expect(notifyUsageLimitWaitResumeCancelled).not.toHaveBeenCalled();
  });

  it('returns superseded when metadata changes identity before fallback cancel commits', async () => {
    const { handlers, registrar } = createRegistrar();
    const attemptA = {
      v: 1 as const, status: 'waiting' as const, issueFingerprint: 'same-tuple', armedAtMs: 100,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:a', resetAtMs: null, nextCheckAtMs: null,
      attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    let metadata = { path: process.cwd(), sessionUsageLimitRecoveryV1: attemptA } as Metadata;
    const attemptB = { ...attemptA, runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b' };
    const updateSessionMetadataWithResult = async <TResult>(handler: (value: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>) => {
      const update = handler({ ...metadata, sessionUsageLimitRecoveryV1: attemptB } as Metadata);
      metadata = update.metadata;
      return update.result;
    };
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));
    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadataWithResult,
      notifyUsageLimitWaitResumeCancelled,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1', issueFingerprint: 'same-tuple', armedAtMs: 100,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' });
    expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'waiting', runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b',
    });
    expect(notifyUsageLimitWaitResumeCancelled).not.toHaveBeenCalled();
  });

  it('derives fallback cancellation from the retry invocation whose metadata ack commits', async () => {
    const { handlers, registrar } = createRegistrar();
    const attemptA = {
      v: 1 as const, status: 'waiting' as const, issueFingerprint: 'same-tuple', armedAtMs: 100,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:a', resetAtMs: null, nextCheckAtMs: null,
      attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    const attemptB = { ...attemptA, runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b' };
    let metadata = { path: process.cwd(), sessionUsageLimitRecoveryV1: attemptA } as Metadata;
    let version = 1;
    let ackCount = 0;
    const socket = {
      emitWithAck: vi.fn(async (_event: string, payload: { metadata: string }) => {
        ackCount += 1;
        if (ackCount === 1) {
          return { result: 'version-mismatch', metadata: JSON.stringify({ path: process.cwd(), sessionUsageLimitRecoveryV1: attemptB }), version: 2 };
        }
        return { result: 'success', metadata: payload.metadata, version: 3 };
      }),
    };
    const updateSessionMetadataWithResult = async <TResult>(
      handler: (value: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>,
    ) => await updateSessionMetadataWithAckResult({
      socket,
      sessionId: 'sess_1',
      sessionEncryptionMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
      getMetadata: () => metadata,
      setMetadata: (next) => { metadata = next ?? ({} as Metadata); },
      getMetadataVersion: () => version,
      setMetadataVersion: (next) => { version = next; },
      syncSessionSnapshotFromServer: async () => {},
      handler,
    });
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));
    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadataWithResult,
      notifyUsageLimitWaitResumeCancelled,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1', issueFingerprint: 'same-tuple', armedAtMs: 100,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'usage_limit_recovery_attempt_superseded' });
    expect(metadata.sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'waiting', runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:b',
    });
    expect(version).toBe(3);
    expect(socket.emitWithAck).toHaveBeenCalledTimes(2);
    expect(notifyUsageLimitWaitResumeCancelled).not.toHaveBeenCalled();
  });

  it('reports fallback metadata persistence failure without notifying the daemon', async () => {
    const { handlers, registrar } = createRegistrar();
    const current = {
      v: 1 as const, status: 'waiting' as const, issueFingerprint: 'same-tuple', armedAtMs: 100,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:a', resetAtMs: null, nextCheckAtMs: null,
      attemptCount: 0, maxAttempts: 3, lastProbeError: null, resumePromptMode: 'standard' as const,
      selectedAuth: { kind: 'native' as const },
    };
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));
    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({ path: process.cwd(), sessionUsageLimitRecoveryV1: current } as Metadata),
      updateSessionMetadataWithResult: async () => { throw new Error('metadata transport failed'); },
      notifyUsageLimitWaitResumeCancelled,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1', issueFingerprint: 'same-tuple', armedAtMs: 100,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:a',
    })).resolves.toMatchObject({ ok: false, errorCode: 'usage_limit_recovery_cancel_persistence_failed' });
    expect(notifyUsageLimitWaitResumeCancelled).not.toHaveBeenCalled();
  });

  it('does not propagate failed wait-resume cancels and survives notifier failures', async () => {
    const { handlers, registrar } = createRegistrar();
    const cancelUsageLimitWaitResume = vi.fn(async () => ({
      ok: false,
      errorCode: 'usage_limit_issue_unavailable',
      error: 'usage_limit_issue_unavailable',
    }));
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => {
      throw new Error('daemon unreachable');
    });

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        cancelUsageLimitWaitResume,
      },
      notifyUsageLimitWaitResumeCancelled,
    });

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    }))).toMatchObject({ ok: false });
    expect(notifyUsageLimitWaitResumeCancelled).not.toHaveBeenCalled();

    // Successful cancel must not fail when the daemon notifier throws (best-effort).
    cancelUsageLimitWaitResume.mockResolvedValueOnce({ ok: true, recovery: { status: 'cancelled' } } as never);
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    }))).toMatchObject({ ok: true, status: 'cancelled' });
    expect(notifyUsageLimitWaitResumeCancelled).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      attemptId: 'runtime-auth-attempt:exact-1',
    });
  });

  it('rejects non-boolean rememberPreference values before dispatching runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      rememberPreference: 'yes',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  it('returns a typed unsupported result instead of fabricating a waiting intent when no runtime recovery hook is installed (F1)', async () => {
    const { handlers, registrar } = createRegistrar();
    let metadata: Metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
    };
    const updateSessionMetadata = vi.fn(async (handler: (metadata: Metadata) => Metadata) => {
      metadata = handler(metadata);
    });
    const updateSessionMetadataWithResult = async <TResult>(
      handler: (value: Metadata) => Readonly<{ metadata: Metadata; result: TResult }>,
    ) => {
      const update = handler(metadata);
      metadata = update.metadata;
      return update.result;
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
      updateSessionMetadata,
      updateSessionMetadataWithResult,
    });

    // F1: never `ok: true, status: 'waiting'` with no finite timing and no runner.
    // Without the runtime control there is nothing that can actually wait/resume,
    // so the honest typed result is `unsupported` — not a fabricated intent with
    // null timing and maxAttempts 0.
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });
    expect((metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1).toBeUndefined();
    expect(updateSessionMetadata).not.toHaveBeenCalled();

    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    }))).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });

    // Cancelling an EXISTING intent stays a valid local metadata operation: it
    // needs no timing and no runner.
    metadata = {
      ...metadata,
      sessionUsageLimitRecoveryV1: {
        v: 1,
        status: 'waiting',
        issueFingerprint: 'usage-limit:sess_1:reset',
        armedAtMs: 1,
        resetAtMs: null,
        nextCheckAtMs: null,
        attemptCount: 0,
        maxAttempts: 0,
        lastProbeError: null,
        resumePromptMode: 'standard',
        selectedAuth: { kind: 'native' },
      },
    } as Metadata;
    expect(parseUsageLimitResult(await handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1,
    }))).toEqual({
      ok: true,
      status: 'cancelled',
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    });
    expect((metadata as Record<string, unknown>).sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'cancelled',
    });
    expect(updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('lets runtime message controls intercept provider-specific messages before enqueueing', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, reviewTurnId: 'turn-review-native' },
    }));
    const enqueueSessionUserMessage = vi.fn(async () => {});
    const revalidateExplicitUserRequest = vi.fn(async (_request: { localId: string }) => ({ status: 'ready' as const }));

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      revalidateExplicitUserRequest,
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    const request = {
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(revalidateExplicitUserRequest).toHaveBeenCalledExactlyOnceWith({
      localId: 'local-review-command',
    });
    expect(handleUserMessage).toHaveBeenCalledWith(request);
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('consumes a blocking recovery decision before provider interception', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, deliveredVia: 'provider' },
    }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      revalidateExplicitUserRequest: vi.fn(async () => ({
        status: 'waiting' as const,
        errorCode: 'session_user_message_recovery_pending',
      })),
      sessionRuntimeControls: { handleUserMessage },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/codex.review do not execute yet',
      localId: 'blocked-provider-command',
      meta: { source: 'test' },
    })).resolves.toEqual({
      ok: false,
      status: 'waiting',
      errorCode: 'session_user_message_recovery_pending',
      error: 'session_user_message_recovery_pending',
    });
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('generates one opaque id at common ingress before recovery and provider delivery', async () => {
    const { handlers, registrar } = createRegistrar();
    const revalidateExplicitUserRequest = vi.fn(async (_request: { localId: string }) => ({ status: 'ready' as const }));
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true },
    }));
    registerSessionHandlers(registrar, process.cwd(), {
      revalidateExplicitUserRequest,
      sessionRuntimeControls: { handleUserMessage },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/codex.review generated identity',
      meta: { source: 'legacy-client' },
    })).resolves.toEqual({ ok: true });

    const generatedLocalId = revalidateExplicitUserRequest.mock.calls[0]?.[0].localId;
    expect(generatedLocalId).toEqual(expect.any(String));
    expect(generatedLocalId?.trim()).toBe(generatedLocalId);
    expect(generatedLocalId?.length).toBeGreaterThan(0);
    expect(handleUserMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      localId: generatedLocalId,
    }));
  });

  it('fails closed on a whitespace-only id before recovery, provider, or generic delivery', async () => {
    const { handlers, registrar } = createRegistrar();
    const revalidateExplicitUserRequest = vi.fn(async () => ({ status: 'ready' as const }));
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));
    const enqueueSessionUserMessage = vi.fn(async () => {});
    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      revalidateExplicitUserRequest,
      sessionRuntimeControls: { handleUserMessage },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'must not deliver',
      localId: ' \t ',
      meta: {},
    })).resolves.toEqual({
      ok: false,
      error: 'Invalid params',
      errorCode: 'session_user_message_invalid_input',
    });
    expect(revalidateExplicitUserRequest).not.toHaveBeenCalled();
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('uses the same generated id and recovery outcome for generic delivery', async () => {
    const { handlers, registrar } = createRegistrar();
    const revalidateExplicitUserRequest = vi.fn(async (_request: { localId: string }) => ({ status: 'ready' as const }));
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));
    const enqueueSessionUserMessage = vi.fn(async () => {});
    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      revalidateExplicitUserRequest,
      sessionRuntimeControls: { handleUserMessage },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'generic generated identity',
      meta: {},
    })).resolves.toEqual({ ok: true });

    const generatedLocalId = revalidateExplicitUserRequest.mock.calls[0]?.[0].localId;
    expect(handleUserMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ localId: generatedLocalId }));
    expect(enqueueSessionUserMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ localId: generatedLocalId }));
  });

  it('replays one complete exact-id outcome, rejects payload collisions, and keeps whitespace ids distinct', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async (request: { localId?: string }) => ({
      handled: true as const,
      result: { ok: true, delivery: `provider:${request.localId}` },
    }));
    const revalidateExplicitUserRequest = vi.fn(async () => ({ status: 'ready' as const }));

    registerSessionHandlers(registrar, process.cwd(), {
      revalidateExplicitUserRequest,
      sessionRuntimeControls: { handleUserMessage },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)!;
    const request = { text: '/codex.review exact', localId: 'opaque-id', meta: { source: 'test' } };

    const [first, replay] = await Promise.all([handler(request), handler(request)]);
    expect(first).toEqual({ ok: true, delivery: 'provider:opaque-id' });
    expect(replay).toEqual(first);
    await expect(handler({ ...request, text: '/codex.review different' })).resolves.toEqual({
      ok: false,
      error: 'session_user_message_id_payload_conflict',
      errorCode: 'session_user_message_id_payload_conflict',
    });
    await expect(handler({ ...request, localId: ' opaque-id' })).resolves.toEqual({
      ok: true,
      delivery: 'provider: opaque-id',
    });

    expect(revalidateExplicitUserRequest).toHaveBeenCalledTimes(2);
    expect(handleUserMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps the outcome registry bounded after more than 1000 completed deliveries', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async (request: { localId?: string }) => ({
      handled: true as const,
      result: { ok: true, localId: request.localId },
    }));
    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: { handleUserMessage },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)!;

    for (let index = 0; index < 1_005; index += 1) {
      await expect(handler({ text: `message-${index}`, localId: `completed-${index}`, meta: {} }))
        .resolves.toEqual({ ok: true, localId: `completed-${index}` });
    }
    await expect(handler({ text: 'message-1004', localId: 'completed-1004', meta: {} }))
      .resolves.toEqual({ ok: true, localId: 'completed-1004' });
    await expect(handler({ text: 'collision', localId: 'completed-1004', meta: {} })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_user_message_id_payload_conflict',
    });
    expect(handleUserMessage).toHaveBeenCalledTimes(1_005);
  });

  it('never evicts in-flight outcomes when the registry is full', async () => {
    const { handlers, registrar } = createRegistrar();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const handleUserMessage = vi.fn(async (request: { localId?: string }) => {
      await blocked;
      return { handled: true as const, result: { ok: true, localId: request.localId } };
    });
    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: { handleUserMessage },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)!;
    const inFlight = Array.from({ length: 1_000 }, (_, index) => handler({
      text: `in-flight-${index}`,
      localId: `in-flight-${index}`,
      meta: {},
    }));
    await vi.waitFor(() => expect(handleUserMessage).toHaveBeenCalledTimes(1_000));

    const exactReplay = handler({ text: 'in-flight-0', localId: 'in-flight-0', meta: {} });
    await expect(handler({ text: 'different', localId: 'in-flight-0', meta: {} })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_user_message_id_payload_conflict',
    });
    await expect(handler({ text: 'refused', localId: 'in-flight-overflow', meta: {} })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_user_message_delivery_registry_unavailable',
    });
    expect(handleUserMessage).toHaveBeenCalledTimes(1_000);

    release();
    await expect(exactReplay).resolves.toEqual({ ok: true, localId: 'in-flight-0' });
    await Promise.all(inFlight);
    expect(handleUserMessage).toHaveBeenCalledTimes(1_000);
  });

  it('returns a typed recovery block instead of acknowledging provider delivery', async () => {
    const { handlers, registrar } = createRegistrar();
    const enqueueSessionUserMessage = vi.fn(async () => ({
      recoveryBlocked: {
        status: 'unavailable' as const,
        errorCode: 'session_user_message_recovery_control_unavailable',
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), { enqueueSessionUserMessage });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'retry with current daemon authority',
      localId: 'fresh-request-1',
      meta: { source: 'test' },
    })).resolves.toEqual({
      ok: false,
      status: 'unavailable',
      errorCode: 'session_user_message_recovery_control_unavailable',
      error: 'session_user_message_recovery_control_unavailable',
    });
  });

  it('registers user-message send when runtime controls are the only message owner', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, deliveredVia: 'runtime-controls' },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    const request = {
      text: 'first Claude turn',
      localId: 'first-turn-local',
      meta: { source: 'new-session' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({
      ok: true,
      deliveredVia: 'runtime-controls',
    });
    expect(handleUserMessage).toHaveBeenCalledWith(request);
  });

  it('treats a runtime message control that returns void as handled', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => undefined);
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    const request = {
      text: 'first Claude turn',
      localId: 'first-turn-local',
      meta: { source: 'new-session' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({
      ok: true,
    });
    expect(handleUserMessage).toHaveBeenCalledWith(request);
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('registers user-message send when enqueue is the only message owner', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage: vi.fn(async () => {}),
    });

    expect(handlers.has(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)).toBe(true);
  });

  it('does not register user-message send when no message owner exists', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {});

    expect(handlers.has(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)).toBe(false);
  });

  it('preserves trusted uploaded image metadata for runtime message controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-user-message-'));
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    try {
      const uploadedPath = '.happier/uploads/messages/m1/screen.png';
      const uploadedContent = Buffer.from('fake image bytes');
      const sha256 = createHash('sha256').update(uploadedContent).digest('hex');
      await mkdir(join(root, '.happier', 'uploads', 'messages', 'm1'), { recursive: true });
      await writeFile(join(root, uploadedPath), uploadedContent);

      registerSessionHandlers(registrar, root, {
        enqueueSessionUserMessage,
        sessionRuntimeControls: {
          handleUserMessage,
        },
      });

      const request = {
        text: 'inspect upload',
        localId: 'local-upload-image',
        meta: {
          happier: {
            kind: 'attachments.v1',
            payload: {
              attachments: [
                {
                  name: 'screen.png',
                  path: uploadedPath,
                  mimeType: 'image/png',
                  sizeBytes: uploadedContent.byteLength,
                  sha256,
                },
              ],
            },
          },
          happierStructuredInputV1: {
            v: 1,
            attachments: [
              {
                kind: 'image',
                mimeType: 'image/png',
                localPath: uploadedPath,
                sha256,
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      };

      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.(request)).resolves.toEqual({ ok: true });

      expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
      expect(enqueueSessionUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            attachments: [
              expect.objectContaining({
                localPath: uploadedPath,
                path: uploadedPath,
              }),
            ],
          }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('admits composer references against the submitted text at the request boundary', async () => {
    // The protocol sanitizer parses metadata independently of the message it accompanies, so
    // the `text.slice(start, end) === token` half of the range contract can only be enforced
    // where both are in hand — this handler. Without the text the whole check is inert, so the
    // wiring itself is the contract being asserted here, not just the protocol helper.
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage: vi.fn(async () => {}),
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'see @src/a.ts and @src/b.ts',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          mentions: [
            { kind: 'happier.file', ref: 'file:src/a.ts', token: '@src/a.ts', start: 4, end: 13 },
            // Stale range: the token at [18, 27) is `@src/b.ts`, not `@src/z.ts`.
            { kind: 'happier.file', ref: 'file:src/z.ts', token: '@src/z.ts', start: 18, end: 27 },
          ],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        happierStructuredInputV1: expect.objectContaining({
          mentions: [expect.objectContaining({ ref: 'file:src/a.ts' })],
        }),
      }),
    }));
  });

  it('drops forged upload-shaped local image metadata before runtime message controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage: vi.fn(async () => {}),
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'inspect forged upload',
      meta: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [
              {
                path: '.happier/uploads/messages/m1/private.png',
                mimeType: 'image/png',
                sha256: '0'.repeat(64),
              },
            ],
          },
        },
        happierStructuredInputV1: {
          v: 1,
          attachments: [
            {
              kind: 'image',
              mimeType: 'image/png',
              localPath: '.happier/uploads/messages/m1/private.png',
              sha256: '0'.repeat(64),
              provenance: { kind: 'sessionAttachmentUpload' },
            },
          ],
        },
      },
    })).resolves.toEqual({ ok: true });

    expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        happierStructuredInputV1: expect.not.objectContaining({
          attachments: expect.any(Array),
        }),
      }),
    }));
  });

  it('enqueues provider-specific slash commands when no runtime hook handles them', async () => {
    const { handlers, registrar } = createRegistrar();
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    })).resolves.toEqual({ ok: true });

    expect(enqueueSessionUserMessage).toHaveBeenCalledWith({
      text: '/codex.review focus on regressions',
      localId: 'local-review-command',
      meta: { source: 'test' },
    });
  });

  it('uses the current goal objective for status-only goal updates', async () => {
    const { handlers, registrar } = createRegistrar();
    const setGoal = vi.fn(async () => {});
    const workState = {
      v: 1,
      backendId: 'codex',
      updatedAt: 1,
      items: [
        {
          id: 'goal:thread-1',
          kind: 'goal',
          origin: 'vendor',
          status: 'active',
          title: 'Ship goal controls',
          updatedAt: 1,
        },
      ],
      primaryItemId: 'goal:thread-1',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
        sessionWorkStateV1: workState,
      } as Metadata & { sessionWorkStateV1: typeof workState }),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual({ workState });

    expect(setGoal).toHaveBeenCalledWith('Ship goal controls', { status: 'paused' });
  });

  it('delegates status-only goal updates to the runtime when metadata has no current objective', async () => {
    const { handlers, registrar } = createRegistrar();
    const runtimeResult = {
      ok: false,
      errorCode: 'goal_not_found',
      error: 'goal_not_found',
    };
    const setGoal = vi.fn(async () => runtimeResult);

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
      } as Metadata),
      sessionRuntimeControls: { setGoal },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({ status: 'paused' }),
    ).resolves.toEqual(runtimeResult);

    expect(setGoal).toHaveBeenCalledWith(undefined, { status: 'paused' });
  });

  it('returns displayable work-state items when metadata preserves future items', async () => {
    const { handlers, registrar } = createRegistrar();
    const metadata = {
      path: process.cwd(),
      host: 'test-host',
      homeDir: '/tmp',
      happyHomeDir: '/tmp/.happier',
      happyLibDir: '/tmp/.happier/lib',
      happyToolsDir: '/tmp/.happier/tools',
      sessionWorkStateV1: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'future:1',
            kind: 'milestone',
            origin: 'future',
            status: 'waiting',
            title: 'Future item',
            updatedAt: 1,
          },
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    } as Metadata;

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => metadata,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET)?.({})).resolves.toEqual({
      workState: {
        v: 1,
        backendId: 'codex',
        updatedAt: 1,
        primaryItemId: 'goal:thread-1',
        items: [
          {
            id: 'goal:thread-1',
            kind: 'goal',
            origin: 'vendor',
            status: 'active',
            title: 'Known goal',
            updatedAt: 1,
          },
        ],
      },
    });
  });

  it('passes through stable unsupported results from runtime goal controls', async () => {
    const { handlers, registrar } = createRegistrar();
    const unsupportedSet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.set',
    };
    const unsupportedGet = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.get',
    };
    const unsupportedClear = {
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.goal.clear',
    };

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        refreshGoal: vi.fn(async () => unsupportedGet),
        setGoal: vi.fn(async () => unsupportedSet),
        clearGoal: vi.fn(async () => unsupportedClear),
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual(unsupportedGet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
      objective: 'Unsupported native goal',
    })).resolves.toEqual(unsupportedSet);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual(unsupportedClear);
  });

  it('returns unsupported when connected-service auth invalidation controls are unavailable', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS)?.({}),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_INVALIDATE_TRANSPORTS}`,
    });
  });

  it('routes connected-service auth apply generation controls to the active runtime', async () => {
    const { handlers, registrar } = createRegistrar();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        applyConnectedServiceAuthGeneration,
      },
    });

    const request = {
      serviceId: ' openai-codex ',
      reason: 'usage_limit',
      requireDirectLiveHotApply: false,
      expected: {
        profileId: 'profile-old',
        groupId: 'group-1',
        generation: '5',
      },
      authGeneration: {
        kind: 'connected_service_credential',
        profileId: 'profile-new',
      },
    };

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.(request),
    ).resolves.toEqual({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      ...request,
      serviceId: 'openai-codex',
    });
  });

  it('routes connected-service runtime identity reads without mutating auth', async () => {
    const { handlers, registrar } = createRegistrar();
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: false,
        inProviderTurn: true,
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        readConnectedServiceRuntimeIdentity,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY)?.({
        serviceId: ' openai-codex ',
        reason: 'same_provider_account_exhausted',
        requireExactProof: true,
      }),
    ).resolves.toEqual({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: false,
        inProviderTurn: true,
      },
    });
    expect(readConnectedServiceRuntimeIdentity).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'same_provider_account_exhausted',
      requireExactProof: true,
    });
  });

  it('fails closed when connected-service auth apply generation returns malformed exact proof', async () => {
    const { handlers, registrar } = createRegistrar();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        status: 'verified',
        proofStrength: 'exact',
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        applyConnectedServiceAuthGeneration,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: 'openai-codex',
        reason: 'usage_limit',
        authGeneration: {
          kind: 'connected_service_credential',
          profileId: 'profile-new',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_runtime_control_result',
      error: 'invalid_runtime_control_result',
    });
  });

  it('fails closed when connected-service runtime identity returns malformed exact proof', async () => {
    const { handlers, registrar } = createRegistrar();
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        source: 'runtime_loaded_credential',
      },
      runtime: {
        safeToApply: true,
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        readConnectedServiceRuntimeIdentity,
      },
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY)?.({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
        requireExactProof: true,
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_runtime_control_result',
      error: 'invalid_runtime_control_result',
    });
  });

  it('returns precise unsupported and invalid-parameter results for connected-service runtime controls', async () => {
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: 'openai-codex',
        reason: 'usage_limit',
        authGeneration: {
          kind: 'connected_service_credential',
          profileId: 'profile-new',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION}`,
    });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY)?.({
        serviceId: 'openai-codex',
        reason: 'same_provider_account_exhausted',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: `unsupported_session_runtime_method:${SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_READ_RUNTIME_IDENTITY}`,
    });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: '',
        reason: 'usage_limit',
        authGeneration: {
          kind: 'connected_service_credential',
          profileId: 'profile-new',
        },
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    await expect(
      handlers.get(SESSION_RPC_METHODS.SESSION_CONNECTED_SERVICE_AUTH_APPLY_GENERATION)?.({
        serviceId: 'openai-codex',
        reason: 'usage_limit',
      }),
    ).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
  });
});

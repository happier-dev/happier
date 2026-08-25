import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  SessionPendingMessageComposerAdmissionPrepareRequestV1Schema,
  SessionUsageLimitRecoveryV1Schema,
} from '@happier-dev/protocol';

vi.mock('./capabilities', () => ({ registerCapabilitiesHandlers: vi.fn() }));
vi.mock('./previewEnv', () => ({ registerPreviewEnvHandler: vi.fn() }));
vi.mock('./bash', () => ({ registerBashHandler: vi.fn() }));
vi.mock('./ripgrep', () => ({ registerRipgrepHandler: vi.fn() }));
vi.mock('./difftastic', () => ({ registerDifftasticHandler: vi.fn() }));
vi.mock('./daemonContributionRegistryProjection', () => ({ registerDaemonContributionRegistryProjectionHandler: vi.fn() }));
vi.mock('./spawnRuntimeSelection', () => ({
  readCanonicalSpawnRuntimeSelection: vi.fn(() => ({})),
  readSpawnRuntimeDescriptorV1: vi.fn(() => undefined),
}));
vi.mock('@/persistence', () => ({ readCredentials: vi.fn(async () => null) }));
vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: vi.fn(),
}));

async function loadRegisterSessionHandlers() {
  const module = await import('./registerSessionHandlers');
  return module.registerSessionHandlers;
}

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

describe('registerSessionHandlers session controls', () => {
  it('prepares whole Pending input and settles only an explicitly accepted payload', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const admittedAttachment = {
      v: 1 as const,
      instanceId: 'issue-42',
      attachment: { pluginId: 'acme.issues', localId: 'issue' },
      key: '42',
      value: { issueId: 43, prepared: true },
      presentation: { label: 'Issue #43', typeLabel: 'Issue' },
    };
    const preparePendingMessageComposerAdmission = vi.fn(async () => ({
      text: 'prepared text',
      meta: { happierStructuredInputV1: { v: 1, composerAttachments: [admittedAttachment] } },
      stagedMediaHandles: [],
    }));
    const acceptPendingMessageComposerAdmission = vi.fn(async () => undefined);

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        preparePendingMessageComposerAdmission,
        acceptPendingMessageComposerAdmission,
      },
    });

    const prepareRequest = {
      localId: 'pending-successor-1',
      text: 'draft text',
      structuredInput: { v: 1 as const, composerAttachments: [admittedAttachment] },
    };
    expect(SessionPendingMessageComposerAdmissionPrepareRequestV1Schema.safeParse(prepareRequest))
      .toMatchObject({ success: true });
    await expect(handlers.get(
      SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_PREPARE_V1,
    )?.(prepareRequest)).resolves.toEqual({
      ok: true,
      text: 'prepared text',
      structuredInput: { v: 1, composerAttachments: [admittedAttachment] },
      stagedMediaHandles: [],
    });
    expect(preparePendingMessageComposerAdmission).toHaveBeenCalledWith({
      localId: 'pending-successor-1',
      text: 'draft text',
      meta: { happierStructuredInputV1: prepareRequest.structuredInput },
    });
    expect(acceptPendingMessageComposerAdmission).not.toHaveBeenCalled();

    const acceptedRequest = {
      sessionId: 'session-1',
      localId: 'pending-successor-1',
      structuredInput: { v: 1, composerAttachments: [admittedAttachment] },
      stagedMediaHandles: [],
    };
    await expect(handlers.get(
      SESSION_RPC_METHODS.SESSION_PENDING_MESSAGE_COMPOSER_ADMISSION_ACCEPTED_V1,
    )?.(acceptedRequest)).resolves.toEqual({ ok: true });
    expect(acceptPendingMessageComposerAdmission).toHaveBeenCalledWith(acceptedRequest);
  });

  it('routes goal RPCs to runtime goal controls and returns current work state', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
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

    registerSessionHandlers(registrar, process.cwd(), {
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
        sessionWorkStateV1: workState,
      }) as Metadata & { sessionWorkStateV1: typeof workState },
      sessionRuntimeControls: {
        refreshGoal,
        setGoal,
        clearGoal,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_GET)?.({})).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_SET)?.({
      objective: '  Ship native goal  ',
      status: 'paused',
      tokenBudget: 1200,
    })).resolves.toEqual({ workState });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_GOAL_CLEAR)?.({})).resolves.toEqual({ workState });

    expect(refreshGoal).toHaveBeenCalledTimes(1);
    expect(setGoal).toHaveBeenCalledWith('Ship native goal', {
      status: 'paused',
      tokenBudget: 1200,
    });
    expect(clearGoal).toHaveBeenCalledTimes(1);
  });

  it('routes catalog and inline review RPCs to runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const listVendorPlugins = vi.fn(async () => ({
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    }));
    const listSkills = vi.fn(async () => ({
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    }));
    const startInlineReview = vi.fn(async () => ({ ok: true, reviewTurnId: 'turn-review-native' }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        listVendorPlugins,
        listSkills,
        startInlineReview,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_VENDOR_PLUGIN_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      vendorPlugins: [{ vendorPluginRef: 'plugin://gmail@openai-curated', name: 'gmail' }],
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_SKILL_CATALOG_LIST)?.({ cwd: ' /override ' })).resolves.toEqual({
      skills: [{ name: 'reviewer', origin: 'codex_native' }],
    });

    const reviewRequest = {
      engineIds: ['codex'],
      instructions: 'Check correctness.',
      runLocation: 'current_session',
      changeType: 'uncommitted',
      base: { kind: 'none' },
    };
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE)?.(reviewRequest)).resolves.toEqual({
      ok: true,
      reviewTurnId: 'turn-review-native',
    });

    expect(listVendorPlugins).toHaveBeenCalledWith({ cwd: '/override' });
    expect(listSkills).toHaveBeenCalledWith({ cwd: '/override' });
    expect(startInlineReview).toHaveBeenCalledWith(reviewRequest);
  });

  it('routes connected-service auth invalidation RPCs to runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
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

  it('routes generic connected-service auth apply and identity RPCs to runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct_1',
      recovery: { status: 'resumed' },
    }));
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        applyConnectedServiceAuthGeneration,
        readConnectedServiceRuntimeIdentity,
      },
    });

    await expect(handlers.get('session.connectedServiceAuth.applyGeneration')?.({
      serviceId: ' openai-codex ',
      reason: 'usage_limit',
      requireDirectLiveHotApply: true,
      expected: { profileId: ' work ', groupId: ' happier ', generation: ' 42 ' },
      authGeneration: {
        kind: 'oauth',
        providerAccountId: 'acct_1',
      },
    })).resolves.toEqual({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: 'acct_1',
      recovery: { status: 'resumed' },
    });
    await expect(handlers.get('session.connectedServiceAuth.readRuntimeIdentity')?.({
      serviceId: ' openai-codex ',
      reason: 'same_provider_account_exhausted',
      requireExactProof: true,
      expected: { generation: 42 },
    })).resolves.toEqual({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
        providerAccountId: 'acct_1',
      },
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      requireDirectLiveHotApply: true,
      expected: { profileId: 'work', groupId: 'happier', generation: '42' },
      authGeneration: {
        kind: 'oauth',
        providerAccountId: 'acct_1',
      },
    });
    expect(readConnectedServiceRuntimeIdentity).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'same_provider_account_exhausted',
      requireExactProof: true,
      expected: { generation: 42 },
    });
  });

  it('rejects malformed connected-service auth apply requests before calling runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        applyConnectedServiceAuthGeneration,
      },
    });

    await expect(handlers.get('session.connectedServiceAuth.applyGeneration')?.({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: {},
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(applyConnectedServiceAuthGeneration).not.toHaveBeenCalled();
  });

  it('fails closed when connected-service auth controls return malformed exact proof', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const applyConnectedServiceAuthGeneration = vi.fn(async () => ({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      verification: {
        proofStrength: 'exact',
        source: 'applied_credential',
      },
    }));
    const readConnectedServiceRuntimeIdentity = vi.fn(async () => ({
      ok: true,
      serviceId: 'openai-codex',
      identity: {
        strategy: 'provider_account_id',
        proofStrength: 'exact',
      },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        applyConnectedServiceAuthGeneration,
        readConnectedServiceRuntimeIdentity,
      },
    });

    await expect(handlers.get('session.connectedServiceAuth.applyGeneration')?.({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: { kind: 'oauth', providerAccountId: 'acct_1' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'malformed_runtime_control_result',
      error: 'malformed_runtime_control_result',
    });
    await expect(handlers.get('session.connectedServiceAuth.readRuntimeIdentity')?.({
      serviceId: 'openai-codex',
      reason: 'same_provider_account_exhausted',
      requireExactProof: true,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'malformed_runtime_control_result',
      error: 'malformed_runtime_control_result',
    });
  });

  it('freezes legacy materialize-next as a side-effect-free upgrade deferral', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const wakePendingMaterialization = vi.fn();
    registerSessionHandlers(registrar, process.cwd(), { sessionRuntimeControls: { wakePendingMaterialization } });
    await expect(handlers.get('session.pendingQueue.materializeNext')?.({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      ok: true, didMaterialize: false, result: { type: 'deferred', reason: 'runtime_upgrade_required' },
    });
    expect(wakePendingMaterialization).not.toHaveBeenCalled();
  });

  it('discovers and publishes V1 wake without returning materializer results', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const wakePendingMaterialization = vi.fn();
    registerSessionHandlers(registrar, process.cwd(), { sessionRuntimeControls: { wakePendingMaterialization } });
    await expect(handlers.get('session.pendingQueue.wake.capability.get.v1')?.({})).resolves.toEqual({
      ok: true, capability: 'pending_queue_wake_v1', protocolVersion: 1, method: 'session.pendingQueue.wake.v1',
    });
    await expect(handlers.get('session.pendingQueue.wake.v1')?.({ protocolVersion: 1 })).resolves.toEqual({ ok: true, result: 'wake_published' });
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(1);
  });

  it('routes terminal composer clear RPCs to runtime controls with typed result normalization', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const clearTerminalComposer = vi.fn(async () => ({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
      providerDiagnostic: 'ignored but preserved',
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        clearTerminalComposer,
      } as any,
    });

    await expect(handlers.get('session.terminalComposer.clear')?.({
      sessionId: 'sess_1',
      expectedStateAtMs: 42,
    })).resolves.toEqual({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
      providerDiagnostic: 'ignored but preserved',
    });

    expect(clearTerminalComposer).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      expectedStateAtMs: 42,
    });
  });

  it('passes concrete terminal composer clear runtime failures through without malformed downgrades', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();

    for (const status of ['no_live_terminal', 'host_dead'] as const) {
      const { handlers, registrar } = createRegistrar();
      const clearTerminalComposer = vi.fn(async () => ({
        ok: false,
        status,
        sessionId: 'sess_1',
        errorCode: status,
        error: status,
      }));

      registerSessionHandlers(registrar, process.cwd(), {
        sessionRuntimeControls: {
          clearTerminalComposer,
        } as any,
      });

      await expect(handlers.get('session.terminalComposer.clear')?.({
        sessionId: 'sess_1',
      })).resolves.toEqual({
        ok: false,
        status,
        sessionId: 'sess_1',
        errorCode: status,
        error: status,
      });

      expect(clearTerminalComposer).toHaveBeenCalledWith({
        sessionId: 'sess_1',
      });
    }
  });

  it('fails terminal composer clear closed for malformed input, missing runtime control, and malformed runtime output', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const malformedRuntimeResult = vi.fn(async () => ({
      ok: true,
      status: 'claude_specific_status',
      sessionId: 'sess_1',
    }));

    {
      const { handlers, registrar } = createRegistrar();
      registerSessionHandlers(registrar, process.cwd(), {
        sessionRuntimeControls: {
          clearTerminalComposer: malformedRuntimeResult,
        } as any,
      });

      await expect(handlers.get('session.terminalComposer.clear')?.({
        sessionId: '   ',
      })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_parameters',
        error: 'invalid_parameters',
      });
      expect(malformedRuntimeResult).not.toHaveBeenCalled();

      await expect(handlers.get('session.terminalComposer.clear')?.({
        sessionId: 'sess_1',
      })).resolves.toEqual({
        ok: false,
        status: 'clear_failed',
        sessionId: 'sess_1',
        errorCode: 'malformed_runtime_control_result',
        error: 'malformed_runtime_control_result',
      });
    }

    {
      const { handlers, registrar } = createRegistrar();
      registerSessionHandlers(registrar, process.cwd(), {
        sessionRuntimeControls: {},
      });

      await expect(handlers.get('session.terminalComposer.clear')?.({
        sessionId: 'sess_1',
      })).resolves.toEqual({
        ok: false,
        status: 'unsupported',
        sessionId: 'sess_1',
        errorCode: 'unsupported_session_runtime_method',
        error: 'unsupported_session_runtime_method:session.terminalComposer.clear',
      });
    }
  });

  it('fails V1 discovery closed when the wake publisher is not attached yet', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1)?.({})).resolves.toEqual({
      ok: false,
      error: 'pending_materialization_wake_unavailable',
      errorCode: 'runtime_upgrade_required',
    });
  });

  it('routes usage-limit recovery RPCs to runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const consumeUsageLimitResetCredit = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const notifyUsageLimitWaitResumeCancelled = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => true,
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
        consumeUsageLimitResetCredit,
      },
      notifyUsageLimitWaitResumeCancelled,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess_1' });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1_700_000_000_000,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'sess_1' });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
      provider: 'codex',
      resumePromptMode: 'off',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess_1' });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT)?.({
      sessionId: 'sess_1',
      provider: 'codex',
      issueFingerprint: 'usage-limit:codex:turn-1',
      resumePromptMode: 'off',
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess_1' });

    expect(enableUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      rememberPreference: true,
      resumePromptMode: 'off',
    });
    expect(cancelUsageLimitWaitResume).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 1_700_000_000_000,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    });
    expect(notifyUsageLimitWaitResumeCancelled).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      attemptId: 'runtime-auth-attempt:exact-1',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      agentId: 'codex',
      resumePromptMode: 'off',
    });
    expect(consumeUsageLimitResetCredit).toHaveBeenCalledWith({
      sessionId: 'sess_1',
      agentId: 'codex',
      issueFingerprint: 'usage-limit:codex:turn-1',
      resumePromptMode: 'off',
    });
  });

  it('rejects whitespace-only usage-limit fingerprints before calling runtime controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));

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
      status: 'malformed_response',
      errorCode: 'invalid_parameters',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      status: 'malformed_response',
      errorCode: 'invalid_parameters',
    });

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
  });

  it('fails closed when usage-limit recovery is disabled', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enableUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const cancelUsageLimitWaitResume = vi.fn(async () => ({ ok: true }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true }));

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => false,
      sessionRuntimeControls: {
        enableUsageLimitWaitResume,
        cancelUsageLimitWaitResume,
        checkUsageLimitRecoveryNow,
      },
    });

    const expected = {
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'feature_disabled',
    };

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      rememberPreference: true,
    })).resolves.toEqual(expected);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
    })).resolves.toEqual(expected);
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'sess_1',
    })).resolves.toEqual(expected);

    expect(enableUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(cancelUsageLimitWaitResume).not.toHaveBeenCalled();
    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
  });

  it('returns unsupported when connected-service auth invalidation controls are unavailable', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
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

  it('returns unsupported when generic connected-service auth controls are unavailable', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {},
    });

    await expect(handlers.get('session.connectedServiceAuth.applyGeneration')?.({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: { kind: 'oauth' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.connectedServiceAuth.applyGeneration',
    });
    await expect(handlers.get('session.connectedServiceAuth.readRuntimeIdentity')?.({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.connectedServiceAuth.readRuntimeIdentity',
    });
  });

  it('fails closed when neither runtime controls nor registered-field durable delivery are available', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => true,
      getSessionMetadata: () => ({
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/tmp',
        happyHomeDir: '/tmp/.happier',
        happyLibDir: '/tmp/.happier/lib',
        happyToolsDir: '/tmp/.happier/tools',
      }) as Metadata,
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });
  });

  it('returns unsupported and enqueues nothing when active runtime usage controls are absent', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enqueueRegisteredSessionStateFieldMutation = vi.fn();
    const enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery = vi.fn();

    registerSessionHandlers(registrar, process.cwd(), {
      isUsageLimitRecoveryEnabled: async () => true,
      getSessionMetadata: () => ({
        path: process.cwd(),
        sessionUsageLimitRecoveryV1: SessionUsageLimitRecoveryV1Schema.parse({
          v: 1,
          status: 'waiting',
          resumePromptMode: 'standard',
          issueFingerprint: 'usage-limit:sess_1:reset',
          armedAtMs: 100,
          resetAtMs: null,
          nextCheckAtMs: null,
          attemptCount: 0,
          maxAttempts: 3,
          lastProbeError: null,
          selectedAuth: { kind: 'native' },
        }),
      }) as Metadata,
      enqueueRegisteredSessionStateFieldMutation,
      enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery,
    } as unknown as Parameters<typeof registerSessionHandlers>[2]);

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });
    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'sess_1',
      issueFingerprint: 'usage-limit:sess_1:reset',
      armedAtMs: 100,
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
    });
    expect(enqueueRegisteredSessionStateFieldMutation).not.toHaveBeenCalled();
    expect(enqueueRegisteredSessionStateFieldMutationAndWaitForDelivery).not.toHaveBeenCalled();
  });

  it('lets runtime message controls intercept provider-specific messages before enqueueing', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, reviewTurnId: 'turn-review-native' },
    }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      enqueueSessionUserMessage,
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

    expect(handleUserMessage).toHaveBeenCalledWith({
      ...request,
      meta: {
        sentFrom: 'ui',
        source: 'ui',
      },
    });
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('revalidates recovery before a provider-specific message control can deliver', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, nativeTurnId: 'must-not-deliver' },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      getSessionMetadata: () => ({} as never),
      sessionRuntimeControls: {
        checkUsageLimitRecoveryNow,
        handleUserMessage,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/native first turn',
      localId: 'provider-specific-recovery-gate',
      meta: { source: 'test' },
    })).resolves.toMatchObject({
      ok: false,
      status: 'waiting',
      errorCode: 'session_user_message_recovery_pending',
    });

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledExactlyOnceWith({ sessionId: 'sess_1' });
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it('generates one opaque id at common ingress before recovery and provider delivery', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const handleUserMessage = vi.fn(async (_request: { localId?: string }) => ({ handled: true as const, result: { ok: true } }));
    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      sessionRuntimeControls: { checkUsageLimitRecoveryNow, handleUserMessage },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/native generated identity',
      meta: { source: 'legacy-client' },
    })).resolves.toEqual({ ok: true });

    const generatedLocalId = handleUserMessage.mock.calls[0]?.[0].localId;
    expect(generatedLocalId).toEqual(expect.any(String));
    expect(generatedLocalId?.trim()).toBe(generatedLocalId);
    expect(generatedLocalId?.length).toBeGreaterThan(0);
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledOnce();
  });

  it('fails closed on a whitespace-only id before recovery, provider, or generic delivery', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const handleUserMessage = vi.fn(async () => ({ handled: false as const }));
    const enqueueSessionUserMessage = vi.fn(async () => {});
    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      enqueueSessionUserMessage,
      sessionRuntimeControls: { checkUsageLimitRecoveryNow, handleUserMessage },
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
    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('requires one typed provider-neutral recovery decision before prompt delivery', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      getSessionMetadata: () => ({
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'waiting',
          issueFingerprint: 'usage-limit:claude:turn-1',
          armedAtMs: 100,
          resetAtMs: null,
          nextCheckAtMs: 200,
          attemptCount: 0,
          maxAttempts: 3,
          lastProbeError: null,
          resumePromptMode: 'standard',
          selectedAuth: { kind: 'native' },
        },
      } as never),
      enqueueSessionUserMessage,
      sessionRuntimeControls: { checkUsageLimitRecoveryNow },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
        text: 'fresh Claude prompt',
        localId: 'fresh-request-1',
        meta: { source: 'test' },
      })).resolves.toEqual({
        ok: false,
        status: 'waiting',
        errorCode: 'session_user_message_recovery_pending',
        error: 'session_user_message_recovery_pending',
      });
    }

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledExactlyOnceWith({ sessionId: 'sess_1' });
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('fails closed on a bounded recovery decision failure and preserves exact request ids', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const checkUsageLimitRecoveryNow = vi.fn(async () => {
      throw new Error('recovery owner unavailable');
    });
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      getSessionMetadata: () => null,
      enqueueSessionUserMessage,
      sessionRuntimeControls: { checkUsageLimitRecoveryNow },
    });

    for (const localId of [' request-1', 'request-1 ', ' request-1'] as const) {
      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
        text: 'fresh prompt',
        localId,
        meta: { source: 'test' },
      })).resolves.toMatchObject({
        ok: false,
        status: 'unavailable',
        errorCode: 'session_user_message_recovery_control_unavailable',
      });
    }

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledTimes(2);
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
  });

  it('bounds a never-settling recovery control and never delivers after its late result', async () => {
    vi.useFakeTimers();
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    let resolveRecovery!: (value: { ok: true; status: 'ready' }) => void;
    const checkUsageLimitRecoveryNow = vi.fn(() => new Promise<{ ok: true; status: 'ready' }>((resolve) => {
      resolveRecovery = resolve;
    }));
    const handleUserMessage = vi.fn(async () => ({ handled: true as const, result: { ok: true } }));
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      getSessionMetadata: () => null,
      enqueueSessionUserMessage,
      sessionRuntimeControls: { checkUsageLimitRecoveryNow, handleUserMessage },
    });
    const result = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'must remain blocked',
      localId: 'stalled-control',
      meta: { source: 'test' },
    });
    await vi.advanceTimersByTimeAsync(7_500);
    await expect(result).resolves.toMatchObject({
      ok: false,
      status: 'unavailable',
      errorCode: 'session_user_message_recovery_control_unavailable',
    });
    resolveRecovery({ ok: true, status: 'ready' });
    await vi.advanceTimersByTimeAsync(0);

    expect(handleUserMessage).not.toHaveBeenCalled();
    expect(enqueueSessionUserMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('owns one complete outcome per exact localId and fails payload collisions closed', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    const handleUserMessage = vi.fn(async (request: { localId?: string }) => ({
      handled: true as const,
      result: { ok: true, delivery: `provider:${request.localId}` },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      sessionRuntimeControls: { checkUsageLimitRecoveryNow, handleUserMessage },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)!;
    const request = { text: '/native exact', localId: 'opaque-id', meta: { source: 'test' } };
    const [first, replay] = await Promise.all([handler(request), handler(request)]);

    expect(replay).toEqual(first);
    await expect(handler({ ...request, text: '/native collision' })).resolves.toEqual({
      ok: false,
      error: 'session_user_message_id_payload_conflict',
      errorCode: 'session_user_message_id_payload_conflict',
    });
    await expect(handler({ ...request, localId: ' opaque-id' })).resolves.toEqual({
      ok: true,
      delivery: 'provider: opaque-id',
    });
    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledTimes(2);
    expect(handleUserMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps the outcome registry bounded after more than 1000 completed deliveries', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async (request: { localId?: string }) => ({
      handled: true as const,
      result: { ok: true, localId: request.localId },
    }));
    registerSessionHandlers(registrar, process.cwd(), { sessionRuntimeControls: { handleUserMessage } });
    const handler = handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)!;

    for (let index = 0; index < 1_005; index += 1) {
      await handler({ text: `message-${index}`, localId: `completed-${index}`, meta: {} });
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
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const handleUserMessage = vi.fn(async (request: { localId?: string }) => {
      await blocked;
      return { handled: true as const, result: { ok: true, localId: request.localId } };
    });
    registerSessionHandlers(registrar, process.cwd(), { sessionRuntimeControls: { handleUserMessage } });
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
    await expect(handler({ text: 'overflow', localId: 'in-flight-overflow', meta: {} })).resolves.toMatchObject({
      ok: false,
      errorCode: 'session_user_message_delivery_registry_unavailable',
    });
    expect(handleUserMessage).toHaveBeenCalledTimes(1_000);

    release();
    await expect(exactReplay).resolves.toEqual({ ok: true, localId: 'in-flight-0' });
    await Promise.all(inFlight);
  });

  it('allows a prompt without a recovery control only when durable metadata has no blocking intent', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const enqueueSessionUserMessage = vi.fn(async () => {});

    registerSessionHandlers(registrar, process.cwd(), {
      sessionId: 'sess_1',
      getSessionMetadata: () => ({} as never),
      enqueueSessionUserMessage,
      sessionRuntimeControls: {},
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: 'ordinary fresh prompt',
      localId: 'fresh-without-blocking-intent',
      meta: { source: 'test' },
    })).resolves.toEqual({ ok: true });
    expect(enqueueSessionUserMessage).toHaveBeenCalledOnce();
  });

  it('registers session.userMessage.send when runtime controls can handle messages without an enqueue hook', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
    const { handlers, registrar } = createRegistrar();
    const handleUserMessage = vi.fn(async () => ({
      handled: true as const,
      result: { ok: true, nativeTurnId: 'native-turn-1' },
    }));

    registerSessionHandlers(registrar, process.cwd(), {
      sessionRuntimeControls: {
        handleUserMessage,
      },
    });

    await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
      text: '/native first turn',
      localId: 'local-native-1',
      meta: { source: 'test' },
    })).resolves.toEqual({
      ok: true,
      nativeTurnId: 'native-turn-1',
    });

    expect(handleUserMessage).toHaveBeenCalledWith({
      text: '/native first turn',
      localId: 'local-native-1',
      meta: {
        sentFrom: 'ui',
        source: 'ui',
      },
    });
  });

  it('admits composer references against the submitted text at the request boundary', async () => {
    // The protocol sanitizer parses metadata independently of the message it accompanies, so
    // the half of the token contract that needs the text can only be enforced
    // where both are in hand — this handler. Without the text the whole check is inert, so the
    // wiring itself is the contract being asserted here, not just the protocol helper.
    const registerSessionHandlers = await loadRegisterSessionHandlers();
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
            { kind: 'happier.file', ref: 'file:src/a.ts', token: '@src/a.ts' },
            // The submitted text carries `@src/b.ts`, never `@src/z.ts`.
            { kind: 'happier.file', ref: 'file:src/z.ts', token: '@src/z.ts' },
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

  it('sanitizes uploaded image metadata before runtime message controls', async () => {
    const registerSessionHandlers = await loadRegisterSessionHandlers();
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

      await expect(handlers.get(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND)?.({
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
              {
                kind: 'image',
                mimeType: 'image/png',
                localPath: '.happier/uploads/messages/m1/forged.png',
                sha256: '0'.repeat(64),
                provenance: { kind: 'sessionAttachmentUpload' },
              },
            ],
          },
        },
      })).resolves.toEqual({ ok: true });

      expect(handleUserMessage).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({
          happierStructuredInputV1: expect.objectContaining({
            imageInputs: [
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
            imageInputs: [
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
});

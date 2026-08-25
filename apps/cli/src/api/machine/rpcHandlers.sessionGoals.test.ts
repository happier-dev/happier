import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Credentials, StoredCredentials } from '@/persistence';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const routeMocks = vi.hoisted(() => ({
  routeSessionUsageLimitRecoveryWaitResumeEnable: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeCancel: vi.fn(),
  routeSessionUsageLimitRecoveryCheckNow: vi.fn(),
  routeSessionUsageLimitRecoverySwitchAccountNow: vi.fn(),
}));
const qualifiedGroupApiMocks = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock('@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter', () => ({
  routeSessionUsageLimitRecoveryWaitResumeEnable: routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable,
  routeSessionUsageLimitRecoveryWaitResumeCancel: routeMocks.routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryCheckNow: routeMocks.routeSessionUsageLimitRecoveryCheckNow,
}));
vi.mock('@/session/usageLimitRecoveryControls/sessionUsageLimitRecoverySwitchAccountNow', () => ({
  routeSessionUsageLimitRecoverySwitchAccountNow: routeMocks.routeSessionUsageLimitRecoverySwitchAccountNow,
}));
vi.mock('@/api/client/qualifiedConnectedAccountApi', () => ({
  readQualifiedConnectedAccountGroupV4: qualifiedGroupApiMocks.read,
}));

import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';

describe('rpcHandlers.sessionGoals', () => {
  const credentials: Credentials = {
    token: 'token-1',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
  const tokenOnlyCredentials: StoredCredentials = {
    token: 'token-only',
    encryption: null,
  };

  let handlers: Map<string, (raw: unknown) => Promise<unknown>>;
  let sessionGoalSet: ReturnType<typeof vi.fn>;
  let sessionGoalClear: ReturnType<typeof vi.fn>;
  let sessionGoalGet: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeEnable: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeCancel: ReturnType<typeof vi.fn>;
  let sessionUsageLimitCheckNow: ReturnType<typeof vi.fn>;
  let sessionUsageLimitSwitchAccountNow: ReturnType<typeof vi.fn>;
  let sessionUsageLimitConsumeResetCredit: ReturnType<typeof vi.fn>;
  let sessionVendorPluginCatalogList: ReturnType<typeof vi.fn>;
  let sessionSkillCatalogList: ReturnType<typeof vi.fn>;
  let createCliActionDepsParams: unknown;
  let stageUsageLimitRecoveryMutation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = new Map();
    sessionGoalSet = vi.fn(async () => ({ ok: true }));
    sessionGoalClear = vi.fn(async () => ({ ok: true }));
    sessionGoalGet = vi.fn(async () => ({ workState: null }));
    sessionUsageLimitWaitResumeEnable = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    sessionUsageLimitWaitResumeCancel = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    sessionUsageLimitCheckNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    sessionUsageLimitSwitchAccountNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    sessionUsageLimitConsumeResetCredit = vi.fn(async () => ({ ok: true, status: 'ready' }));
    sessionVendorPluginCatalogList = vi.fn(async () => ({ vendorPlugins: [] }));
    sessionSkillCatalogList = vi.fn(async () => ({ skills: [] }));
    createCliActionDepsParams = null;
    stageUsageLimitRecoveryMutation = vi.fn(async () => undefined);
    routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable.mockReset();
    routeMocks.routeSessionUsageLimitRecoveryWaitResumeCancel.mockReset();
    routeMocks.routeSessionUsageLimitRecoveryCheckNow.mockReset();
    routeMocks.routeSessionUsageLimitRecoverySwitchAccountNow.mockReset();
    qualifiedGroupApiMocks.read.mockReset();
    routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable.mockResolvedValue({ ok: true, status: 'waiting' });
    routeMocks.routeSessionUsageLimitRecoveryWaitResumeCancel.mockResolvedValue({ ok: true, status: 'cancelled' });
    routeMocks.routeSessionUsageLimitRecoveryCheckNow.mockResolvedValue({ ok: true, status: 'waiting' });
    routeMocks.routeSessionUsageLimitRecoverySwitchAccountNow.mockResolvedValue({ ok: true, status: 'waiting' });
  });

  function registerWithTransport(extraDeps: Partial<Parameters<typeof registerMachineSessionGoalRpcHandlers>[0]['deps']> = {}) {
    const rawSession = createSessionRecordFixture({
      id: 'resolved-session',
      metadata: '{}',
      path: '/repo',
      host: 'localhost',
      machineId: 'machine-1',
      encryptionMode: 'e2ee',
    });
    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      deps: {
        isUsageLimitRecoveryEnabled: async () => true,
        readStoredCredentials: async () => credentials,
        resolveSessionTransportContext: async () => ({
          ok: true,
          sessionId: 'resolved-session',
          rawSession,
          accountEncryptionCurrentness: {
            mode: 'e2ee', version: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: 'content-fingerprint', updatedAt: 1,
          },
          ctx: {
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
          },
          mode: 'e2ee',
        }),
        currentMachineId: 'machine-1',
        stageUsageLimitRecoveryMutation: async ({ mutation }) => {
          await stageUsageLimitRecoveryMutation(mutation);
        },
        createCliActionDeps: (input) => {
          createCliActionDepsParams = input;
          return {
            sessionGoalSet,
            sessionGoalClear,
            sessionGoalGet,
            sessionUsageLimitWaitResumeEnable,
            sessionUsageLimitWaitResumeCancel,
            sessionUsageLimitCheckNow,
            sessionUsageLimitSwitchAccountNow,
            sessionUsageLimitConsumeResetCredit,
            sessionVendorPluginCatalogList,
            sessionSkillCatalogList,
          };
        },
        ...extraDeps,
      },
    });
  }

  it('routes inactive-session goal controls through CLI action deps', async () => {
    registerWithTransport();

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET)?.({
      sessionId: 'session-prefix',
      status: 'paused',
    })).resolves.toEqual({ ok: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({ ok: true });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_GET)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({ workState: null });

    expect(sessionGoalSet).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      status: 'paused',
    });
    expect(sessionGoalClear).toHaveBeenCalledWith({ sessionId: 'resolved-session' });
    expect(sessionGoalGet).toHaveBeenCalledWith({ sessionId: 'resolved-session' });
  });

  it('routes plaintext session goal controls with token-only credentials', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'resolved-session',
      metadata: '{}',
      path: '/repo',
      host: 'localhost',
      machineId: 'machine-1',
      encryptionMode: 'plain',
    });
    registerWithTransport({
      readStoredCredentials: async () => tokenOnlyCredentials,
      resolveSessionTransportContext: async () => ({
        ok: true,
        sessionId: 'resolved-session',
        rawSession,
        accountEncryptionCurrentness: {
          mode: 'plain', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1,
        },
        ctx: null,
        mode: 'plain',
      }),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_GET)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({ workState: null });
    expect(createCliActionDepsParams).toMatchObject({
      credentials: tokenOnlyCredentials,
      mode: 'plain',
      ctx: null,
    });
  });

  it('returns stable invalid-parameter errors before dispatching malformed controls', async () => {
    registerWithTransport();

    const result = await handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET)?.({
      sessionId: 'session-prefix',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionGoalSet).not.toHaveBeenCalled();
  });

  it('routes inactive-session catalog list controls through CLI action deps', async () => {
    sessionVendorPluginCatalogList.mockResolvedValueOnce({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    sessionSkillCatalogList.mockResolvedValueOnce({
      skills: [{ name: 'review', origin: 'codex_native' }],
    });
    registerWithTransport();

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_VENDOR_PLUGIN_CATALOG_LIST)?.({
      sessionId: 'session-prefix',
      cwd: '/repo',
    })).resolves.toEqual({
      vendorPlugins: [{ name: 'gmail', vendorPluginRef: 'plugin://gmail@openai-curated' }],
    });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_SKILL_CATALOG_LIST)?.({
      sessionId: 'session-prefix',
      cwd: '/repo',
    })).resolves.toEqual({
      skills: [{ name: 'review', origin: 'codex_native' }],
    });

    expect(sessionVendorPluginCatalogList).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      cwd: '/repo',
    });
    expect(sessionSkillCatalogList).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      cwd: '/repo',
    });
  });

  it('makes the daemon handler the sole local inactive usage-limit control owner', async () => {
    const resumeInactiveSessionWhenUsageLimitReady = vi.fn(async () => true);
    const scheduleInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    const cancelInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    registerWithTransport({
      resumeInactiveSessionWhenUsageLimitReady,
      scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      rememberPreference: true,
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'resolved-session' });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL)?.({
      sessionId: 'session-prefix',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      armedAtMs: 123,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'resolved-session' });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
      provider: ' codex ',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'resolved-session' });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW)?.({
      sessionId: 'session-prefix',
      provider: ' codex ',
      operation: 'switch_account_now',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'resolved-session' });
    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT)?.({
      sessionId: 'session-prefix',
      provider: ' codex ',
      issueFingerprint: 'usage-limit:codex:turn-1',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'resolved-session' });

    expect(routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'resolved-session',
      currentMachineId: 'machine-1',
      stageUsageLimitRecoveryMutation: expect.any(Function),
    }));
    expect(routeMocks.routeSessionUsageLimitRecoveryWaitResumeCancel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'resolved-session',
      stageUsageLimitRecoveryMutation: expect.any(Function),
    }));
    expect(routeMocks.routeSessionUsageLimitRecoveryCheckNow).toHaveBeenCalledTimes(2);
    expect(routeMocks.routeSessionUsageLimitRecoverySwitchAccountNow).toHaveBeenCalledTimes(1);
    expect(createCliActionDepsParams).toBeNull();
    expect(sessionUsageLimitWaitResumeEnable).not.toHaveBeenCalled();
    expect(sessionUsageLimitWaitResumeCancel).not.toHaveBeenCalled();
    expect(sessionUsageLimitCheckNow).not.toHaveBeenCalled();
    expect(sessionUsageLimitSwitchAccountNow).not.toHaveBeenCalled();
    expect(sessionUsageLimitConsumeResetCredit).not.toHaveBeenCalled();

    const daemonStage = routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable.mock.calls[0]?.[0]
      ?.stageUsageLimitRecoveryMutation;
    await daemonStage?.({
      v: 1,
      sessionId: 'resolved-session',
      mutationId: 'usage-mutation-1',
      fieldId: 'runtime.usageLimitRecovery',
      deliveryClass: 'durable_required',
      source: 'daemon',
      observedAt: 1,
      op: { kind: 'clear' },
    });
    expect(stageUsageLimitRecoveryMutation).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'runtime.usageLimitRecovery',
      source: 'daemon',
    }));
  });

  it('reads a scalar recovery group policy from the qualified V4 owner', async () => {
    qualifiedGroupApiMocks.read.mockResolvedValueOnce({
      policy: { resumePromptMode: 'off' },
    });
    registerWithTransport();

    await handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
    });
    const loadGroupPolicy = routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable
      .mock.calls[0]?.[0]?.resumePromptTierSources?.loadGroupPolicy;

    await expect(loadGroupPolicy?.({
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: null,
    })).resolves.toEqual({ resumePromptMode: 'off' });
    expect(qualifiedGroupApiMocks.read).toHaveBeenCalledWith({
      token: 'token-1',
      group: {
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        groupId: 'codex-main',
      },
    });
  });

  it('routes plain inactive usage-limit control with token-only credentials and no crypto context', async () => {
    const rawSession = createSessionRecordFixture({
      id: 'resolved-session',
      metadata: '{}',
      path: '/repo',
      host: 'localhost',
      machineId: 'machine-1',
      encryptionMode: 'plain',
    });
    registerWithTransport({
      readStoredCredentials: async () => tokenOnlyCredentials,
      resolveSessionTransportContext: async () => ({
        ok: true,
        sessionId: 'resolved-session',
        rawSession,
        accountEncryptionCurrentness: {
          mode: 'plain', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1,
        },
        ctx: null,
        mode: 'plain',
      }),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'resolved-session' });

    expect(routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable).toHaveBeenCalledWith(expect.objectContaining({
      credentials: tokenOnlyCredentials,
      ctx: null,
      mode: 'plain',
    }));
    expect(createCliActionDepsParams).toBeNull();
  });

  it('preserves typed unavailable for retained E2EE usage-limit control without material', async () => {
    registerWithTransport({
      readStoredCredentials: async () => tokenOnlyCredentials,
      resolveSessionTransportContext: async () => ({
        ok: false,
        code: 'encryption_material_unavailable',
        sessionId: 'resolved-session',
      }),
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'resolved-session',
      errorCode: 'encryption_material_unavailable',
    });
    expect(routeMocks.routeSessionUsageLimitRecoveryWaitResumeEnable).not.toHaveBeenCalled();
  });

  it('returns invalid-parameter errors for malformed daemon usage-limit controls', async () => {
    registerWithTransport();

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
      issueFingerprint: '   ',
    })).resolves.toEqual({
      ok: false,
      status: 'malformed_response',
      errorCode: 'invalid_parameters',
    });

    expect(sessionUsageLimitWaitResumeEnable).not.toHaveBeenCalled();
  });

  it('fails closed for daemon usage-limit controls when the feature is disabled', async () => {
    registerWithTransport({
      isUsageLimitRecoveryEnabled: async () => false,
    });

    await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE)?.({
      sessionId: 'session-prefix',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'session-prefix',
      errorCode: 'feature_disabled',
    });

    expect(sessionUsageLimitWaitResumeEnable).not.toHaveBeenCalled();
  });
});

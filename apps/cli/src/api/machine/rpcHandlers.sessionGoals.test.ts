import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Credentials } from '@/persistence';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';

describe('rpcHandlers.sessionGoals', () => {
  const credentials: Credentials = {
    token: 'token-1',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };

  let handlers: Map<string, (raw: unknown) => Promise<unknown>>;
  let sessionGoalSet: ReturnType<typeof vi.fn>;
  let sessionGoalClear: ReturnType<typeof vi.fn>;
  let sessionGoalGet: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeEnable: ReturnType<typeof vi.fn>;
  let sessionUsageLimitWaitResumeCancel: ReturnType<typeof vi.fn>;
  let sessionUsageLimitCheckNow: ReturnType<typeof vi.fn>;
  let sessionUsageLimitSwitchAccountNow: ReturnType<typeof vi.fn>;
  let sessionVendorPluginCatalogList: ReturnType<typeof vi.fn>;
  let sessionSkillCatalogList: ReturnType<typeof vi.fn>;
  let createCliActionDepsParams: unknown;

  beforeEach(() => {
    handlers = new Map();
    sessionGoalSet = vi.fn(async () => ({ ok: true }));
    sessionGoalClear = vi.fn(async () => ({ ok: true }));
    sessionGoalGet = vi.fn(async () => ({ workState: null }));
    sessionUsageLimitWaitResumeEnable = vi.fn(async () => ({ ok: true, recovery: { status: 'waiting' } }));
    sessionUsageLimitWaitResumeCancel = vi.fn(async () => ({ ok: true, recovery: { status: 'cancelled' } }));
    sessionUsageLimitCheckNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    sessionUsageLimitSwitchAccountNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    sessionVendorPluginCatalogList = vi.fn(async () => ({ vendorPlugins: [] }));
    sessionSkillCatalogList = vi.fn(async () => ({ skills: [] }));
    createCliActionDepsParams = null;
  });

  function registerWithTransport(extraDeps: Partial<Parameters<typeof registerMachineSessionGoalRpcHandlers>[0]['deps']> = {}) {
    const rawSession = createSessionRecordFixture({
      id: 'resolved-session',
      metadata: '{}',
      path: '/repo',
      host: 'localhost',
      machineId: 'machine-1',
      encryptionMode: 'plain',
    });
    registerMachineSessionGoalRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
      deps: {
        isUsageLimitRecoveryEnabled: async () => true,
        readCredentials: async () => credentials,
        resolveSessionTransportContext: async () => ({
          ok: true,
          sessionId: 'resolved-session',
          rawSession,
          ctx: {
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
          },
          mode: 'plain',
        }),
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

  it('routes inactive-session usage-limit controls through CLI action deps', async () => {
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
      issueFingerprint: null,
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

    expect(sessionUsageLimitWaitResumeEnable).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      issueFingerprint: 'usage-limit:session-prefix:reset',
      remember: true,
      resumePromptMode: 'custom',
    });
    expect(sessionUsageLimitWaitResumeCancel).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      issueFingerprint: null,
    });
    expect(sessionUsageLimitCheckNow).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      provider: 'codex',
      resumePromptMode: 'custom',
    });
    expect(sessionUsageLimitSwitchAccountNow).toHaveBeenCalledWith({
      sessionId: 'resolved-session',
      provider: 'codex',
      resumePromptMode: 'custom',
    });
    expect(createCliActionDepsParams).toEqual(expect.objectContaining({
      resumeInactiveSessionWhenUsageLimitReady,
      scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck,
    }));
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

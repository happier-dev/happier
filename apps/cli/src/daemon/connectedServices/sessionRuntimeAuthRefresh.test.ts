import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceDaemonAuthBridgeRefreshResult } from './daemonAuthBridgeTypes';

import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from './connectedServiceChildEnvironment';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from './runtimeAuth/types';
import { ConnectedServiceRuntimeRegistry } from './runtimeRegistry/registry';
import { createSessionConnectedServiceRuntimeAuthRefreshHandler } from './sessionRuntimeAuthRefresh';
import { createSessionHandleAuthService } from '@/plugins/runtime/context/session/services/auth';

function buildRegistry(): ConnectedServiceRuntimeRegistry {
  const registry = new ConnectedServiceRuntimeRegistry();
  registry.registerTarget({
    pid: 123,
    agentId: 'codex',
    sessionId: 'session-1',
    materializationKey: 'materialization-1',
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'main',
          profileId: 'fallback',
        },
      },
    },
    connectedServiceSelectionsEnv: {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        fallbackProfileId: 'fallback',
        generation: 7,
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      }]),
    },
  });
  return registry;
}

function buildClaudeRegistry(): ConnectedServiceRuntimeRegistry {
  const registry = new ConnectedServiceRuntimeRegistry();
  registry.registerTarget({
    pid: 456,
    agentId: 'claude',
    sessionId: 'claude-session-1',
    materializationKey: 'claude-materialization-1',
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': {
          source: 'connected',
          selection: 'profile',
          profileId: 'claude-profile',
        },
      },
    },
    connectedServiceSelectionsEnv: {
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'claude-profile',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      }]),
    },
  });
  return registry;
}

const selection = {
  kind: 'group' as const,
  serviceId: 'openai-codex' as const,
  groupId: 'main',
  activeProfileId: 'primary',
  fallbackProfileId: 'fallback',
  generation: 7,
};

function bridgeRefreshResult(value: unknown): Promise<ConnectedServiceDaemonAuthBridgeRefreshResult> {
  // Deliberately bypass the compile-time plugin contract to exercise hostile/stale runtime plugins.
  return Promise.resolve(value as ConnectedServiceDaemonAuthBridgeRefreshResult);
}

function unsupportedRuntimeAuthAdapter(): ConnectedServiceProviderRuntimeAuthAdapter {
  return {
    classifyRuntimeAuthFailure: () => null,
    materializeActiveProfile: async () => ({}),
    canHotApply: () => ({}),
    hotApply: async () => ({}),
    recoverAfterRuntimeAuthSwitch: async () => ({}),
    probeQuota: async () => ({}),
    refreshActiveProfile: async () => ({ status: 'unsupported' }),
  };
}

describe('createSessionConnectedServiceRuntimeAuthRefreshHandler', () => {
  it('authorizes the live session exact selection and delegates to the canonical daemon bridge', async () => {
    const registry = buildRegistry();
    const refresh = vi.fn(async () => ({
      status: 'refreshed' as const,
      result: {
        accessToken: 'fresh-token',
        chatgptAccountId: 'acct-1',
        chatgptPlanType: 'plus',
      },
    }));
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry,
      resolveDaemonAuthBridge: async () => ({
        registration: { serviceId: 'openai-codex', refresh },
      }),
    });

    await expect(handler({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-1',
      selection,
      planType: 'plus',
      failingAccessTokenFingerprint: 'sha256:failed',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      reason: 'chatgpt_auth_tokens_refresh',
    })).resolves.toEqual({
      ok: true,
      result: {
        status: 'refreshed',
        result: {
          accessToken: 'fresh-token',
          chatgptAccountId: 'acct-1',
          chatgptPlanType: 'plus',
        },
      },
    });
    expect(refresh).toHaveBeenCalledWith({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-1',
      selection,
      planType: 'plus',
      failingAccessTokenFingerprint: 'sha256:failed',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      reason: 'chatgpt_auth_tokens_refresh',
      forceRefresh: true,
    });
  });

  it('settles a known credential-health bridge failure as typed reconnect-required instead of rejecting the daemon route', async () => {
    const reconnectRequired = Object.assign(
      new Error('credential refresh requires reconnect'),
      { code: 'connected_service_credential_reconnect_required' as const },
    );
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry: buildRegistry(),
      resolveDaemonAuthBridge: async () => ({
        registration: {
          serviceId: 'openai-codex',
          refresh: async () => { throw reconnectRequired; },
        },
      }),
    });

    await expect(handler({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-needs-reauth',
      selection,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual({
      ok: true,
      result: {
        status: 'failed',
        reason: 'connected_service_credential_reconnect_required',
      },
    });
  });

  it.each([
    ['failed', { status: 'failed', reason: 'provider_failed' }, { status: 'failed', reason: 'provider_failed' }],
    ['unavailable', { status: 'unavailable', reason: 'provider_unavailable' }, { status: 'unavailable', reason: 'provider_unavailable' }],
    ['matching pending', { status: 'pending', refreshAttemptId: 'codex-refresh-attempt-1' }, { status: 'pending', refreshAttemptId: 'codex-refresh-attempt-1' }],
  ])('preserves an explicit bridge %s settlement', async (_name, bridgeResult, expected) => {
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry: buildRegistry(),
      resolveDaemonAuthBridge: async () => ({
        registration: {
          serviceId: 'openai-codex',
          refresh: async () => await bridgeRefreshResult(bridgeResult),
        },
      }),
    });

    await expect(handler({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-1',
      selection,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual({ ok: true, result: expected });
  });

  it('composes the Claude runtime request through the real session service and exact daemon bridge identity', async () => {
    const refresh = vi.fn(async () => ({
      status: 'refreshed' as const,
      result: { accessToken: 'fresh-claude-access' },
    }));
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry: buildClaudeRegistry(),
      resolveDaemonAuthBridge: async () => ({
        registration: { serviceId: 'claude-subscription', refresh },
      }),
    });
    const auth = createSessionHandleAuthService({
      readSessionId: async () => 'claude-session-1',
      readAgentId: async () => 'claude',
      resolveAdapter: async () => unsupportedRuntimeAuthAdapter(),
      refreshViaDaemon: async (request) => {
        const settlement = await handler({
          sessionId: request.sessionId,
          refreshAttemptId: request.refreshAttemptId,
          selection: {
            kind: 'profile',
            serviceId: 'claude-subscription',
            profileId: 'claude-profile',
          },
          expectedCredentialRevision: request.expectedCredentialRevision,
          reason: request.reason,
        });
        if (!settlement.ok) throw new Error(settlement.errorCode);
        return settlement.result;
      },
    });

    await expect(auth.services.refreshRuntimeAuth({
      serviceId: 'claude-subscription',
      refreshAttemptId: 'claude-auth-refresh-stable',
      selection: {
        kind: 'profile',
        serviceId: 'claude-subscription',
        profileId: 'claude-profile',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      },
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      reason: 'claude_agent_sdk_oauth_token_refresh',
    })).resolves.toEqual({
      status: 'refreshed',
      result: { accessToken: 'fresh-claude-access' },
    });
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      refreshAttemptId: 'claude-auth-refresh-stable',
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
      reason: 'claude_agent_sdk_oauth_token_refresh',
    }));
  });

  it.each([
    ['mismatched pending', { status: 'pending', refreshAttemptId: 'someone-else' }],
    ['nested failed', { status: 'refreshed', result: { status: 'failed', reason: 'nested_failure' } }],
    ['raw credentials', { accessToken: 'unproven-token' }],
    ['malformed status', { status: 'refreshed' }],
    ['undefined', undefined],
  ])('fails closed for a fulfilled bridge %s result', async (_name, bridgeResult) => {
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry: buildRegistry(),
      resolveDaemonAuthBridge: async () => ({
        registration: {
          serviceId: 'openai-codex',
          refresh: async () => await bridgeRefreshResult(bridgeResult),
        },
      }),
    });

    await expect(handler({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-1',
      selection,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual({
      ok: true,
      result: {
        status: 'failed',
        reason: _name === 'mismatched pending'
          ? 'runtime_auth_refresh_attempt_mismatch'
          : 'runtime_auth_refresh_invalid_bridge_result',
      },
    });
  });

  it.each([
    ['explicit proof', { status: 'refreshed', result: { accessToken: 'fresh-token' } }, { status: 'refreshed', result: { accessToken: 'fresh-token' } }],
    ['failed', { status: 'failed', reason: 'provider_failed' }, { status: 'failed', reason: 'provider_failed' }],
    ['unavailable', { status: 'unavailable', reason: 'provider_unavailable' }, { status: 'unavailable', reason: 'provider_unavailable' }],
    ['matching pending', { status: 'pending', refreshAttemptId: 'composed-attempt' }, { status: 'pending', refreshAttemptId: 'composed-attempt' }],
    ['nested failure', { status: 'refreshed', result: { status: 'failed', reason: 'nested' } }, { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' }],
    ['nested unavailable', { status: 'refreshed', result: { status: 'unavailable', reason: 'nested' } }, { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' }],
    ['nested pending', { status: 'refreshed', result: { status: 'pending', refreshAttemptId: 'composed-attempt' } }, { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' }],
    ['raw no-proof', { accessToken: 'raw-token' }, { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' }],
    ['undefined', undefined, { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' }],
  ])('preserves truthful %s settlement through the bridge handler and real session auth service', async (
    _name,
    bridgeResult,
    expected,
  ) => {
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry: buildRegistry(),
      resolveDaemonAuthBridge: async () => ({
        registration: {
          serviceId: 'openai-codex',
          refresh: async () => await bridgeRefreshResult(bridgeResult),
        },
      }),
    });
    const auth = createSessionHandleAuthService({
      readSessionId: async () => 'session-1',
      readAgentId: async () => 'codex',
      resolveAdapter: async () => unsupportedRuntimeAuthAdapter(),
      refreshViaDaemon: async (request) => {
        const settlement = await handler({
          sessionId: request.sessionId,
          refreshAttemptId: request.refreshAttemptId,
          selection,
          expectedCredentialRevision: request.expectedCredentialRevision,
        });
        if (!settlement.ok) throw new Error(settlement.errorCode);
        return settlement.result;
      },
    });

    await expect(auth.services.refreshRuntimeAuth({
      serviceId: 'openai-codex',
      refreshAttemptId: 'composed-attempt',
      selection,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual(expected);
  });

  it('uses the registered current selection when an SDK callback still carries launch-era selection', async () => {
    const refresh = vi.fn();
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry: buildRegistry(),
      resolveDaemonAuthBridge: async () => ({
        registration: { serviceId: 'openai-codex', refresh },
      }),
    });

    await expect(handler({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-recheck',
      selection: { ...selection, activeProfileId: 'someone-else' },
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual({ ok: true, result: { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' } });
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      selection,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    }));
  });

  it('rechecks the exact runtime target after asynchronous bridge resolution', async () => {
    const registry = buildRegistry();
    const refresh = vi.fn();
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry,
      resolveDaemonAuthBridge: async () => {
        registry.unregisterPid(123);
        return { registration: { serviceId: 'openai-codex', refresh } };
      },
    });

    await expect(handler({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-recheck',
      selection,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'connected_service_session_refresh_forbidden',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects a refreshed credential when the exact session target is replaced while refresh is in flight', async () => {
    const registry = buildRegistry();
    let finishRefresh!: () => void;
    const refreshBarrier = new Promise<void>((resolve) => { finishRefresh = resolve; });
    const refresh = vi.fn(async () => {
      await refreshBarrier;
      return {
        status: 'refreshed' as const,
        result: { accessToken: 'must-not-be-returned' },
      };
    });
    const handler = createSessionConnectedServiceRuntimeAuthRefreshHandler({
      registry,
      resolveDaemonAuthBridge: async () => ({
        registration: { serviceId: 'openai-codex', refresh },
      }),
    });

    const resultPromise = handler({
      sessionId: 'session-1',
      refreshAttemptId: 'codex-refresh-attempt-replaced',
      selection,
      expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    registry.registerTarget({
      pid: 456,
      agentId: 'codex',
      sessionId: 'session-1',
      materializationKey: 'materialization-2',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'replacement',
          },
        },
      },
      connectedServiceSelectionsEnv: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'replacement',
          activeProfileId: 'replacement-profile',
          fallbackProfileId: 'replacement-profile',
          generation: 8,
          credentialRevision: 'csr_ZYXWVUTSRQPNMKJHGFEDCBA987',
        }]),
      },
    });
    finishRefresh();

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      errorCode: 'connected_service_session_refresh_forbidden',
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
});

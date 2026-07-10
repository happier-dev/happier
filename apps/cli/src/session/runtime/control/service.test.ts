import { describe, expect, it, vi } from 'vitest';
import type {
  HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
  HostRuntimeControlConnectedServiceAuthApplyGenerationOutputV1,
  HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
  HostRuntimeControlConnectedServiceRuntimeIdentityOutputV1,
  HostRuntimeControlResultV1,
} from '@happier-dev/agents';

import { createHostRuntimeControlService } from './service';

type SessionConnectedServiceAuthControls = Readonly<{
  applyConnectedServiceAuthGeneration: (
    input: HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
  ) => Promise<HostRuntimeControlResultV1<HostRuntimeControlConnectedServiceAuthApplyGenerationOutputV1>>;
  readConnectedServiceRuntimeIdentity: (
    input: HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
  ) => Promise<HostRuntimeControlResultV1<HostRuntimeControlConnectedServiceRuntimeIdentityOutputV1>>;
}>;

describe('createHostRuntimeControlService', () => {
  it('fails closed when session transport invalidation context is unavailable', async () => {
    const service = createHostRuntimeControlService({
      agentId: 'test-agent',
      context: {
        cwd: '/workspace',
        metadata: {},
        accountSettings: null,
        processEnv: {},
      },
    });

    await expect(service.session.checkConnectedServiceAuthTransportInvalidation()).resolves.toEqual({
      ok: false,
      code: 'session_transport_unavailable',
      error: 'session_transport_unavailable',
      diagnostics: [{ code: 'session_transport_unavailable' }],
    });
    await expect(service.session.invalidateConnectedServiceAuthTransports()).resolves.toEqual({
      ok: false,
      code: 'session_transport_unavailable',
      error: 'session_transport_unavailable',
      diagnostics: [{ code: 'session_transport_unavailable' }],
    });
  });

  it('fails closed when connected-service auth apply and identity delegates are unavailable', async () => {
    const service = createHostRuntimeControlService({
      agentId: 'test-agent',
      context: {
        cwd: '/workspace',
        metadata: {},
        accountSettings: null,
        processEnv: {},
      },
    });
    const sessionControls = service.session as typeof service.session & SessionConnectedServiceAuthControls;

    await expect(sessionControls.applyConnectedServiceAuthGeneration({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: { kind: 'oauth' },
    })).resolves.toEqual({
      ok: false,
      code: 'connected_service_auth_apply_unavailable',
      error: 'connected_service_auth_apply_unavailable',
      diagnostics: [{ code: 'connected_service_auth_apply_unavailable' }],
    });
    await expect(sessionControls.readConnectedServiceRuntimeIdentity({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
    })).resolves.toEqual({
      ok: false,
      code: 'connected_service_runtime_identity_unavailable',
      error: 'connected_service_runtime_identity_unavailable',
      diagnostics: [{ code: 'connected_service_runtime_identity_unavailable' }],
    });
  });

  it('delegates connected-service auth apply and identity reads through sanitized session controls', async () => {
    const applyConnectedServiceAuthGeneration = vi.fn(async (
      _input: HostRuntimeControlConnectedServiceAuthApplyGenerationInputV1,
    ): Promise<HostRuntimeControlResultV1<HostRuntimeControlConnectedServiceAuthApplyGenerationOutputV1>> => ({
      ok: true,
      value: {
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_1',
      },
    }));
    const readConnectedServiceRuntimeIdentity = vi.fn(async (
      _input: HostRuntimeControlConnectedServiceRuntimeIdentityInputV1,
    ): Promise<HostRuntimeControlResultV1<HostRuntimeControlConnectedServiceRuntimeIdentityOutputV1>> => ({
      ok: false,
      code: 'provider_failed',
      error: '/Users/leeroy/.codex/auth.json contains sk-secret-token',
      diagnostics: [{
        code: 'provider_failed',
        message: 'Bearer sk-secret-token in stderr',
        details: { path: '/Users/leeroy/.codex/auth.json' },
      }],
    }));
    const service = createHostRuntimeControlService({
      agentId: 'test-agent',
      context: {
        cwd: '/workspace',
        metadata: {},
        accountSettings: null,
        processEnv: {},
      },
      session: {
        applyConnectedServiceAuthGeneration,
        readConnectedServiceRuntimeIdentity,
      },
    });
    const sessionControls = service.session as typeof service.session & SessionConnectedServiceAuthControls;

    await expect(sessionControls.applyConnectedServiceAuthGeneration({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: { kind: 'oauth' },
    })).resolves.toEqual({
      ok: true,
      value: {
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_1',
      },
    });
    const identityResult = await sessionControls.readConnectedServiceRuntimeIdentity({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
    });

    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: { kind: 'oauth' },
    }, undefined);
    expect(readConnectedServiceRuntimeIdentity).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
    }, undefined);
    expect(identityResult).toEqual({
      ok: false,
      code: 'provider_failed',
      error: 'provider_failed',
      diagnostics: [{ code: 'provider_failed' }],
    });
    expect(JSON.stringify(identityResult)).not.toContain('/Users/leeroy');
    expect(JSON.stringify(identityResult)).not.toContain('sk-secret-token');
    expect(JSON.stringify(identityResult)).not.toContain('Bearer');
  });

  it('propagates aborts before invoking app-server request delegates', async () => {
    const request = vi.fn(async (): Promise<HostRuntimeControlResultV1<string>> => ({ ok: true, value: 'unreachable' }));
    const controller = new AbortController();
    controller.abort();
    const service = createHostRuntimeControlService({
      agentId: 'test-agent',
      context: {
        cwd: '/workspace',
        metadata: {},
        accountSettings: null,
        processEnv: {},
      },
      appServer: { request },
    });

    await expect(service.appServer.request({
      method: 'account/read',
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      code: 'runtime_control_aborted',
      error: 'runtime_control_aborted',
      diagnostics: [{ code: 'runtime_control_aborted' }],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('sanitizes diagnostics when app-server delegates fail', async () => {
    const service = createHostRuntimeControlService({
      agentId: 'test-agent',
      context: {
        cwd: '/workspace',
        metadata: {},
        accountSettings: null,
        processEnv: {},
      },
      appServer: {
        request: vi.fn(async () => {
          throw new Error('/Users/leeroy/.codex/auth.json contains sk-secret-token');
        }),
      },
    });

    const result = await service.appServer.request({ method: 'account/read' });

    expect(result).toEqual({
      ok: false,
      code: 'app_server_control_failed',
      error: 'app_server_control_failed',
      diagnostics: [{ code: 'app_server_control_failed' }],
    });
    expect(JSON.stringify(result)).not.toContain('/Users/leeroy');
    expect(JSON.stringify(result)).not.toContain('sk-secret-token');
  });

  it('sanitizes diagnostics returned by app-server delegates', async () => {
    const service = createHostRuntimeControlService({
      agentId: 'test-agent',
      context: {
        cwd: '/workspace',
        metadata: {},
        accountSettings: null,
        processEnv: {},
      },
      appServer: {
        request: async () => ({
          ok: false,
          code: 'provider_failed',
          error: '/Users/leeroy/.codex/auth.json contains sk-secret-token',
          diagnostics: [{
            code: 'provider_failed',
            message: 'Bearer sk-secret-token in stderr',
            details: { path: '/Users/leeroy/.codex/auth.json' },
          }],
        }),
      },
    });

    const result = await service.appServer.request({ method: 'account/read' });

    expect(result).toEqual({
      ok: false,
      code: 'provider_failed',
      error: 'provider_failed',
      diagnostics: [{ code: 'provider_failed' }],
    });
    expect(JSON.stringify(result)).not.toContain('/Users/leeroy');
    expect(JSON.stringify(result)).not.toContain('sk-secret-token');
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodexAgentRuntimeDescriptor } from '@happier-dev/agents';

import { logger } from '@/utils/logger';

import { forkCodexAppServerConversationNative } from './nativeFork';
import { codexAppServerProviderNativeForkHandler } from './providerNativeForkHandler';

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./nativeFork', () => ({
  forkCodexAppServerConversationNative: vi.fn(async () => ({ type: 'success', vendorSessionId: 'forked-thread' })),
}));

describe('codexAppServerProviderNativeForkHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(forkCodexAppServerConversationNative).mockResolvedValue({ type: 'success', vendorSessionId: 'forked-thread' });
  });
  it('preserves connected-service group affinity in fork metadata', async () => {
    const parentMetadata = {
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'parent-thread',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'main',
        homePath: '/tmp/connected-codex-home',
      }),
    };

    const result = await codexAppServerProviderNativeForkHandler({
      credentials: {} as never,
      agentId: 'codex',
      parentSessionId: 'session-parent',
      parentRawSession: { metadata: parentMetadata },
      parentMetadata,
      directory: '/repo',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 10,
    });

    expect(forkCodexAppServerConversationNative).toHaveBeenCalledWith({
      directory: '/repo',
      parentCodexSessionId: 'parent-thread',
      processEnv: expect.objectContaining({ CODEX_HOME: '/tmp/connected-codex-home' }),
    });
    expect(logger.debug).toHaveBeenCalledWith(
      '[CodexAppServerFork] attempting native latest fork',
      expect.objectContaining({
        agentId: 'codex',
        parentSessionId: 'session-parent',
        backendMode: 'appServer',
        forkPointType: 'latest',
        hasRuntimeDescriptor: true,
        hasVendorSessionId: true,
        hasRuntimeHomePath: true,
      }),
    );
        expect(logger.debug).toHaveBeenCalledWith(
      '[CodexAppServerFork] native latest fork succeeded',
      expect.objectContaining({
        agentId: 'codex',
        parentSessionId: 'session-parent',
        hasForkedVendorSessionId: true,
        fallbackResult: 'native_fork_succeeded',
      }),
    );
    expect(result?.metadata.agentRuntimeDescriptorV1).toMatchObject({
      providerId: 'codex',
      provider: {
        vendorSessionId: 'forked-thread',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'main',
        providerExtra: {
          runtimeAffinity: {
            vendorSessionId: 'forked-thread',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceGroupId: 'main',
          },
        },
      },
    });
    expect(JSON.stringify(result?.metadata.agentRuntimeDescriptorV1)).not.toContain('/tmp/connected-codex-home');
  });

  it('logs an explicit skip reason for non-latest fork points', async () => {
    const parentMetadata = {
      agentRuntimeDescriptorV1: buildCodexAgentRuntimeDescriptor({
        backendMode: 'appServer',
        vendorSessionId: 'parent-thread',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceGroupId: 'main',
        homePath: '/tmp/connected-codex-home',
      }),
    };

    const result = await codexAppServerProviderNativeForkHandler({
      credentials: {} as never,
      agentId: 'codex',
      parentSessionId: 'session-parent',
      parentRawSession: { metadata: parentMetadata },
      parentMetadata,
      directory: '/repo',
      forkPoint: { type: 'seq', upToSeqInclusive: 10 },
      targetSeqInclusive: 10,
    });

    expect(result).toBeNull();
    expect(forkCodexAppServerConversationNative).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
      '[CodexAppServerFork] skipping native fork',
      expect.objectContaining({
        agentId: 'codex',
        parentSessionId: 'session-parent',
        backendMode: 'appServer',
        forkPointType: 'seq',
        skipReason: 'fork_point_not_latest',
        hasVendorSessionId: true,
        fallbackResult: 'fallback_to_replay',
      }),
    );
  });

  it('surfaces a native failure before dispatch instead of flattening it to unsupported', async () => {
    const failure = new Error('app server launch failed');
    vi.mocked(forkCodexAppServerConversationNative).mockResolvedValueOnce({
      type: 'failed_before_dispatch',
      error: failure,
    });
    const parentMetadata = {
      codexBackendMode: 'appServer',
      codexSessionId: 'parent-thread',
    };
    await expect(codexAppServerProviderNativeForkHandler({
      credentials: {} as never,
      agentId: 'codex',
      parentSessionId: 'session-parent',
      parentRawSession: { metadata: parentMetadata },
      parentMetadata,
      directory: '/repo',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 10,
    })).rejects.toMatchObject({
      name: 'ProviderNativeForkFailedBeforeDispatchError',
      cause: failure,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      '[CodexAppServerFork] native latest fork failed',
      expect.objectContaining({
        agentId: 'codex',
        parentSessionId: 'session-parent',
        errorMessage: 'app server launch failed',
        fallbackResult: 'failed_before_dispatch',
      }),
    );
  });

  it('surfaces an indeterminate dispatched fork without allowing replay', async () => {
    vi.mocked(forkCodexAppServerConversationNative).mockResolvedValueOnce({
      type: 'indeterminate_after_dispatch',
      error: new Error('Codex app-server request thread/fork timed out'),
    });
    const parentMetadata = {
      codexBackendMode: 'appServer',
      codexSessionId: 'parent-thread',
    };

    await expect(codexAppServerProviderNativeForkHandler({
      credentials: {} as never,
      agentId: 'codex',
      parentSessionId: 'session-parent',
      parentRawSession: { metadata: parentMetadata },
      parentMetadata,
      directory: '/repo',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 10,
    })).rejects.toMatchObject({ name: 'ProviderNativeForkIndeterminateError' });

    expect(logger.debug).toHaveBeenCalledWith(
      '[CodexAppServerFork] native latest fork outcome is indeterminate',
      expect.objectContaining({
        agentId: 'codex',
        parentSessionId: 'session-parent',
        fallbackResult: 'do_not_replay_outcome_unknown',
      }),
    );
  });

  it('preserves an operation-owned abort for the tracked operation terminalizer', async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error('Action operation cancelled'), { name: 'AbortError' });
    vi.mocked(forkCodexAppServerConversationNative).mockRejectedValueOnce(abortError);
    controller.abort();
    const parentMetadata = {
      codexBackendMode: 'appServer',
      codexSessionId: 'parent-thread',
    };

    await expect(codexAppServerProviderNativeForkHandler({
      credentials: {} as never,
      agentId: 'codex',
      parentSessionId: 'session-parent',
      parentRawSession: { metadata: parentMetadata },
      parentMetadata,
      directory: '/repo',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 10,
      signal: controller.signal,
    })).rejects.toBe(abortError);

    expect(forkCodexAppServerConversationNative).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it('redacts sensitive values from provider-level native fork failure diagnostics', async () => {
    const parentVendorSessionId = '019d94f3-0a6f-7c41-bb18-d26425384658';
    const bearerToken = 'sk-proj-provider-wrapper-secret-token-1234567890';
    const accessToken = 'access-token-provider-wrapper-secret-abcdef';
    const authHeaderToken = 'auth-header-provider-wrapper-secret-uvwxyz';
    const threadId = 'thread_provider_wrapper_secret_abcdef';
    const failure = Object.assign(
      new Error(`failed parent ${parentVendorSessionId}; Authorization: Bearer ${bearerToken}; accessToken=${accessToken}; authHeader=Bearer ${authHeaderToken}; CODEX_THREAD_ID=${threadId}`),
      { code: 'E_PROVIDER_FORK' },
    );
    vi.mocked(forkCodexAppServerConversationNative).mockResolvedValueOnce({
      type: 'indeterminate_after_dispatch',
      error: failure,
    });
    const parentMetadata = {
      codexBackendMode: 'appServer',
      codexSessionId: parentVendorSessionId,
    };

    await expect(codexAppServerProviderNativeForkHandler({
      credentials: {} as never,
      agentId: 'codex',
      parentSessionId: 'session-parent',
      parentRawSession: { metadata: parentMetadata },
      parentMetadata,
      directory: '/repo',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 10,
    })).rejects.toMatchObject({ name: 'ProviderNativeForkIndeterminateError' });
    const serializedDiagnostics = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedDiagnostics).not.toContain(parentVendorSessionId);
    expect(serializedDiagnostics).not.toContain(bearerToken);
    expect(serializedDiagnostics).not.toContain(accessToken);
    expect(serializedDiagnostics).not.toContain(authHeaderToken);
    expect(serializedDiagnostics).not.toContain(threadId);

    expect(logger.debug).toHaveBeenCalledWith(
      '[CodexAppServerFork] native latest fork outcome is indeterminate',
      expect.objectContaining({
        agentId: 'codex',
        parentSessionId: 'session-parent',
        errorName: 'Error',
        errorCode: 'E_PROVIDER_FORK',
        fallbackResult: 'do_not_replay_outcome_unknown',
      }),
    );
    const failedCall = vi.mocked(logger.debug).mock.calls.find(([message]) => message === '[CodexAppServerFork] native latest fork outcome is indeterminate');
    const errorMessage = String((failedCall?.[1] as { errorMessage?: unknown } | undefined)?.errorMessage ?? '');
    expect(errorMessage).toContain('failed parent');
    expect(errorMessage).toContain('[REDACTED]');
  });

  it('does not include raw vendor resume ids in provider-level fork diagnostics', async () => {
    vi.mocked(forkCodexAppServerConversationNative).mockResolvedValueOnce({ type: 'unsupported' });
    const parentMetadata = {
      codexBackendMode: 'appServer',
      codexSessionId: 'raw-parent-provider-thread-id',
    };

    await expect(codexAppServerProviderNativeForkHandler({
      credentials: {} as never,
      agentId: 'codex',
      parentSessionId: 'session-parent',
      parentRawSession: { metadata: parentMetadata },
      parentMetadata,
      directory: '/repo',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 10,
    })).resolves.toBeNull();

    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('raw-parent-provider-thread-id');
  });
});

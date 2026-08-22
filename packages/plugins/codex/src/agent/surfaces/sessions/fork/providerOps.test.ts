import { describe, expect, it, vi } from 'vitest';

import { createCodexForkSurface } from './providerOps.js';

describe('createCodexForkSurface', () => {
  it('preserves connected-service group affinity in fork launch metadata', async () => {
    const forkNative = vi.fn(async () => ({ providerSessionId: ' forked-thread ' }));
    const surface = createCodexForkSurface({
      forkNative,
      baseProcessEnv: { EXISTING: '1' },
    });

    const result = await surface.fork?.({
      parentSessionId: 'parent-session',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
      parentMetadata: {
        providerSessionId: 'stale-other-agent-thread',
        codexSessionId: 'parent-thread',
        codexBackendMode: 'appServer',
        codexHome: 'connectedService',
        codexConnectedServiceId: 'service-1',
        codexConnectedServiceProfileId: 'profile-1',
        codexConnectedServiceGroupId: 'group-1',
        codexHomePath: '/codex-home',
      },
    });

    expect(forkNative).toHaveBeenCalledWith({
      directory: '/repo',
      parentCodexSessionId: 'parent-thread',
      processEnv: {
        EXISTING: '1',
        CODEX_HOME: '/codex-home',
      },
    });
    expect(result?.providerSessionId).toBe('forked-thread');
    expect(result?.launch.environmentVariables).toEqual({ CODEX_HOME: '/codex-home' });
    expect(result?.launch.sessionStateUpdates).toContainEqual({
      fieldId: 'identity.providerSessionId',
      value: 'forked-thread',
    });
    expect(result?.launch.sessionStateUpdates).toContainEqual({
      fieldId: 'identity.runtimeDescriptor',
      value: expect.objectContaining({
        agent: expect.objectContaining({
          backendMode: 'appServer',
          providerSessionId: 'forked-thread',
          connectedServiceGroupId: 'group-1',
          agentExtra: expect.objectContaining({
            runtimeHandle: expect.objectContaining({
              providerSessionId: 'forked-thread',
              connectedServiceGroupId: 'group-1',
            }),
          }),
        }),
      }),
    });
  });

  it('fails closed for non-latest fork points', async () => {
    const forkNative = vi.fn(async () => ({ providerSessionId: 'forked-thread' }));
    const onDiagnostic = vi.fn();
    const surface = createCodexForkSurface({ forkNative, onDiagnostic });

    await expect(surface.fork?.({
      parentSessionId: 'parent-session',
      directory: '/repo',
      forkPoint: { kind: 'message_seq', upToSeqInclusive: 10 },
      parentMetadata: {
        providerSessionId: 'parent-thread',
        codexBackendMode: 'appServer',
      },
    })).resolves.toBeNull();

    expect(forkNative).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      type: 'skip',
      skipReason: 'fork_point_not_latest',
    }));
  });

  it('propagates an indeterminate app-server fork instead of selecting another fork path', async () => {
    const failure = Object.assign(new Error('fork outcome is unknown'), {
      name: 'CodexAppServerNativeForkFailure',
      outcome: 'indeterminate_after_dispatch',
    });
    const forkNative = vi.fn(async () => {
      throw failure;
    });
    const onDiagnostic = vi.fn();
    const surface = createCodexForkSurface({ forkNative, onDiagnostic });

    await expect(surface.fork?.({
      parentSessionId: 'parent-session',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
      parentMetadata: {
        providerSessionId: 'parent-thread',
        codexBackendMode: 'appServer',
      },
    })).rejects.toBe(failure);

    expect(forkNative).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      type: 'failed',
      error: failure,
    }));
  });

  it('uses typed ACP operations for ACP-backed latest forks', async () => {
    const forkNative = vi.fn(async () => {
      throw new Error('ACP forks must not start the app-server native fork client');
    });
    const loadSession = vi.fn(async () => ({
      ok: true,
      value: {
        providerSessionId: 'parent-acp-thread',
      },
    }));
    const forkSession = vi.fn(async () => ({
      ok: true,
      value: {
        providerSessionId: ' forked-acp-thread ',
      },
    }));
    const surface = createCodexForkSurface({ forkNative });

    const result = await surface.fork?.({
      parentSessionId: 'parent-session',
      directory: '/repo',
      forkPoint: { kind: 'latest' },
      parentMetadata: {
        providerSessionId: 'stale-other-agent-thread',
        codexSessionId: 'parent-acp-thread',
        codexBackendMode: 'acp',
        codexHome: 'connectedService',
        codexConnectedServiceId: 'service-1',
        codexConnectedServiceProfileId: 'profile-1',
        codexConnectedServiceGroupId: 'group-1',
        codexHomePath: '/codex-home',
      },
      acp: {
        loadSession,
        forkSession,
      },
    });

    expect(forkNative).not.toHaveBeenCalled();
    expect(loadSession).toHaveBeenCalledWith({
      backendId: 'codex',
      directory: '/repo',
      providerSessionId: 'parent-acp-thread',
    });
    expect(forkSession).toHaveBeenCalledWith({
      backendId: 'codex',
      directory: '/repo',
      sourceProviderSessionId: 'parent-acp-thread',
    });
    expect(result?.providerSessionId).toBe('forked-acp-thread');
    expect(result?.launch.sessionStateUpdates).toContainEqual({
      fieldId: 'identity.providerSessionId',
      value: 'forked-acp-thread',
    });
    expect(result?.launch.sessionStateUpdates).toContainEqual({
      fieldId: 'identity.runtimeDescriptor',
      value: expect.objectContaining({
        agent: expect.objectContaining({
          backendMode: 'acp',
          providerSessionId: 'forked-acp-thread',
          connectedServiceGroupId: 'group-1',
        }),
      }),
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnInTmux: vi.fn(),
  killWindow: vi.fn(async () => true),
}));

vi.mock('@/integrations/tmux', () => ({
  isTmuxAvailable: async () => true,
  selectPreferredTmuxSessionName: () => 'happy',
  TmuxUtilities: class {
    static DEFAULT_SESSION_NAME = 'happy';
    executeTmuxCommand = async () => ({ stdout: 'happy\t1\t1' });
    spawnInTmux = mocks.spawnInTmux;
    killWindow = mocks.killWindow;
  },
}));

vi.mock('../platform/tmux/spawnConfig', () => ({
  buildTmuxSpawnConfig: () => ({ commandTokens: ['happier', 'codex'], tmuxEnv: {}, unsetEnvKeys: [] }),
}));

vi.mock('../backendTargetRouting', () => ({
  resolveDaemonCliSubcommandFromBackendTarget: () => 'codex',
}));

function params() {
  const pidToTrackedSession = new Map();
  return {
    terminalRequest: {
      requested: 'tmux' as const,
      tmux: { sessionName: 'happy', isolated: true, tmpDir: null, source: 'typed' as const },
    },
    directory: '/tmp/project',
    options: { directory: '/tmp/project' },
    trackedSpawnOptions: { directory: '/tmp/project' },
    normalizedExistingSessionId: '',
    effectiveResume: '',
    effectiveBackendTargetV2: { kind: 'backend' as const, sourceKind: 'built_in' as const, backendId: 'codex' },
    sessionControlArgs: [],
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    localServicesBridgeAuthorization: {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      pluginId: 'happier.agent.codex',
      contributionId: 'codex',
      tokenFilePath: '/tmp/token',
    },
    pidToTrackedSession,
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: () => 'session-a',
    onChildExited: vi.fn(async (pid: number) => {
      pidToTrackedSession.delete(pid);
    }),
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForPid: vi.fn(),
      cleanupSpawnResourcesForPid: vi.fn(async () => true),
      consumeSessionAttachCleanupForPid: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => {}),
      persistAcceptedSpawnMarker: vi.fn(async () => {}),
      removeAcceptedSpawnMarkerIfOwned:
        vi.fn(async () => true),
    },
    cleanupSpawnResources: vi.fn(async () => undefined),
    logDebug: vi.fn(),
    warn: vi.fn(),
  };
}

describe('spawnTmuxHostedSessionAndWaitForWebhook', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs the final provider authorization guard immediately before tmux child creation', async () => {
    const refusal = {
      type: 'error' as const,
      errorCode: 'SPAWN_VALIDATION_FAILED' as const,
      errorMessage: 'provider_authorization_changed',
    };
    const revalidateBeforeCommit = vi.fn(async () => refusal);
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    await expect(spawnTmuxHostedSessionAndWaitForWebhook({
      ...params(),
      revalidateBeforeCommit,
    })).resolves.toMatchObject({ spawnResult: refusal });

    expect(revalidateBeforeCommit).toHaveBeenCalledTimes(1);
    expect(mocks.spawnInTmux).not.toHaveBeenCalled();
  });

  it('returns a refusal raised at the actual new-window boundary without regular-spawn fallback', async () => {
    const refusal = {
      type: 'error' as const,
      errorCode: 'SPAWN_VALIDATION_FAILED' as const,
      errorMessage: 'provider_authorization_changed_during_tmux_setup',
    };
    const revalidateBeforeCommit = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(refusal);
    mocks.spawnInTmux.mockImplementationOnce(async (_args, options) => ({
      success: false,
      creationDisposition: 'not_created',
      commitRefusal: await options.beforeCreateWindow(),
    }));
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    await expect(spawnTmuxHostedSessionAndWaitForWebhook({
      ...params(),
      revalidateBeforeCommit,
    })).resolves.toEqual({
      spawnResult: refusal,
      tmuxRequested: true,
      tmuxFallbackReason: null,
      tmuxCreationDisposition: 'not_created',
    });
    expect(revalidateBeforeCommit).toHaveBeenCalledTimes(2);
  });

  it('sanitizes tmux launcher diagnostics and the fallback reason passed to regular spawn', async () => {
    const rawSecret = 'provider-secret-tmux';
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: false,
      creationDisposition: 'not_created',
      error: `tmux echoed ${rawSecret}`,
    });
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const result = await spawnTmuxHostedSessionAndWaitForWebhook({
      ...input,
      sanitizeDiagnosticText: (value) => value.replaceAll(rawSecret, '[REDACTED]'),
    });

    expect(result).toMatchObject({ spawnResult: null, tmuxFallbackReason: 'tmux echoed [REDACTED]' });
    expect(JSON.stringify(input.logDebug.mock.calls)).not.toContain(rawSecret);
  });

  it('propagates an ambiguous tmux creation outcome instead of declaring regular fallback safe', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: false,
      creationDisposition: 'created_or_uncertain',
      error: 'tmux client timed out after new-window',
    });
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    await expect(spawnTmuxHostedSessionAndWaitForWebhook(params())).resolves.toMatchObject({
      spawnResult: null,
      tmuxRequested: true,
      tmuxFallbackReason: 'tmux client timed out after new-window',
      tmuxCreationDisposition: 'created_or_uncertain',
    });
  });

  it('tracks a recovered tmux pane PID and transfers launch cleanup into the existing lifecycle owner', async () => {
    mocks.spawnInTmux.mockImplementationOnce(async (_args, options) => ({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: `happy:${options.windowName}`,
      sessionName: 'happy',
      windowName: options.windowName,
      pid: 4242,
    }));
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => expect(input.pidToAwaiter.has(4242)).toBe(true));
    const tracked = input.pidToTrackedSession.get(4242);
    expect(tracked).toMatchObject({ pid: 4242, tmuxSessionId: expect.stringMatching(/^happy:happy-/u) });
    expect(mocks.spawnInTmux.mock.calls.at(-1)?.[1]?.windowName).toMatch(
      /^happy-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-codex$/u,
    );
    input.pidToAwaiter.get(4242)?.({ ...tracked!, happySessionId: 'session-a' });

    await expect(pending).resolves.toMatchObject({
      spawnResult: { type: 'success', sessionId: 'session-a' },
    });
    expect(input.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid).toHaveBeenCalledWith(4242);
    expect(input.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid).toHaveBeenCalledWith(4242);
    expect(input.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledWith(tracked);
  });

  it('installs webhook custody before accepted marker persistence can complete', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:early-webhook',
      sessionName: 'happy',
      windowName: 'early-webhook',
      pid: 4243,
    });
    let resolveMarker!: () => void;
    const markerPersistence = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });
    const input = params();
    input.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(
      async () => await markerPersistence,
    );
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => expect(input.pidToAwaiter.has(4243)).toBe(true));
    const tracked = input.pidToTrackedSession.get(4243);
    expect(tracked?.acceptedSpawnMarkerGate).toEqual(expect.any(Promise));

    resolveMarker();
    input.pidToAwaiter.get(4243)?.({
      ...tracked!,
      happySessionId: 'session-early',
    });

    await expect(pending).resolves.toMatchObject({
      spawnResult: { type: 'success', sessionId: 'session-early' },
    });
  });

  it('cancels exact tmux custody when marker publication fails before ACK', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:marker-refused',
      sessionName: 'happy',
      windowName: 'marker-refused',
      pid: 4244,
    });
    const input = params();
    input.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockRejectedValueOnce(
      new Error('marker refused'),
    );
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    await expect(
      spawnTmuxHostedSessionAndWaitForWebhook({
        ...input,
      }),
    ).rejects.toThrow('marker refused');
    expect(mocks.killWindow).toHaveBeenCalledOnce();
    expect(mocks.killWindow).toHaveBeenCalledWith(
      'happy:marker-refused',
    );
    expect(input.onChildExited).toHaveBeenCalledWith(
      4244,
      expect.objectContaining({
        reason: 'startup-cancelled-before-ack',
      }),
    );
    expect(input.pidToTrackedSession.has(4244)).toBe(false);
  });

  it('retires the exact tmux startup owner when canonical readiness is refused', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:readiness-refused',
      sessionName: 'happy',
      windowName: 'readiness-refused',
      pid: 4245,
    });
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } =
      await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook({
      ...input,
    });
    await vi.waitFor(() => expect(input.pidToAwaiter.has(4245)).toBe(true));
    const tracked = input.pidToTrackedSession.get(4245);
    expect(tracked).toBeDefined();
    Object.assign(tracked!, {
      happySessionId: 'session-readiness-refused',
      spawnStartupReadinessFailure: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'managed_provider_request_auth_activation_failed',
      },
    });
    input.pidToAwaiter.get(4245)?.(tracked!);

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
    expect(mocks.killWindow).toHaveBeenCalledOnce();
    expect(mocks.killWindow).toHaveBeenCalledWith(
      'happy:readiness-refused',
    );
    expect(input.cleanupSpawnResources).toHaveBeenCalledOnce();
    expect(
      input.cleanupSpawnResources.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.killWindow.mock.invocationCallOrder[0]!,
    );
    expect(input.onChildExited).toHaveBeenCalledOnce();
    expect(input.pidToTrackedSession.has(4245)).toBe(false);
  });

  it('retains tmux custody when exact window absence cannot be verified', async () => {
    const pid = 4255;
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:absence-unverified',
      sessionName: 'happy',
      windowName: 'absence-unverified',
      pid,
    });
    mocks.killWindow.mockResolvedValueOnce(false);
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } =
      await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => expect(input.pidToAwaiter.has(pid)).toBe(true));
    const tracked = input.pidToTrackedSession.get(pid)!;
    Object.assign(tracked, {
      spawnStartupReadinessFailure: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'managed_provider_request_auth_activation_failed',
      },
    });
    input.pidToAwaiter.get(pid)?.(tracked);

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'error',
        errorCode: 'SPAWN_FAILED',
        errorMessage:
          'startup_retirement_incomplete:terminal_host_disposition_failed',
      },
    });
    expect(input.onChildExited).not.toHaveBeenCalled();
    expect(input.pidToTrackedSession.get(pid)).toBe(tracked);
  });

  it('retires the same tracked object at its promoted runner PID after tmux disposal', async () => {
    const wrapperPid = 4246;
    const runnerPid = 4346;
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:promoted-before-cancel',
      sessionName: 'happy',
      windowName: 'promoted-before-cancel',
      pid: wrapperPid,
    });
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } =
      await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => {
      expect(input.pidToAwaiter.has(wrapperPid)).toBe(true);
    });
    const tracked = input.pidToTrackedSession.get(wrapperPid)!;
    input.pidToTrackedSession.delete(wrapperPid);
    Object.assign(tracked, {
      pid: runnerPid,
      happySessionId: 'session-promoted-before-cancel',
      spawnStartupReadinessFailure: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'managed_provider_request_auth_activation_failed',
      },
    });
    input.pidToTrackedSession.set(runnerPid, tracked);
    input.pidToAwaiter.get(wrapperPid)?.(tracked);

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
    expect(mocks.killWindow).toHaveBeenCalledWith(
      'happy:promoted-before-cancel',
    );
    expect(input.onChildExited).toHaveBeenCalledWith(
      runnerPid,
      expect.objectContaining({
        reason: 'startup-cancelled-before-ack',
      }),
    );
    expect([...input.pidToTrackedSession.values()]).not.toContain(tracked);
  });
});

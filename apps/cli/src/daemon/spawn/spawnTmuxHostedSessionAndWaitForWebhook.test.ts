import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  trackedSessionsForProcess,
  untrackSession,
  type SessionTrackingKey,
  type TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';
import type { TrackedSession } from '@/daemon/types';

const mocks = vi.hoisted(() => ({
  spawnInTmux: vi.fn(),
  killWindow: vi.fn(async () => true),
  writeTerminalHostAttachmentInfo: vi.fn(async () => ({
    version: 2 as const,
    attachmentId: 'attachment-bound',
  })),
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

vi.mock('@/terminal/attachment/terminalAttachmentInfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/terminal/attachment/terminalAttachmentInfo')>();
  return {
    ...actual,
    writeTerminalHostAttachmentInfo: mocks.writeTerminalHostAttachmentInfo,
  };
});

// Production spawns mint the Session key; tests find the Session by its process.
function trackedFor(input: Readonly<{ trackedSessionsByKey: TrackedSessionMap }>, pid: number): TrackedSession | undefined {
  return trackedSessionsForProcess(input.trackedSessionsByKey, pid)[0];
}

function trackingKeyFor(input: Readonly<{ trackedSessionsByKey: TrackedSessionMap }>, pid: number): SessionTrackingKey | undefined {
  return trackedFor(input, pid)?.trackingKey;
}

function params() {
  const trackedSessionsByKey: TrackedSessionMap = new Map();
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
    trackedSessionsByKey,
    spawnAwaiterByKey: new Map(),
    spawnResultResolverByKey: new Map(),
    spawnWebhookTimeoutByKey: new Map(),
    resolveCanonicalTrackedSessionId: () => 'session-a',
    onChildExited: vi.fn(async (pid: number) => {
      for (const tracked of trackedSessionsForProcess(trackedSessionsByKey, pid)) untrackSession(trackedSessionsByKey, tracked);
    }),
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForSession: vi.fn(),
      cleanupSpawnResourcesForSession: vi.fn(async () => true),
      consumeSessionAttachCleanupForSession: vi.fn(),
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

  it('tracks the stable V2 authority path and exact bootstrap identity for a runner bootstrap', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'private-tmux-session:@7',
      sessionName: 'private-tmux-session',
      windowName: 'runner',
      windowId: '@7',
      pid: 4242,
    });
    const input = {
      ...params(),
      terminalRequest: {
        requested: 'tmux' as const,
        tmux: {
          sessionName: 'private-tmux-session',
          isolated: true,
          tmpDir: null,
          source: 'typed' as const,
        },
      },
      runnerAgentSessionBootstrapAuthorization: {
        authorityFilePath: '/private/runner-authority.json',
        bootstrapFilePath: '/private/runner-bootstrap.json',
        descriptor: {
          v: 1 as const,
          pluginId: 'plugin.acme',
          pluginVersion: '1.0.0',
          agentId: 'agent',
          backendId: 'agent',
          occurrenceId: 'occurrence:plugin.acme:1',
          sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId: 'generation-1',
            installSource: 'npm' as const,
          },
        },
      },
      runnerAgentInvocationContext: Object.freeze({
        cwd: '/tmp/project',
        environment: Object.freeze({}),
        providerBindingActive: true,
      }),
      extraEnvForChildWithMessage: {
        PROVIDER_SECRET: 'must-not-become-daemon-authority',
      },
    };
    const pending = (await import(
      './spawnTmuxHostedSessionAndWaitForWebhook'
    )).spawnTmuxHostedSessionAndWaitForWebhook(input);

    await vi.waitFor(() => {
      expect(input.spawnAwaiterByKey.has(trackingKeyFor(input, 4242))).toBe(true);
    });
    const tracked = trackedFor(input, 4242)!;
    expect(tracked).toMatchObject({
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/private/runner-authority.json',
      runnerAgentBootstrapIdentity: {
        agentId: 'agent',
        backendId: 'agent',
      },
      runnerAgentInvocationContext: {
        cwd: '/tmp/project',
        environment: {},
        providerBindingActive: true,
      },
    });
    expect(JSON.stringify(tracked)).not.toContain(
      'must-not-become-daemon-authority',
    );
    input.spawnAwaiterByKey.get(trackingKeyFor(input, 4242))?.({
      ...tracked,
      happySessionId: 'session-4242',
    });

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'success',
        sessionId: 'session-4242',
      },
    });
    expect(JSON.stringify(input.logDebug.mock.calls)).not.toContain('session-4242');
    expect(JSON.stringify(input.logDebug.mock.calls)).not.toContain('private-tmux-session');
  });

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
      sessionId: 'happy:@7',
      sessionName: 'happy',
      windowName: options.windowName,
      windowId: '@7',
      pid: 4242,
    }));
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => expect(input.spawnAwaiterByKey.has(trackingKeyFor(input, 4242))).toBe(true));
    const tracked = trackedFor(input, 4242);
    expect(tracked).toMatchObject({ pid: 4242, tmuxSessionId: 'happy:@7' });
    expect(mocks.spawnInTmux.mock.calls.at(-1)?.[1]?.windowName).toMatch(
      /^happy-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-codex$/u,
    );
    input.spawnAwaiterByKey.get(trackingKeyFor(input, 4242))?.({ ...tracked!, happySessionId: 'session-a' });

    await expect(pending).resolves.toMatchObject({
      spawnResult: { type: 'success', sessionId: 'session-a' },
    });
    expect(input.spawnLifecycleCallbacks.registerSpawnResourceCleanupForSession).toHaveBeenCalledWith(tracked!.trackingKey);
    expect(input.spawnLifecycleCallbacks.consumeSessionAttachCleanupForSession).toHaveBeenCalledWith(tracked!.trackingKey);
    expect(input.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledWith(tracked);
    expect(mocks.writeTerminalHostAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: expect.any(String),
      sessionId: 'session-a',
      handle: expect.objectContaining({
        kind: 'tmux',
        sessionName: 'happy',
        paneId: '@7',
        attachMetadata: expect.objectContaining({ topology: 'shared' }),
      }),
    });
  });

  it('installs webhook custody before accepted marker persistence can complete', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:@7',
      sessionName: 'happy',
      windowName: 'early-webhook',
      windowId: '@7',
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
    await vi.waitFor(() => expect(input.spawnAwaiterByKey.has(trackingKeyFor(input, 4243))).toBe(true));
    const tracked = trackedFor(input, 4243);
    expect(tracked?.acceptedSpawnMarkerGate).toEqual(expect.any(Promise));

    resolveMarker();
    input.spawnAwaiterByKey.get(trackingKeyFor(input, 4243))?.({
      ...tracked!,
      happySessionId: 'session-early',
    });

    await expect(pending).resolves.toMatchObject({
      spawnResult: { type: 'success', sessionId: 'session-early' },
    });
  });

  it('retires the exact tmux startup owner when bound attachment persistence fails', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:@7',
      sessionName: 'happy',
      windowName: 'binding-failure',
      windowId: '@7',
      pid: 4260,
    });
    mocks.writeTerminalHostAttachmentInfo.mockRejectedValueOnce(new Error('synthetic descriptor failure'));
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } = await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => expect(input.spawnAwaiterByKey.has(trackingKeyFor(input, 4260))).toBe(true));
    const tracked = trackedFor(input, 4260)!;
    input.spawnAwaiterByKey.get(trackingKeyFor(input, 4260))?.({ ...tracked, happySessionId: 'session-binding-failure' });

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'error',
        errorCode: 'SPAWN_FAILED',
        errorMessage: 'terminal_attachment_binding_failed',
      },
    });
    expect(mocks.killWindow).toHaveBeenCalledWith('happy:@7');
    expect(trackedFor(input, 4260)).toBeUndefined();
  });

  it('cancels exact tmux custody when marker publication fails before ACK', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:@7',
      sessionName: 'happy',
      windowName: 'marker-refused',
      windowId: '@7',
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
    expect(input.logDebug).toHaveBeenCalledWith(
      '[DAEMON RUN] Failed to persist accepted spawn marker for PID 4244 (tmux)',
      'marker refused',
    );
    expect(mocks.killWindow).toHaveBeenCalledOnce();
    expect(mocks.killWindow).toHaveBeenCalledWith(
      'happy:@7',
    );
    expect(input.onChildExited).toHaveBeenCalledWith(
      4244,
      expect.objectContaining({
        reason: 'startup-cancelled-before-ack',
      }),
    );
    expect(trackedFor(input, 4244)).toBeUndefined();
  });

  it('retires the exact tmux startup owner when canonical readiness is refused', async () => {
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:@7',
      sessionName: 'happy',
      windowName: 'readiness-refused',
      windowId: '@7',
      pid: 4245,
    });
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } =
      await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook({
      ...input,
    });
    await vi.waitFor(() => expect(input.spawnAwaiterByKey.has(trackingKeyFor(input, 4245))).toBe(true));
    const tracked = trackedFor(input, 4245);
    expect(tracked).toBeDefined();
    Object.assign(tracked!, {
      happySessionId: 'session-readiness-refused',
      spawnStartupReadinessFailure: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'managed_provider_request_auth_activation_failed',
      },
    });
    input.spawnAwaiterByKey.get(trackingKeyFor(input, 4245))?.(tracked!);

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
    expect(mocks.killWindow).toHaveBeenCalledOnce();
    expect(mocks.killWindow).toHaveBeenCalledWith(
      'happy:@7',
    );
    expect(input.cleanupSpawnResources).toHaveBeenCalledOnce();
    expect(
      input.cleanupSpawnResources.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.killWindow.mock.invocationCallOrder[0]!,
    );
    expect(input.onChildExited).toHaveBeenCalledOnce();
    expect(trackedFor(input, 4245)).toBeUndefined();
  });

  it('retains tmux custody when exact window absence cannot be verified', async () => {
    const pid = 4255;
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:@7',
      sessionName: 'happy',
      windowName: 'absence-unverified',
      windowId: '@7',
      pid,
    });
    mocks.killWindow.mockResolvedValueOnce(false);
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } =
      await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => expect(input.spawnAwaiterByKey.has(trackingKeyFor(input, pid))).toBe(true));
    const tracked = trackedFor(input, pid)!;
    Object.assign(tracked, {
      spawnStartupReadinessFailure: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'managed_provider_request_auth_activation_failed',
      },
    });
    input.spawnAwaiterByKey.get(trackingKeyFor(input, pid))?.(tracked);

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'error',
        errorCode: 'SPAWN_FAILED',
        errorMessage:
          'startup_retirement_incomplete:terminal_host_disposition_failed',
      },
    });
    expect(input.onChildExited).not.toHaveBeenCalled();
    expect(trackedFor(input, pid)).toBe(tracked);
  });

  it('retires the same tracked object at its promoted runner PID after tmux disposal', async () => {
    const wrapperPid = 4246;
    const runnerPid = 4346;
    mocks.spawnInTmux.mockResolvedValueOnce({
      success: true,
      creationDisposition: 'created_or_uncertain',
      sessionId: 'happy:@7',
      sessionName: 'happy',
      windowName: 'promoted-before-cancel',
      windowId: '@7',
      pid: wrapperPid,
    });
    const input = params();
    const { spawnTmuxHostedSessionAndWaitForWebhook } =
      await import('./spawnTmuxHostedSessionAndWaitForWebhook');

    const pending = spawnTmuxHostedSessionAndWaitForWebhook(input);
    await vi.waitFor(() => {
      expect(input.spawnAwaiterByKey.has(trackingKeyFor(input, wrapperPid))).toBe(true);
    });
    const tracked = trackedFor(input, wrapperPid)!;
    Object.assign(tracked, {
      pid: runnerPid,
      happySessionId: 'session-promoted-before-cancel',
      spawnStartupReadinessFailure: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'managed_provider_request_auth_activation_failed',
      },
    });
    // Promotion rewrites the Session's pid in place; its key and awaiter stay.
    input.spawnAwaiterByKey.get(tracked.trackingKey)?.(tracked);

    await expect(pending).resolves.toMatchObject({
      spawnResult: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
      },
    });
    expect(mocks.killWindow).toHaveBeenCalledWith(
      'happy:@7',
    );
    expect(input.onChildExited).toHaveBeenCalledWith(
      runnerPid,
      expect.objectContaining({
        reason: 'startup-cancelled-before-ack',
      }),
    );
    expect([...input.trackedSessionsByKey.values()]).not.toContain(tracked);
  });
});

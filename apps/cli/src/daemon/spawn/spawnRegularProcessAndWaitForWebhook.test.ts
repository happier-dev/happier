import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { TrackedSession } from '../types';

const mocks = vi.hoisted(() => ({
  spawnHappyCLI: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.spawnHappyCLI,
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  writeFile: mocks.writeFile,
}));

function createFakeChildProcess(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function createManagedAttachment() {
  return {
    v: 1 as const,
    process: {
      pid: 9_001,
      processStartTimeMs: 1_717_171_700_001,
      processCommandHash: 'a'.repeat(64),
    },
    endpoint: { host: '127.0.0.1' as const, port: 8317 },
    materialization: {
      rootDir: '/tmp/managed-materialized',
      materializationId: 'csm_managed',
    },
  };
}

function createParams() {
  return {
    args: ['opencode'],
    directory: '/tmp/happier-project',
    options: { directory: '/tmp/happier-project' },
    trackedSpawnOptions: { directory: '/tmp/happier-project' },
    normalizedExistingSessionId: '',
    effectiveResume: '',
    localServicesBridgeAuthorization: {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      pluginId: 'happier.agent.opencode',
      contributionId: 'opencode',
      tokenFilePath: '/tmp/happier-bridge-token',
    },
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    processEnv: {
      PATH: process.env.PATH,
      HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '321',
    },
    pidToTrackedSession: new Map(),
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'session-1'),
    onChildExited: vi.fn(),
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForPid: vi.fn(),
      cleanupSpawnResourcesForPid: vi.fn(async () => true),
      consumeSessionAttachCleanupForPid: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => {}),
      persistAcceptedSpawnMarker:
        vi.fn(async (_tracked: TrackedSession) => {}),
      removeAcceptedSpawnMarkerIfOwned:
        vi.fn(async () => true),
    },
    cleanupSpawnResources: vi.fn(),
    logDebug: vi.fn(),
    warn: vi.fn(),
  } as const;
}

describe('spawnRegularProcessAndWaitForWebhook', () => {
  const originalOomScoreAdjustment = process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ;
  const originalSessionWebhookTimeoutMs = process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalServerUrl = process.env.HAPPIER_SERVER_URL;
  const originalPlatform = process.platform;
  const originalDebug = process.env.DEBUG;

  beforeEach(() => {
    mocks.spawnHappyCLI.mockReset().mockReturnValue(createFakeChildProcess(4242));
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
    process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ = '321';
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
  });

  it('runs the final provider authorization guard immediately before regular child creation', async () => {
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const refusal = {
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'provider_authorization_changed',
    };
    const revalidateBeforeCommit = vi.fn(async () => refusal);

    await expect(spawnRegularProcessAndWaitForWebhook({
      ...createParams(),
      revalidateBeforeCommit,
    })).resolves.toEqual(refusal);

    expect(revalidateBeforeCommit).toHaveBeenCalledTimes(1);
    expect(mocks.spawnHappyCLI).not.toHaveBeenCalled();
  });

  it('matches an early canonical webhook while accepted-marker persistence is blocked and completes once after acceptance', async () => {
    const child = createFakeChildProcess(4243);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const params = createParams();
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
    });
    const onTrackedSessionReported = vi.fn();
    const onTrackedSessionReady = vi.fn(async () => {
      expect(params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget).toHaveBeenCalledWith(4243);
    });
    const writeSessionMarkerFn = vi.fn(async () => {});

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } = await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      readCredentialsFn: async () => null,
      onTrackedSessionReady,
      onTrackedSessionReported,
    });
    const pending = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    expect(params.pidToTrackedSession.get(4243)).toEqual(expect.objectContaining({
      pid: 4243,
      startedBy: 'daemon',
    }));
    expect(params.pidToAwaiter.has(4243)).toBe(true);

    const webhookReadiness = onWebhook('session-4243', {
      hostPid: 4243,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata);
    expect(params.pidToTrackedSession.get(4243)).toEqual(expect.objectContaining({
      happySessionId: 'session-4243',
    }));
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();

    releaseMarker();
    await expect(pending).resolves.toEqual({ type: 'success', sessionId: 'session-4243' });
    await expect(webhookReadiness).resolves.toBeUndefined();
    expect(onTrackedSessionReady).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(onTrackedSessionReported).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(writeSessionMarkerFn).toHaveBeenCalledTimes(1));
    expect(params.pidToAwaiter.has(4243)).toBe(false);
    expect(params.pidToSpawnResultResolver.has(4243)).toBe(false);
    expect(params.pidToSpawnWebhookTimeout.has(4243)).toBe(false);
  });

  it('keeps one startup owner when canonical activation pauses across wrapper promotion', async () => {
    const wrapperPid = 4244;
    const runnerPid = 4245;
    const child = createFakeChildProcess(wrapperPid);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    let resumeActivation!: () => void;
    const activationPaused = new Promise<void>((resolve) => {
      resumeActivation = resolve;
    });
    const activationStarted = vi.fn();
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker
      .mockImplementationOnce(async (tracked) => {
        tracked.managedLocalServiceRunAttachment =
          createManagedAttachment();
        tracked.activateConnectedAccountSessionBindingOnCanonicalSession =
          vi.fn(async () => {
            activationStarted();
            await activationPaused;
            return null;
          });
      });
    const promoteSessionMarkerFn = vi.fn(async () => ({
      sourceMarkerOwnership: {
        happySessionId: `PID-${wrapperPid}`,
      },
      targetMarkerOwnership: {
        happySessionId: `PID-${runnerPid}`,
        processCommandHash: 'b'.repeat(64),
        processStartTimeMs: 2_000,
      },
      targetProcessCommand: 'runner command',
    }));
    const { createOnChildExited } =
      await import('../sessions/onChildExited');
    const onChildExited = createOnChildExited({
      pidToTrackedSession: params.pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      promoteSessionMarkerFn,
      removeSessionMarkerFn: vi.fn(async () => undefined),
    } as never);
    const { createOnHappySessionWebhook } =
      await import('../sessions/onHappySessionWebhook');
    const writeSessionMarkerFn = vi.fn(async () => undefined);
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: 2_000,
        command: 'runner command',
      }),
      writeSessionMarkerFn,
      onTrackedSessionReady: vi.fn(async () => undefined),
    });
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === runnerPid && signal === 0) return true;
        return true;
      }) as typeof process.kill);
    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
      onChildExited,
    });
    let originalTrackedSession: TrackedSession | undefined;
    await vi.waitFor(() => {
      originalTrackedSession =
        params.pidToTrackedSession.get(wrapperPid);
      expect(originalTrackedSession).toBeDefined();
    });
    await onWebhook(
      `PID-${runnerPid}`,
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );
    const canonicalWebhook = onWebhook(
      'session-promoted',
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );
    await vi.waitFor(() => expect(activationStarted).toHaveBeenCalledOnce());

    child.emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(params.pidToTrackedSession.get(runnerPid))
        .toBe(originalTrackedSession);
      expect(promoteSessionMarkerFn).toHaveBeenCalledOnce();
    });
    resumeActivation();

    await expect(canonicalWebhook).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({
      type: 'success',
      sessionId: 'session-promoted',
    });
    expect(writeSessionMarkerFn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-promoted',
      }),
      { adoptCanonicalSessionIdFromPidPlaceholder: true },
    );
    expect(params.pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(params.pidToAwaiter).toHaveLength(0);
    expect(params.pidToSpawnResultResolver).toHaveLength(0);
    expect(params.pidToSpawnWebhookTimeout).toHaveLength(0);
    killSpy.mockRestore();
  });

  it('continues the same startup when the wrapper exits before accepted-marker persistence promotes its live runner', async () => {
    const wrapperPid = 4247;
    const runnerPid = 4248;
    const child = createFakeChildProcess(wrapperPid);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker
      .mockImplementationOnce(async (tracked) => {
        tracked.managedLocalServiceRunAttachment =
          createManagedAttachment();
        await markerPersisted;
      });
    const promoteSessionMarkerFn = vi.fn(async () => ({
      sourceMarkerOwnership: {
        happySessionId: `PID-${wrapperPid}`,
      },
      targetMarkerOwnership: {
        happySessionId: `PID-${runnerPid}`,
        processCommandHash: 'b'.repeat(64),
        processStartTimeMs: 2_000,
      },
      targetProcessCommand: 'runner command',
    }));
    const { createOnChildExited } =
      await import('../sessions/onChildExited');
    const onChildExited = createOnChildExited({
      pidToTrackedSession: params.pidToTrackedSession,
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      getApiMachineForSessions: () => null,
      promoteSessionMarkerFn,
      removeSessionMarkerFn: vi.fn(async () => undefined),
    } as never);
    const { createOnHappySessionWebhook } =
      await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      getParentPidFn: () => wrapperPid,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: 2_000,
        command: 'runner command',
      }),
      writeSessionMarkerFn: vi.fn(async () => undefined),
    });
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    vi.spyOn(process, 'kill')
      .mockImplementation(((candidatePid: number, signal?: NodeJS.Signals | number) => {
        if (candidatePid === runnerPid && signal === 0) return true;
        return true;
      }) as typeof process.kill);

    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
      onChildExited,
    });
    await vi.waitFor(() => {
      expect(params.pidToAwaiter.has(wrapperPid)).toBe(true);
    });
    await onWebhook(
      `PID-${runnerPid}`,
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );

    child.emit('exit', 0, null);
    releaseMarker();
    await vi.waitFor(() => {
      expect(params.pidToTrackedSession.get(runnerPid))
        .toBeDefined();
    });
    await onWebhook(
      'session-after-early-wrapper-exit',
      {
        hostPid: runnerPid,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );

    await expect(pending).resolves.toEqual({
      type: 'success',
      sessionId: 'session-after-early-wrapper-exit',
    });
    expect(params.pidToTrackedSession.has(wrapperPid)).toBe(false);
    expect(params.pidToTrackedSession.get(runnerPid))
      .toEqual(expect.objectContaining({
        pid: runnerPid,
        happySessionId: 'session-after-early-wrapper-exit',
      }));
  });

  it('rejects an old webhook success when replacement custody owns the PID before marker acceptance', async () => {
    const child = createFakeChildProcess(4250);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const params = createParams();
    const replacementLifecycleCleanup = vi.fn();
    const lifecycleCleanupByPid = new Map<number, () => void>();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
      params.pidToAwaiter.delete(pid);
      params.pidToSpawnResultResolver.delete(pid);
      const cleanup = lifecycleCleanupByPid.get(pid);
      lifecycleCleanupByPid.delete(pid);
      cleanup?.();
    });
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
    });
    const onTrackedSessionReported = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } = await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      readCredentialsFn: async () => null,
      onTrackedSessionReported,
    });
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));

    const supersededWebhookReadiness = onWebhook('session-old-4250', {
      hostPid: 4250,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata);
    const supersededWebhookFailure = expect(supersededWebhookReadiness).rejects.toThrow('spawn custody');
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();

    const replacementTracked = {
      pid: 4250,
      startedBy: 'daemon',
      happySessionId: 'PID-4250',
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeout = setTimeout(() => {}, 60_000);
    params.pidToTrackedSession.set(4250, replacementTracked);
    params.pidToAwaiter.set(4250, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4250, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4250, replacementTimeout);
    lifecycleCleanupByPid.set(4250, replacementLifecycleCleanup);

    releaseMarker();
    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: expect.any(String),
    });
    await Promise.resolve();
    await Promise.resolve();
    await supersededWebhookFailure;

    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
    expect(params.spawnLifecycleCallbacks.consumeSessionAttachCleanupForPid).not.toHaveBeenCalled();
    expect(params.spawnLifecycleCallbacks.registerConnectedServiceSpawnTarget).not.toHaveBeenCalled();
    expect(params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid).not.toHaveBeenCalled();
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4250)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4250)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4250)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4250)).toBe(replacementTimeout);
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();

    child.emit('exit', 1, null);
    await Promise.resolve();
    await Promise.resolve();

    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4250)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4250)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4250)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4250)).toBe(replacementTimeout);
    expect(lifecycleCleanupByPid.get(4250)).toBe(replacementLifecycleCleanup);
    expect(replacementLifecycleCleanup).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  it('keeps early child-exit observation armed while accepted-spawn custody is persisted', async () => {
    const child = createFakeChildProcess(4244);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    let markerPresent = false;
    const params = createParams();
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
      markerPresent = true;
    });
    params.onChildExited.mockImplementationOnce(async () => {
      markerPresent = false;
    });

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    child.emit('exit', 1, null);
    expect(params.onChildExited).not.toHaveBeenCalled();

    releaseMarker();

    await vi.waitFor(() => expect(params.onChildExited).toHaveBeenCalledTimes(1));
    expect(markerPresent).toBe(false);
    expect(params.onChildExited).toHaveBeenCalledWith(4244, expect.objectContaining({
      reason: 'process-exited-before-webhook',
    }));
    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=4244, code=1, signal=null)',
    });
  });

  it('treats child error as diagnostic until a later exit authoritatively terminates the child', async () => {
    const child = createFakeChildProcess(4245);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const flushStreamingSanitizer = vi.fn(() => '');
    const params = {
      ...createParams(),
      createStreamingSanitizer: () => ({
        push: () => '',
        flush: flushStreamingSanitizer,
      }),
    };
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(async () => {
      await markerPersisted;
    });

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    child.emit('error', new Error('spawn failed'));
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(flushStreamingSanitizer).not.toHaveBeenCalled();
    releaseMarker();

    await vi.waitFor(() => expect(params.pidToAwaiter.has(4245)).toBe(true));
    expect(params.onChildExited).not.toHaveBeenCalled();
    child.emit('exit', 1, null);

    await expect(pending).resolves.toEqual(expect.objectContaining({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: expect.stringContaining('Child process exited before session webhook'),
    }));
    expect(params.onChildExited).toHaveBeenCalledTimes(1);
    expect(params.onChildExited).toHaveBeenCalledWith(4245, expect.objectContaining({
      reason: 'process-exited-before-webhook',
    }));
    expect(flushStreamingSanitizer).toHaveBeenCalledTimes(2);
  });

  it('cleans only the exact provisional webhook custody when marker publication fails after an early canonical webhook', async () => {
    const child = createFakeChildProcess(4246);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    params.onChildExited.mockImplementationOnce(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });
    let rejectMarker!: (error: Error) => void;
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(
      async () => await new Promise<void>((_resolve, reject) => {
        rejectMarker = reject;
      }),
    );
    const onTrackedSessionReported = vi.fn();
    const writeSessionMarkerFn = vi.fn(async () => {});

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } = await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn,
      readCredentialsFn: async () => null,
      onTrackedSessionReported,
    });
    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
    });

    await vi.waitFor(() => expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));
    const failedMarkerWebhookReadiness = onWebhook('session-4246', {
      hostPid: 4246,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata);
    const failedMarkerWebhookFailure = expect(failedMarkerWebhookReadiness).rejects.toThrow('spawn custody');
    expect(params.pidToTrackedSession.get(4246)).toEqual(expect.objectContaining({
      happySessionId: 'session-4246',
    }));
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();
    rejectMarker(new Error('marker write rejected'));

    await expect(pending).rejects.toThrow('marker write rejected');
    await failedMarkerWebhookFailure;
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.cleanupSpawnResources).toHaveBeenCalledOnce();
    expect(params.spawnLifecycleCallbacks.cleanupPendingSessionAttach).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.has(4246)).toBe(false);
    expect(params.pidToAwaiter.has(4246)).toBe(false);
    expect(params.pidToSpawnResultResolver.has(4246)).toBe(false);
    expect(params.pidToSpawnWebhookTimeout.has(4246)).toBe(false);
    expect(params.onChildExited).toHaveBeenCalledOnce();
    expect(onTrackedSessionReported).not.toHaveBeenCalled();
    expect(writeSessionMarkerFn).not.toHaveBeenCalled();

    await expect(onWebhook('session-4246', {
      hostPid: 4246,
      path: '/tmp/happier-project',
      startedBy: 'daemon',
    } as Metadata)).resolves.toBeUndefined();
    expect(params.pidToTrackedSession.has(4246)).toBe(false);
    child.emit('exit', null, 'SIGTERM');
    await Promise.resolve();
    expect(params.onChildExited).toHaveBeenCalledOnce();
    expect(params.pidToTrackedSession.has(4246)).toBe(false);
  });

  it('cancels its superseded webhook timeout when marker rejection preserves replacement custody', async () => {
    vi.useFakeTimers();
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '25';
    const child = createFakeChildProcess(4247);
    const replacementChild = createFakeChildProcess(4247);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();
    let rejectMarker!: (error: Error) => void;
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker.mockImplementationOnce(
      async () => await new Promise<void>((_resolve, reject) => {
        rejectMarker = reject;
      }),
    );

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await Promise.resolve();
    await Promise.resolve();
    expect(params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1);
    expect(params.pidToSpawnWebhookTimeout.has(4247)).toBe(true);

    const replacementTracked = {
      pid: 4247,
      startedBy: 'daemon',
      happySessionId: 'PID-4247',
      childProcess: replacementChild,
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeoutCallback = vi.fn();
    const replacementTimeout = setTimeout(replacementTimeoutCallback, 1_000);
    params.pidToTrackedSession.set(4247, replacementTracked);
    params.pidToAwaiter.set(4247, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4247, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4247, replacementTimeout);

    await vi.advanceTimersByTimeAsync(50);

    expect(params.pidToTrackedSession.get(4247)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4247)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4247)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4247)).toBe(replacementTimeout);
    expect(replacementTracked).not.toHaveProperty('sessionWebhookTimedOutAtMs');
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();
    expect(replacementTimeoutCallback).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(replacementChild.kill).not.toHaveBeenCalled();
    expect(params.cleanupSpawnResources).not.toHaveBeenCalled();
    expect(params.spawnLifecycleCallbacks.cleanupPendingSessionAttach).not.toHaveBeenCalled();

    rejectMarker(new Error('marker write rejected after replacement'));
    await expect(pending).rejects.toThrow('marker write rejected after replacement');
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4247)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4247)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4247)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4247)).toBe(replacementTimeout);
    expect(replacementTracked).not.toHaveProperty('sessionWebhookTimedOutAtMs');
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();
    expect(replacementTimeoutCallback).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(replacementChild.kill).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  it('settles an exiting old child after marker acceptance without delegating replacement custody by PID', async () => {
    const child = createFakeChildProcess(4248);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    let releaseMarker!: () => void;
    const persistAcceptedSpawnMarker = vi.fn(
      async () => await new Promise<void>((resolve) => {
        releaseMarker = resolve;
      }),
    );
    const oldAttachCleanup = vi.fn(async () => {});
    const replacementAttachCleanup = vi.fn(async () => {});
    const sessionAttachCleanupByPid = new Map<number, () => Promise<void>>();
    let pendingAttachCleanup: (() => Promise<void>) | null = oldAttachCleanup;
    const { createSpawnLifecycleCallbacks } = await import('./createSpawnLifecycleCallbacks');
    const realSpawnLifecycleCallbacks = createSpawnLifecycleCallbacks({
      connectedServicesBindingsRaw: {},
      catalogAgentId: 'opencode',
      materializationKey: 'materialization-old-spawn',
      hasConnectedServiceAuth: () => false,
      getSpawnResourceCleanupOnExit: () => null,
      onSpawnResourceCleanupArmed: vi.fn(),
      spawnResourceCleanupByPid: new Map(),
      getSessionAttachCleanup: () => pendingAttachCleanup,
      setSessionAttachCleanup: (cleanup) => {
        pendingAttachCleanup = cleanup;
      },
      sessionAttachCleanupByPid,
      persistAcceptedSpawnMarker,
    });
    const consumeSessionAttachCleanupForPid = vi.fn(
      realSpawnLifecycleCallbacks.consumeSessionAttachCleanupForPid,
    );
    const registerConnectedServiceSpawnTarget = vi.fn(
      realSpawnLifecycleCallbacks.registerConnectedServiceSpawnTarget,
    );
    const registerSpawnResourceCleanupForPid = vi.fn(
      realSpawnLifecycleCallbacks.registerSpawnResourceCleanupForPid,
    );
    const spawnLifecycleCallbacks = {
      ...realSpawnLifecycleCallbacks,
      consumeSessionAttachCleanupForPid,
      registerConnectedServiceSpawnTarget,
      registerSpawnResourceCleanupForPid,
    };
    const params = {
      ...createParams(),
      spawnLifecycleCallbacks,
    };
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await vi.waitFor(() => expect(persistAcceptedSpawnMarker).toHaveBeenCalledTimes(1));

    const replacementTracked = {
      pid: 4248,
      startedBy: 'daemon',
      happySessionId: 'PID-4248',
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeout = setTimeout(() => {}, 60_000);
    params.pidToTrackedSession.set(4248, replacementTracked);
    params.pidToAwaiter.set(4248, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4248, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4248, replacementTimeout);
    sessionAttachCleanupByPid.set(4248, replacementAttachCleanup);

    child.emit('exit', 1, null);

    expect(params.pidToTrackedSession.get(4248)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4248)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4248)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4248)).toBe(replacementTimeout);
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();

    releaseMarker();
    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=4248, code=1, signal=null)',
    });
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4248)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4248)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4248)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4248)).toBe(replacementTimeout);
    expect(sessionAttachCleanupByPid.get(4248)).toBe(replacementAttachCleanup);
    expect(consumeSessionAttachCleanupForPid).not.toHaveBeenCalled();
    expect(registerConnectedServiceSpawnTarget).not.toHaveBeenCalled();
    expect(registerSpawnResourceCleanupForPid).not.toHaveBeenCalled();
    expect(oldAttachCleanup).not.toHaveBeenCalled();
    expect(replacementAttachCleanup).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  it('does not delegate an old child exit after marker publication when replacement custody owns the PID', async () => {
    const child = createFakeChildProcess(4249);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    const params = createParams();

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const pending = spawnRegularProcessAndWaitForWebhook(params);
    await vi.waitFor(() => {
      expect(params.spawnLifecycleCallbacks.registerSpawnResourceCleanupForPid).toHaveBeenCalledWith(4249);
    });

    const replacementTracked = {
      pid: 4249,
      startedBy: 'daemon',
      happySessionId: 'PID-4249',
    };
    const replacementAwaiter = vi.fn();
    const replacementResolver = vi.fn();
    const replacementTimeout = setTimeout(() => {}, 60_000);
    params.pidToTrackedSession.set(4249, replacementTracked);
    params.pidToAwaiter.set(4249, replacementAwaiter);
    params.pidToSpawnResultResolver.set(4249, replacementResolver);
    params.pidToSpawnWebhookTimeout.set(4249, replacementTimeout);

    child.emit('exit', 1, null);

    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: 'Child process exited before session webhook (pid=4249, code=1, signal=null)',
    });
    expect(params.onChildExited).not.toHaveBeenCalled();
    expect(params.pidToTrackedSession.get(4249)).toBe(replacementTracked);
    expect(params.pidToAwaiter.get(4249)).toBe(replacementAwaiter);
    expect(params.pidToSpawnResultResolver.get(4249)).toBe(replacementResolver);
    expect(params.pidToSpawnWebhookTimeout.get(4249)).toBe(replacementTimeout);
    expect(replacementAwaiter).not.toHaveBeenCalled();
    expect(replacementResolver).not.toHaveBeenCalled();
    clearTimeout(replacementTimeout);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = originalDebug;
    if (originalOomScoreAdjustment === undefined) {
      delete process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ;
    } else {
      process.env.HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ = originalOomScoreAdjustment;
    }
    if (originalSessionWebhookTimeoutMs === undefined) {
      delete process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS;
    } else {
      process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = originalSessionWebhookTimeoutMs;
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    if (originalServerUrl === undefined) {
      delete process.env.HAPPIER_SERVER_URL;
    } else {
      process.env.HAPPIER_SERVER_URL = originalServerUrl;
    }
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
    vi.restoreAllMocks();
  });

  it('sanitizes provider credentials from stdout, stderr, exit diagnostics, and callbacks', async () => {
    const child = createFakeChildProcess(5152);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.DEBUG = '1';
    const rawSecret = 'provider-secret-42';
    const sanitizeDiagnosticText = vi.fn((value: string) => value.replaceAll(rawSecret, '[REDACTED]'));

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = { ...createParams(), sanitizeDiagnosticText };
    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(mocks.spawnHappyCLI).toHaveBeenCalledTimes(1));
    child.stdout.emit('data', `stdout echoed ${rawSecret}`);
    child.stderr.emit('data', `stderr echoed ${rawSecret}`);
    child.emit('exit', 1, null);

    const result = await resultPromise;
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.onChildExited.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).toContain('[REDACTED]');
    expect(sanitizeDiagnosticText).toHaveBeenCalled();
  });

  it('uses channel-scoped streaming sanitizers so chunk boundaries cannot expose provider credentials', async () => {
    const child = createFakeChildProcess(5153);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.DEBUG = '1';
    const rawSecret = 'provider-secret-42';
    const createStreamingSanitizer = () => {
      let pending = '';
      return {
        push(value: string | Uint8Array) {
          pending += typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
          if (!pending.includes(rawSecret)) return '';
          const output = pending.replaceAll(rawSecret, '[REDACTED]');
          pending = '';
          return output;
        },
        flush() {
          const output = pending.replaceAll(rawSecret, '[REDACTED]');
          pending = '';
          return output;
        },
      };
    };

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = { ...createParams(), createStreamingSanitizer };
    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => expect(mocks.spawnHappyCLI).toHaveBeenCalledTimes(1));
    child.stdout.emit('data', 'stdout provider-sec');
    child.stdout.emit('data', 'ret-42 done');
    child.stderr.emit('data', 'stderr provider-');
    child.stderr.emit('data', 'secret-42 done');
    child.emit('exit', 1, null);

    const result = await resultPromise;
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.onChildExited.mock.calls)).not.toContain(rawSecret);
    expect(JSON.stringify(params.logDebug.mock.calls)).toContain('[REDACTED]');
  });

  it('captures a redacted stderr tail when a child exits before the session webhook', async () => {
    const child = createFakeChildProcess(5151);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.spawnHappyCLI).toHaveBeenCalledTimes(1);
    });
    child.stderr.emit(
      'data',
      [
        'startup phase one',
        'authorization: bearer sk-secretsecretsecretsecretsecret',
        'fatal: missing configured provider runtime',
      ].join('\n'),
    );
    child.emit('exit', 1, null);

    const result = await resultPromise;
    expect(result.type).toBe('error');
    if (result.type !== 'error') {
      throw new Error('Expected child pre-webhook exit to return a spawn error');
    }
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
      errorMessage: expect.stringContaining('fatal: missing configured provider runtime'),
    });
    expect(result.errorMessage).toContain('recent stderr:');
    expect(result.errorMessage).toContain('authorization: bearer [REDACTED]');
    expect(result.errorMessage).not.toContain('sk-secretsecretsecretsecretsecret');
    expect(params.onChildExited).toHaveBeenCalledWith(5151, expect.objectContaining({
      reason: 'process-exited-before-webhook',
      code: 1,
      signal: null,
      stderrTail: expect.stringContaining('fatal: missing configured provider runtime'),
    }));
  });

  it('cancels the exact regular launch when the webhook deadline expires', async () => {
    const child = createFakeChildProcess(6262);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '10';

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });

    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
    });
    await vi.waitFor(() => {
      expect(params.pidToTrackedSession.has(6262)).toBe(true);
    });
    const tracked = params.pidToTrackedSession.get(6262);
    const result = await pending;

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 6262',
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(params.cleanupSpawnResources).toHaveBeenCalledOnce();
    expect(
      params.cleanupSpawnResources.mock.invocationCallOrder[0],
    ).toBeLessThan(
      params.onChildExited.mock.invocationCallOrder[0]!,
    );
    expect(tracked).toEqual(expect.objectContaining({
      sessionWebhookTimedOutAtMs: expect.any(Number),
    }));
  });

  it('retains regular startup custody when canonical exit cleanup is incomplete', async () => {
    const child = createFakeChildProcess(6264);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '10';
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();
    params.onChildExited.mockImplementation(async () => undefined);

    await expect(
      spawnRegularProcessAndWaitForWebhook(params),
    ).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage:
        'startup_retirement_incomplete:exit_cleanup_incomplete',
    });
    expect(params.onChildExited).toHaveBeenCalledOnce();
    expect(params.pidToTrackedSession.get(6264)).toEqual(
      expect.objectContaining({ pid: 6264 }),
    );
  });

  it('reports timeout and retires once when canonical activation outlives the startup deadline', async () => {
    const child = createFakeChildProcess(6263);
    mocks.spawnHappyCLI.mockReturnValueOnce(child);
    process.env.HAPPIER_DAEMON_SESSION_WEBHOOK_TIMEOUT_MS = '25';
    let resumeActivation!: () => void;
    const activationPaused = new Promise<void>((resolve) => {
      resumeActivation = resolve;
    });
    const activationStarted = vi.fn();
    const params = createParams();
    params.onChildExited.mockImplementation(async (pid) => {
      params.pidToTrackedSession.delete(pid);
    });
    params.spawnLifecycleCallbacks.persistAcceptedSpawnMarker
      .mockImplementationOnce(async (tracked) => {
        tracked.managedLocalServiceRunAttachment =
          createManagedAttachment();
        tracked.activateConnectedAccountSessionBindingOnCanonicalSession =
          vi.fn(async () => {
            activationStarted();
            await activationPaused;
            return null;
          });
      });
    const onTrackedSessionReady = vi.fn(async () => undefined);
    const { spawnRegularProcessAndWaitForWebhook } =
      await import('./spawnRegularProcessAndWaitForWebhook');
    const { createOnHappySessionWebhook } =
      await import('../sessions/onHappySessionWebhook');
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: params.pidToTrackedSession,
      pidToAwaiter: params.pidToAwaiter,
      findHappyProcessByPidFn: async () => null,
      writeSessionMarkerFn: vi.fn(async () => undefined),
      onTrackedSessionReady,
    });

    const pending = spawnRegularProcessAndWaitForWebhook({
      ...params,
    });
    await Promise.resolve();
    expect(params.pidToAwaiter.has(6263)).toBe(true);
    const tracked = params.pidToTrackedSession.get(6263);
    expect(tracked).toBeDefined();
    const canonicalWebhook = onWebhook(
      'session-6263',
      {
        hostPid: 6263,
        path: '/tmp/happier-project',
        startedBy: 'daemon',
      } as Metadata,
    );
    await vi.waitFor(() => expect(activationStarted).toHaveBeenCalledOnce());

    await expect(pending).resolves.toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
      errorMessage: 'Session webhook timeout for PID 6263',
    });
    expect(child.kill).not.toHaveBeenCalled();

    resumeActivation();
    await expect(canonicalWebhook).rejects.toThrow(
      'custody changed',
    );
    expect(onTrackedSessionReady).not.toHaveBeenCalled();
    expect(params.pidToAwaiter).toHaveLength(0);
    expect(params.pidToSpawnResultResolver).toHaveLength(0);
    expect(params.pidToSpawnWebhookTimeout).toHaveLength(0);
  });

  it('applies the spawned child OOM score adjustment after a PID is available', async () => {
    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = createParams();

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.writeFile).toHaveBeenCalledWith('/proc/4242/oom_score_adj', '321\n', 'utf8');
    });
    const awaiter = params.pidToAwaiter.get(4242);
    expect(awaiter).toBeDefined();
    awaiter?.({
      startedBy: 'daemon',
      pid: 4242,
      happySessionId: 'session-1',
      spawnOptions: params.trackedSpawnOptions,
      directoryCreated: false,
    });

    await expect(resultPromise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
  });

  it('uses daemon-issued child controls instead of ambient process env for regular child launch', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/ambient-happier-home';
    process.env.HAPPIER_SERVER_URL = 'https://ambient.example.test';

    const { spawnRegularProcessAndWaitForWebhook } = await import('./spawnRegularProcessAndWaitForWebhook');
    const params = {
      ...createParams(),
      processEnv: {
        PATH: process.env.PATH,
        HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
        HAPPIER_DAEMON_SPAWNED_CHILD_OOM_SCORE_ADJ: '321',
        HAPPIER_HOME_DIR: '/tmp/ambient-happier-home',
        HAPPIER_SERVER_URL: 'https://ambient.example.test',
      },
      extraEnvForChildWithMessage: {
        HAPPIER_HOME_DIR: '/tmp/daemon-happier-home',
        HAPPIER_SERVER_URL: 'https://daemon.example.test',
      },
    } as Parameters<typeof spawnRegularProcessAndWaitForWebhook>[0] & { processEnv: NodeJS.ProcessEnv };

    const resultPromise = spawnRegularProcessAndWaitForWebhook(params);

    await vi.waitFor(() => {
      expect(mocks.spawnHappyCLI).toHaveBeenCalled();
    });
    const launchOptions = mocks.spawnHappyCLI.mock.calls[0]?.[1] as { env?: NodeJS.ProcessEnv } | undefined;
    expect(launchOptions?.env?.HAPPIER_HOME_DIR).toBe('/tmp/daemon-happier-home');
    expect(launchOptions?.env?.HAPPIER_SERVER_URL).toBe('https://daemon.example.test');

    const awaiter = params.pidToAwaiter.get(4242);
    expect(awaiter).toBeDefined();
    awaiter?.({
      startedBy: 'daemon',
      pid: 4242,
      happySessionId: 'session-1',
      spawnOptions: params.trackedSpawnOptions,
      directoryCreated: false,
    });

    await expect(resultPromise).resolves.toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
  });
});

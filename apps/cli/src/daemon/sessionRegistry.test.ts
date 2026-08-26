import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceLocalSecretStorage } from './deviceLocalSecretStorage';

const testDeviceLocalSecretStorage: DeviceLocalSecretStorage = {
  sealJson: ({ value }) => `test.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`,
  openJson: ({ ciphertext }) => JSON.parse(Buffer.from(ciphertext.slice('test.'.length), 'base64url').toString('utf8')) as unknown,
  deriveOpaqueIdentity: ({ value }) =>
    Buffer.from(value, 'utf8').toString('hex').padEnd(64, '0').slice(0, 64),
  deriveSecretKey: () => new Uint8Array(32).fill(7),
};

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('sessionRegistry', () => {
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalPublicReleaseChannel = process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
  const originalReleaseRing = process.env.HAPPIER_RELEASE_RING;
  const originalReleaseChannel = process.env.HAPPIER_RELEASE_CHANNEL;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-session-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    delete process.env.HAPPIER_RELEASE_RING;
    delete process.env.HAPPIER_RELEASE_CHANNEL;
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('node:fs/promises');
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    if (originalPublicReleaseChannel === undefined) {
      delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    } else {
      process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL = originalPublicReleaseChannel;
    }
    if (originalReleaseRing === undefined) {
      delete process.env.HAPPIER_RELEASE_RING;
    } else {
      process.env.HAPPIER_RELEASE_RING = originalReleaseRing;
    }
    if (originalReleaseChannel === undefined) {
      delete process.env.HAPPIER_RELEASE_CHANNEL;
    } else {
      process.env.HAPPIER_RELEASE_CHANNEL = originalReleaseChannel;
    }
  });

  it('should write a marker and preserve createdAt across updates', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 12345,
      happySessionId: 'sess-1',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markers1 = await listSessionMarkers();
    expect(markers1).toHaveLength(1);
    expect(markers1[0].pid).toBe(12345);
    expect(markers1[0].happySessionId).toBe('sess-1');
    expect(markers1[0].happyHomeDir).toBe(configuration.happyHomeDir);
    expect(typeof markers1[0].createdAt).toBe('number');
    expect(typeof markers1[0].updatedAt).toBe('number');

    const createdAt1 = markers1[0].createdAt;
    const updatedAt1 = markers1[0].updatedAt;

    await writeSessionMarker({
      pid: 12345,
      happySessionId: 'sess-2',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markers2 = await listSessionMarkers();
    expect(markers2).toHaveLength(1);
    expect(markers2[0].createdAt).toBe(createdAt1);
    expect(markers2[0].updatedAt).toBeGreaterThanOrEqual(updatedAt1);
    expect(markers2[0].happySessionId).toBe('sess-2');
  }, 60_000);

  it('persists only the stable runner daemon-service authority path', async () => {
    const {
      listSessionMarkers,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const authorityPath =
      join(happyHomeDir, 'tmp', 'agent-authorities', 'session.json');

    await writeSessionMarker({
      pid: 12347,
      happySessionId: 'session-authority-path',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
    });

    const [marker] = await listSessionMarkers();
    expect(marker).toMatchObject({
      happySessionId: 'session-authority-path',
      agentRuntimeDaemonServiceAuthorityFilePath: authorityPath,
    });
    expect(JSON.stringify(marker)).not.toContain('capability');
    expect(JSON.stringify(marker)).not.toContain('controlToken');
  });

  it('clears only the exact stale daemon-service promotion marker and custody facts', async () => {
    const {
      clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned,
      listSessionMarkers,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const processCommandHash = 'f'.repeat(64);
    const processStartTimeMs = 1_717_171_717_700;
    const authorityFilePath = join(
      happyHomeDir,
      'tmp',
      'agent-authorities',
      'stale-promotion.json',
    );
    const retention = {
      v: 1 as const,
      sourceGenerationIds: ['registry:dependency'],
      qualifiedDependencyIds: ['acme.plugin/dependency'],
    };
    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'session-stale-promotion',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash,
      processStartTimeMs,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
      agentRuntimeDaemonServiceSessionOpenAttestation: {
        request: {
          kind: 'create',
          sessionId: 'session-stale-promotion',
          cwd: '/tmp/project',
        },
        providerSessionId: 'provider-session-1',
      },
      runnerAgentImmutableGenerationId: 'registry:agent',
      runnerManagedDependencyRetentionV1: retention,
    });

    await expect(
      clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned({
        pid: 12348,
        sessionId: 'session-stale-promotion',
        processCommandHash,
        processStartTimeMs,
        authorityFilePath,
        immutableGenerationId: 'registry:agent',
        retention,
      }),
    ).resolves.toBe(true);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 12348,
        happySessionId: 'session-stale-promotion',
        cwd: '/tmp/project',
      }),
    ]);
    const [cleared] = await listSessionMarkers();
    expect(cleared).not.toHaveProperty(
      'agentRuntimeDaemonServiceAuthorityFilePath',
    );
    expect(cleared).not.toHaveProperty(
      'agentRuntimeDaemonServiceSessionOpenAttestation',
    );
    expect(cleared).not.toHaveProperty(
      'runnerAgentImmutableGenerationId',
    );
    expect(cleared).not.toHaveProperty(
      'runnerManagedDependencyRetentionV1',
    );

    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'session-stale-promotion',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash,
      processStartTimeMs,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
      runnerAgentImmutableGenerationId: 'registry:agent',
      runnerManagedDependencyRetentionV1: retention,
    });
    await expect(
      clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned({
        pid: 12348,
        sessionId: 'session-stale-promotion',
        processCommandHash,
        processStartTimeMs,
        authorityFilePath,
      }),
    ).resolves.toBe(true);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        runnerAgentImmutableGenerationId: 'registry:agent',
        runnerManagedDependencyRetentionV1: retention,
      }),
    ]);
    expect((await listSessionMarkers())[0]).not.toHaveProperty(
      'agentRuntimeDaemonServiceAuthorityFilePath',
    );

    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'session-stale-promotion',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash,
      processStartTimeMs,
      agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
      runnerAgentImmutableGenerationId: 'registry:agent',
      runnerManagedDependencyRetentionV1: retention,
    });
    await expect(
      clearSessionMarkerAgentRuntimeDaemonServicePromotionIfOwned({
        pid: 12348,
        sessionId: 'session-stale-promotion',
        processCommandHash,
        processStartTimeMs,
        authorityFilePath,
        immutableGenerationId: 'registry:agent',
        retention: {
          ...retention,
          sourceGenerationIds: ['registry:other-dependency'],
        },
      }),
    ).resolves.toBe(false);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        agentRuntimeDaemonServiceAuthorityFilePath: authorityFilePath,
        runnerAgentImmutableGenerationId: 'registry:agent',
        runnerManagedDependencyRetentionV1: retention,
      }),
    ]);
  });

  it('merges non-secret managed-dependency retention under exact live runner marker ownership', async () => {
    const {
      listSessionMarkers,
      updateSessionMarkerRunnerManagedDependencyRetention,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const processCommandHash = 'c'.repeat(64);
    const processStartTimeMs = 1_717_171_717_321;
    await writeSessionMarker({
      pid: 12349,
      happySessionId: 'session-managed-dependency-retention',
      startedBy: 'daemon',
      processCommandHash,
      processStartTimeMs,
      runnerManagedDependencyRetentionV1: {
        v: 1,
        sourceGenerationIds: ['registry:g'],
        qualifiedDependencyIds: ['acme.plugin/tool-g'],
      },
    });

    await expect(
      updateSessionMarkerRunnerManagedDependencyRetention({
        pid: 12349,
        sessionId: 'session-managed-dependency-retention',
        processCommandHash,
        processStartTimeMs,
        retention: {
          v: 1,
          sourceGenerationIds: ['registry:h'],
          qualifiedDependencyIds: ['acme.plugin/tool-h'],
          adoptedManagedProviderAuthority: {
            pluginId: 'acme.plugin',
            immutableGenerationId: 'provider-generation-stale',
            manifestAuthority: 'external',
            hardRevocationRevisionAtAdmission: 0,
          },
        },
      }),
    ).resolves.toBe(true);
    await expect(
      updateSessionMarkerRunnerManagedDependencyRetention({
        pid: 12349,
        sessionId: 'session-managed-dependency-retention',
        processCommandHash,
        processStartTimeMs: processStartTimeMs + 1,
        retention: {
          v: 1,
          sourceGenerationIds: ['registry:must-not-write'],
          qualifiedDependencyIds: ['acme.plugin/must-not-write'],
        },
      }),
    ).resolves.toBe(false);

    const [marker] = await listSessionMarkers();
    expect(marker).toMatchObject({
      runnerManagedDependencyRetentionV1: {
        v: 1,
        sourceGenerationIds: ['registry:g', 'registry:h'],
        qualifiedDependencyIds: [
          'acme.plugin/tool-g',
          'acme.plugin/tool-h',
        ],
      },
    });
    expect(JSON.stringify(marker)).not.toContain('capability');
    expect(JSON.stringify(marker)).not.toContain('token');
    expect(marker?.runnerManagedDependencyRetentionV1
      ?.adoptedManagedProviderAuthority).toBeUndefined();
  });

  it('pins and exactly releases the adopted Provider authority under the exact runner process identity', async () => {
    const {
      listSessionMarkers,
      updateSessionMarkerRunnerManagedProviderAuthority,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const processCommandHash = 'e'.repeat(64);
    const processStartTimeMs = 1_717_171_717_500;
    const identity = {
      pid: 12351,
      sessionId: 'session-managed-provider-retention',
      processCommandHash,
      processStartTimeMs,
    } as const;
    const providerP = {
      pluginId: 'acme.provider.p',
      immutableGenerationId: 'registry:provider-p',
      manifestAuthority: 'bundled_first_party',
      hardRevocationRevisionAtAdmission: 7,
    } as const;
    const providerQ = {
      pluginId: 'acme.provider.q',
      immutableGenerationId: 'registry:provider-q',
      manifestAuthority: 'external',
      hardRevocationRevisionAtAdmission: 11,
    } as const;
    const providerPWrongSourceClass = {
      ...providerP,
      manifestAuthority: 'external',
    } as const;
    await writeSessionMarker({
      pid: identity.pid,
      happySessionId: identity.sessionId,
      startedBy: 'daemon',
      processCommandHash,
      processStartTimeMs,
      runnerManagedDependencyRetentionV1: {
        v: 1,
        sourceGenerationIds: ['registry:dependency'],
        qualifiedDependencyIds: ['acme.plugin/dependency'],
      },
    });

    await expect(
      updateSessionMarkerRunnerManagedProviderAuthority({
        ...identity,
        authority: providerP,
      }),
    ).resolves.toBe(true);
    await expect(
      updateSessionMarkerRunnerManagedProviderAuthority({
        ...identity,
        authority: providerQ,
      }),
    ).resolves.toBe(false);
    await expect(
      updateSessionMarkerRunnerManagedProviderAuthority({
        ...identity,
        authority: null,
        expectedAuthority: providerPWrongSourceClass,
      }),
    ).resolves.toBe(false);
    await expect(
      updateSessionMarkerRunnerManagedProviderAuthority({
        ...identity,
        authority: null,
        expectedAuthority: providerQ,
      }),
    ).resolves.toBe(false);
    await expect(
      updateSessionMarkerRunnerManagedProviderAuthority({
        ...identity,
        processStartTimeMs: processStartTimeMs + 1,
        authority: null,
        expectedAuthority: providerP,
      }),
    ).resolves.toBe(false);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        runnerManagedDependencyRetentionV1: {
          v: 1,
          adoptedManagedProviderAuthority: providerP,
          sourceGenerationIds: ['registry:dependency'],
          qualifiedDependencyIds: ['acme.plugin/dependency'],
        },
      }),
    ]);

    await expect(
      updateSessionMarkerRunnerManagedProviderAuthority({
        ...identity,
        authority: null,
        expectedAuthority: providerP,
      }),
    ).resolves.toBe(true);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        runnerManagedDependencyRetentionV1: {
          v: 1,
          sourceGenerationIds: ['registry:dependency'],
          qualifiedDependencyIds: ['acme.plugin/dependency'],
        },
      }),
    ]);
    expect(
      (await listSessionMarkers())[0]
        ?.runnerManagedDependencyRetentionV1,
    ).not.toHaveProperty(
      'adoptedManagedProviderAuthority',
    );
  });

  it('pins one exact non-authorizing Runner Agent generation for each process identity', async () => {
    const {
      listSessionMarkers,
      updateSessionMarkerRunnerAgentImmutableGenerationId,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const processCommandHash = 'd'.repeat(64);
    const processStartTimeMs = 1_717_171_717_654;
    await writeSessionMarker({
      pid: 12350,
      happySessionId: 'session-runner-agent-generation',
      startedBy: 'daemon',
      processCommandHash,
      processStartTimeMs,
    });

    await expect(
      updateSessionMarkerRunnerAgentImmutableGenerationId({
        pid: 12350,
        sessionId: 'session-runner-agent-generation',
        processCommandHash,
        processStartTimeMs,
        immutableGenerationId: 'registry:g',
      }),
    ).resolves.toBe(true);
    await expect(
      updateSessionMarkerRunnerAgentImmutableGenerationId({
        pid: 12350,
        sessionId: 'session-runner-agent-generation',
        processCommandHash,
        processStartTimeMs,
        immutableGenerationId: 'registry:g',
      }),
    ).resolves.toBe(true);
    await expect(
      updateSessionMarkerRunnerAgentImmutableGenerationId({
        pid: 12350,
        sessionId: 'session-runner-agent-generation',
        processCommandHash,
        processStartTimeMs,
        immutableGenerationId: 'registry:h',
      }),
    ).resolves.toBe(false);

    await writeSessionMarker({
      pid: 12350,
      happySessionId: 'session-runner-agent-generation',
      startedBy: 'daemon',
      processCommandHash,
      processStartTimeMs,
    });
    await writeSessionMarker({
      pid: 12351,
      happySessionId: 'session-runner-agent-generation-h',
      startedBy: 'daemon',
      processCommandHash: 'e'.repeat(64),
      processStartTimeMs: processStartTimeMs + 1,
      runnerAgentImmutableGenerationId: 'registry:h',
    });

    expect(await listSessionMarkers()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pid: 12350,
        runnerAgentImmutableGenerationId: 'registry:g',
      }),
      expect.objectContaining({
        pid: 12351,
        runnerAgentImmutableGenerationId: 'registry:h',
      }),
    ]));
  });

  it('persists accepted pre-webhook child custody with secret-free startup identity before session attach', async () => {
    const { configuration } = await import('@/configuration');
    const { persistAcceptedSpawnMarker } = await import('./spawn/persistAcceptedSpawnMarker');
    const { listSessionMarkers } = await import('./sessionRegistry');
    const startupInstructionsSentinel =
      'Startup instructions must never enter the durable daemon marker';
    const startupInstructions = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 7,
      instructions: startupInstructionsSentinel,
    };
    const startupInstructionsMarker = {
      v: startupInstructions.v,
      id: startupInstructions.id,
      revision: startupInstructions.revision,
    };
    const trackedSession: import('./types').TrackedSession = {
      startedBy: 'daemon',
      pid: 12346,
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/tmp/private/runner-daemon-authority.json',
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        spawnNonce: 'nonce-before-session-attach',
        environmentVariables: {
          OPENAI_API_KEY: 'sk-device-local-marker',
        },
        agentSessionStartupInstructionsV1: startupInstructions,
      },
    };

    await persistAcceptedSpawnMarker({
      deviceLocalSecretStorage: testDeviceLocalSecretStorage,
      readProcessIdentityByPidFn: async () => ({
        pid: 12346,
        processStartTimeMs: 1_717_171_717_000,
        command: 'happier codex --started-by daemon',
      }),
      trackedSession,
    });

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 12346,
        happySessionId: 'PID-12346',
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        processStartTimeMs: 1_717_171_717_000,
        respawn: expect.objectContaining({
          spawnNonce: 'nonce-before-session-attach',
          sealedEnvironmentVariables: expect.objectContaining({
            format: 'device_local_v1',
          }),
        }),
        agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
        agentRuntimeDaemonServiceAuthorityFilePath:
          '/tmp/private/runner-daemon-authority.json',
      }),
    ]);
    expect(trackedSession.agentSessionStartupInstructionsMarkerV1)
      .toEqual(startupInstructionsMarker);
    const serializedMarker = readFileSync(
      join(
        configuration.happyHomeDir,
        'tmp',
        'daemon-sessions',
        'pid-12346.json',
      ),
      'utf8',
    );
    expect(serializedMarker).not.toContain(startupInstructionsSentinel);
    expect(serializedMarker).not.toContain('"instructions"');
  });

  it('adopts a nonce-correlated PID placeholder when only the early process-start witness is unavailable', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const pid = 123460;
    const spawnNonce = 'nonce-accepted-before-process-identity';
    const processCommand = 'happier codex --started-by daemon';
    const processCommandHash = hashProcessCommand(processCommand);
    const respawn = {
      version: 1 as const,
      directory: '/tmp/project',
      spawnNonce,
      backendTarget: {
        kind: 'builtInAgent' as const,
        agentId: 'codex' as const,
      },
    };

    await writeSessionMarker({
      pid,
      happySessionId: `PID-${pid}`,
      startedBy: 'daemon',
      processCommand,
      processCommandHash,
      respawn,
    });

    await expect(writeSessionMarker({
      pid,
      happySessionId: 'session-canonical-after-webhook',
      startedBy: 'daemon',
      processCommand,
      processCommandHash,
      processStartTimeMs: 1_717_171_717_000,
      respawn,
    }, {
      adoptCanonicalSessionIdFromPidPlaceholder: true,
    })).resolves.toBeUndefined();

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid,
        happySessionId: 'session-canonical-after-webhook',
        processCommandHash,
        processStartTimeMs: 1_717_171_717_000,
      }),
    ]);

    const mismatchedPid = pid + 1;
    await writeSessionMarker({
      pid: mismatchedPid,
      happySessionId: `PID-${mismatchedPid}`,
      startedBy: 'daemon',
      processCommand,
      processCommandHash,
      respawn: { ...respawn, spawnNonce: 'nonce-command-mismatch' },
    });
    await expect(writeSessionMarker({
      pid: mismatchedPid,
      happySessionId: 'session-command-mismatch',
      startedBy: 'daemon',
      processCommand: 'different runner command',
      processCommandHash: hashProcessCommand('different runner command'),
      processStartTimeMs: 1_717_171_717_001,
      respawn: { ...respawn, spawnNonce: 'nonce-command-mismatch' },
    }, {
      adoptCanonicalSessionIdFromPidPlaceholder: true,
    })).rejects.toThrow(
      'session_marker_canonical_adoption_ownership_mismatch',
    );
  });

  it('persists and clears only the exact active turn and causal input custody for the matching session marker', async () => {
    const {
      listSessionMarkers,
      updateSessionMarkerActiveTurn,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    await writeSessionMarker({
      pid: 12347,
      happySessionId: 'sess-active-turn',
      startedBy: 'daemon',
      cwd: '/tmp',
    });
    const admission = {
      turnId: 'session-turn:exact-1',
      inputId: 'input:exact-1',
      userMessageSeq: 7,
      userMessageSeqs: [7],
    } as const;

    await expect(updateSessionMarkerActiveTurn({
      pid: 12347,
      sessionId: 'sess-active-turn',
      activeTurnId: 'session-turn:exact-1',
      agentRuntimeDaemonServiceActiveAdmission: admission,
    })).resolves.toBe(true);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        activeTurnId: 'session-turn:exact-1',
        agentRuntimeDaemonServiceActiveAdmission: {
          turnId: 'session-turn:exact-1',
          inputId: 'input:exact-1',
          userMessageSeq: 7,
          userMessageSeqs: [7],
        },
      }),
    ]);

    await expect(updateSessionMarkerActiveTurn({
      pid: 12347,
      sessionId: 'other-session',
      activeTurnId: null,
    })).resolves.toBe(false);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({ activeTurnId: 'session-turn:exact-1' }),
    ]);

    await expect(updateSessionMarkerActiveTurn({
      pid: 12347,
      sessionId: 'sess-active-turn',
      activeTurnId: null,
      expectedAgentRuntimeDaemonServiceActiveAdmission: {
        ...admission,
        inputId: 'input:newer',
      },
    })).resolves.toBe(false);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        activeTurnId: 'session-turn:exact-1',
        agentRuntimeDaemonServiceActiveAdmission: admission,
      }),
    ]);

    await expect(updateSessionMarkerActiveTurn({
      pid: 12347,
      sessionId: 'sess-active-turn',
      activeTurnId: null,
      expectedAgentRuntimeDaemonServiceActiveAdmission:
        admission,
    })).resolves.toBe(true);
    const [cleared] = await listSessionMarkers();
    expect(cleared).not.toHaveProperty('activeTurnId');
    expect(cleared).not.toHaveProperty(
      'agentRuntimeDaemonServiceActiveAdmission',
    );
  });

  it('preserves active-turn custody across routine writes for the same session only', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'sess-active-turn-preserve',
      startedBy: 'daemon',
      cwd: '/tmp',
      activeTurnId: 'session-turn:exact-2',
      agentRuntimeDaemonServiceActiveAdmission: {
        turnId: 'session-turn:exact-2',
        inputId: 'input:exact-2',
        userMessageSeq: null,
        userMessageSeqs: [],
      },
    });

    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'sess-active-turn-preserve',
      startedBy: 'daemon',
      cwd: '/tmp/refreshed',
    });
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        cwd: '/tmp/refreshed',
        activeTurnId: 'session-turn:exact-2',
        agentRuntimeDaemonServiceActiveAdmission:
          expect.objectContaining({
            inputId: 'input:exact-2',
            userMessageSeq: null,
            userMessageSeqs: [],
          }),
      }),
    ]);

    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'sess-replacement',
      startedBy: 'daemon',
      cwd: '/tmp/replacement',
    });
    const [replacement] = await listSessionMarkers();
    expect(replacement).not.toHaveProperty('activeTurnId');
    expect(replacement).not.toHaveProperty(
      'agentRuntimeDaemonServiceActiveAdmission',
    );
  });

  it('preserves daemon respawn recovery across routine writes for the same process identity only', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    const respawn = {
      version: 1 as const,
      directory: '/tmp/session-respawn-preserve',
      backendTarget: {
        kind: 'builtInAgent' as const,
        agentId: 'codex' as const,
      },
      spawnNonce: 'nonce-session-respawn-preserve',
      connectedServices: {
        version: 1 as const,
        bindingsByServiceId: {},
      },
      connectedServiceMaterializationIdentityV1: {
        v: 1 as const,
        id: 'csm_session_respawn_preserve',
        createdAt: 1_000,
      },
    };
    await writeSessionMarker({
      pid: 12350,
      happySessionId: 'sess-respawn-preserve',
      startedBy: 'daemon',
      cwd: '/tmp/session-respawn-preserve',
      processCommandHash: 'e'.repeat(64),
      processStartTimeMs: 2_000,
      respawn,
    });

    await writeSessionMarker({
      pid: 12350,
      happySessionId: 'sess-respawn-preserve',
      startedBy: 'daemon',
      cwd: '/tmp/session-respawn-preserve/refreshed',
      processCommandHash: 'e'.repeat(64),
      processStartTimeMs: 2_000,
    });
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        cwd: '/tmp/session-respawn-preserve/refreshed',
        respawn: expect.objectContaining({
          version: 1,
          directory: '/tmp/session-respawn-preserve',
          backendTarget: {
            kind: 'builtInAgent',
            agentId: 'codex',
          },
          spawnNonce: 'nonce-session-respawn-preserve',
          connectedServices: {
            version: 1,
            bindingsByServiceId: {},
          },
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'csm_session_respawn_preserve',
            createdAt: 1_000,
          },
        }),
      }),
    ]);

    await writeSessionMarker({
      pid: 12350,
      happySessionId: 'sess-respawn-preserve',
      startedBy: 'terminal',
      cwd: '/tmp/session-respawn-preserve/terminal-owned',
      processCommandHash: 'e'.repeat(64),
      processStartTimeMs: 2_000,
    });
    const [terminalOwned] = await listSessionMarkers();
    expect(terminalOwned).toMatchObject({
      happySessionId: 'sess-respawn-preserve',
      startedBy: 'terminal',
      cwd: '/tmp/session-respawn-preserve/terminal-owned',
    });
    expect(terminalOwned).not.toHaveProperty('respawn');

    await writeSessionMarker({
      pid: 12350,
      happySessionId: 'sess-replacement',
      startedBy: 'daemon',
      cwd: '/tmp/session-replacement',
      processCommandHash: 'f'.repeat(64),
      processStartTimeMs: 3_000,
    });
    const [replacement] = await listSessionMarkers();
    expect(replacement).not.toHaveProperty('respawn');
  });

  it('preserves required startup identity across same-session rewrites and rejects conflicts', async () => {
    const {
      listSessionMarkers,
      updateSessionMarkerAgentSessionStartupInstructionsMarker,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const marker = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 7,
    };
    await writeSessionMarker({
      pid: 12349,
      happySessionId: 'sess-startup-instructions',
      startedBy: 'daemon',
      cwd: '/tmp',
    });

    await expect(
      updateSessionMarkerAgentSessionStartupInstructionsMarker({
        pid: 12349,
        sessionId: 'sess-startup-instructions',
        marker,
      }),
    ).resolves.toBe(true);
    await expect(
      updateSessionMarkerAgentSessionStartupInstructionsMarker({
        pid: 12349,
        sessionId: 'other-session',
        marker: { ...marker, revision: 8 },
      }),
    ).resolves.toBe(false);
    await expect(writeSessionMarker({
      pid: 12349,
      happySessionId: 'sess-startup-instructions',
      startedBy: 'daemon',
      cwd: '/tmp/conflicting',
      agentSessionStartupInstructionsMarkerV1: {
        ...marker,
        revision: 8,
      },
    })).rejects.toThrow(
      'session_marker_startup_instructions_marker_conflict',
    );

    await writeSessionMarker({
      pid: 12349,
      happySessionId: 'sess-startup-instructions',
      startedBy: 'daemon',
      cwd: '/tmp/refreshed',
    });
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        cwd: '/tmp/refreshed',
        agentSessionStartupInstructionsMarkerV1: marker,
      }),
    ]);

    await writeSessionMarker({
      pid: 12349,
      happySessionId: 'sess-replacement',
      startedBy: 'daemon',
      cwd: '/tmp/replacement',
    });
    const [replacement] = await listSessionMarkers();
    expect(replacement).not.toHaveProperty(
      'agentSessionStartupInstructionsMarkerV1',
    );
  });

  it('adopts startup-instruction custody from the exact nonce-correlated PID placeholder', async () => {
    const {
      listSessionMarkers,
      updateSessionMarkerAgentSessionStartupInstructionsMarker,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const pid = 12350;
    const spawnNonce = 'startup-instructions-placeholder';
    const marker = {
      v: 1 as const,
      id: 'happier.global_voice_agent',
      revision: 7,
    };
    await writeSessionMarker({
      pid,
      happySessionId: `PID-${pid}`,
      startedBy: 'daemon',
      cwd: '/tmp',
      respawn: {
        version: 1,
        directory: '/tmp',
        spawnNonce,
        backendTarget: {
          kind: 'builtInAgent',
          agentId: 'codex',
        },
      },
    });

    await expect(
      updateSessionMarkerAgentSessionStartupInstructionsMarker({
        pid,
        sessionId: 'sess-startup-instructions-placeholder',
        marker,
        expectedSpawnNonce: 'wrong-nonce',
      }),
    ).resolves.toBe(false);
    await expect(
      updateSessionMarkerAgentSessionStartupInstructionsMarker({
        pid,
        sessionId: 'sess-startup-instructions-placeholder',
        marker,
        expectedSpawnNonce: spawnNonce,
      }),
    ).resolves.toBe(true);

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid,
        happySessionId: 'sess-startup-instructions-placeholder',
        agentSessionStartupInstructionsMarkerV1: marker,
      }),
    ]);
  });

  it('should ignore markers with wrong happyHomeDir and tolerate invalid JSON', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(dir, { recursive: true });
    // Write a marker with different happyHomeDir
    writeFileSync(
      join(dir, 'pid-111.json'),
      JSON.stringify({ pid: 111, happySessionId: 'x', happyHomeDir: '/other', createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8'
    );
    // Write invalid JSON
    writeFileSync(join(dir, 'pid-222.json'), '{', 'utf-8');

    const markers = await listSessionMarkers();
    expect(markers).toEqual([]);
  });

  it('removeSessionMarker should not throw if the marker does not exist', async () => {
    const { removeSessionMarker } = await import('./sessionRegistry');
    await expect(removeSessionMarker(99999)).resolves.toBeUndefined();
  });

  it('conditionally removes only the marker owned by the observed session identity', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      removeSessionMarkerIfOwned,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const pid = 34567;
    const oldProcessCommandHash = hashProcessCommand('old runner');
    const replacementProcessCommandHash = hashProcessCommand('replacement runner');
    await writeSessionMarker({
      pid,
      happySessionId: 'session-old',
      processCommandHash: oldProcessCommandHash,
    });
    await writeSessionMarker({
      pid,
      happySessionId: 'session-replacement',
      processCommandHash: replacementProcessCommandHash,
    });

    await expect(removeSessionMarkerIfOwned({
      pid,
      happySessionId: 'session-old',
      processCommandHash: oldProcessCommandHash,
    })).resolves.toBe(false);

    expect(await listSessionMarkers()).toEqual([
      expect.objectContaining({
        pid,
        happySessionId: 'session-replacement',
        processCommandHash: replacementProcessCommandHash,
      }),
    ]);
  });

  it('does not remove a reused PID marker when the captured process start identity changed', async () => {
    const {
      listSessionMarkers,
      removeSessionMarkerIfOwned,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const pid = 34570;
    await writeSessionMarker({
      pid,
      happySessionId: 'session-same',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 2_000,
    });

    await expect(removeSessionMarkerIfOwned({
      pid,
      happySessionId: 'session-same',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 1_000,
    })).resolves.toBe(false);
    expect(await listSessionMarkers()).toEqual([
      expect.objectContaining({ pid, processStartTimeMs: 2_000 }),
    ]);
  });

  it('serializes conditional removal before a replacement marker write for the same PID', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      removeSessionMarkerIfOwned,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const pid = 34568;
    const oldProcessCommandHash = hashProcessCommand('old runner');
    const replacementProcessCommandHash = hashProcessCommand('replacement runner');
    await writeSessionMarker({
      pid,
      happySessionId: 'session-old',
      processCommandHash: oldProcessCommandHash,
    });

    const removal = removeSessionMarkerIfOwned({
      pid,
      happySessionId: 'session-old',
      processCommandHash: oldProcessCommandHash,
    });
    const replacement = writeSessionMarker({
      pid,
      happySessionId: 'session-replacement',
      processCommandHash: replacementProcessCommandHash,
    });
    await Promise.all([removal, replacement]);

    expect(await listSessionMarkers()).toEqual([
      expect.objectContaining({
        pid,
        happySessionId: 'session-replacement',
        processCommandHash: replacementProcessCommandHash,
      }),
    ]);
  });

  it('vetoes conditional removal when live custody changed before the mutation commits', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      removeSessionMarkerIfOwned,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const pid = 34569;
    const processCommandHash = hashProcessCommand('same resumed runner');
    await writeSessionMarker({
      pid,
      happySessionId: 'session-same',
      processCommandHash,
    });

    await expect(removeSessionMarkerIfOwned({
      pid,
      happySessionId: 'session-same',
      processCommandHash,
      isStillOwned: () => false,
    })).resolves.toBe(false);

    expect(await listSessionMarkers()).toEqual([
      expect.objectContaining({
        pid,
        happySessionId: 'session-same',
        processCommandHash,
      }),
    ]);
  });

  it('writes valid JSON payload shape to disk', async () => {
    const { configuration } = await import('@/configuration');
    const { writeSessionMarker } = await import('./sessionRegistry');

    // 64 hex chars (sha256)
    const processCommandHash = 'a'.repeat(64);

    await writeSessionMarker({
      pid: 54321,
      happySessionId: 'sess-xyz',
      startedBy: 'daemon',
      cwd: '/tmp',
      processCommandHash,
      processStartTimeMs: 1_717_171_717_123,
      processCommand: 'node dist/index.mjs --started-by daemon',
    });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions', 'pid-54321.json');
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(54321);
    expect(parsed.happySessionId).toBe('sess-xyz');
    expect(parsed.happyHomeDir).toBe(configuration.happyHomeDir);
    expect(parsed.startedBy).toBe('daemon');
    expect(parsed.processCommandHash).toBe(processCommandHash);
    expect(parsed.processStartTimeMs).toBe(1_717_171_717_123);
    expect(parsed.processCommand).toBe('node dist/index.mjs --started-by daemon');
    expect(typeof parsed.createdAt).toBe('number');
    expect(typeof parsed.updatedAt).toBe('number');
  });

  it('persists native V1 respawn targets in the predecessor-readable marker shape', async () => {
    const { configuration } = await import('@/configuration');
    const {
      buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
    } = await import('./processSupervision/sessionRunnerRespawnDescriptor');
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    });

    expect(respawn).not.toBeNull();
    await writeSessionMarker({
      pid: 54323,
      happySessionId: 'sess-native-v1-marker',
      startedBy: 'daemon',
      cwd: '/tmp/repo',
      respawn: respawn!,
    });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions', 'pid-54323.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      respawn?: { version?: number; backendTarget?: unknown };
    };
    expect(raw.respawn).toMatchObject({
      version: 1,
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    });
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        respawn: expect.objectContaining({
          version: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        }),
      }),
    ]);
  });

  it('persists Oh My Pi restart identity structurally and imports it for respawn', async () => {
    const { configuration } = await import('@/configuration');
    const {
      buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
    } = await import('./processSupervision/sessionRunnerRespawnDescriptor');
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: { kind: 'backend', backendId: 'ohMyPi', sourceKind: 'built_in' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'ohMyPi',
        agent: {
          backendMode: 'acp',
        },
      },
    });

    expect(respawn).not.toBeNull();
    await writeSessionMarker({
      pid: 54325,
      happySessionId: 'sess-ohmypi-v1-marker',
      startedBy: 'daemon',
      cwd: '/tmp/repo',
      respawn: respawn!,
    });

    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions', 'pid-54325.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { respawn?: unknown };
    expect(raw.respawn).toMatchObject({
      version: 1,
      agentIdentity: {
        pluginId: 'happier.agent.ohmypi',
        localId: 'ohmypi',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentIdentity: {
          pluginId: 'happier.agent.ohmypi',
          localId: 'ohmypi',
        },
        agent: {
          backendMode: 'acp',
        },
      },
    });
    expect(raw.respawn).not.toHaveProperty('backendTarget');
    expect(raw.respawn).not.toHaveProperty('backendTargetV2');
    expect(JSON.stringify(raw.respawn)).not.toContain('ohMyPi');
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        respawn: expect.objectContaining({
          version: 1,
          backendTarget: { kind: 'builtInAgent', agentId: 'ohMyPi' },
          runtimeDescriptorV1: expect.objectContaining({
            agentId: 'ohMyPi',
          }),
        }),
      }),
    ]);
  });

  it('persists a lossy configured V1 projection beside its canonical V2 marker identity', async () => {
    const { configuration } = await import('@/configuration');
    const {
      buildSessionRunnerRespawnDescriptorV1FromSpawnOptions,
    } = await import('./processSupervision/sessionRunnerRespawnDescriptor');
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    const respawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: 'kiro',
        sourceKind: 'configured',
      },
    });

    expect(respawn).not.toBeNull();
    await writeSessionMarker({
      pid: 54324,
      happySessionId: 'sess-configured-v1-marker',
      startedBy: 'daemon',
      cwd: '/tmp/repo',
      respawn: respawn!,
    });

    const expectedRespawn = {
      version: 1,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'kiro' },
      backendTargetV2: {
        kind: 'backend',
        backendId: 'customAcpRuntimeCarrier',
        configuredBackendId: 'kiro',
        sourceKind: 'configured',
      },
    };
    const filePath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions', 'pid-54324.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { respawn?: unknown };
    expect(raw.respawn).toMatchObject(expectedRespawn);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        respawn: expect.objectContaining(expectedRespawn),
      }),
    ]);
  });

   it('allows concurrent marker refreshes for the same pid', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await expect(
      Promise.all([
        writeSessionMarker({
          pid: 12346,
          happySessionId: 'sess-concurrent-a',
          startedBy: 'daemon',
          cwd: '/tmp',
        }),
        writeSessionMarker({
          pid: 12346,
          happySessionId: 'sess-concurrent-b',
          startedBy: 'daemon',
          cwd: '/tmp',
        }),
      ]),
    ).resolves.toHaveLength(2);

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual(
      expect.objectContaining({
        pid: 12346,
        startedBy: 'daemon',
      }),
    );
  });

  it('supports opencode flavor markers', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 777,
      happySessionId: 'sess-opencode',
      startedBy: 'terminal',
      flavor: 'opencode',
      cwd: '/tmp',
    });

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].pid).toBe(777);
    expect(markers[0].flavor).toBe('opencode');
  });

  it('marks and clears connected-service restart intent on an existing marker', async () => {
    const {
      clearSessionMarkerConnectedServiceRestartIntent,
      listSessionMarkers,
      markSessionMarkerConnectedServiceRestartIntent,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 778,
      happySessionId: 'sess-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp',
    });

    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 778,
      requestedAtMs: 1234.9,
    })).resolves.toBe(true);

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 778,
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 1234,
        },
      }),
    ]);

    await clearSessionMarkerConnectedServiceRestartIntent(778);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.not.objectContaining({
        connectedServiceRestartIntent: expect.anything(),
      }),
    ]);
  });

   it('can preserve a connected-service restart intent across routine marker refreshes', async () => {
    const {
      listSessionMarkers,
      markSessionMarkerConnectedServiceRestartIntent,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 780,
      happySessionId: 'sess-preserve-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp',
    });
    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 780,
      requestedAtMs: 55_000,
    })).resolves.toBe(true);

    await writeSessionMarker(
      {
        pid: 780,
        happySessionId: 'sess-preserve-restart-intent',
        startedBy: 'daemon',
        cwd: '/tmp',
        metadata: { codexSessionId: 'codex-thread' },
      },
      { preserveConnectedServiceRestartIntent: true },
    );

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 780,
        metadata: { codexSessionId: 'codex-thread' },
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 55_000,
        },
      }),
    ]);
  });

  it('preserves a connected-service restart intent when mark races with a routine marker refresh', async () => {
    const refreshWriteBlock = createDeferred<void>();
    let refreshWriteBlocked = false;
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
          const data = args[1];
          if (
            !refreshWriteBlocked
            && typeof data === 'string'
            && data.includes('"refreshMarkerRace": true')
          ) {
            refreshWriteBlocked = true;
            await refreshWriteBlock.promise;
          }
          return await actual.writeFile(...args);
        }),
      };
    });

    try {
      const {
        listSessionMarkers,
        markSessionMarkerConnectedServiceRestartIntent,
        writeSessionMarker,
      } = await import('./sessionRegistry');

      await writeSessionMarker({
        pid: 782,
        happySessionId: 'sess-mark-refresh-race',
        startedBy: 'daemon',
        cwd: '/tmp',
      });

      const refreshPromise = writeSessionMarker(
        {
          pid: 782,
          happySessionId: 'sess-mark-refresh-race',
          startedBy: 'daemon',
          cwd: '/tmp',
          metadata: { refreshMarkerRace: true },
        },
        { preserveConnectedServiceRestartIntent: true },
      );
      await waitUntil(() => refreshWriteBlocked);

      const markPromise = markSessionMarkerConnectedServiceRestartIntent({
        pid: 782,
        requestedAtMs: 78_200,
      });
      await Promise.race([
        markPromise,
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);

      refreshWriteBlock.resolve();
      await Promise.all([refreshPromise, markPromise]);

      await expect(listSessionMarkers()).resolves.toEqual([
        expect.objectContaining({
          pid: 782,
          metadata: { refreshMarkerRace: true },
          connectedServiceRestartIntent: {
            v: 1,
            requestedAtMs: 78_200,
          },
        }),
      ]);
    } finally {
      refreshWriteBlock.resolve();
      vi.resetModules();
    }
  });

  it('does not resurrect a connected-service restart intent when clear races with a routine marker refresh', async () => {
    const refreshWriteBlock = createDeferred<void>();
    let refreshWriteBlocked = false;
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return {
        ...actual,
        writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
          const data = args[1];
          if (
            !refreshWriteBlocked
            && typeof data === 'string'
            && data.includes('"refreshMarkerRace": true')
          ) {
            refreshWriteBlocked = true;
            await refreshWriteBlock.promise;
          }
          return await actual.writeFile(...args);
        }),
      };
    });

    try {
      const {
        clearSessionMarkerConnectedServiceRestartIntent,
        listSessionMarkers,
        writeSessionMarker,
      } = await import('./sessionRegistry');

      await writeSessionMarker({
        pid: 783,
        happySessionId: 'sess-clear-refresh-race',
        startedBy: 'daemon',
        cwd: '/tmp',
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 78_300,
        },
      });

      const refreshPromise = writeSessionMarker(
        {
          pid: 783,
          happySessionId: 'sess-clear-refresh-race',
          startedBy: 'daemon',
          cwd: '/tmp',
          metadata: { refreshMarkerRace: true },
        },
        { preserveConnectedServiceRestartIntent: true },
      );
      await waitUntil(() => refreshWriteBlocked);

      const clearPromise = clearSessionMarkerConnectedServiceRestartIntent(783);
      await Promise.race([
        clearPromise,
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);

      refreshWriteBlock.resolve();
      await Promise.all([refreshPromise, clearPromise]);

      const markers = await listSessionMarkers();
      expect(markers).toEqual([
        expect.objectContaining({
          pid: 783,
          metadata: { refreshMarkerRace: true },
        }),
      ]);
      expect(markers[0]).not.toHaveProperty('connectedServiceRestartIntent');
    } finally {
      refreshWriteBlock.resolve();
      vi.resetModules();
    }
  });

  it('does not create a connected-service restart intent marker when no session marker exists', async () => {
    const { listSessionMarkers, markSessionMarkerConnectedServiceRestartIntent } = await import('./sessionRegistry');

    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 779,
      requestedAtMs: 1234,
    })).resolves.toBe(false);
    await expect(listSessionMarkers()).resolves.toEqual([]);
  });

  it('promotes onto a nonce-correlated canonical runner marker without replacing its identity', async () => {
    const {
      listSessionMarkers,
      markSessionMarkerConnectedServiceRestartIntent,
      promoteSessionMarkerPid,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const respawn = {
      version: 1 as const,
      directory: '/wrapper',
      spawnNonce: 'nonce-promote-existing-target',
    };

    await writeSessionMarker({
      pid: 780,
      happySessionId: 'PID-780',
      startedBy: 'daemon',
      cwd: '/wrapper',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 1_000,
      processCommand: 'wrapper command',
      metadata: { owner: 'wrapper' },
      respawn,
      activeTurnId: 'turn-from-wrapper',
      agentSessionStartupInstructionsMarkerV1: {
        v: 1,
        id: 'happier.global_voice_agent',
        revision: 7,
      },
    });
    await writeSessionMarker({
      pid: 781,
      happySessionId: 'sess-promote-intent',
      startedBy: 'daemon',
      cwd: '/runner',
      processCommandHash: 'b'.repeat(64),
      processCommand: 'runner command',
      metadata: { owner: 'runner' },
      respawn: {
        ...respawn,
        directory: '/runner',
      },
    });
    await markSessionMarkerConnectedServiceRestartIntent({
      pid: 780,
      requestedAtMs: 5678,
    });

    await expect(promoteSessionMarkerPid(780, 781)).resolves.toEqual({
      sourceMarkerOwnership: {
        happySessionId: 'PID-780',
        processCommandHash: 'a'.repeat(64),
        processStartTimeMs: 1_000,
      },
      targetMarkerOwnership: {
        happySessionId: 'sess-promote-intent',
        processCommandHash: 'b'.repeat(64),
      },
      targetProcessCommand: 'runner command',
    });

    const markers = await listSessionMarkers();
    const wrapperMarker = markers.find((marker) => marker.pid === 780);
    const runnerMarker = markers.find((marker) => marker.pid === 781);
    expect(wrapperMarker).toEqual(expect.objectContaining({
      happySessionId: 'PID-780',
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 5678,
      },
    }));
    expect(runnerMarker).toEqual(expect.objectContaining({
      pid: 781,
      happySessionId: 'sess-promote-intent',
      cwd: '/runner',
      processCommandHash: 'b'.repeat(64),
      processCommand: 'runner command',
      metadata: { owner: 'runner' },
      activeTurnId: 'turn-from-wrapper',
      agentSessionStartupInstructionsMarkerV1: {
        v: 1,
        id: 'happier.global_voice_agent',
        revision: 7,
      },
    }));
    expect(runnerMarker).not.toHaveProperty('connectedServiceRestartIntent');
  });

  it('promotes a canonical resume wrapper onto the same nonce-correlated canonical runner session', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      promoteSessionMarkerPid,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 792,
      happySessionId: 'sess-resume-promotion',
      startedBy: 'daemon',
      cwd: '/wrapper',
      processCommandHash: 'a'.repeat(64),
      processCommand: 'wrapper command',
      metadata: { owner: 'wrapper' },
      respawn: {
        version: 1,
        directory: '/wrapper',
        spawnNonce: 'nonce-resume-promotion',
      },
      activeTurnId: 'turn-from-resume-wrapper',
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 7890,
      },
    });
    await writeSessionMarker({
      pid: 793,
      happySessionId: 'sess-resume-promotion',
      startedBy: 'daemon',
      cwd: '/runner',
      processCommandHash: 'b'.repeat(64),
      processCommand: 'runner command',
      metadata: { owner: 'runner' },
      respawn: {
        version: 1,
        directory: '/runner',
        spawnNonce: 'nonce-resume-promotion',
      },
    });

    await expect(promoteSessionMarkerPid(792, 793)).resolves.toEqual({
      sourceMarkerOwnership: {
        happySessionId: 'sess-resume-promotion',
        processCommandHash: 'a'.repeat(64),
      },
      targetMarkerOwnership: {
        happySessionId: 'sess-resume-promotion',
        processCommandHash: 'b'.repeat(64),
      },
      targetProcessCommand: 'runner command',
    });

    const markers = await listSessionMarkers();
    expect(markers.find((marker) => marker.pid === 792)).toEqual(expect.objectContaining({
      happySessionId: 'sess-resume-promotion',
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 7890,
      },
    }));
    const runnerMarker = markers.find((marker) => marker.pid === 793);
    expect(runnerMarker).toEqual(expect.objectContaining({
      happySessionId: 'sess-resume-promotion',
      cwd: '/runner',
      processCommandHash: 'b'.repeat(64),
      processCommand: 'runner command',
      metadata: { owner: 'runner' },
      activeTurnId: 'turn-from-resume-wrapper',
      respawn: expect.objectContaining({
        spawnNonce: 'nonce-resume-promotion',
      }),
    }));
    expect(runnerMarker).not.toHaveProperty('connectedServiceRestartIntent');
  });

  it.each([
    {
      sourceIdentity: 'placeholder',
      wrapperPid: 794,
      runnerPid: 795,
      sourceSessionId: 'PID-794',
    },
    {
      sourceIdentity: 'canonical',
      wrapperPid: 796,
      runnerPid: 797,
      sourceSessionId: 'sess-composed-promotion',
    },
  ])(
    'removes only the exact $sourceIdentity wrapper marker after transferring live custody to its canonical runner',
    async ({ wrapperPid, runnerPid, sourceSessionId }) => {
      const {
        listSessionMarkers,
        removeSessionMarkerIfOwned,
        writeSessionMarker,
      } = await import('./sessionRegistry');
      const { createOnChildExited } = await import('./sessions/onChildExited');
      const canonicalSessionId = 'sess-composed-promotion';
      const wrapperProcessCommandHash = 'a'.repeat(64);
      const runnerProcessCommandHash = 'b'.repeat(64);
      const spawnNonce = `nonce-composed-promotion-${wrapperPid}`;

      await writeSessionMarker({
        pid: wrapperPid,
        happySessionId: sourceSessionId,
        startedBy: 'daemon',
        cwd: '/wrapper',
        processCommandHash: wrapperProcessCommandHash,
        processCommand: 'wrapper command',
        metadata: { owner: 'wrapper' },
        respawn: {
          version: 1,
          directory: '/wrapper',
          spawnNonce,
        },
      });
      await writeSessionMarker({
        pid: runnerPid,
        happySessionId: canonicalSessionId,
        startedBy: 'daemon',
        cwd: '/runner',
        processCommandHash: runnerProcessCommandHash,
        processCommand: 'runner command',
        metadata: { owner: 'runner' },
        respawn: {
          version: 1,
          directory: '/runner',
          spawnNonce,
        },
      });

      const tracked = {
        pid: wrapperPid,
        startedBy: 'daemon',
        happySessionId: canonicalSessionId,
        processCommandHash: runnerProcessCommandHash,
        sessionRunnerPid: runnerPid,
      };
      const pidToTrackedSession = new Map([[wrapperPid, tracked]]);
      const removeSessionMarkerIfOwnedFn = vi.fn(async (input: Parameters<typeof removeSessionMarkerIfOwned>[0]) => {
        expect(pidToTrackedSession.has(wrapperPid)).toBe(false);
        expect(pidToTrackedSession.get(runnerPid)).toEqual(expect.objectContaining({
          pid: runnerPid,
          happySessionId: canonicalSessionId,
        }));
        return await removeSessionMarkerIfOwned(input);
      });
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === runnerPid && signal === 0) return true;
        return originalKill(pid, signal);
      }) as typeof process.kill);

      try {
        const onChildExited = createOnChildExited({
          pidToTrackedSession,
          spawnResourceCleanupByPid: new Map(),
          sessionAttachCleanupByPid: new Map(),
          getApiMachineForSessions: () => null,
          removeSessionMarkerIfOwnedFn,
        });

        await onChildExited(wrapperPid, {
          reason: 'process-exited',
          code: 0,
          signal: null,
        });

        expect(removeSessionMarkerIfOwnedFn).toHaveBeenCalledWith(expect.objectContaining({
          pid: wrapperPid,
          happySessionId: sourceSessionId,
          processCommandHash: wrapperProcessCommandHash,
        }));
        expect(await listSessionMarkers()).toEqual([
          expect.objectContaining({
            pid: runnerPid,
            happySessionId: canonicalSessionId,
            processCommandHash: runnerProcessCommandHash,
            processCommand: 'runner command',
            metadata: { owner: 'runner' },
          }),
        ]);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it('rejects an existing runner marker with a different spawn nonce without changing either marker', async () => {
    const {
      listSessionMarkers,
      promoteSessionMarkerPid,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 784,
      happySessionId: 'PID-784',
      startedBy: 'daemon',
      cwd: '/wrapper',
      processCommandHash: 'a'.repeat(64),
      processCommand: 'wrapper command',
      metadata: { owner: 'wrapper' },
      respawn: {
        version: 1,
        directory: '/wrapper',
        spawnNonce: 'nonce-wrapper',
      },
      activeTurnId: 'turn-wrapper',
    });
    await writeSessionMarker({
      pid: 785,
      happySessionId: 'sess-unrelated-runner',
      startedBy: 'daemon',
      cwd: '/runner',
      processCommandHash: 'b'.repeat(64),
      processCommand: 'runner command',
      metadata: { owner: 'runner' },
      respawn: {
        version: 1,
        directory: '/runner',
        spawnNonce: 'nonce-other',
      },
    });
    const before = await listSessionMarkers();

    await expect(promoteSessionMarkerPid(784, 785)).resolves.toBeNull();
    await expect(listSessionMarkers()).resolves.toEqual(before);
  });

  it('rejects an existing runner marker for a different canonical session or missing nonce correlation', async () => {
    const {
      listSessionMarkers,
      promoteSessionMarkerPid,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 788,
      happySessionId: 'sess-not-a-wrapper-placeholder',
      startedBy: 'daemon',
      cwd: '/wrapper',
      respawn: {
        version: 1,
        directory: '/wrapper',
        spawnNonce: 'nonce-shared',
      },
    });
    await writeSessionMarker({
      pid: 789,
      happySessionId: 'sess-canonical-runner',
      startedBy: 'daemon',
      cwd: '/runner',
      respawn: {
        version: 1,
        directory: '/runner',
        spawnNonce: 'nonce-shared',
      },
    });
    const beforeNonPlaceholder = await listSessionMarkers();
    await expect(promoteSessionMarkerPid(788, 789)).resolves.toBeNull();
    await expect(listSessionMarkers()).resolves.toEqual(beforeNonPlaceholder);

    await writeSessionMarker({
      pid: 790,
      happySessionId: 'PID-790',
      startedBy: 'daemon',
      cwd: '/wrapper-without-nonce',
      respawn: {
        version: 1,
        directory: '/wrapper-without-nonce',
      },
    });
    await writeSessionMarker({
      pid: 791,
      happySessionId: 'sess-runner-without-correlation',
      startedBy: 'daemon',
      cwd: '/runner-without-nonce',
      respawn: {
        version: 1,
        directory: '/runner-without-nonce',
      },
    });
    const beforeMissingNonce = await listSessionMarkers();
    await expect(promoteSessionMarkerPid(790, 791)).resolves.toBeNull();
    await expect(listSessionMarkers()).resolves.toEqual(beforeMissingNonce);
  });

  it('retains the existing no-target marker promotion behavior', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      promoteSessionMarkerPid,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 786,
      happySessionId: 'PID-786',
      startedBy: 'daemon',
      cwd: '/wrapper',
      processCommandHash: 'a'.repeat(64),
      processCommand: 'wrapper command',
      metadata: { owner: 'wrapper' },
      respawn: {
        version: 1,
        directory: '/wrapper',
        spawnNonce: 'nonce-no-target',
      },
      activeTurnId: 'turn-wrapper',
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 6789,
      },
    });

    await expect(promoteSessionMarkerPid(786, 787, {
      readProcessIdentityByPidFn: async () => ({
        pid: 787,
        processStartTimeMs: 1_717_171_717_000,
        command: 'runner command',
      }),
    })).resolves.toEqual({
      sourceMarkerOwnership: {
        happySessionId: 'PID-786',
        processCommandHash: 'a'.repeat(64),
      },
      targetMarkerOwnership: {
        happySessionId: 'PID-786',
        processCommandHash: hashProcessCommand('runner command'),
        processStartTimeMs: 1_717_171_717_000,
      },
      targetProcessCommand: 'runner command',
    });
    const promoted = (await listSessionMarkers()).find((marker) => marker.pid === 787);
    expect(promoted).toEqual(expect.objectContaining({
      happySessionId: 'PID-786',
      cwd: '/wrapper',
      processCommand: 'runner command',
      processCommandHash: hashProcessCommand('runner command'),
      processStartTimeMs: 1_717_171_717_000,
      metadata: { owner: 'wrapper' },
      activeTurnId: 'turn-wrapper',
      respawn: expect.objectContaining({
        spawnNonce: 'nonce-no-target',
      }),
    }));
    expect(promoted).not.toHaveProperty('connectedServiceRestartIntent');
  });

  it('writes markers into a channel-scoped tmp dir for the dev public ring', async () => {
    process.env.HAPPIER_RELEASE_RING = 'dev';
    vi.resetModules();

    const { configuration } = await import('@/configuration');
    const { writeSessionMarker } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 9001,
      happySessionId: 'sess-dev',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markerPath = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions.dev', 'pid-9001.json');
    expect(existsSync(markerPath)).toBe(true);
  });

  it('reads and removes legacy preview session markers', async () => {
    process.env.HAPPIER_RELEASE_RING = 'dev';
    vi.resetModules();

    const { configuration } = await import('@/configuration');
    const { listSessionMarkers, removeSessionMarker } = await import('./sessionRegistry');

    const legacyPreviewDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions.preview');
    mkdirSync(legacyPreviewDir, { recursive: true });
    writeFileSync(
      join(legacyPreviewDir, 'pid-404.json'),
      JSON.stringify(
        {
          pid: 404,
          happySessionId: 'sess-404',
          happyHomeDir: configuration.happyHomeDir,
          createdAt: 1,
          updatedAt: 2,
          startedBy: 'daemon',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      pid: 404,
      happySessionId: 'sess-404',
    });

    await removeSessionMarker(404);
    expect(existsSync(join(legacyPreviewDir, 'pid-404.json'))).toBe(false);
  });

  it('tolerates older respawn markers with experimentalCodexResume', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');

    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, 'pid-333.json'),
      JSON.stringify(
        {
          pid: 333,
          happySessionId: 'sess-333',
          happyHomeDir: configuration.happyHomeDir,
          createdAt: 1,
          updatedAt: 2,
          respawn: {
            version: 1,
            directory: '/tmp',
            experimentalCodexResume: true,
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].pid).toBe(333);
    expect(markers[0].respawn).toMatchObject({
      version: 1,
      directory: '/tmp',
      codexBackendMode: 'acp',
    });
    expect(markers[0].respawn).not.toHaveProperty('experimentalCodexResume');
  });


  it('never mirrors replay seed text into the on-disk session marker', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    const seedText = `REPLAY-SEED-${'x'.repeat(4096)}`;

    await writeSessionMarker({
      pid: 12399,
      happySessionId: 'sess-replay-seeded',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      metadata: {
        hostPid: 12399,
        flavor: 'cursor',
        replaySeedV1: {
          v: 1,
          seedText,
          sourceSessionId: 'source-session',
          sourceCutoffSeqInclusive: 12,
          createdAtMs: 1,
        },
      },
    });

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    // The seed is the user's prior conversation in cleartext. The Session row is
    // e2ee, so mirroring it into a temp file would publish what the Session hides.
    expect(markers[0].metadata.replaySeedV1.seedText).toBe('');
    // Blanked exactly the way the Session-metadata owner retires a seed: the
    // identity fields, and every other mirrored field, survive.
    expect(markers[0].metadata.replaySeedV1).toMatchObject({
      v: 1,
      sourceSessionId: 'source-session',
      sourceCutoffSeqInclusive: 12,
    });
    expect(markers[0].metadata.flavor).toBe('cursor');

    const raw = readFileSync(
      join(configuration.happyHomeDir, 'tmp', 'daemon-sessions', 'pid-12399.json'),
      'utf-8',
    );
    expect(raw).not.toContain(seedText);
  });

  it('blanks a replay seed that an older marker already mirrored to disk', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers, updateSessionMarkerActiveTurn } = await import('./sessionRegistry');
    const seedText = `REPLAY-SEED-${'y'.repeat(4096)}`;
    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    const filePath = join(dir, 'pid-12400.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        pid: 12400,
        happySessionId: 'sess-stale-seed',
        happyHomeDir: configuration.happyHomeDir,
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        metadata: {
          hostPid: 12400,
          replaySeedV1: {
            v: 1,
            seedText,
            sourceSessionId: 'source-session',
            sourceCutoffSeqInclusive: 12,
            createdAtMs: 1,
          },
        },
      }),
      'utf-8',
    );

    await updateSessionMarkerActiveTurn({
      pid: 12400,
      sessionId: 'sess-stale-seed',
      activeTurnId: 'turn-1',
    });

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].activeTurnId).toBe('turn-1');
    expect(markers[0].metadata.replaySeedV1.seedText).toBe('');
    expect(readFileSync(filePath, 'utf-8')).not.toContain(seedText);
  });

});

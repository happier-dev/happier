import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('rewrites only the expected respawn ciphertext under exact marker ownership', async () => {
    const {
      listSessionMarkers,
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const processCommandHash = 'a'.repeat(64);
    const processStartTimeMs = 1_717_171_717_123;
    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'session-respawn-reseal',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash,
      processStartTimeMs,
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: {
          kind: 'builtInAgent',
          agentId: 'codex',
        },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: 'historical-alias',
        },
      },
    });

    await expect(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned({
        pid: 12348,
        ownership: {
          happySessionId: 'session-respawn-reseal',
          processCommandHash,
          processStartTimeMs,
        },
        expectedCiphertext: 'historical-alias',
        replacementCiphertext: 'canonical',
      }),
    ).resolves.toBe(true);
    await expect(
      rewriteSessionMarkerRespawnEnvironmentCiphertextIfOwned({
        pid: 12348,
        ownership: {
          happySessionId: 'session-respawn-reseal',
          processCommandHash,
          processStartTimeMs: processStartTimeMs + 1,
        },
        expectedCiphertext: 'canonical',
        replacementCiphertext: 'must-not-write',
      }),
    ).resolves.toBe(false);

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 12348,
        happySessionId: 'session-respawn-reseal',
        processCommandHash,
        processStartTimeMs,
        respawn: expect.objectContaining({
          sealedEnvironmentVariables: {
            format: 'account_scoped_v1',
            ciphertext: 'canonical',
          },
        }),
      }),
    ]);
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
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        spawnNonce: 'nonce-before-session-attach',
        agentSessionStartupInstructionsV1: startupInstructions,
      },
    };

    await persistAcceptedSpawnMarker({
      readProcessIdentityByPidFn: async () => ({
        pid: 12346,
        processStartTimeMs: 1_717_171_717_000,
        command: 'happier codex --started-by daemon',
      }),
      trackedSession,
      managedLocalServiceRunAttachment: {
        v: 1,
        process: {
          pid: 701,
          processStartTimeMs: 1_717_171_717_701,
          processCommandHash: 'a'.repeat(64),
        },
        endpoint: {
          host: '127.0.0.1',
          port: 45_701,
        },
        materialization: {
          rootDir: '/tmp/happier-managed-provider',
          materializationId: 'materialization-managed-provider',
        },
      },
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
        }),
        agentSessionStartupInstructionsMarkerV1: startupInstructionsMarker,
        managedLocalServiceRunAttachment: {
          v: 1,
          process: {
            pid: 701,
            processStartTimeMs: 1_717_171_717_701,
            processCommandHash: 'a'.repeat(64),
          },
          endpoint: {
            host: '127.0.0.1',
            port: 45_701,
          },
          materialization: {
            rootDir: '/tmp/happier-managed-provider',
            materializationId: 'materialization-managed-provider',
          },
        },
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

  it('refuses managed wrapper custody when the accepted Agent process identity is incomplete', async () => {
    const { persistAcceptedSpawnMarker } = await import('./spawn/persistAcceptedSpawnMarker');
    const { listSessionMarkers } = await import('./sessionRegistry');

    await expect(persistAcceptedSpawnMarker({
      readProcessIdentityByPidFn: async () => ({
        pid: 12347,
        command: 'happier codex --started-by daemon',
      }),
      trackedSession: {
        startedBy: 'daemon',
        pid: 12347,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          spawnNonce: 'nonce-incomplete-agent-identity',
        },
      },
      managedLocalServiceRunAttachment: {
        v: 1,
        process: {
          pid: 702,
          processStartTimeMs: 1_717_171_717_702,
          processCommandHash: 'b'.repeat(64),
        },
        endpoint: {
          host: '127.0.0.1',
          port: 45_702,
        },
        materialization: {
          rootDir: '/tmp/happier-managed-provider-incomplete-agent',
          materializationId: 'materialization-managed-provider-incomplete-agent',
        },
      },
    })).rejects.toThrow('Managed local-service custody requires exact Agent process identity');

    await expect(listSessionMarkers()).resolves.toEqual([]);
  });

  it('persists and clears only the exact active turn for the matching session marker', async () => {
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

    await expect(updateSessionMarkerActiveTurn({
      pid: 12347,
      sessionId: 'sess-active-turn',
      activeTurnId: 'session-turn:exact-1',
    })).resolves.toBe(true);
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({ activeTurnId: 'session-turn:exact-1' }),
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
    })).resolves.toBe(true);
    const [cleared] = await listSessionMarkers();
    expect(cleared).not.toHaveProperty('activeTurnId');
  });

  it('preserves active-turn custody across routine writes for the same session only', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    await writeSessionMarker({
      pid: 12348,
      happySessionId: 'sess-active-turn-preserve',
      startedBy: 'daemon',
      cwd: '/tmp',
      activeTurnId: 'session-turn:exact-2',
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

  it('preserves a managed local-service run attachment across same-session rewrites only', async () => {
    const {
      listSessionMarkers,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_680,
        processStartTimeMs: 1_717_171_717_000,
        processCommandHash: 'a'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_680 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime',
        materializationId: 'materialization-1',
      },
    };
    const ownership = {
      happySessionId: 'sess-managed-service',
      processCommandHash: '1'.repeat(64),
      processStartTimeMs: 1_717_171_700_000,
    };

    await writeSessionMarker({
      pid: 12_340,
      ...ownership,
      startedBy: 'daemon',
      cwd: '/tmp/first',
    });
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_340,
      ownership,
      expectedAttachment: null,
      attachment,
    })).resolves.toBe(true);

    await writeSessionMarker({
      pid: 12_340,
      ...ownership,
      startedBy: 'daemon',
      cwd: '/tmp/refreshed',
    });
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        cwd: '/tmp/refreshed',
        managedLocalServiceRunAttachment: attachment,
      }),
    ]);

    await writeSessionMarker({
      pid: 12_340,
      happySessionId: 'sess-replacement',
      processCommandHash: ownership.processCommandHash,
      processStartTimeMs: ownership.processStartTimeMs,
      startedBy: 'daemon',
      cwd: '/tmp/replacement',
    });
    const [replacement] = await listSessionMarkers();
    expect(replacement).not.toHaveProperty('managedLocalServiceRunAttachment');
  });

  it('adopts an exact same-process PID placeholder into the canonical session and preserves its managed attachment', async () => {
    const {
      listSessionMarkers,
      writeSessionMarker,
      writeSessionMarkerWithManagedLocalServiceRunAttachment,
    } = await import('./sessionRegistry');
    const pid = 12_341;
    const processCommandHash = '2'.repeat(64);
    const processStartTimeMs = 1_717_171_700_001;
    const spawnNonce = 'nonce-same-pid-canonical-adoption';
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_681,
        processStartTimeMs: 1_717_171_717_001,
        processCommandHash: 'b'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_681 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-adoption',
        materializationId: 'materialization-adoption',
      },
    };

    await writeSessionMarkerWithManagedLocalServiceRunAttachment({
      marker: {
        pid,
        happySessionId: `PID-${pid}`,
        processCommandHash,
        processStartTimeMs,
        startedBy: 'daemon',
        cwd: '/tmp/placeholder',
        respawn: {
          version: 1,
          directory: '/tmp/placeholder',
          spawnNonce,
        },
      },
      attachment,
    });
    await writeSessionMarker({
      pid,
      happySessionId: 'session-canonical',
      processCommandHash,
      processStartTimeMs,
      startedBy: 'daemon',
      cwd: '/tmp/canonical',
      respawn: {
        version: 1,
        directory: '/tmp/canonical',
        spawnNonce,
      },
    }, {
      adoptCanonicalSessionIdFromPidPlaceholder: true,
    });

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid,
        happySessionId: 'session-canonical',
        cwd: '/tmp/canonical',
        managedLocalServiceRunAttachment: attachment,
      }),
    ]);
    await expect(writeSessionMarker({
      pid,
      happySessionId: 'session-conflict',
      processCommandHash: '3'.repeat(64),
      processStartTimeMs,
      startedBy: 'daemon',
      cwd: '/tmp/conflict',
      respawn: {
        version: 1,
        directory: '/tmp/conflict',
        spawnNonce,
      },
    }, {
      adoptCanonicalSessionIdFromPidPlaceholder: true,
    })).rejects.toThrow(
      'session_marker_canonical_adoption_ownership_mismatch',
    );
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid,
        happySessionId: 'session-canonical',
        cwd: '/tmp/canonical',
        managedLocalServiceRunAttachment: attachment,
      }),
    ]);
  });

  it('rejects same-process canonical adoption from a foreign spawn nonce without losing managed custody', async () => {
    const {
      listSessionMarkers,
      writeSessionMarker,
      writeSessionMarkerWithManagedLocalServiceRunAttachment,
    } = await import('./sessionRegistry');
    const pid = 12_342;
    const processCommandHash = '4'.repeat(64);
    const processStartTimeMs = 1_717_171_700_002;
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_682,
        processStartTimeMs: 1_717_171_717_002,
        processCommandHash: 'c'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_682 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-foreign-adoption',
        materializationId: 'materialization-foreign-adoption',
      },
    };
    await writeSessionMarkerWithManagedLocalServiceRunAttachment({
      marker: {
        pid,
        happySessionId: `PID-${pid}`,
        processCommandHash,
        processStartTimeMs,
        startedBy: 'daemon',
        cwd: '/tmp/placeholder',
        respawn: {
          version: 1,
          directory: '/tmp/placeholder',
          spawnNonce: 'nonce-accepted-spawn',
        },
      },
      attachment,
    });

    await expect(writeSessionMarker({
      pid,
      happySessionId: 'session-foreign-spawn',
      processCommandHash,
      processStartTimeMs,
      startedBy: 'daemon',
      cwd: '/tmp/foreign',
      respawn: {
        version: 1,
        directory: '/tmp/foreign',
        spawnNonce: 'nonce-foreign-spawn',
      },
    }, {
      adoptCanonicalSessionIdFromPidPlaceholder: true,
    })).rejects.toThrow(
      'session_marker_canonical_adoption_ownership_mismatch',
    );

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid,
        happySessionId: `PID-${pid}`,
        cwd: '/tmp/placeholder',
        respawn: expect.objectContaining({
          spawnNonce: 'nonce-accepted-spawn',
        }),
        managedLocalServiceRunAttachment: attachment,
      }),
    ]);
  });

  it('does not preserve or mutate an attachment after same-session PID reuse', async () => {
    const {
      clearSessionMarkerManagedLocalServiceRunAttachment,
      listSessionMarkers,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const attachment = (suffix: string, pid: number) => ({
      v: 1 as const,
      process: {
        pid,
        processStartTimeMs: 1_717_171_717_010,
        processCommandHash: suffix.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_690 },
      materialization: {
        rootDir: `/tmp/happier-provider-runtime-reuse-${suffix}`,
        materializationId: `materialization-reuse-${suffix}`,
      },
    });
    const staleAttachment = attachment('8', 24_690);
    const currentAttachment = attachment('9', 24_691);
    const staleOwnership = {
      happySessionId: 'sess-managed-service-reused',
      processCommandHash: 'a'.repeat(64),
      processStartTimeMs: 1_717_171_700_010,
    };
    const currentOwnership = {
      ...staleOwnership,
      processCommandHash: 'b'.repeat(64),
      processStartTimeMs: 1_717_171_700_011,
    };
    await writeSessionMarker({
      pid: 12_349,
      ...staleOwnership,
      startedBy: 'daemon',
      cwd: '/tmp/stale-owner',
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_349,
      ownership: staleOwnership,
      expectedAttachment: null,
      attachment: staleAttachment,
    });

    await writeSessionMarker({
      pid: 12_349,
      ...currentOwnership,
      startedBy: 'daemon',
      cwd: '/tmp/current-owner',
    });
    let [current] = await listSessionMarkers();
    expect(current).not.toHaveProperty('managedLocalServiceRunAttachment');
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_349,
      ownership: staleOwnership,
      expectedAttachment: null,
      attachment: staleAttachment,
    })).resolves.toBe(false);
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_349,
      ownership: currentOwnership,
      expectedAttachment: null,
      attachment: currentAttachment,
    })).resolves.toBe(true);
    await expect(clearSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_349,
      ownership: staleOwnership,
      attachment: currentAttachment,
    })).resolves.toBe('mismatch');
    [current] = await listSessionMarkers();
    expect(current.managedLocalServiceRunAttachment).toEqual(currentAttachment);
  });

  it('sets and clears only the exact managed local-service attachment owned by the session', async () => {
    const {
      clearSessionMarkerManagedLocalServiceRunAttachment,
      listSessionMarkers,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const first = {
      v: 1 as const,
      process: {
        pid: 24_681,
        processStartTimeMs: 1_717_171_717_001,
        processCommandHash: 'b'.repeat(64),
      },
      endpoint: { host: '::1' as const, port: 40_681 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-first',
        materializationId: 'materialization-first',
      },
    };
    const replacement = {
      ...first,
      process: {
        ...first.process,
        pid: 24_682,
        processCommandHash: 'c'.repeat(64),
      },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-replacement',
        materializationId: 'materialization-replacement',
      },
    };
    const ownership = {
      happySessionId: 'sess-managed-service-cas',
      processCommandHash: '2'.repeat(64),
      processStartTimeMs: 1_717_171_700_001,
    };

    await writeSessionMarker({
      pid: 12_341,
      ...ownership,
      startedBy: 'daemon',
      cwd: '/tmp',
    });
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_341,
      ownership: { ...ownership, happySessionId: 'other-session' },
      expectedAttachment: null,
      attachment: first,
    })).resolves.toBe(false);
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_341,
      ownership,
      expectedAttachment: null,
      attachment: first,
    })).resolves.toBe(true);
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_341,
      ownership,
      expectedAttachment: null,
      attachment: replacement,
    })).resolves.toBe(false);
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_341,
      ownership,
      expectedAttachment: first,
      attachment: replacement,
    })).resolves.toBe(true);

    await expect(clearSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_341,
      ownership,
      attachment: first,
    })).resolves.toBe('mismatch');
    await expect(clearSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_341,
      ownership,
      attachment: replacement,
    })).resolves.toBe('cleared');
    await expect(clearSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_341,
      ownership,
      attachment: replacement,
    })).resolves.toBe('already_absent');
    const [cleared] = await listSessionMarkers();
    expect(cleared).not.toHaveProperty('managedLocalServiceRunAttachment');
  });

  it('does not let a stale full-marker rewrite resurrect a cleared managed local-service attachment', async () => {
    const {
      clearSessionMarkerManagedLocalServiceRunAttachment,
      listSessionMarkers,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_687,
        processStartTimeMs: 1_717_171_717_005,
        processCommandHash: 'b'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_687 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-stale',
        materializationId: 'materialization-stale',
      },
    };
    const ownership = {
      happySessionId: 'sess-managed-service-stale',
      processCommandHash: '3'.repeat(64),
      processStartTimeMs: 1_717_171_700_002,
    };
    await writeSessionMarker({
      pid: 12_347,
      ...ownership,
      startedBy: 'daemon',
      cwd: '/tmp/first',
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_347,
      ownership,
      expectedAttachment: null,
      attachment,
    });
    const stale = (await listSessionMarkers())[0];
    await expect(clearSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_347,
      ownership,
      attachment,
    })).resolves.toBe('cleared');

    await writeSessionMarker({
      ...stale,
      cwd: '/tmp/stale-rewrite',
    });

    const [afterStaleRewrite] = await listSessionMarkers();
    expect(afterStaleRewrite.cwd).toBe('/tmp/stale-rewrite');
    expect(afterStaleRewrite).not.toHaveProperty('managedLocalServiceRunAttachment');
  });

  it('keeps the current CAS winner when a stale attachment clear races replacement', async () => {
    const {
      clearSessionMarkerManagedLocalServiceRunAttachment,
      listSessionMarkers,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const attachment = (suffix: string, pid: number) => ({
      v: 1 as const,
      process: {
        pid,
        processStartTimeMs: 1_717_171_717_006,
        processCommandHash: suffix.repeat(64),
      },
      endpoint: { host: '::1' as const, port: 40_688 },
      materialization: {
        rootDir: `/tmp/happier-provider-runtime-race-${suffix}`,
        materializationId: `materialization-race-${suffix}`,
      },
    });
    const first = attachment('c', 24_688);
    const replacement = attachment('d', 24_689);
    const ownership = {
      happySessionId: 'sess-managed-service-race',
      processCommandHash: '4'.repeat(64),
      processStartTimeMs: 1_717_171_700_003,
    };
    await writeSessionMarker({
      pid: 12_348,
      ...ownership,
      startedBy: 'daemon',
      cwd: '/tmp',
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_348,
      ownership,
      expectedAttachment: null,
      attachment: first,
    });

    const [replaceResult, staleClearResult] = await Promise.all([
      setSessionMarkerManagedLocalServiceRunAttachment({
        pid: 12_348,
        ownership,
        expectedAttachment: first,
        attachment: replacement,
      }),
      clearSessionMarkerManagedLocalServiceRunAttachment({
        pid: 12_348,
        ownership,
        attachment: first,
      }),
    ]);

    expect(replaceResult).toBe(true);
    expect(staleClearResult).toBe('mismatch');
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        managedLocalServiceRunAttachment: replacement,
      }),
    ]);
  });

  it('rejects malformed or secret-bearing managed local-service attachments', async () => {
    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');
    const dir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid-12342.json'), JSON.stringify({
      pid: 12_342,
      happySessionId: 'sess-malformed-attachment',
      happyHomeDir: configuration.happyHomeDir,
      createdAt: 1,
      updatedAt: 1,
      managedLocalServiceRunAttachment: {
        v: 1,
        process: {
          pid: 24_683,
          processStartTimeMs: 1_717_171_717_002,
          processCommandHash: 'd'.repeat(64),
        },
        endpoint: { host: '127.0.0.1', port: 40_683 },
        materialization: {
          rootDir: '/tmp/happier-provider-runtime-malformed',
          materializationId: 'materialization-malformed',
        },
        capability: 'must-never-be-persisted',
      },
    }), 'utf-8');

    await expect(listSessionMarkers()).resolves.toEqual([]);
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

  it('transfers the source managed local-service attachment during exact PID promotion', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      promoteSessionMarkerPid,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_684,
        processStartTimeMs: 1_717_171_717_003,
        processCommandHash: 'e'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_684 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-promotion',
        materializationId: 'materialization-promotion',
      },
    };
    const respawn = {
      version: 1 as const,
      directory: '/wrapper',
      spawnNonce: 'nonce-managed-service-promotion',
    };
    const sourceOwnership = {
      happySessionId: 'PID-12343',
      processCommandHash: '5'.repeat(64),
      processStartTimeMs: 1_717_171_700_004,
    };
    const targetCommand = 'canonical runner process';
    const targetOwnership = {
      happySessionId: 'sess-managed-service-promotion',
      processCommandHash: hashProcessCommand(targetCommand),
      processStartTimeMs: 1_717_171_700_005,
    };
    await writeSessionMarker({
      pid: 12_343,
      ...sourceOwnership,
      startedBy: 'daemon',
      cwd: '/wrapper',
      respawn,
    });
    await expect(setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_343,
      ownership: sourceOwnership,
      expectedAttachment: null,
      attachment,
    })).resolves.toBe(true);
    await writeSessionMarker({
      pid: 12_344,
      ...targetOwnership,
      processCommand: targetCommand,
      startedBy: 'daemon',
      cwd: '/runner',
      respawn: { ...respawn, directory: '/runner' },
    });

    await expect(promoteSessionMarkerPid(12_343, 12_344, {
      readProcessIdentityByPidFn: async (pid) => pid === 12_344
        ? {
            pid,
            command: targetCommand,
            processStartTimeMs: targetOwnership.processStartTimeMs,
          }
        : null,
    })).resolves.toEqual({
      sourceMarkerOwnership: {
        ...sourceOwnership,
      },
      targetMarkerOwnership: {
        ...targetOwnership,
      },
      targetProcessCommand: targetCommand,
    });
    await expect(listSessionMarkers()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        pid: 12_344,
        happySessionId: 'sess-managed-service-promotion',
        managedLocalServiceRunAttachment: attachment,
      }),
    ]));
  });

  it('promotes managed custody onto the exact runner placeholder written before its canonical webhook', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      promoteSessionMarkerPid,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const wrapperPid = 12_354;
    const runnerPid = 12_355;
    const spawnNonce = 'nonce-managed-placeholder-target';
    const runnerCommand = 'managed placeholder runner';
    const runnerStartTimeMs = 1_717_171_700_015;
    const runnerCommandHash = hashProcessCommand(runnerCommand);
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_695,
        processStartTimeMs: 1_717_171_717_015,
        processCommandHash: 'e'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_695 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-placeholder-target',
        materializationId: 'materialization-placeholder-target',
      },
    };
    const wrapperOwnership = {
      happySessionId: `PID-${wrapperPid}`,
      processCommandHash: 'f'.repeat(64),
      processStartTimeMs: 1_717_171_700_014,
    };
    await writeSessionMarker({
      pid: wrapperPid,
      ...wrapperOwnership,
      startedBy: 'daemon',
      cwd: '/wrapper',
      respawn: {
        version: 1,
        directory: '/wrapper',
        spawnNonce,
      },
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: wrapperPid,
      ownership: wrapperOwnership,
      expectedAttachment: null,
      attachment,
    });
    await writeSessionMarker({
      pid: runnerPid,
      happySessionId: `PID-${runnerPid}`,
      processCommandHash: runnerCommandHash,
      processStartTimeMs: runnerStartTimeMs,
      processCommand: runnerCommand,
      startedBy: 'daemon',
      cwd: '/runner',
      respawn: {
        version: 1,
        directory: '/runner',
        spawnNonce,
      },
    });

    await expect(promoteSessionMarkerPid(wrapperPid, runnerPid, {
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: runnerStartTimeMs,
        command: runnerCommand,
      }),
    })).resolves.toEqual({
      sourceMarkerOwnership: wrapperOwnership,
      targetMarkerOwnership: {
        happySessionId: `PID-${runnerPid}`,
        processCommandHash: runnerCommandHash,
        processStartTimeMs: runnerStartTimeMs,
      },
      targetProcessCommand: runnerCommand,
    });
    expect(
      (await listSessionMarkers())
        .find((marker) => marker.pid === runnerPid),
    ).toEqual(expect.objectContaining({
      happySessionId: `PID-${runnerPid}`,
      managedLocalServiceRunAttachment: attachment,
    }));
  });

  it('rejects PID promotion instead of merging conflicting managed local-service attachments', async () => {
    const {
      listSessionMarkers,
      promoteSessionMarkerPid,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const attachment = (suffix: string, pid: number) => ({
      v: 1 as const,
      process: {
        pid,
        processStartTimeMs: 1_717_171_717_004,
        processCommandHash: suffix.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_685 },
      materialization: {
        rootDir: `/tmp/happier-provider-runtime-${suffix}`,
        materializationId: `materialization-${suffix}`,
      },
    });
    const sourceAttachment = attachment('f', 24_685);
    const targetAttachment = attachment('a', 24_686);
    const respawn = {
      version: 1 as const,
      directory: '/wrapper',
      spawnNonce: 'nonce-managed-service-conflict',
    };
    const sourceOwnership = {
      happySessionId: 'PID-12345',
      processCommandHash: '6'.repeat(64),
      processStartTimeMs: 1_717_171_700_006,
    };
    const targetOwnership = {
      happySessionId: 'sess-managed-service-conflict',
      processCommandHash: '7'.repeat(64),
      processStartTimeMs: 1_717_171_700_007,
    };
    await writeSessionMarker({
      pid: 12_345,
      ...sourceOwnership,
      startedBy: 'daemon',
      cwd: '/wrapper',
      respawn,
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_345,
      ownership: sourceOwnership,
      expectedAttachment: null,
      attachment: sourceAttachment,
    });
    await writeSessionMarker({
      pid: 12_346,
      ...targetOwnership,
      startedBy: 'daemon',
      cwd: '/runner',
      respawn: { ...respawn, directory: '/runner' },
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_346,
      ownership: targetOwnership,
      expectedAttachment: null,
      attachment: targetAttachment,
    });
    const before = await listSessionMarkers();

    await expect(promoteSessionMarkerPid(12_345, 12_346)).resolves.toBeNull();
    await expect(listSessionMarkers()).resolves.toEqual(before);
  });

  it('refuses to transfer an attachment when the target PID identity cannot be observed', async () => {
    const {
      listSessionMarkers,
      promoteSessionMarkerPid,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const ownership = {
      happySessionId: 'PID-12350',
      processCommandHash: '8'.repeat(64),
      processStartTimeMs: 1_717_171_700_008,
    };
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_692,
        processStartTimeMs: 1_717_171_717_012,
        processCommandHash: '9'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_692 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-unobserved-target',
        materializationId: 'materialization-unobserved-target',
      },
    };
    await writeSessionMarker({
      pid: 12_350,
      ...ownership,
      startedBy: 'daemon',
      cwd: '/wrapper',
      respawn: {
        version: 1,
        directory: '/wrapper',
        spawnNonce: 'nonce-managed-service-unobserved-target',
      },
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: 12_350,
      ownership,
      expectedAttachment: null,
      attachment,
    });

    await expect(promoteSessionMarkerPid(12_350, 12_351, {
      readProcessIdentityByPidFn: async () => null,
    })).resolves.toBeNull();
    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 12_350,
        managedLocalServiceRunAttachment: attachment,
      }),
    ]);
  });

  it('normalizes a managed placeholder to the live runner before its canonical webhook', async () => {
    const {
      hashProcessCommand,
      listSessionMarkers,
      promoteSessionMarkerPid,
      setSessionMarkerManagedLocalServiceRunAttachment,
      writeSessionMarker,
    } = await import('./sessionRegistry');
    const { configuration } = await import('@/configuration');
    const { createOnHappySessionWebhook } =
      await import('./sessions/onHappySessionWebhook');
    const wrapperPid = 12_352;
    const runnerPid = 12_353;
    const sourceOwnership = {
      happySessionId: `PID-${wrapperPid}`,
      processCommandHash: 'c'.repeat(64),
      processStartTimeMs: 1_717_171_700_009,
    };
    const attachment = {
      v: 1 as const,
      process: {
        pid: 24_693,
        processStartTimeMs: 1_717_171_717_013,
        processCommandHash: 'd'.repeat(64),
      },
      endpoint: { host: '127.0.0.1' as const, port: 40_693 },
      materialization: {
        rootDir: '/tmp/happier-provider-runtime-pre-webhook',
        materializationId: 'materialization-pre-webhook',
      },
    };
    const runnerCommand = 'pre-webhook canonical runner';
    const runnerStartTimeMs = 1_717_171_700_010;
    await writeSessionMarker({
      pid: wrapperPid,
      ...sourceOwnership,
      startedBy: 'daemon',
      cwd: '/wrapper',
      respawn: {
        version: 1,
        directory: '/wrapper',
        spawnNonce: 'nonce-managed-service-pre-webhook',
      },
    });
    await setSessionMarkerManagedLocalServiceRunAttachment({
      pid: wrapperPid,
      ownership: sourceOwnership,
      expectedAttachment: null,
      attachment,
    });

    const promotion = await promoteSessionMarkerPid(wrapperPid, runnerPid, {
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: runnerStartTimeMs,
        command: runnerCommand,
      }),
    });
    expect(promotion).toEqual({
      sourceMarkerOwnership: sourceOwnership,
      targetMarkerOwnership: {
        happySessionId: `PID-${runnerPid}`,
        processCommandHash: hashProcessCommand(runnerCommand),
        processStartTimeMs: runnerStartTimeMs,
      },
      targetProcessCommand: runnerCommand,
    });
    const promotedMarker = (await listSessionMarkers())
      .find((marker) => marker.pid === runnerPid);
    expect(promotedMarker).toEqual(expect.objectContaining({
      happySessionId: `PID-${runnerPid}`,
      managedLocalServiceRunAttachment: attachment,
    }));
    const tracked = {
      pid: runnerPid,
      startedBy: 'daemon' as const,
      happySessionId: promotion?.targetMarkerOwnership?.happySessionId,
      processCommandHash:
        promotion?.targetMarkerOwnership?.processCommandHash,
      processStartTimeMs:
        promotion?.targetMarkerOwnership?.processStartTimeMs,
      processCommand: promotion?.targetProcessCommand,
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: {
          kind: 'backend' as const,
          backendId: 'codex',
          sourceKind: 'built_in' as const,
        },
        spawnNonce: 'nonce-managed-service-pre-webhook',
      },
      managedLocalServiceRunAttachment: attachment,
      activateConnectedAccountSessionBindingOnCanonicalSession:
        vi.fn(async () => null),
    };
    const awaiter = vi.fn();
    const onWebhook = createOnHappySessionWebhook({
      pidToTrackedSession: new Map([[runnerPid, tracked]]),
      pidToAwaiter: new Map([[runnerPid, awaiter]]),
      getParentPidFn: () => null,
      findHappyProcessByPidFn: async () => null,
      readProcessIdentityByPidFn: async () => ({
        pid: runnerPid,
        processStartTimeMs: runnerStartTimeMs,
        command: runnerCommand,
      }),
      onTrackedSessionReady: vi.fn(async () => undefined),
    });

    await expect(onWebhook('session-managed-pre-webhook', {
      path: '/tmp/project',
      host: 'test-host',
      homeDir: '/tmp/home',
      happyHomeDir: configuration.happyHomeDir,
      happyLibDir: '/tmp/lib',
      happyToolsDir: '/tmp/tools',
      hostPid: runnerPid,
      startedBy: 'daemon',
      machineId: 'machine-test',
    })).resolves.toBeUndefined();
    expect(awaiter).toHaveBeenCalledOnce();
    expect(
      (await listSessionMarkers()).find((marker) => marker.pid === runnerPid),
    ).toEqual(expect.objectContaining({
      happySessionId: 'session-managed-pre-webhook',
      managedLocalServiceRunAttachment: attachment,
      processCommandHash: hashProcessCommand(runnerCommand),
      processStartTimeMs: runnerStartTimeMs,
    }));
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

});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS } from '@happier-dev/cli-common/firstPartyRuntime';
import { createEnvKeyScope } from '@/testkit/env/envScope';

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
  const releaseEnvScope = createEnvKeyScope(STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS);
  const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
  const originalReleaseRing = process.env.HAPPIER_RELEASE_RING;
  let happyHomeDir: string;

  beforeEach(() => {
    happyHomeDir = join(tmpdir(), `happier-cli-session-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
    releaseEnvScope.patch({
      HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
      HAPPIER_RELEASE_RING: undefined,
      HAPPIER_RELEASE_CHANNEL: undefined,
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(happyHomeDir)) {
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
    if (originalHappyHomeDir === undefined) {
      delete process.env.HAPPIER_HOME_DIR;
    } else {
      process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
    }
    releaseEnvScope.restore();
    if (originalReleaseRing === undefined) {
      delete process.env.HAPPIER_RELEASE_RING;
    } else {
      process.env.HAPPIER_RELEASE_RING = originalReleaseRing;
    }
  });

  it('should write a marker and preserve createdAt across updates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
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

    vi.setSystemTime(updatedAt1 + 1_000);

    await writeSessionMarker({
      pid: 12345,
      happySessionId: 'sess-2',
      startedBy: 'terminal',
      cwd: '/tmp',
    });

    const markers2 = await listSessionMarkers();
    expect(markers2).toHaveLength(1);
    expect(markers2[0].createdAt).toBe(createdAt1);
    expect(markers2[0].updatedAt).toBeGreaterThan(updatedAt1);
    expect(markers2[0].happySessionId).toBe('sess-2');
  });

  it('atomically upgrades pre-webhook placeholder custody without losing the spawn nonce', async () => {
    const { listSessionMarkers, writeSessionMarker } = await import('./sessionRegistry');
    const respawn = {
      version: 1 as const,
      directory: '/tmp/project',
      backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' as const },
      spawnNonce: 'spawn-nonce-marker-upgrade',
    };

    await writeSessionMarker({
      pid: 12346,
      happySessionId: 'PID-12346',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      respawn,
    });
    await writeSessionMarker({
      pid: 12346,
      happySessionId: 'sess-marker-upgraded',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      metadata: { hostPid: 12346 },
      respawn,
    });

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 12346,
        happySessionId: 'sess-marker-upgraded',
        metadata: { hostPid: 12346 },
        respawn: expect.objectContaining({
          spawnNonce: 'spawn-nonce-marker-upgrade',
        }),
      }),
    ]);
  });

  it('persists and clears only the exact active turn for the matching tracked session marker', async () => {
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

  it('publishes terminal host death into the existing session marker state file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T18:00:00.000Z'));
    const {
      clearSessionMarkerTerminalHostHealth,
      listSessionMarkers,
      publishSessionMarkerTerminalHostHealth,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 67178,
      happySessionId: 'sess-host-dead',
      startedBy: 'daemon',
      cwd: '/workspace',
    });

    await expect(publishSessionMarkerTerminalHostHealth({
      pid: 67178,
      health: {
        status: 'host_dead',
        sessionId: 'sess-host-dead',
        runnerPid: 67178,
        hostKind: 'zellij',
        zellijSessionName: 'happier-claude-unified-67178-1783572630999',
        observedAt: 1783616376567,
        reason: 'pane_dead',
      },
    })).resolves.toBe(true);

    expect(await listSessionMarkers()).toEqual([
      expect.objectContaining({
        pid: 67178,
        happySessionId: 'sess-host-dead',
        terminalHostHealth: {
          status: 'host_dead',
          sessionId: 'sess-host-dead',
          runnerPid: 67178,
          hostKind: 'zellij',
          zellijSessionName: 'happier-claude-unified-67178-1783572630999',
          observedAt: 1783616376567,
          reason: 'pane_dead',
        },
      }),
    ]);

    await expect(clearSessionMarkerTerminalHostHealth({
      pid: 67178,
      sessionId: 'sess-host-dead',
    })).resolves.toBe(true);
    expect(await listSessionMarkers()).toEqual([
      expect.not.objectContaining({ terminalHostHealth: expect.anything() }),
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

  it('refreshSessionMarkerRespawn rewrites the respawn descriptor from updated spawn options and preserves marker identity fields', async () => {
    const { listSessionMarkers, refreshSessionMarkerRespawn, writeSessionMarker } = await import('./sessionRegistry');
    const { buildSessionRunnerRespawnDescriptorV1FromSpawnOptions } = await import('./processSupervision/sessionRunnerRespawnDescriptor');

    const previousBindings = {
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'old-profile' } },
    };
    const processCommandHash = 'b'.repeat(64);
    const previousRespawn = buildSessionRunnerRespawnDescriptorV1FromSpawnOptions({
      directory: '/tmp/work',
      connectedServices: previousBindings,
    });
    expect(previousRespawn).not.toBeNull();
    await writeSessionMarker({
      pid: 7777,
      happySessionId: 'sess-switch',
      startedBy: 'daemon',
      cwd: '/tmp/work',
      processCommandHash,
      metadata: { path: '/tmp/work' },
      respawn: previousRespawn!,
    });

    // Hot-applied auth switch updates tracked spawn options in memory; the
    // durable marker must follow or the next daemon restores stale bindings
    // and treats real switch requests as 'unchanged'.
    const updatedBindings = {
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'profile', profileId: 'new-profile' } },
    };
    await refreshSessionMarkerRespawn({
      pid: 7777,
      spawnOptions: {
        directory: '/tmp/work',
        connectedServices: updatedBindings,
        connectedServicesUpdatedAt: 1234,
      },
    });

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    expect(marker.happySessionId).toBe('sess-switch');
    expect(marker.processCommandHash).toBe(processCommandHash);
    expect(marker.metadata).toEqual({ path: '/tmp/work' });
    expect((marker.respawn as { connectedServices?: unknown } | undefined)?.connectedServices).toEqual(updatedBindings);
  });

  it('refreshSessionMarkerRespawn is a no-op when no marker exists for the pid', async () => {
    const { listSessionMarkers, refreshSessionMarkerRespawn } = await import('./sessionRegistry');

    await refreshSessionMarkerRespawn({
      pid: 8888,
      spawnOptions: { directory: '/tmp/none' },
    });

    await expect(listSessionMarkers()).resolves.toHaveLength(0);
  });

  it('marks and clears connected-service restart intent on an existing marker', async () => {
    const {
      clearSessionMarkerConnectedServiceRestartIntent,
      listSessionMarkers,
      markSessionMarkerConnectedServiceRestartIntent,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 9991,
      happySessionId: 'sess-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp/work',
    });

    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 9991,
      requestedAtMs: 12_345,
    })).resolves.toBe(true);

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 9991,
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 12_345,
        },
      }),
    ]);

    await clearSessionMarkerConnectedServiceRestartIntent(9991);

    const markers = await listSessionMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]).not.toHaveProperty('connectedServiceRestartIntent');
  });

  it('can preserve a connected-service restart intent across routine marker refreshes', async () => {
    const {
      listSessionMarkers,
      markSessionMarkerConnectedServiceRestartIntent,
      writeSessionMarker,
    } = await import('./sessionRegistry');

    await writeSessionMarker({
      pid: 9995,
      happySessionId: 'sess-preserve-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp/work',
    });
    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 9995,
      requestedAtMs: 55_000,
    })).resolves.toBe(true);

    await writeSessionMarker(
      {
        pid: 9995,
        happySessionId: 'sess-preserve-restart-intent',
        startedBy: 'daemon',
        cwd: '/tmp/work',
        metadata: { codexSessionId: 'codex-thread' },
      },
      { preserveConnectedServiceRestartIntent: true },
    );

    await expect(listSessionMarkers()).resolves.toEqual([
      expect.objectContaining({
        pid: 9995,
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
        pid: 9996,
        happySessionId: 'sess-mark-refresh-race',
        startedBy: 'daemon',
        cwd: '/tmp/work',
      });

      const refreshPromise = writeSessionMarker(
        {
          pid: 9996,
          happySessionId: 'sess-mark-refresh-race',
          startedBy: 'daemon',
          cwd: '/tmp/work',
          metadata: { refreshMarkerRace: true },
        },
        { preserveConnectedServiceRestartIntent: true },
      );
      await waitUntil(() => refreshWriteBlocked);

      const markPromise = markSessionMarkerConnectedServiceRestartIntent({
        pid: 9996,
        requestedAtMs: 99_960,
      });
      await Promise.race([
        markPromise,
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);

      refreshWriteBlock.resolve();
      await Promise.all([refreshPromise, markPromise]);

      await expect(listSessionMarkers()).resolves.toEqual([
        expect.objectContaining({
          pid: 9996,
          metadata: { refreshMarkerRace: true },
          connectedServiceRestartIntent: {
            v: 1,
            requestedAtMs: 99_960,
          },
        }),
      ]);
    } finally {
      refreshWriteBlock.resolve();
      vi.doUnmock('node:fs/promises');
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
        pid: 9997,
        happySessionId: 'sess-clear-refresh-race',
        startedBy: 'daemon',
        cwd: '/tmp/work',
        connectedServiceRestartIntent: {
          v: 1,
          requestedAtMs: 99_970,
        },
      });

      const refreshPromise = writeSessionMarker(
        {
          pid: 9997,
          happySessionId: 'sess-clear-refresh-race',
          startedBy: 'daemon',
          cwd: '/tmp/work',
          metadata: { refreshMarkerRace: true },
        },
        { preserveConnectedServiceRestartIntent: true },
      );
      await waitUntil(() => refreshWriteBlocked);

      const clearPromise = clearSessionMarkerConnectedServiceRestartIntent(9997);
      await Promise.race([
        clearPromise,
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);

      refreshWriteBlock.resolve();
      await Promise.all([refreshPromise, clearPromise]);

      const markers = await listSessionMarkers();
      expect(markers).toEqual([
        expect.objectContaining({
          pid: 9997,
          metadata: { refreshMarkerRace: true },
        }),
      ]);
      expect(markers[0]).not.toHaveProperty('connectedServiceRestartIntent');
    } finally {
      refreshWriteBlock.resolve();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('does not create a connected-service restart intent marker when no session marker exists', async () => {
    const { listSessionMarkers, markSessionMarkerConnectedServiceRestartIntent } = await import('./sessionRegistry');

    await expect(markSessionMarkerConnectedServiceRestartIntent({
      pid: 9992,
      requestedAtMs: 12_345,
    })).resolves.toBe(false);

    await expect(listSessionMarkers()).resolves.toHaveLength(0);
  });

  it('promotes a connected-service restart intent from a wrapper marker to an existing runner marker', async () => {
    const registry = await import('./sessionRegistry');
    const {
      listSessionMarkers,
      promoteSessionMarkerConnectedServiceRestartIntent,
      writeSessionMarker,
    } = registry;

    await writeSessionMarker({
      pid: 9993,
      happySessionId: 'sess-promote-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp/wrapper',
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 44_000,
      },
    });
    await writeSessionMarker({
      pid: 9994,
      happySessionId: 'sess-promote-restart-intent',
      startedBy: 'daemon',
      cwd: '/tmp/runner',
      processCommandHash: 'c'.repeat(64),
      metadata: { owner: 'runner' },
    });

    await expect(promoteSessionMarkerConnectedServiceRestartIntent({
      fromPid: 9993,
      toPid: 9994,
    })).resolves.toBe(true);

    await expect(listSessionMarkers()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        pid: 9994,
        cwd: '/tmp/runner',
        processCommandHash: 'c'.repeat(64),
        metadata: { owner: 'runner' },
      }),
    ]));
    const runnerMarker = (await listSessionMarkers()).find((marker) => marker.pid === 9994);
    expect(runnerMarker).toMatchObject({
      connectedServiceRestartIntent: {
        v: 1,
        requestedAtMs: 44_000,
      },
    });
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
    expect(parsed.processCommand).toBe('node dist/index.mjs --started-by daemon');
    expect(typeof parsed.createdAt).toBe('number');
    expect(typeof parsed.updatedAt).toBe('number');
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

  it('reads legacy unscoped markers for the preview ring during marker migration', async () => {
    process.env.HAPPIER_RELEASE_RING = 'preview';
    vi.resetModules();

    const { configuration } = await import('@/configuration');
    const { listSessionMarkers } = await import('./sessionRegistry');

    const legacyDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    mkdirSync(legacyDir, { recursive: true });

    writeFileSync(
      join(legacyDir, 'pid-4242.json'),
      JSON.stringify(
        {
          pid: 4242,
          happySessionId: 'sess-legacy-preview',
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
    expect(markers).toEqual([
      expect.objectContaining({
        pid: 4242,
        happySessionId: 'sess-legacy-preview',
      }),
    ]);
  });

  it('removes both scoped and legacy marker files for preview ring cleanup', async () => {
    process.env.HAPPIER_RELEASE_RING = 'preview';
    vi.resetModules();

    const { configuration } = await import('@/configuration');
    const { removeSessionMarker } = await import('./sessionRegistry');

    const legacyDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
    const scopedDir = join(configuration.happyHomeDir, 'tmp', 'daemon-sessions.preview');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(scopedDir, { recursive: true });

    writeFileSync(
      join(legacyDir, 'pid-5151.json'),
      JSON.stringify({ pid: 5151, happySessionId: 'sess-legacy', happyHomeDir: configuration.happyHomeDir, createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(scopedDir, 'pid-5151.json'),
      JSON.stringify({ pid: 5151, happySessionId: 'sess-scoped', happyHomeDir: configuration.happyHomeDir, createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8',
    );

    await removeSessionMarker(5151);

    expect(existsSync(join(legacyDir, 'pid-5151.json'))).toBe(false);
    expect(existsSync(join(scopedDir, 'pid-5151.json'))).toBe(false);
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

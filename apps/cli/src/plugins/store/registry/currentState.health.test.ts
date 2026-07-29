import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SupervisedPluginActivationAttempt } from '@/plugins/runtime/lifecycle/manager';
import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '../install/trustIdentity';
import { PluginStateFileV1Schema } from '../state';
import {
  readPluginRegistryCommitRecord,
  replacePluginRegistryCommitRecord,
} from './commitRecord';
import {
  createPluginRegistryStateStore,
  type PluginRegistryRuntimeLifecycle,
} from './currentState';
import {
  persistInstallationStateRevision,
  prepareImmutablePluginGeneration,
  readInstallationStateRevision,
} from './generationStore';
import type { PluginRegistryTransactionResult } from './service';
import type { PluginRegistryReconcileSurface } from './reconcile';
import { createDaemonPluginChangeService } from '../../daemon/changeService';
import { readInstalledPluginCatalog } from '../../projection/catalog/installed';

const PLUGIN_ID = 'acme.health.recovery';
const TEST_GENERATION_CUSTODY_RETIREMENT = Object.freeze({
  readCredentials: async () => ({
    token: 'account-token',
    encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
  }),
  retireGeneration: async () => undefined,
});

async function createFixture(options?: Readonly<{
  runtimeLifecycle?: PluginRegistryRuntimeLifecycle;
  prepareGeneration?: typeof prepareImmutablePluginGeneration;
  reconciliationSurfaces?: readonly PluginRegistryReconcileSurface[];
  onReconciliationPending?: (diagnostic: Readonly<{
    operation: string;
    pendingSurfaces: readonly string[];
    message?: string;
  }>) => void;
  runAutomaticCurrentnessChange?: (
    pluginId: string,
    change: (control: Readonly<{ onApplied: () => void }>) => Promise<void>,
  ) => Promise<void>;
}>) {
  const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-registry-health-'));
  const pluginRoot = join(happyHomeDir, 'plugin');
  const manifestPath = join(pluginRoot, '.happier-plugin', 'plugin.json');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
  const trust = createPluginTrustRecord({ pluginId: PLUGIN_ID, distribution, approvedAtMs: 1 });
  let createdAtMs = 10;
  let daemonUptimeMs = 0;
  const scheduled: Array<() => Promise<void>> = [];
  let lastInstallResult: PluginRegistryTransactionResult | null = null;
  const runtimeLifecycle: PluginRegistryRuntimeLifecycle = options?.runtimeLifecycle ?? Object.freeze({
    prepare: async () => Object.freeze({ abort: async () => undefined, adopt: async () => undefined }),
  });
  const store = createPluginRegistryStateStore({
    happyHomeDir,
    nowMs: () => createdAtMs++,
    runtimeLifecycle,
    generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
    ...(options?.prepareGeneration ? { prepareGeneration: options.prepareGeneration } : {}),
    ...(options?.reconciliationSurfaces ? { reconciliationSurfaces: options.reconciliationSurfaces } : {}),
    ...(options?.onReconciliationPending
      ? { onReconciliationPending: options.onReconciliationPending }
      : {}),
    runAutomaticCurrentnessChange: options?.runAutomaticCurrentnessChange
      ?? (async (_pluginId, change) => await change({ onApplied: () => undefined })),
    healthSupervisor: {
      daemonInstanceId: 'daemon-health-a',
      daemonUptimeMs: () => daemonUptimeMs,
      schedule: (delayMs, task) => {
        expect(delayMs).toBe(10 * 60_000);
        scheduled.push(task);
      },
    },
  });

  async function install(version: string, options?: Readonly<{
    executable?: boolean;
    stateStore?: typeof store;
  }>): Promise<string> {
    const stateStore = options?.stateStore ?? store;
    const executable = options?.executable !== false;
    if (executable) {
      await writeFile(join(pluginRoot, 'daemon.mjs'), `export const version = ${JSON.stringify(version)};\n`, 'utf8');
    }
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 2,
      id: PLUGIN_ID,
      version,
      displayName: 'Health recovery fixture',
      engines: { happier: '>=0.0.0' }, runtime: { apiVersion: 1 },
      ...(executable ? { entrypoints: { daemon: './daemon.mjs' } } : {}),
      hostAccess: { required: [], optional: [] },
      contributes: {},
    }), 'utf8');
    const catalogRecord = PluginStateFileV1Schema.parse({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        [PLUGIN_ID]: {
          source: {
            kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link',
            resolvedPath: pluginRoot, manifestPath,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: { mode: 'link', manifestVersion: version, trust, updatePolicy: 'manual' },
          state: { enabled: true },
        },
      },
    }).plugins[PLUGIN_ID]!;
    lastInstallResult = await stateStore.install({
      pluginId: PLUGIN_ID,
      sourceRootPath: pluginRoot,
      manifestRelativePath: '.happier-plugin/plugin.json',
      catalogRecord,
      trust,
      updatePolicy: 'manual',
      optionalAccess: [],
    });
    const commit = await readPluginRegistryCommitRecord(stateStore.paths);
    const generationId = commit?.pluginGenerations[PLUGIN_ID]?.immutableGenerationId;
    if (!generationId) throw new Error('Expected an installed generation');
    return generationId;
  }

  const attempt = (
    immutableGenerationId: string,
    attemptId: string,
    outcome: 'fatal' | 'nonfatal',
    phase: 'primaryBootstrap' | 'lazyActivation' = 'lazyActivation',
  ): SupervisedPluginActivationAttempt => Object.freeze({
    attemptId,
    pluginId: PLUGIN_ID,
    immutableGenerationId,
    phase,
    startedAtMs: createdAtMs,
    completedAtMs: createdAtMs + 1,
    outcome,
  });

  async function readRevision() {
    const commit = await readPluginRegistryCommitRecord(store.paths);
    if (!commit) throw new Error('Expected a registry commit');
    const revision = await readInstallationStateRevision({ paths: store.paths, reference: commit.installationState });
    return { commit, revision };
  }

  async function makeHealthy(generationId: string): Promise<void> {
    await store.observeActivationAttempt(attempt(generationId, `healthy-${generationId}`, 'nonfatal', 'primaryBootstrap'));
    const task = scheduled.shift();
    if (!task) throw new Error('Expected a scheduled health observation');
    daemonUptimeMs += 10 * 60_000;
    await task();
  }

  return {
    happyHomeDir,
    store,
    install,
    attempt,
    makeHealthy,
    readRevision,
    readLastInstallResult: () => lastInstallResult,
  };
}

describe('PluginRegistryStateStore generation health supervision', () => {
  it('restarts a pending health observation under the new daemon incarnation', async () => {
    const fixture = await createFixture();
    const generationId = await fixture.install('1.0.0');
    await fixture.store.observeActivationAttempt(fixture.attempt(
      generationId,
      'daemon-a-bootstrap',
      'nonfatal',
      'primaryBootstrap',
    ));

    const restartedTasks: Array<() => Promise<void>> = [];
    const restartedStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async () => Object.freeze({ abort: async () => undefined, adopt: async () => undefined }),
      }),
      generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
      healthSupervisor: {
        daemonInstanceId: 'daemon-health-b',
        daemonUptimeMs: () => 25,
        schedule: (_delayMs, task) => { restartedTasks.push(task); },
      },
    });
    await restartedStore.observeActivationAttempt(fixture.attempt(
      generationId,
      'daemon-b-bootstrap',
      'nonfatal',
      'primaryBootstrap',
    ));

    const state = await fixture.readRevision();
    expect(state.revision.health[generationId]?.observation).toEqual({
      daemonInstanceId: 'daemon-health-b',
      startedAtUptimeMs: 25,
    });
    expect(restartedTasks).toHaveLength(1);
  });

  it('reports pending reconciliation from background health observation, failure recording, and recovery', async () => {
    const onReconciliationPending = vi.fn();
    const fixture = await createFixture({
      onReconciliationPending,
      reconciliationSurfaces: [{
        name: 'fixtureProjection',
        apply: async () => {
          throw new Error('fixture projection unavailable');
        },
      }],
    });
    const generationId = await fixture.install('1.0.0');
    onReconciliationPending.mockClear();

    await fixture.store.observeActivationAttempt(fixture.attempt(
      generationId,
      'healthy-start',
      'nonfatal',
      'primaryBootstrap',
    ));
    expect(onReconciliationPending).toHaveBeenLastCalledWith({
      operation: 'health_observation_start',
      pendingSurfaces: ['reconciliation'],
      message: expect.stringContaining('fixtureProjection: fixture projection unavailable'),
    });

    onReconciliationPending.mockClear();
    await fixture.makeHealthy(generationId);
    expect(onReconciliationPending).toHaveBeenLastCalledWith({
      operation: 'health_observation_completion',
      pendingSurfaces: ['reconciliation'],
      message: expect.stringContaining('fixtureProjection: fixture projection unavailable'),
    });

    onReconciliationPending.mockClear();
    await fixture.store.observeActivationAttempt(fixture.attempt(generationId, 'failure-a', 'fatal'));
    expect(onReconciliationPending).toHaveBeenLastCalledWith({
      operation: 'health_failure_record',
      pendingSurfaces: ['reconciliation'],
      message: expect.stringContaining('fixtureProjection: fixture projection unavailable'),
    });
    await fixture.store.observeActivationAttempt(fixture.attempt(generationId, 'failure-b', 'fatal'));

    onReconciliationPending.mockClear();
    await fixture.store.observeActivationAttempt(fixture.attempt(generationId, 'failure-c', 'fatal'));
    expect(onReconciliationPending).toHaveBeenLastCalledWith({
      operation: 'health_recovery',
      pendingSurfaces: ['reconciliation'],
      message: expect.stringContaining('fixtureProjection: fixture projection unavailable'),
    });
  });

  it('marks a descriptor-only generation healthy immediately after committed reconciliation', async () => {
    const fixture = await createFixture();
    const generationId = await fixture.install('1.0.0', { executable: false });

    expect(fixture.readLastInstallResult()).toMatchObject({
      status: 'committed',
      applied: true,
      pendingSurfaces: [],
    });
    const state = await fixture.readRevision();
    expect(state.revision.health[generationId]).toMatchObject({
      state: 'healthy',
      tryOnce: 'unavailable',
      observation: null,
    });
  });

  it('marks a descriptor-only generation healthy after pending reconciliation succeeds on restart', async () => {
    let projectionAvailable = true;
    const projectionSurface: PluginRegistryReconcileSurface = {
      name: 'fixtureProjection',
      apply: async () => {
        if (!projectionAvailable) throw new Error('fixture projection unavailable');
      },
    };
    const fixture = await createFixture({
      reconciliationSurfaces: [projectionSurface],
    });
    const priorGenerationId = await fixture.install('1.0.0', { executable: false });
    expect((await fixture.readRevision()).revision.health[priorGenerationId]).toMatchObject({
      state: 'healthy',
      tryOnce: 'unavailable',
    });

    projectionAvailable = false;
    const generationId = await fixture.install('2.0.0', { executable: false });

    expect(fixture.readLastInstallResult()).toMatchObject({
      status: 'committed',
      applied: true,
      pendingSurfaces: ['reconciliation'],
    });
    expect((await fixture.readRevision()).revision.health[generationId]).toMatchObject({
      state: 'pending',
      tryOnce: 'unavailable',
    });
    expect((await fixture.readRevision()).revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: priorGenerationId,
        role: 'lastKnownGood',
        automaticRecoveryEligible: true,
      }),
    ]);

    projectionAvailable = true;
    const restartedStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async () => Object.freeze({ abort: async () => undefined, adopt: async () => undefined }),
      }),
      generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
      reconciliationSurfaces: [projectionSurface],
    });
    await restartedStore.initialize();
    expect((await fixture.readRevision()).revision.health[generationId]).toMatchObject({
      state: 'pending',
      tryOnce: 'unavailable',
    });
    await restartedStore.settleCurrentNonExecutableHealthAfterRuntimePublication();

    expect((await fixture.readRevision()).revision.health[generationId]).toMatchObject({
      state: 'healthy',
      tryOnce: 'unavailable',
      observation: null,
    });
    expect((await fixture.readRevision()).revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: priorGenerationId,
        role: 'userRollback',
        automaticRecoveryEligible: false,
      }),
    ]);
  });

  it('retains a pending same-channel predecessor as user rollback rather than automatic LKG', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.install('2.0.0');

    const state = await fixture.readRevision();
    expect(state.revision.health[firstGenerationId]).toMatchObject({ state: 'pending' });
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: firstGenerationId,
        role: 'userRollback',
        automaticRecoveryEligible: false,
      }),
    ]);
  });

  it('uses the prior healthy same-channel generation as LKG and keeps identical failed bytes quarantined', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');

    let state = await fixture.readRevision();
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: firstGenerationId,
        role: 'lastKnownGood',
        automaticRecoveryEligible: true,
      }),
    ]);

    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(firstGenerationId);
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]).toMatchObject({
      install: { manifestVersion: '1.0.0' },
      state: { enabled: true },
    });
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: secondGenerationId,
        role: 'quarantined',
        automaticRecoveryEligible: false,
      }),
    ]);
    const failedHealth = state.revision.health[secondGenerationId];
    expect(failedHealth).toMatchObject({ state: 'quarantined', tryOnce: 'available' });
    expect(state.revision.healthTombstones).toContainEqual(expect.objectContaining({
      pluginId: PLUGIN_ID,
      fingerprint: failedHealth?.fingerprint,
      state: 'quarantined',
    }));

    const restartedPreparedEnabledStates: boolean[] = [];
    const restartedStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async (candidate) => {
          const record = candidate.runtimeCatalog.plugins[PLUGIN_ID];
          if (record) restartedPreparedEnabledStates.push(record.state.enabled);
          return Object.freeze({ abort: async () => undefined, adopt: async () => undefined });
        },
      }),
    });
    const reinstalledGenerationId = await fixture.install('2.0.0', { stateStore: restartedStore });
    state = await fixture.readRevision();
    expect(reinstalledGenerationId).not.toBe(secondGenerationId);
    expect(state.revision.health[reinstalledGenerationId]).toMatchObject({
      fingerprint: failedHealth?.fingerprint,
      state: 'quarantined',
      tryOnce: 'available',
    });
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);
    expect(restartedPreparedEnabledStates.at(-1)).toBe(false);

    await restartedStore.uninstallWithResult(PLUGIN_ID);
    state = await fixture.readRevision();
    expect(state.revision.healthTombstones).toContainEqual(expect.objectContaining({
      pluginId: PLUGIN_ID,
      fingerprint: failedHealth?.fingerprint,
      state: 'quarantined',
    }));
    await restartedStore.uninstallWithResult(PLUGIN_ID, { clearHealthHistory: true });
    state = await fixture.readRevision();
    expect(state.revision.healthTombstones).not.toContainEqual(expect.objectContaining({ pluginId: PLUGIN_ID }));
  });

  it('recovers the verified LKG when the failing current generation bytes are missing', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    await rm(join(fixture.store.paths.generationsDir, secondGenerationId), { recursive: true });

    for (const attemptId of ['missing-a', 'missing-b', 'missing-c']) {
      await fixture.store.observeActivationAttempt(
        fixture.attempt(secondGenerationId, attemptId, 'fatal', 'primaryBootstrap'),
      );
    }

    const state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(firstGenerationId);
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]).toMatchObject({
      install: { manifestVersion: '1.0.0' },
      state: { enabled: true },
    });
    expect(state.revision.rollbackRetention).toContainEqual(expect.objectContaining({
      immutableGenerationId: secondGenerationId,
      role: 'quarantined',
      automaticRecoveryEligible: false,
      byteAvailability: 'missing',
    }));
    expect(state.revision.health[secondGenerationId]).toMatchObject({
      state: 'quarantined',
      tryOnce: 'unavailable',
    });
  });

  it('projects rollback availability only while retained immutable bytes still re-verify', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    await fixture.install('2.0.0');

    await expect(readInstalledPluginCatalog({ happyHomeDir: fixture.happyHomeDir }))
      .resolves.toContainEqual(expect.objectContaining({
        pluginId: PLUGIN_ID,
        rollbackAvailability: 'available',
      }));

    await writeFile(
      join(fixture.store.paths.generationsDir, firstGenerationId, 'daemon.mjs'),
      'export const version = "tampered";\n',
      'utf8',
    );

    await expect(readInstalledPluginCatalog({ happyHomeDir: fixture.happyHomeDir }))
      .resolves.toContainEqual(expect.objectContaining({
        pluginId: PLUGIN_ID,
        rollbackAvailability: 'unavailable',
      }));
  });

  it.each(['packageDigest', 'artifactDigest'] as const)(
    'rejects rollback when retained %s metadata does not match the verified generation',
    async (digestField) => {
      const prepare = vi.fn(async () => Object.freeze({
        abort: async () => undefined,
        adopt: async () => undefined,
      }));
      const fixture = await createFixture({
        runtimeLifecycle: Object.freeze({ prepare }),
      });
      const firstGenerationId = await fixture.install('1.0.0');
      await fixture.makeHealthy(firstGenerationId);
      await fixture.install('2.0.0');
      prepare.mockClear();

      const current = await fixture.readRevision();
      const mismatchedState = {
        ...current.revision,
        revisionId: 'state-mismatched-retention-identity',
        rollbackRetention: current.revision.rollbackRetention.map((retention) => (
          retention.immutableGenerationId === firstGenerationId
            ? { ...retention, [digestField]: `sha256:${'0'.repeat(64)}` }
            : retention
        )),
      };
      const installationState = await persistInstallationStateRevision({
        paths: fixture.store.paths,
        state: mismatchedState,
      });
      await replacePluginRegistryCommitRecord({
        paths: fixture.store.paths,
        expectedRevision: current.commit.revision,
        next: {
          ...current.commit,
          revision: current.commit.revision + 1,
          baseRevision: current.commit.revision,
          transactionId: 'mismatched-retention-identity',
          installationState,
        },
      });

      await expect(readInstalledPluginCatalog({ happyHomeDir: fixture.happyHomeDir }))
        .resolves.toContainEqual(expect.objectContaining({
          pluginId: PLUGIN_ID,
          rollbackAvailability: 'unavailable',
        }));
      await expect(fixture.store.rollback(PLUGIN_ID)).rejects.toThrow(/retained identity/i);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it('rejects retained bytes whose immutable record belongs to another plugin', async () => {
    const prepare = vi.fn(async () => Object.freeze({
      abort: async () => undefined,
      adopt: async () => undefined,
    }));
    const fixture = await createFixture({
      runtimeLifecycle: Object.freeze({ prepare }),
    });
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    await fixture.install('2.0.0');
    prepare.mockClear();

    const recordPath = join(
      fixture.store.paths.generationsDir,
      firstGenerationId,
      'plugin-generation.v1.json',
    );
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({
      ...record,
      pluginId: 'acme.other.plugin',
    }), 'utf8');

    await expect(readInstalledPluginCatalog({ happyHomeDir: fixture.happyHomeDir }))
      .resolves.toContainEqual(expect.objectContaining({
        pluginId: PLUGIN_ID,
        rollbackAvailability: 'unavailable',
      }));
    await expect(fixture.store.rollback(PLUGIN_ID)).rejects.toThrow(/retained identity/i);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not enter automatic recovery while a user apply for the same plugin owns currentness', async () => {
    let userApplyEntered!: () => void;
    const userApplyStarted = new Promise<void>((resolve) => { userApplyEntered = resolve; });
    let releaseUserApply!: () => void;
    const userApplyBlocked = new Promise<void>((resolve) => { releaseUserApply = resolve; });
    let recoveryPrepareEntered!: () => void;
    const recoveryPrepareStarted = new Promise<void>((resolve) => { recoveryPrepareEntered = resolve; });
    let releaseRecoveryPrepare!: () => void;
    const recoveryPrepareBlocked = new Promise<void>((resolve) => { releaseRecoveryPrepare = resolve; });
    let watchRecoveryPrepare = false;

    let service!: ReturnType<typeof createDaemonPluginChangeService>;
    const fixture = await createFixture({
      runtimeLifecycle: Object.freeze({
        prepare: async (candidate) => {
          if (watchRecoveryPrepare && candidate.mutationKind !== 'install') {
            recoveryPrepareEntered();
            await recoveryPrepareBlocked;
          }
          return Object.freeze({ abort: async () => undefined, adopt: async () => undefined });
        },
      }),
      runAutomaticCurrentnessChange: async (pluginId, change) => {
        await service.runAutomaticCurrentnessChange(pluginId, change);
      },
    });
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    for (const attemptId of ['failure-a', 'failure-b']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    service = createDaemonPluginChangeService({
      prepare: async () => ({
        pluginId: PLUGIN_ID,
        requiresReview: false,
        apply: async (_decision, control) => {
          userApplyEntered();
          await userApplyBlocked;
          const appliedGeneration = await fixture.install('3.0.0');
          control?.onApplied();
          return {
            kind: 'committed' as const,
            pluginId: PLUGIN_ID,
            desiredGeneration: appliedGeneration,
            appliedGeneration,
            pendingSurfaces: [],
          };
        },
        cleanup: async () => undefined,
      }),
    });
    const userApply = service.requestPluginChange({
      kind: 'development',
      pluginId: PLUGIN_ID,
      sourceRootPath: '/tmp/acme-health-recovery',
    });
    await userApplyStarted;

    watchRecoveryPrepare = true;
    const recovery = fixture.store.observeActivationAttempt(
      fixture.attempt(secondGenerationId, 'failure-c', 'fatal'),
    );
    const enteredBeforeUserApplyReleased = await Promise.race([
      recoveryPrepareStarted.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);

    releaseUserApply();
    if (enteredBeforeUserApplyReleased) releaseRecoveryPrepare();
    await Promise.all([userApply, recovery]);

    expect(enteredBeforeUserApplyReleased).toBe(false);
    const current = await fixture.readRevision();
    expect(current.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.install.manifestVersion).toBe('3.0.0');
    await service.shutdown();
  });

  it('fails closed before automatic currentness recovery when the daemon change owner is not wired', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    const unwiredStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async () => Object.freeze({ abort: async () => undefined, adopt: async () => undefined }),
      }),
      generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
    });
    for (const attemptId of ['failure-a', 'failure-b']) {
      await unwiredStore.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    await expect(unwiredStore.observeActivationAttempt(
      fixture.attempt(secondGenerationId, 'failure-c', 'fatal'),
    )).rejects.toThrow();
    const current = await fixture.readRevision();
    expect(current.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(secondGenerationId);
  });

  it('disables the failing current generation when retained LKG bytes fail re-verification', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    await writeFile(
      join(fixture.store.paths.generationsDir, firstGenerationId, 'daemon.mjs'),
      'export const corrupted = true;\n',
      'utf8',
    );

    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    const state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(secondGenerationId);
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);
    expect(state.revision.health[secondGenerationId]).toMatchObject({ state: 'quarantined' });
  });

  it('disables the failing current generation when the verified LKG cannot activate', async () => {
    const prepareKinds: string[] = [];
    const fixture = await createFixture({
      runtimeLifecycle: Object.freeze({
        prepare: async (candidate) => {
          prepareKinds.push(candidate.mutationKind);
          if (candidate.mutationKind === 'rollback') {
            throw new Error('fixture retained LKG activation failed');
          }
          return Object.freeze({ abort: async () => undefined, adopt: async () => undefined });
        },
      }),
    });
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    prepareKinds.length = 0;

    for (const attemptId of ['failure-a', 'failure-b']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }
    await expect(fixture.store.observeActivationAttempt(
      fixture.attempt(secondGenerationId, 'failure-c', 'fatal'),
    )).rejects.toThrow('fixture retained LKG activation failed');

    const state = await fixture.readRevision();
    expect(prepareKinds).toEqual(['rollback', 'state']);
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(secondGenerationId);
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);
    expect(state.revision.health[secondGenerationId]).toMatchObject({
      state: 'quarantined',
      tryOnce: 'available',
    });
    expect(state.revision.healthTombstones).toContainEqual(expect.objectContaining({
      pluginId: PLUGIN_ID,
      fingerprint: state.revision.health[secondGenerationId]?.fingerprint,
      state: 'quarantined',
    }));
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: firstGenerationId,
        role: 'userRollback',
        automaticRecoveryEligible: false,
        byteAvailability: 'available',
      }),
    ]);
  });

  it('consumes the quarantined candidate Try once before an explicit rollback can execute it', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');

    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }
    let state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(firstGenerationId);
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: secondGenerationId,
        role: 'quarantined',
      }),
    ]);

    await fixture.store.rollback(PLUGIN_ID);
    state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(secondGenerationId);
    expect(state.revision.health[secondGenerationId]).toMatchObject({ state: 'trial', tryOnce: 'consumed' });
    expect(state.revision.healthTombstones).toContainEqual(expect.objectContaining({
      pluginId: PLUGIN_ID,
      fingerprint: state.revision.health[secondGenerationId]?.fingerprint,
      state: 'consumed',
    }));

    await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, 'failed-try-once', 'fatal'));
    state = await fixture.readRevision();
    expect(state.revision.health[secondGenerationId]).toMatchObject({ state: 'quarantined', tryOnce: 'consumed' });
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);

    await fixture.store.rollback(PLUGIN_ID);
    state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(firstGenerationId);
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: secondGenerationId,
        role: 'quarantined',
      }),
    ]);
    await expect(fixture.store.rollback(PLUGIN_ID)).rejects.toThrow(/Try once.*unavailable/i);
  });

  it('does not consume Try once when quarantined retained bytes fail verification', async () => {
    const prepare = vi.fn(async () => Object.freeze({
      abort: async () => undefined,
      adopt: async () => undefined,
    }));
    const fixture = await createFixture({
      runtimeLifecycle: Object.freeze({ prepare }),
    });
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }
    prepare.mockClear();

    await writeFile(
      join(fixture.store.paths.generationsDir, secondGenerationId, 'daemon.mjs'),
      'export const corrupted = true;\n',
      'utf8',
    );

    await expect(fixture.store.rollback(PLUGIN_ID)).rejects.toThrow(/generation.*mismatch/i);
    const state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(firstGenerationId);
    expect(state.revision.health[secondGenerationId]).toMatchObject({
      state: 'quarantined',
      tryOnce: 'available',
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('durably consumes Try once before preparing quarantined bytes and does not re-arm after preparation fails', async () => {
    let inspectTryOncePreparation = false;
    let fixture!: Awaited<ReturnType<typeof createFixture>>;
    const preparedStates: Array<Readonly<{
      currentGenerationId: string | undefined;
      candidateGenerationId: string | undefined;
      healthState: string | undefined;
      tryOnce: string | undefined;
      tombstoneState: string | undefined;
    }>> = [];
    fixture = await createFixture({
      runtimeLifecycle: Object.freeze({
        prepare: async (candidate) => {
          if (!inspectTryOncePreparation || candidate.mutationKind !== 'rollback') {
            return Object.freeze({ abort: async () => undefined, adopt: async () => undefined });
          }
          const persisted = await fixture.readRevision();
          const candidateGenerationId = candidate.pluginGenerations[PLUGIN_ID]?.immutableGenerationId;
          const health = candidateGenerationId
            ? persisted.revision.health[candidateGenerationId]
            : undefined;
          const tombstone = persisted.revision.healthTombstones.find((entry) => (
            entry.pluginId === PLUGIN_ID && entry.fingerprint === health?.fingerprint
          ));
          preparedStates.push(Object.freeze({
            currentGenerationId: persisted.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId,
            candidateGenerationId,
            healthState: health?.state,
            tryOnce: health?.tryOnce,
            tombstoneState: tombstone?.state,
          }));
          throw new Error('fixture quarantined preparation failed');
        },
      }),
    });
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    inspectTryOncePreparation = true;
    await expect(fixture.store.rollback(PLUGIN_ID)).rejects.toThrow('fixture quarantined preparation failed');

    expect(preparedStates).toEqual([{
      currentGenerationId: firstGenerationId,
      candidateGenerationId: secondGenerationId,
      healthState: 'trial',
      tryOnce: 'consumed',
      tombstoneState: 'consumed',
    }]);
    const persisted = await fixture.readRevision();
    expect(persisted.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(firstGenerationId);
    expect(persisted.revision.health[secondGenerationId]).toMatchObject({
      state: 'trial',
      tryOnce: 'consumed',
    });
    let restartedPrepareCalls = 0;
    const restartedStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async () => {
          restartedPrepareCalls += 1;
          throw new Error('restarted store must not prepare consumed quarantine');
        },
      }),
      generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
    });
    await expect(restartedStore.rollback(PLUGIN_ID)).rejects.toThrow(/Try once.*unavailable/i);
    expect(restartedPrepareCalls).toBe(0);
    expect(preparedStates).toHaveLength(1);

    const reinstalledCandidateEnabledStates: boolean[] = [];
    const reinstallStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async (candidate) => {
          const record = candidate.runtimeCatalog.plugins[PLUGIN_ID];
          if (record) reinstalledCandidateEnabledStates.push(record.state.enabled);
          return Object.freeze({ abort: async () => undefined, adopt: async () => undefined });
        },
      }),
      generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
    });
    const reinstalledGenerationId = await fixture.install('2.0.0', { stateStore: reinstallStore });
    const reinstalled = await fixture.readRevision();
    expect(reinstalled.revision.health[reinstalledGenerationId]).toMatchObject({
      fingerprint: persisted.revision.health[secondGenerationId]?.fingerprint,
      state: 'quarantined',
      tryOnce: 'consumed',
    });
    expect(reinstalled.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);
    expect(reinstalledCandidateEnabledStates.at(-1)).toBe(false);
    await expect(reinstallStore.setEnabled(PLUGIN_ID, true)).rejects.toThrow(/Try once.*unavailable/i);
  });

  it('durably consumes Try once before re-enabling a quarantined current generation', async () => {
    let inspectTryOncePreparation = false;
    let fixture!: Awaited<ReturnType<typeof createFixture>>;
    const preparedStates: Array<Readonly<{
      persistedEnabled: boolean | undefined;
      candidateEnabled: boolean | undefined;
      healthState: string | undefined;
      tryOnce: string | undefined;
      tombstoneState: string | undefined;
    }>> = [];
    fixture = await createFixture({
      runtimeLifecycle: Object.freeze({
        prepare: async (candidate) => {
          if (!inspectTryOncePreparation || candidate.mutationKind !== 'state') {
            return Object.freeze({ abort: async () => undefined, adopt: async () => undefined });
          }
          const persisted = await fixture.readRevision();
          const health = persisted.revision.health[
            persisted.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId ?? ''
          ];
          const tombstone = persisted.revision.healthTombstones.find((entry) => (
            entry.pluginId === PLUGIN_ID && entry.fingerprint === health?.fingerprint
          ));
          preparedStates.push(Object.freeze({
            persistedEnabled: persisted.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled,
            candidateEnabled: candidate.runtimeCatalog.plugins[PLUGIN_ID]?.state.enabled,
            healthState: health?.state,
            tryOnce: health?.tryOnce,
            tombstoneState: tombstone?.state,
          }));
          throw new Error('fixture quarantined enable preparation failed');
        },
      }),
    });
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    await fixture.makeHealthy(secondGenerationId);
    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    inspectTryOncePreparation = true;
    await expect(fixture.store.setEnabled(PLUGIN_ID, true)).rejects.toThrow(
      'fixture quarantined enable preparation failed',
    );

    expect(preparedStates).toEqual([{
      persistedEnabled: false,
      candidateEnabled: true,
      healthState: 'trial',
      tryOnce: 'consumed',
      tombstoneState: 'consumed',
    }]);
    const persisted = await fixture.readRevision();
    expect(persisted.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(secondGenerationId);
    expect(persisted.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);
    expect(persisted.revision.health[secondGenerationId]).toMatchObject({
      state: 'trial',
      tryOnce: 'consumed',
    });
    await expect(fixture.store.setEnabled(PLUGIN_ID, true)).rejects.toThrow(/Try once.*unavailable/i);
    expect(preparedStates).toHaveLength(1);
  });

  it('preserves a quarantined predecessor role when a newer same-channel candidate is installed', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    await fixture.makeHealthy(secondGenerationId);
    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    let state = await fixture.readRevision();
    expect(state.revision.health[secondGenerationId]).toMatchObject({ state: 'quarantined', tryOnce: 'available' });
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);

    await fixture.install('3.0.0');
    state = await fixture.readRevision();
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: secondGenerationId,
        role: 'quarantined',
        automaticRecoveryEligible: false,
      }),
    ]);

    await fixture.store.rollback(PLUGIN_ID);
    state = await fixture.readRevision();
    expect(state.revision.health[secondGenerationId]).toMatchObject({ state: 'trial', tryOnce: 'consumed' });
  });

  it('evicts only quarantined available Try-once bytes under storage pressure and reports rollback unavailable', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    await expect(fixture.store.evictQuarantinedTryOnceBytesForStoragePressure()).resolves.toEqual({
      evictedGenerationIds: [],
    });
    expect((await fixture.readRevision()).revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: firstGenerationId,
        role: 'lastKnownGood',
        automaticRecoveryEligible: true,
        byteAvailability: 'available',
      }),
    ]);
    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    await expect(fixture.store.evictQuarantinedTryOnceBytesForStoragePressure()).resolves.toEqual({
      evictedGenerationIds: [secondGenerationId],
    });
    const state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(firstGenerationId);
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: secondGenerationId,
        role: 'quarantined',
        automaticRecoveryEligible: false,
        byteAvailability: 'evicted',
      }),
    ]);
    expect(state.revision.health[secondGenerationId]).toMatchObject({
      state: 'quarantined',
      tryOnce: 'available',
    });
    expect(state.revision.healthTombstones).toContainEqual(expect.objectContaining({
      pluginId: PLUGIN_ID,
      fingerprint: state.revision.health[secondGenerationId]?.fingerprint,
      state: 'quarantined',
    }));
    await expect(access(join(fixture.store.paths.generationsDir, firstGenerationId))).resolves.toBeUndefined();
    await expect(access(join(fixture.store.paths.generationsDir, secondGenerationId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(
      fixture.store.paths.generationsDir,
      `.retired-${secondGenerationId}.v1.json`,
    ))).resolves.toBeUndefined();
    await expect(fixture.store.rollback(PLUGIN_ID)).rejects.toThrow(/no available rollback generation/i);

    await expect(fixture.store.evictQuarantinedTryOnceBytesForStoragePressure()).resolves.toEqual({
      evictedGenerationIds: [],
    });
  });

  it('handles an exact local storage-pressure write failure by evicting quarantine before one fresh install attempt', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }

    let unrelatedFailureCalls = 0;
    const unrelatedFailureStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async () => Object.freeze({ abort: async () => undefined, adopt: async () => undefined }),
      }),
      generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
      prepareGeneration: async () => {
        unrelatedFailureCalls += 1;
        throw Object.assign(new Error('device unavailable'), { code: 'EIO' });
      },
    });
    await expect(fixture.install('3.0.0', { stateStore: unrelatedFailureStore })).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(unrelatedFailureCalls).toBe(1);
    expect((await fixture.readRevision()).revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: secondGenerationId,
        byteAvailability: 'available',
      }),
    ]);

    let prepareCalls = 0;
    const pressuredStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async () => Object.freeze({ abort: async () => undefined, adopt: async () => undefined }),
      }),
      generationCustodyRetirement: TEST_GENERATION_CUSTODY_RETIREMENT,
      prepareGeneration: async (input) => {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          throw Object.assign(new Error('device full'), { code: 'ENOSPC' });
        }
        return await prepareImmutablePluginGeneration(input);
      },
    });

    const thirdGenerationId = await fixture.install('3.0.0', { stateStore: pressuredStore });
    expect(prepareCalls).toBe(2);
    expect(thirdGenerationId).not.toBe(firstGenerationId);
    expect(thirdGenerationId).not.toBe(secondGenerationId);
    await expect(access(join(fixture.store.paths.generationsDir, secondGenerationId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(
      fixture.store.paths.generationsDir,
      `.retired-${secondGenerationId}.v1.json`,
    ))).resolves.toBeUndefined();
  });

  it('preserves the generation-cleanup diagnostic when storage-pressure eviction commits but cleanup remains pending', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }
    await mkdir(join(fixture.store.paths.generationsDir, 'generation-invalid-obsolete'));

    await expect(fixture.store.evictQuarantinedTryOnceBytesForStoragePressure()).rejects.toThrow(
      /storage-pressure.*reconciliation.*generationCleanup.*generation-invalid-obsolete/iu,
    );
    const state = await fixture.readRevision();
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: secondGenerationId,
        byteAvailability: 'evicted',
      }),
    ]);
  });

  it('makes the prior generation user-rollback-only after health and ignores stale attempts across restart', async () => {
    const fixture = await createFixture();
    const firstGenerationId = await fixture.install('1.0.0');
    await fixture.makeHealthy(firstGenerationId);
    const secondGenerationId = await fixture.install('2.0.0');
    await fixture.makeHealthy(secondGenerationId);

    let state = await fixture.readRevision();
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: firstGenerationId,
        role: 'userRollback',
        automaticRecoveryEligible: false,
      }),
    ]);

    for (const attemptId of ['failure-a', 'failure-b', 'failure-c']) {
      await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, attemptId, 'fatal'));
    }
    state = await fixture.readRevision();
    expect(state.commit.pluginGenerations[PLUGIN_ID]?.immutableGenerationId).toBe(secondGenerationId);
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);
    expect(state.revision.rollbackRetention).toEqual([
      expect.objectContaining({
        immutableGenerationId: firstGenerationId,
        role: 'userRollback',
        automaticRecoveryEligible: false,
      }),
    ]);

    await fixture.store.setEnabled(PLUGIN_ID, true);
    state = await fixture.readRevision();
    expect(state.revision.health[secondGenerationId]).toMatchObject({ state: 'trial', tryOnce: 'consumed' });
    expect(state.revision.healthTombstones).toContainEqual(expect.objectContaining({
      pluginId: PLUGIN_ID,
      fingerprint: state.revision.health[secondGenerationId]?.fingerprint,
      state: 'consumed',
    }));
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(true);

    await fixture.store.observeActivationAttempt(fixture.attempt(secondGenerationId, 'failed-try-once', 'fatal'));
    state = await fixture.readRevision();
    expect(state.revision.health[secondGenerationId]).toMatchObject({ state: 'quarantined', tryOnce: 'consumed' });
    expect(state.revision.runtimeCatalog?.plugins[PLUGIN_ID]?.state.enabled).toBe(false);
    await expect(fixture.store.setEnabled(PLUGIN_ID, true)).rejects.toThrow(/Try once.*unavailable/i);

    state = await fixture.readRevision();
    const revisionBeforeStaleAttempt = state.commit.revision;
    const restartedStore = createPluginRegistryStateStore({
      happyHomeDir: fixture.store.paths.happyHomeDir,
      runtimeLifecycle: Object.freeze({
        prepare: async () => Object.freeze({ abort: async () => undefined, adopt: async () => undefined }),
      }),
    });
    await restartedStore.observeActivationAttempt(fixture.attempt(firstGenerationId, 'stale-after-restart', 'fatal'));
    expect((await readPluginRegistryCommitRecord(fixture.store.paths))?.revision).toBe(revisionBeforeStaleAttempt);

    await fixture.store.rollback(PLUGIN_ID);
    expect((await fixture.store.read()).plugins[PLUGIN_ID]).toMatchObject({
      install: { manifestVersion: '1.0.0' },
      state: { enabled: true },
    });

    await fixture.store.uninstallWithResult(PLUGIN_ID, { clearHealthHistory: true });
    state = await fixture.readRevision();
    expect(state.revision.healthTombstones).not.toContainEqual(expect.objectContaining({ pluginId: PLUGIN_ID }));
  });
});

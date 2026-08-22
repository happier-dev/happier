import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../configuration', () => ({ configuration: { happyHomeDir: join(tmpdir(), 'unused-registry-home') } }));

import { resolvePluginStorePaths } from '../paths';
import { createPluginRegistryCommitCoordinator } from './commitCoordinator';
import { createEmptyPluginRegistryCommitRecord, readPluginRegistryCommitRecord, type PluginRegistryCommitRecord } from './commitRecord';
import { persistInstallationStateRevision, type PluginInstallationStateRevision } from './generationStore';
import { createPluginRegistryTransactionService } from './service';

const nextStateRevision: PluginInstallationStateRevision = {
  t: 'happier_plugin_installations_v1', schemaVersion: 1, revisionId: 'state-1', createdAtMs: 1,
  plugins: {}, rollbackRetention: [],
};
function next(current: PluginRegistryCommitRecord, transactionId: string): PluginRegistryCommitRecord {
  return {
    ...current, revision: current.revision + 1, baseRevision: current.revision, transactionId,
    installationState: { revisionId: `state-${current.revision + 1}` },
    createdAtMs: current.createdAtMs + 1,
  };
}

async function setup() {
  const happyHomeDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'happier-registry-service-')));
  const paths = resolvePluginStorePaths({ happyHomeDir });
  const coordinator = createPluginRegistryCommitCoordinator({ paths, owner: { pid: 300, instanceId: 'daemon-a' } });
  await coordinator.commit({
    transactionId: 'bootstrap', baseRevision: null,
    expectedCurrent: null,
    buildNext: () => createEmptyPluginRegistryCommitRecord({ transactionId: 'bootstrap', createdAtMs: 1, creatorPid: 300, creatorInstanceId: 'daemon-a' }),
  });
  await persistInstallationStateRevision({ paths, state: nextStateRevision });
  const current = await coordinator.readCurrent();
  if (!current) throw new Error('Expected bootstrap current record');
  return { paths, coordinator, current };
}

describe('plugin registry transaction service', () => {
  it('aborts a prepared candidate exactly once on pre-commit failure and leaves committed state exact', async () => {
    const { paths, coordinator, current } = await setup();
    let aborts = 0;
    const service = createPluginRegistryTransactionService({ coordinator });
    const result = await service.execute({
      transactionId: 'tx-pre-fail', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => { throw new Error('registration invalid'); },
      persist: async (_prepared, current) => next(current!, 'tx-pre-fail'),
      abortPrepared: async () => { aborts += 1; },
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    });

    expect(result).toMatchObject({ status: 'precommit_failed', phase: 'validateAndActivate' });
    expect(aborts).toBe(1);
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 0 });
  });

  it('keeps a successful commit authoritative when reconciliation fails and does not retire the prior generation', async () => {
    const { paths, coordinator, current } = await setup();
    let aborts = 0;
    let retires = 0;
    let cleanups = 0;
    const service = createPluginRegistryTransactionService({ coordinator });
    const result = await service.execute({
      transactionId: 'tx-post-fail', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, current) => next(current!, 'tx-post-fail'),
      abortPrepared: async () => { aborts += 1; },
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'retryable' as const, message: 'watcher unavailable' }),
      retirePrevious: async () => { retires += 1; },
      cleanup: async () => { cleanups += 1; },
    });

    expect(result).toMatchObject({
      status: 'committed',
      applied: true,
      record: { revision: 1 },
      pendingSurfaces: ['reconciliation'],
      message: 'watcher unavailable',
    });
    expect({ aborts, retires, cleanups }).toEqual({ aborts: 0, retires: 0, cleanups: 0 });
    await expect(readPluginRegistryCommitRecord(paths)).resolves.toMatchObject({ revision: 1, transactionId: 'tx-post-fail' });
  });

  it('reports outcomeUnknown when a durable candidate cannot be confirmed as adopted', async () => {
    const { coordinator, current } = await setup();
    const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));
    const service = createPluginRegistryTransactionService({ coordinator });

    await expect(service.execute({
      transactionId: 'tx-adoption-fail', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, current) => next(current!, 'tx-adoption-fail'),
      abortPrepared: async () => undefined,
      adopt: async () => { throw new Error('serving swap failed'); },
      reconcile,
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    })).resolves.toMatchObject({
      status: 'outcomeUnknown',
      phase: 'adoption',
      message: 'serving swap failed',
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('adopts a published candidate and lets a restarted owner resolve currentness while durability is pending', async () => {
    const { paths } = await setup();
    const coordinator = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 301, instanceId: 'daemon-durability-pending' },
      flushCommit: async () => { throw new Error('fsync failed'); },
    });
    const current = await coordinator.readCurrent();
    if (!current) throw new Error('Expected bootstrap current record');
    let aborts = 0;
    let adopts = 0;
    let reconciles = 0;
    let retires = 0;
    let cleanups = 0;
    const service = createPluginRegistryTransactionService({ coordinator });

    await expect(service.execute({
      transactionId: 'tx-durability-pending', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, current) => next(current!, 'tx-durability-pending'),
      abortPrepared: async () => { aborts += 1; },
      adopt: async () => { adopts += 1; },
      reconcile: async () => { reconciles += 1; return { status: 'reconciled' as const }; },
      retirePrevious: async () => { retires += 1; },
      cleanup: async () => { cleanups += 1; },
    })).resolves.toMatchObject({
      status: 'outcomeUnknown',
      phase: 'durability',
      record: { revision: 1 },
      message: 'fsync failed',
    });
    expect({ aborts, adopts, reconciles, retires, cleanups }).toEqual({
      aborts: 0,
      adopts: 1,
      reconciles: 0,
      retires: 0,
      cleanups: 0,
    });
    const restartedCoordinator = createPluginRegistryCommitCoordinator({
      paths,
      owner: { pid: 302, instanceId: 'daemon-restarted' },
    });
    await expect(restartedCoordinator.readCurrent()).resolves.toMatchObject({
      revision: 1,
      transactionId: 'tx-durability-pending',
    });
  });

  it('serves nothing during a first-install adoption gap and does not answer before adoption settles', async () => {
    const published = createEmptyPluginRegistryCommitRecord({
      transactionId: 'tx-first-install', createdAtMs: 1, creatorPid: 300, creatorInstanceId: 'daemon-a',
    });
    let activeCandidate: string | null = null;
    let responseSettled = false;
    let signalAdoptionStarted!: () => void;
    const adoptionStarted = new Promise<void>((resolve) => { signalAdoptionStarted = resolve; });
    let releaseAdoption!: () => void;
    const adoptionReleased = new Promise<void>((resolve) => { releaseAdoption = resolve; });
    let reconciles = 0;
    const service = createPluginRegistryTransactionService({
      coordinator: {
        readCurrent: async () => null,
        commit: async () => ({
          status: 'committed_durability_pending' as const,
          record: published,
          message: 'fsync failed',
        }),
      },
    });

    const execution = service.execute({
      transactionId: 'tx-first-install', baseRevision: null,
      expectedCurrent: null,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async (candidate) => candidate.id,
      persist: async () => published,
      abortPrepared: async () => undefined,
      adopt: async (_record, candidate) => {
        signalAdoptionStarted();
        await adoptionReleased;
        activeCandidate = candidate;
      },
      reconcile: async () => { reconciles += 1; return { status: 'reconciled' as const }; },
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    });
    void execution.then(() => { responseSettled = true; });

    await adoptionStarted;
    expect(activeCandidate).toBeNull();
    expect(responseSettled).toBe(false);
    releaseAdoption();
    await expect(execution).resolves.toMatchObject({
      status: 'outcomeUnknown',
      phase: 'durability',
      record: { revision: 0 },
    });
    expect(activeCandidate).toBe('candidate');
    expect(reconciles).toBe(0);
  });

  it('reports a durability-pending adoption failure without aborting or starting post-adoption work', async () => {
    const current = createEmptyPluginRegistryCommitRecord({
      transactionId: 'bootstrap', createdAtMs: 1, creatorPid: 300, creatorInstanceId: 'daemon-a',
    });
    const published = next(current, 'tx-durability-adoption-fail');
    const calls = { aborts: 0, adopts: 0, reconciles: 0, retires: 0, cleanups: 0 };
    const service = createPluginRegistryTransactionService({
      coordinator: {
        readCurrent: async () => current,
        commit: async () => ({
          status: 'committed_durability_pending' as const,
          record: published,
          message: 'fsync failed',
        }),
      },
    });

    await expect(service.execute({
      transactionId: 'tx-durability-adoption-fail', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async () => published,
      abortPrepared: async () => { calls.aborts += 1; },
      adopt: async () => {
        calls.adopts += 1;
        throw new Error('serving swap failed');
      },
      reconcile: async () => { calls.reconciles += 1; return { status: 'reconciled' as const }; },
      retirePrevious: async () => { calls.retires += 1; },
      cleanup: async () => { calls.cleanups += 1; },
    })).resolves.toMatchObject({
      status: 'outcomeUnknown',
      phase: 'adoption',
      record: { revision: 1 },
      message: 'serving swap failed',
    });
    expect(calls).toEqual({ aborts: 0, adopts: 1, reconciles: 0, retires: 0, cleanups: 0 });
  });

  it('does not use persisted transaction identity as in-flight execution dedupe', async () => {
    const { coordinator, current } = await setup();
    const order: string[] = [];
    const service = createPluginRegistryTransactionService({ coordinator });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstPrepared!: () => void;
    const firstPrepared = new Promise<void>((resolve) => { markFirstPrepared = resolve; });
    const operation = {
      transactionId: 'tx-green', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => {
        order.push('prepare-first');
        markFirstPrepared();
        await firstReleased;
        return { id: 'candidate' };
      },
      validateAndActivate: async () => { order.push('validate'); },
      persist: async (_prepared: { id: string }, current: PluginRegistryCommitRecord | null) => { order.push('persist'); return next(current!, 'tx-green'); },
      abortPrepared: async () => { order.push('abort'); },
      adopt: async () => { order.push('adopt'); },
      reconcile: async () => { order.push('reconcile'); return { status: 'reconciled' as const }; },
      retirePrevious: async () => { order.push('retire'); },
      cleanup: async () => { order.push('cleanup'); },
    };
    const first = service.execute(operation);
    await firstPrepared;
    const secondPrepare = vi.fn(async () => {
      order.push('prepare-second');
      return { id: 'candidate' };
    });
    const second = service.execute({ ...operation, prepare: secondPrepare });
    releaseFirst();

    expect(second).not.toBe(first);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual(['committed', 'conflict']);
    expect(secondPrepare).toHaveBeenCalledOnce();
    expect(order).toContain('abort');
  });

  it('aborts and reports a prepared candidate when reading current fails before persistence', async () => {
    let aborts = 0;
    const service = createPluginRegistryTransactionService({
      coordinator: {
        readCurrent: async () => { throw new Error('corrupt current record'); },
        commit: async () => { throw new Error('commit must not run'); },
      },
    });

    await expect(service.execute({
      transactionId: 'tx-read-fail', baseRevision: 0,
      expectedCurrent: null,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async () => { throw new Error('persist must not run'); },
      abortPrepared: async () => { aborts += 1; },
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    })).resolves.toMatchObject({ status: 'precommit_failed', phase: 'readCurrent', message: 'corrupt current record' });
    expect(aborts).toBe(1);
  });

  it('surfaces abort failure on a stale-base conflict', async () => {
    const { coordinator, current } = await setup();
    const service = createPluginRegistryTransactionService({ coordinator });

    await expect(service.execute({
      transactionId: 'tx-conflict-abort-fail', baseRevision: 99,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, current) => next(current!, 'must-not-persist'),
      abortPrepared: async () => { throw new Error('candidate disposal failed'); },
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    })).resolves.toMatchObject({
      status: 'conflict', expectedRevision: 99, actualRevision: 0, abortMessage: 'candidate disposal failed',
    });
  });

  it('classifies retirement and cleanup failures truthfully after commit', async () => {
    const first = await setup();
    const retirementService = createPluginRegistryTransactionService({ coordinator: first.coordinator });
    const firstCurrent = await first.coordinator.readCurrent();
    if (!firstCurrent) throw new Error('Expected bootstrap current record');
    await expect(retirementService.execute({
      transactionId: 'tx-retirement-fail', baseRevision: 0,
      expectedCurrent: firstCurrent,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, current) => next(current!, 'tx-retirement-fail'),
      abortPrepared: async () => undefined,
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => { throw new Error('retirement timed out'); },
      cleanup: async () => undefined,
    })).resolves.toMatchObject({ status: 'committed', pendingSurfaces: ['retirement'], message: 'retirement timed out' });

    const second = await setup();
    const cleanupService = createPluginRegistryTransactionService({ coordinator: second.coordinator });
    const secondCurrent = await second.coordinator.readCurrent();
    if (!secondCurrent) throw new Error('Expected bootstrap current record');
    await expect(cleanupService.execute({
      transactionId: 'tx-cleanup-fail', baseRevision: 0,
      expectedCurrent: secondCurrent,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, current) => next(current!, 'tx-cleanup-fail'),
      abortPrepared: async () => undefined,
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => undefined,
      cleanup: async () => { throw new Error('cleanup failed'); },
    })).resolves.toMatchObject({ status: 'committed', pendingSurfaces: ['cleanup'], message: 'cleanup failed' });
  });

  it('projects transaction lifecycle error inputs through the redacted head bound', async () => {
    const rawFailure = [
      'BEGIN_FAILURE client_secret=registry-lifecycle-secret',
      '🙂'.repeat(1_200),
      'END_STACK',
    ].join(' ');
    const assertProjected = (message: string | undefined): void => {
      const actual = message ?? '';
      expect(actual).toMatch(/^BEGIN_FAILURE/u);
      expect(actual).not.toContain('registry-lifecycle-secret');
      expect(actual).not.toContain('END_STACK');
      expect(Buffer.byteLength(actual, 'utf8')).toBeLessThanOrEqual(2_048);
    };
    const { coordinator, current } = await setup();
    const service = createPluginRegistryTransactionService({ coordinator });

    const activationFailure = await service.execute({
      transactionId: 'tx-projected-activation-failure', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => { throw new Error(rawFailure); },
      persist: async (_prepared, currentRecord) => next(currentRecord!, 'tx-projected-activation-failure'),
      abortPrepared: async () => { throw new Error(rawFailure); },
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    });
    expect(activationFailure).toMatchObject({ status: 'precommit_failed', phase: 'validateAndActivate' });
    if (activationFailure.status !== 'precommit_failed') throw new Error('Expected precommit failure');
    assertProjected(activationFailure.message);
    assertProjected(activationFailure.abortMessage);

    const reconciliationFailure = await service.execute({
      transactionId: 'tx-projected-reconciliation-failure', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, currentRecord) => next(currentRecord!, 'tx-projected-reconciliation-failure'),
      abortPrepared: async () => undefined,
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'retryable' as const, message: rawFailure }),
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    });
    expect(reconciliationFailure).toMatchObject({ status: 'committed', pendingSurfaces: ['reconciliation'] });
    if (reconciliationFailure.status !== 'committed') throw new Error('Expected committed transaction');
    assertProjected(reconciliationFailure.message);

    const durabilityService = createPluginRegistryTransactionService({
      coordinator: {
        readCurrent: async () => current,
        commit: async () => ({
          status: 'committed_durability_pending' as const,
          record: next(current, 'tx-projected-durability-failure'),
          message: rawFailure,
        }),
      },
    });
    const durabilityFailure = await durabilityService.execute({
      transactionId: 'tx-projected-durability-failure', baseRevision: 0,
      expectedCurrent: current,
      prepare: async () => ({ id: 'candidate' }),
      validateAndActivate: async () => undefined,
      persist: async (_prepared, currentRecord) => next(currentRecord!, 'tx-projected-durability-failure'),
      abortPrepared: async () => undefined,
      adopt: async () => undefined,
      reconcile: async () => ({ status: 'reconciled' as const }),
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
    });
    expect(durabilityFailure).toMatchObject({ status: 'outcomeUnknown', phase: 'durability' });
    if (durabilityFailure.status !== 'outcomeUnknown') throw new Error('Expected durability ambiguity');
    assertProjected(durabilityFailure.message);
  });
});

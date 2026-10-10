import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginAvailabilityReleasePublishActionInputV1Schema } from '@happier-dev/protocol';
import type { FeaturesResponse } from '@happier-dev/protocol';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import type { PluginRegistryAvailabilityInventory } from '@/plugins/store/registry/currentState';
import { logger } from '@/ui/logger';

import {
  createServerPluginAvailabilityPublisher,
  type PluginAvailabilityPublisher,
} from './serverPublisher';
import { createDaemonPluginAvailabilityReporter } from './daemonReporter';

const { publisher, PluginAvailabilityReleaseContentConflictError } = vi.hoisted(() => {
  class PluginAvailabilityReleaseContentConflictError extends Error {
    readonly code = 'plugin_release_content_conflict' as const;
  }
  return {
    publisher: {
      publishRelease: vi.fn<PluginAvailabilityPublisher['publishRelease']>(async (input) => ({
        facts: input.facts,
        outcome: 'created',
      })),
      reportMaterializations: vi.fn<PluginAvailabilityPublisher['reportMaterializations']>(async () => ({
        revision: 0,
        outcome: 'replaced',
      })),
    },
    PluginAvailabilityReleaseContentConflictError,
  };
});

vi.mock('./serverPublisher', () => ({
  createServerPluginAvailabilityPublisher: vi.fn(() => publisher),
  PluginAvailabilityReleaseContentConflictError,
  isPluginAvailabilityReleaseContentConflictError: (error: unknown) => (
    error instanceof PluginAvailabilityReleaseContentConflictError
  ),
}));

vi.mock('@/ui/logger', () => ({
  logger: { warn: vi.fn() },
}));

const credentials = {
  token: 'account-token',
  encryption: null,
} satisfies StoredCredentials;

const release = PluginAvailabilityReleasePublishActionInputV1Schema.parse({
  facts: {
    ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
    archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
    normalizedManifest: {
      schemaVersion: 2,
      id: 'com.acme.fixture',
      version: '1.2.3',
      displayName: 'Fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {},
    },
    collectionContracts: [],
    uiSlots: [],
    packageAssetArchive: {
      archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
      resources: [],
    },
  },
  sourceClass: 'registryPackage',
});

const materialization = {
  materializationId: 'materialization-fixture',
  pluginId: 'com.acme.fixture',
  version: '1.2.3',
  sourceClass: 'registryPackage',
  portableRelease: true,
  archiveDigestSha256: release.facts.archiveDigestSha256,
  uiArtifacts: [],
  enabled: true,
  trustState: 'trusted',
  observedAt: 12,
} satisfies PluginRegistryAvailabilityInventory['materializations'][number];

const unrelatedRelease = PluginAvailabilityReleasePublishActionInputV1Schema.parse({
  facts: {
    ref: { pluginId: 'com.acme.unrelated', version: '2.0.0' },
    archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
    normalizedManifest: {
      schemaVersion: 2,
      id: 'com.acme.unrelated',
      version: '2.0.0',
      displayName: 'Unrelated',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      contributes: {},
    },
    collectionContracts: [],
    uiSlots: [],
    packageAssetArchive: {
      archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
      resources: [],
    },
  },
  sourceClass: 'registryPackage',
});

const unrelatedMaterialization = {
  ...materialization,
  materializationId: 'materialization-unrelated',
  pluginId: 'com.acme.unrelated',
  version: '2.0.0',
} satisfies PluginRegistryAvailabilityInventory['materializations'][number];

const inventory = {
  revision: 12,
  releasePublications: [release],
  materializations: [materialization],
} satisfies PluginRegistryAvailabilityInventory;

function createDeferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function readyServerFeatures(): CliServerFeaturesSnapshot {
  return {
    status: 'ready',
    // Server-features is the reporter's transport boundary; this fixture only
    // supplies the identity the reporter actually reads.
    features: {
      features: {},
      capabilities: {
        serverIdentity: { serverIdentityId: 'srv_availability_daemon' },
      },
    } as unknown as FeaturesResponse,
  };
}

describe('daemon plugin Availability reporter', () => {
  beforeEach(() => {
    publisher.publishRelease.mockReset();
    publisher.reportMaterializations.mockReset();
    publisher.reportMaterializations.mockResolvedValue({ revision: 1, outcome: 'replaced' });
    vi.mocked(createServerPluginAvailabilityPublisher).mockClear();
    vi.mocked(logger.warn).mockReset();
  });

  it('retires reporting with the daemon lifetime without publishing a queued successor', async () => {
    const abort = new AbortController();
    const reason = new Error('daemon retired');
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    publisher.publishRelease.mockImplementationOnce(async (_input, options) => {
      entered();
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(reason), { once: true }));
      return { facts: release.facts, outcome: 'created' };
    });
    const reporter = createDaemonPluginAvailabilityReporter({ credentials,
      serverFeaturesSnapshotStore: { getSnapshot: readyServerFeatures }, getMachineId: () => 'machine-current', signal: abort.signal });
    const first = reporter.report(inventory);
    await started;
    const successor = reporter.report({ ...inventory, revision: 13, materializations: [] });
    const results = Promise.allSettled([first, successor]);
    expect(publisher.publishRelease).toHaveBeenCalledWith(release, { signal: abort.signal });
    abort.abort(reason);
    expect(await results).toEqual([{ status: 'rejected', reason }, { status: 'rejected', reason }]);
    expect(publisher.reportMaterializations).not.toHaveBeenCalled();
  });

  it('publishes verified releases before reporting the exact persisted machine snapshot with live identity facts', async () => {
    const releaseCompletion = createDeferred();
    const callOrder: string[] = [];
    publisher.publishRelease.mockImplementationOnce(async (input) => {
      callOrder.push('release');
      await releaseCompletion.promise;
      return { facts: input.facts, outcome: 'created' };
    });
    publisher.reportMaterializations.mockImplementationOnce(async () => {
      callOrder.push('materializations');
      return { revision: 1, outcome: 'replaced' };
    });
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: {
        getSnapshot: readyServerFeatures,
      },
      getMachineId: () => 'machine-current',
    });

    const report = reporter.report(inventory);
    await Promise.resolve();
    expect(publisher.reportMaterializations).not.toHaveBeenCalled();

    releaseCompletion.resolve();
    await report;

    expect(callOrder).toEqual(['release', 'materializations']);
    expect(createServerPluginAvailabilityPublisher).toHaveBeenCalledWith({ credentials });
    expect(publisher.publishRelease).toHaveBeenCalledWith(release);
    expect(publisher.reportMaterializations).toHaveBeenCalledWith({
      expectedRevision: null,
      snapshot: {
        serverIdentityId: 'srv_availability_daemon',
        machineId: 'machine-current',
        materializations: [{
          ...materialization,
          serverIdentityId: 'srv_availability_daemon',
          machineId: 'machine-current',
        }],
      },
    });
  });

  it('reports persisted installation facts without live declarations and suppresses declaration-only changes', async () => {
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: { getSnapshot: readyServerFeatures },
      getMachineId: () => 'machine-current',
    });
    await reporter.report({ ...inventory, materializations: [{
      ...materialization,
      declaredManifest: release.facts.normalizedManifest,
      declaredUiEntries: {},
    }] });
    const reported = publisher.reportMaterializations.mock.calls[0]?.[0].snapshot.materializations[0];
    expect(reported).toEqual({ ...materialization, serverIdentityId: 'srv_availability_daemon', machineId: 'machine-current' });
    await reporter.report({ ...inventory, materializations: [{
      ...materialization,
      declaredManifest: { ...release.facts.normalizedManifest, displayName: 'Fresh live description' },
      declaredUiEntries: {},
    }] });
    expect(publisher.reportMaterializations).toHaveBeenCalledTimes(1);
  });

  it('does not open the transport when the daemon lacks a ready server identity', async () => {
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: { getSnapshot: () => undefined },
      getMachineId: () => 'machine-current',
    });

    await reporter.report(inventory);

    expect(publisher.publishRelease).not.toHaveBeenCalled();
    expect(publisher.reportMaterializations).not.toHaveBeenCalled();
  });

  it('retains conflicting release evidence in the complete snapshot so Availability can classify it', async () => {
    publisher.publishRelease.mockRejectedValueOnce(
      new PluginAvailabilityReleaseContentConflictError('plugin_release_content_conflict'),
    );
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: {
        getSnapshot: readyServerFeatures,
      },
      getMachineId: () => 'machine-current',
    });

    await reporter.report({
      revision: 13,
      // A previously reported `com.acme.removed@1.0.0` is intentionally absent:
      // this full replacement snapshot retires it. The conflicting B
      // coordinate remains as evidence while unrelated C stays current.
      releasePublications: [release, unrelatedRelease],
      materializations: [materialization, unrelatedMaterialization],
    });

    expect(publisher.publishRelease).toHaveBeenNthCalledWith(1, release);
    expect(publisher.publishRelease).toHaveBeenNthCalledWith(2, unrelatedRelease);
    expect(publisher.reportMaterializations).toHaveBeenCalledWith({
      expectedRevision: null,
      snapshot: {
        serverIdentityId: 'srv_availability_daemon',
        machineId: 'machine-current',
        materializations: [
          {
            ...materialization,
            serverIdentityId: 'srv_availability_daemon',
            machineId: 'machine-current',
          },
          {
            ...unrelatedMaterialization,
            serverIdentityId: 'srv_availability_daemon',
            machineId: 'machine-current',
          },
        ],
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[PLUGIN AVAILABILITY] Release-content conflict retained for Account availability classification; publish a new version',
      { pluginId: 'com.acme.fixture', version: '1.2.3' },
    );
  });

  it('does not hide ordinary publisher failures by reporting the machine snapshot', async () => {
    publisher.publishRelease.mockRejectedValueOnce(new Error('transport unavailable'));
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: {
        getSnapshot: readyServerFeatures,
      },
      getMachineId: () => 'machine-current',
    });

    await expect(reporter.report(inventory)).rejects.toThrow('transport unavailable');
    expect(publisher.reportMaterializations).not.toHaveBeenCalled();
  });

  it('serializes reports and coalesces in-flight changes to the latest full body', async () => {
    const firstReport = createDeferred();
    publisher.reportMaterializations
      .mockImplementationOnce(async () => {
        await firstReport.promise;
        return { revision: 4, outcome: 'replaced' };
      })
      .mockResolvedValueOnce({ revision: 5, outcome: 'replaced' });
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: { getSnapshot: readyServerFeatures },
      getMachineId: () => 'machine-current',
    });

    const first = reporter.report(inventory);
    await Promise.resolve();
    const superseded = reporter.report({ ...inventory, revision: 13, materializations: [] });
    const latest = reporter.report({
      ...inventory,
      revision: 14,
      materializations: [unrelatedMaterialization],
    });

    expect(publisher.reportMaterializations).toHaveBeenCalledTimes(1);
    firstReport.resolve();
    await Promise.all([first, superseded, latest]);

    expect(publisher.reportMaterializations).toHaveBeenCalledTimes(2);
    expect(publisher.reportMaterializations).toHaveBeenNthCalledWith(2, {
      expectedRevision: 4,
      snapshot: {
        serverIdentityId: 'srv_availability_daemon',
        machineId: 'machine-current',
        materializations: [{
          ...unrelatedMaterialization,
          serverIdentityId: 'srv_availability_daemon',
          machineId: 'machine-current',
        }],
      },
    });
  });

  it('restarts a drain when a report arrives at the previous drain completion boundary', async () => {
    const firstReportCompletion = createDeferred();
    publisher.reportMaterializations
      .mockImplementationOnce(async () => {
        await firstReportCompletion.promise;
        return { revision: 4, outcome: 'replaced' };
      })
      .mockResolvedValueOnce({ revision: 5, outcome: 'replaced' });
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: { getSnapshot: readyServerFeatures },
      getMachineId: () => 'machine-current',
    });

    const first = reporter.report(inventory);
    await Promise.resolve();

    let boundaryReport!: Promise<void>;
    const boundaryReportStarted = createDeferred();
    void firstReportCompletion.promise.then(() => Promise.resolve().then(() => Promise.resolve().then(() => {
      boundaryReport = reporter.report({
        ...inventory,
        revision: 13,
        materializations: [unrelatedMaterialization],
      });
      boundaryReportStarted.resolve();
    })));

    firstReportCompletion.resolve();
    await boundaryReportStarted.promise;
    await Promise.all([first, boundaryReport]);

    expect(publisher.reportMaterializations).toHaveBeenCalledTimes(2);
    expect(publisher.reportMaterializations).toHaveBeenNthCalledWith(2, {
      expectedRevision: 4,
      snapshot: {
        serverIdentityId: 'srv_availability_daemon',
        machineId: 'machine-current',
        materializations: [{
          ...unrelatedMaterialization,
          serverIdentityId: 'srv_availability_daemon',
          machineId: 'machine-current',
        }],
      },
    });
  });

  it('refreshes the server CAS token on conflict and resends the current full body', async () => {
    publisher.reportMaterializations
      .mockResolvedValueOnce({ revision: 8, outcome: 'conflict' })
      .mockResolvedValueOnce({ revision: 9, outcome: 'replaced' });
    const reporter = createDaemonPluginAvailabilityReporter({
      credentials,
      serverFeaturesSnapshotStore: { getSnapshot: readyServerFeatures },
      getMachineId: () => 'machine-current',
    });

    await reporter.report(inventory);

    expect(publisher.reportMaterializations).toHaveBeenCalledTimes(2);
    expect(publisher.reportMaterializations.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: null });
    expect(publisher.reportMaterializations.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 8 });
    expect(publisher.reportMaterializations.mock.calls[1]?.[0].snapshot.materializations)
      .toEqual(publisher.reportMaterializations.mock.calls[0]?.[0].snapshot.materializations);
  });
});

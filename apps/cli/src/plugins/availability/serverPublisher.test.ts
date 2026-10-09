import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PluginAvailabilityActionHttpPathsV1,
  PluginAvailabilityMaterializationsReportActionInputV1Schema,
  PluginAvailabilityReleasePublishActionInputV1Schema,
} from '@happier-dev/protocol';

import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import * as persistence from '@/persistence';

import {
  createServerPluginAvailabilityPublisher,
  PluginAvailabilityReleaseContentConflictError,
  readServerPluginManagedResources,
} from './serverPublisher';

vi.mock('axios');
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: vi.fn(),
}));

const releaseInput = PluginAvailabilityReleasePublishActionInputV1Schema.parse({
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

const materializationsInput = PluginAvailabilityMaterializationsReportActionInputV1Schema.parse({
  expectedRevision: null,
  snapshot: {
    serverIdentityId: 'srv_availabilityPublisherFixture',
    machineId: 'machine-publisher-fixture',
    materializations: [],
  },
});

describe('server plugin Availability publisher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.isAxiosError).mockReset();
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockReset();
  });

  it('reads removal dependencies through captured Account authority and refuses missing or mismatched census responses', async () => {
    const credentials = { token: 'current-account', encryption: null } satisfies persistence.StoredCredentials;
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token: 'another-account', encryption: null });
    const binding = { credentials, serverUrl: 'https://captured-home.example', homeId: 'home-a',
      controller: { machineId: 'controller-a', installationId: 'installation-a' } };
    const normal = { availabilityCursor: 0, hostingCapability: { enabled: false }, intent: null,
      release: null, uiArtifacts: [], packageAssets: [] };
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { ...normal, managedResources: [], managedResourcesReviewed: true } });
    await expect(readServerPluginManagedResources(binding, 'com.acme.fixture')).resolves.toEqual({ resources: [], reviewed: true });
    expect(axios.post).toHaveBeenLastCalledWith('https://captured-home.example/v1/plugins/availability/intents/read',
      { pluginId: 'com.acme.fixture', includeManagedResources: true, controller: binding.controller, homeId: binding.homeId }, expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer current-account' }),
      }));

    vi.mocked(axios.post).mockResolvedValueOnce({ data: normal });
    await expect(readServerPluginManagedResources(binding, 'com.acme.fixture')).rejects.toThrow('plugin_managed_resource_preflight_unavailable');
    vi.mocked(axios.post).mockResolvedValueOnce({ data: { ...normal, managedResources: [{
      managedId: 'foreign-resource', homeId: 'home-b', custodianAccountId: 'current-account', intentRevision: 1,
      controller: binding.controller, provider: { pluginId: 'com.acme.fixture', localId: 'compute' }, allocation: 'may-exist',
    }], managedResourcesReviewed: true } });
    await expect(readServerPluginManagedResources(binding, 'com.acme.fixture')).rejects.toThrow('plugin_managed_resource_preflight_unavailable');
  });

  it('publishes verified release facts and complete machine materializations through the canonical paths and proof', async () => {
    const releasePath = PluginAvailabilityActionHttpPathsV1[
      'account.plugins.availability.release.publish'
    ];
    const materializationsPath = PluginAvailabilityActionHttpPathsV1[
      'account.plugins.availability.materializations.report'
    ];
    vi.mocked(createDefaultPluginInstallationPublisherHeader)
      .mockResolvedValueOnce('release-proof')
      .mockResolvedValueOnce('materializations-proof');
    vi.mocked(axios.post)
      .mockResolvedValueOnce({ data: { facts: releaseInput.facts, outcome: 'created' } })
      .mockResolvedValueOnce({ data: { revision: 1, outcome: 'replaced' } });
    const publisher = createServerPluginAvailabilityPublisher({
      credentials: { token: 'account-token' } as never,
    });
    const signal = new AbortController().signal;

    await expect(publisher.publishRelease(releaseInput, { signal })).resolves.toMatchObject({
      outcome: 'created',
      facts: { ref: releaseInput.facts.ref },
    });
    await expect(publisher.reportMaterializations(materializationsInput)).resolves.toEqual({
      revision: 1,
      outcome: 'replaced',
    });

    expect(createDefaultPluginInstallationPublisherHeader).toHaveBeenNthCalledWith(1, {
      method: 'POST',
      path: releasePath,
      body: releaseInput,
    });
    expect(createDefaultPluginInstallationPublisherHeader).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      path: materializationsPath,
      body: materializationsInput,
    });
    expect(axios.post).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(new RegExp(`${releasePath}$`, 'u')),
      releaseInput,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer account-token',
          'x-happier-plugin-installation-manifest-publisher': 'release-proof',
        }),
        signal,
      }),
    );
    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(new RegExp(`${materializationsPath}$`, 'u')),
      materializationsInput,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer account-token',
          'x-happier-plugin-installation-manifest-publisher': 'materializations-proof',
        }),
      }),
    );
  });

  it('converts only the canonical same-coordinate release conflict into the reporter-visible typed outcome', async () => {
    vi.mocked(createDefaultPluginInstallationPublisherHeader).mockResolvedValueOnce('release-proof');
    const conflict = Object.assign(new Error('Conflict'), {
      response: {
        status: 409,
        data: { error: 'plugin_release_content_conflict' },
      },
    });
    const unrelatedConflict = Object.assign(new Error('Conflict'), {
      response: {
        status: 409,
        data: { error: 'plugin_intent_revision_conflict' },
      },
    });
    vi.mocked(axios.isAxiosError).mockImplementation(
      (error) => error === conflict || error === unrelatedConflict,
    );
    vi.mocked(axios.post)
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(unrelatedConflict);
    const publisher = createServerPluginAvailabilityPublisher({
      credentials: { token: 'account-token' } as never,
    });

    await expect(publisher.publishRelease(releaseInput)).rejects.toBeInstanceOf(
      PluginAvailabilityReleaseContentConflictError,
    );
    await expect(publisher.publishRelease(releaseInput)).rejects.toBe(unrelatedConflict);
  });
});

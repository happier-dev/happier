import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NpmRegistryHttpsClient } from '@/plugins/distribution/npm/httpsClient';
import { createTestNpmTarball, sriSha512 } from '@/plugins/distribution/testkit/npmTarball';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE } from '@/plugins/store/marketplace/service';

import { createDaemonPluginChangeService } from './changeService';
import type { DaemonPluginChangeService } from './changeService';
import type { ExpectedMarketplaceListing } from './changeContract';
import { createDaemonNpmPluginChangePreparer } from './npmChangePreparer';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function createNpmPackageFixture(params: Readonly<{
  packageName?: string;
  packageJsonName?: string;
  pluginId?: string;
  version?: string;
  entrypoints?: Readonly<Record<string, string>>;
  hostAccess?: Readonly<{
    required: readonly unknown[];
    optional: readonly unknown[];
  }>;
  contributes?: Readonly<Record<string, unknown>>;
  markerPath: string;
  tarballUrl?: string;
}>): Promise<Readonly<{
  packageName: string;
  version: string;
  integrity: string;
  manifestDigest: string;
  client: NpmRegistryHttpsClient;
}>> {
  const packageName = params.packageName ?? '@acme/npm-candidate';
  const pluginId = params.pluginId ?? 'acme.npm-candidate';
  const version = params.version ?? '1.2.3';
  const manifestRaw = JSON.stringify({
    schemaVersion: 2,
    id: pluginId,
    version,
    displayName: 'Acme npm candidate',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
    entrypoints: params.entrypoints ?? { daemon: './dist/daemon.mjs' },
    hostAccess: params.hostAccess ?? { required: [], optional: [] },
    contributes: params.contributes ?? {},
  });
  const archive = await createTestNpmTarball([
    {
      name: 'package/package.json',
      body: JSON.stringify({
        name: params.packageJsonName ?? packageName,
        version,
        keywords: ['happier-plugin'],
        files: ['.happier-plugin', 'dist', 'payload.txt'],
        happier: { manifest: '.happier-plugin/plugin.json' },
        scripts: { preinstall: `touch ${params.markerPath}.lifecycle` },
        dependencies: { 'ordinary-runtime-dependency': '^1.0.0' },
      }),
    },
    {
      name: 'package/.happier-plugin/plugin.json',
      body: manifestRaw,
    },
    {
      name: 'package/dist/daemon.mjs',
      body: [
        "import './runtimeDependency.mjs';",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(params.markerPath)}, 'imported');`,
        'export async function activate() {}',
        '',
      ].join('\n'),
    },
    { name: 'package/dist/runtimeDependency.mjs', body: 'export const bundledDependency = true;\n' },
    { name: 'package/payload.txt', body: `reviewed bytes ${version}` },
  ]);
  const integrity = sriSha512(archive);
  const client: NpmRegistryHttpsClient = {
    getJson: async () => ({
      name: packageName,
      'dist-tags': { latest: version },
      versions: {
        [version]: {
          name: packageName,
          version,
          dist: {
            integrity,
            tarball: params.tarballUrl
              ?? `https://registry.example.test/${encodeURIComponent(packageName)}/-/candidate-${version}.tgz`,
          },
        },
      },
    }),
    getBody: async () => ({ body: Readable.from([archive]), contentLength: archive.byteLength }),
  };
  return {
    packageName,
    version,
    integrity,
    manifestDigest: `sha256:${createHash('sha256').update(manifestRaw).digest('hex')}`,
    client,
  };
}

async function candidateRoots(happyHomeDir: string): Promise<readonly string[]> {
  const cacheDir = resolvePluginStorePaths({ happyHomeDir }).cacheDir;
  try {
    return (await readdir(cacheDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-npm-candidate-'))
      .map((entry) => join(cacheDir, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function findFile(rootPath: string, fileName: string): Promise<string> {
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === fileName) return path;
    }
  }
  throw new Error(`Could not find ${fileName} below npm candidate root`);
}

function curatedListing(
  fixture: Readonly<{
    packageName: string;
    version: string;
    integrity: string;
    manifestDigest: string;
  }>,
  source: Readonly<{ id: string; sourceUrl: string }>,
  overrides: Partial<ExpectedMarketplaceListing> = {},
): ExpectedMarketplaceListing {
  return {
    source: { id: source.id, kind: 'curated', sourceUrl: source.sourceUrl },
    pluginId: 'acme.npm-candidate',
    publisher: { id: 'acme', displayName: 'Acme' },
    packageName: fixture.packageName,
    registryOrigin: 'https://registry.example.test',
    version: fixture.version,
    integrity: fixture.integrity,
    manifestDigest: fixture.manifestDigest,
    review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
    updatePolicy: 'automatic',
    ...overrides,
  } as ExpectedMarketplaceListing;
}

async function installReviewedCuratedCandidate(params: Readonly<{
  service: DaemonPluginChangeService;
  fixture: Readonly<{
    packageName: string;
    version: string;
    integrity: string;
    manifestDigest: string;
  }>;
  source: Readonly<{ id: string; sourceUrl: string }>;
  optionalSelections?: readonly Readonly<{ accessId: string; selected: boolean }>[];
}>): Promise<void> {
  const result = await params.service.requestPluginChange({
    kind: 'installNpm',
    packageName: params.fixture.packageName,
    selector: params.fixture.version,
    registryOrigin: 'https://registry.example.test',
    expectedMarketplaceListing: curatedListing(params.fixture, params.source),
  });
  if (result.kind !== 'reviewRequired') throw new Error('Expected initial curated npm review');
  const committed = await params.service.decidePluginChange({
    pendingChangeId: result.pendingChangeId,
    decision: 'installAndTrust',
    actorEvidence: {
      kind: 'authenticatedLocalUser',
      interactionId: 'initial-curated-install',
      occurredAtMs: 10,
    },
    ...(params.optionalSelections ? { optionalSelections: params.optionalSelections } : {}),
  });
  if (committed.kind !== 'committed') throw new Error('Expected initial curated npm commit');
}

async function requestCuratedUpdate(params: Readonly<{
  service: DaemonPluginChangeService;
  fixture: Readonly<{
    packageName: string;
    version: string;
    integrity: string;
    manifestDigest: string;
  }>;
  source: Readonly<{ id: string; sourceUrl: string }>;
  listingOverrides?: Partial<ExpectedMarketplaceListing>;
  registryOrigin?: string;
}>) {
  return await params.service.requestPluginChange({
    kind: 'installNpm',
    packageName: params.fixture.packageName,
    selector: params.fixture.version,
    registryOrigin: params.registryOrigin ?? 'https://registry.example.test',
    expectedMarketplaceListing: curatedListing(
      params.fixture,
      params.source,
      params.listingOverrides,
    ),
  });
}

describe('createDaemonNpmPluginChangePreparer', () => {
  it('keeps credential-bearing npm tarball query data out of the serializable installation review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-review-redaction-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'never'),
      tarballUrl: 'https://registry.example.test/@acme/npm-candidate/-/candidate-1.2.3.tgz?token=private-registry-secret',
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => fixture.client,
      }),
    });

    const result = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    });

    expect(result).toMatchObject({
      kind: 'reviewRequired',
      review: {
        source: {
          kind: 'npm',
          locator: `${fixture.packageName}@${fixture.version}`,
          integrity: fixture.integrity,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-registry-secret');
    if (result.kind === 'reviewRequired') {
      await service.decidePluginChange({
        pendingChangeId: result.pendingChangeId,
        decision: 'cancel',
      });
    }
  });

  it('stages an exact unreviewed community npm candidate for one real Install and trust review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-community-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => fixture.client,
      }),
    });

    const result = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      selector: fixture.version,
      registryOrigin: 'https://registry.example.test',
      expectedMarketplaceListing: {
        source: {
          id: COMMUNITY_NPM_MARKETPLACE_SOURCE.id,
          kind: 'community-npm',
          sourceUrl: COMMUNITY_NPM_MARKETPLACE_SOURCE.sourceUrl,
        },
        pluginId: 'acme.npm-candidate',
        publisher: { id: 'acme', displayName: 'Acme' },
        packageName: fixture.packageName,
        registryOrigin: 'https://registry.example.test',
        version: fixture.version,
        integrity: fixture.integrity,
        manifestDigest: fixture.manifestDigest,
        review: { status: 'unreviewed', reviewedAt: null },
        updatePolicy: 'manual',
      },
    });

    expect(result).toMatchObject({
      kind: 'reviewRequired',
      review: {
        pluginId: 'acme.npm-candidate',
        version: fixture.version,
        source: { kind: 'npm', integrity: fixture.integrity },
      },
    });
    if (result.kind !== 'reviewRequired') throw new Error('Expected community npm Install and trust review');
    const committed = await service.decidePluginChange({
      pendingChangeId: result.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'community-marketplace-install',
        occurredAtMs: 20,
      },
    });
    expect(committed).toMatchObject({ kind: 'committed', pluginId: 'acme.npm-candidate' });
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.npm-candidate'])
      .toMatchObject({
        install: {
          updatePolicy: 'manual',
          trust: { distribution: { kind: 'npm', packageName: fixture.packageName } },
        },
        source: {
          resolvedVersion: fixture.version,
        },
      });
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('prepares an exact approved curated marketplace candidate and commits only after a decision', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const marketplaceSource = (
      await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()
    ).sources[0]!;
    const adopt = vi.fn(async () => undefined);
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt }));
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
        createClient: () => fixture.client,
      }),
    });

    const result = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      selector: fixture.version,
      registryOrigin: 'https://registry.example.test',
      expectedMarketplaceListing: {
        source: {
          id: marketplaceSource.id,
          kind: 'curated',
          sourceUrl: marketplaceSource.sourceUrl,
        },
        pluginId: 'acme.npm-candidate',
        publisher: { id: 'acme', displayName: 'Acme' },
        packageName: fixture.packageName,
        registryOrigin: 'https://registry.example.test',
        version: fixture.version,
        integrity: fixture.integrity,
        manifestDigest: fixture.manifestDigest,
        review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
        updatePolicy: 'automatic',
      },
    });

    expect(result).toMatchObject({
      kind: 'reviewRequired',
      review: {
        pluginId: 'acme.npm-candidate',
        packageIdentity: { name: fixture.packageName, version: fixture.version },
        publisherIdentity: { status: 'unverified', id: 'acme', displayName: 'Acme' },
        updateChannel: {
          kind: 'npm',
          packageName: fixture.packageName,
          registryOrigin: 'https://registry.example.test',
          marketplaceSource: {
            id: marketplaceSource.id,
            kind: 'curated',
            sourceUrl: marketplaceSource.sourceUrl,
          },
        },
        integrity: {
          packageDigest: expect.stringMatching(/^sha256:/),
          manifestDigest: fixture.manifestDigest,
          uiArtifactDigest: expect.stringMatching(/^sha256:/),
        },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: {
          status: 'approved',
          sourceId: marketplaceSource.id,
          reviewedAt: '2026-07-21T00:00:00.000Z',
        },
        contributions: [],
        uiArtifacts: { status: 'none', contributionIds: [] },
        compatibility: { happier: '^0.2.0', runtimeApiVersion: 1 },
        updatePolicy: 'automatic',
      },
    });
    if (result.kind !== 'reviewRequired') throw new Error('Expected curated npm Install and trust review');
    await expect(service.decidePluginChange({
      pendingChangeId: result.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'marketplace-install', occurredAtMs: 20 },
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.npm-candidate' });
    expect(prepareRuntime).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledOnce();
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.npm-candidate']).toMatchObject({
      source: { resolvedVersion: fixture.version },
      install: {
        manifestDigest: fixture.manifestDigest,
        updatePolicy: 'automatic',
        trust: {
          distribution: {
            kind: 'npm',
            registryOrigin: 'https://registry.example.test',
            packageName: fixture.packageName,
          },
        },
      },
    });
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('automatically applies an unchanged same-channel npm update and preserves valid optional selections exactly', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-automatic-update-home-'));
    roots.push(happyHomeDir);
    const hostAccess = {
      required: [],
      optional: [{
        id: 'token',
        capability: 'secrets',
        reason: 'Use the selected token',
        scope: { secretIds: ['token'], access: ['read'] },
      }],
    } as const;
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
      hostAccess,
    });
    const updateFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'update'),
      version: '1.2.4',
      hostAccess,
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({
      service,
      fixture: initialFixture,
      source: marketplaceSource,
      optionalSelections: [{ accessId: 'token', selected: true }],
    });
    const before = (await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.npm-candidate']!;

    activeClient = updateFixture.client;
    await expect(requestCuratedUpdate({
      service,
      fixture: updateFixture,
      source: marketplaceSource,
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.npm-candidate',
      desiredGeneration: expect.any(String),
      appliedGeneration: expect.any(String),
    });

    const after = (await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.npm-candidate']!;
    expect(after.source.resolvedVersion).toBe('1.2.4');
    expect(after.install.trust).toEqual(before.install.trust);
    expect(after.install.optionalAccess).toEqual(before.install.optionalAccess);
    expect(after.install.optionalAccess?.[0]?.selectedAtMs).toBe(10);
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('automatically applies an exact trusted daemon-owned update without a marketplace request DTO', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-explicit-update-home-'));
    roots.push(happyHomeDir);
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
    });
    const updateFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'update'),
      version: '1.2.4',
    });
    const marketplaceSource = (
      await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()
    ).sources[0]!;
    const runtimeLifecycle = {
      prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
    };
    const initialService = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle,
        createClient: () => initialFixture.client,
      }),
    });
    await installReviewedCuratedCandidate({
      service: initialService,
      fixture: initialFixture,
      source: marketplaceSource,
    });

    const prepareUpdate = createDaemonNpmPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
      createClient: () => updateFixture.client,
    });
    const updateService = createDaemonPluginChangeService({
      prepare: async (request) => await prepareUpdate(request, {
        installedUpdate: {
          pluginId: 'acme.npm-candidate',
          updatePolicy: 'automatic',
        },
      }),
    });
    await expect(updateService.requestPluginChange({
      kind: 'installNpm',
      packageName: updateFixture.packageName,
      registryOrigin: 'https://registry.example.test',
    })).resolves.toMatchObject({
      kind: 'committed',
      pluginId: 'acme.npm-candidate',
    });
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.npm-candidate']).toMatchObject({
        source: { resolvedVersion: '1.2.4' },
        install: { updatePolicy: 'automatic' },
      });
  });

  it('drops a removed optional selection while preserving still-valid selections during an automatic update', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-optional-contraction-home-'));
    roots.push(happyHomeDir);
    const retainedAccess = {
      id: 'token',
      capability: 'secrets',
      reason: 'Use the selected token',
      scope: { secretIds: ['token'], access: ['read'] },
    } as const;
    const removedAccess = {
      id: 'retired-token',
      capability: 'secrets',
      reason: 'Use the retired token',
      scope: { secretIds: ['retired-token'], access: ['read'] },
    } as const;
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
      hostAccess: { required: [], optional: [retainedAccess, removedAccess] },
    });
    const updateFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'update'),
      version: '1.2.4',
      hostAccess: { required: [], optional: [retainedAccess] },
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({
      service,
      fixture: initialFixture,
      source: marketplaceSource,
      optionalSelections: [
        { accessId: retainedAccess.id, selected: true },
        { accessId: removedAccess.id, selected: true },
      ],
    });
    const before = (await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.npm-candidate']!;

    activeClient = updateFixture.client;
    await expect(requestCuratedUpdate({
      service,
      fixture: updateFixture,
      source: marketplaceSource,
    })).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.npm-candidate' });

    const afterSelections = (await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.npm-candidate']?.install.optionalAccess;
    expect(afterSelections).toEqual([before.install.optionalAccess?.[0]]);
  });

  it('requires review when the prior installed manifest no longer matches its durable digest', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-prior-manifest-mismatch-home-'));
    roots.push(happyHomeDir);
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
    });
    const updateFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'update'),
      version: '1.2.4',
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({ service, fixture: initialFixture, source: marketplaceSource });
    const installed = (await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.npm-candidate']!;
    const priorManifest = JSON.parse(await readFile(installed.source.manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(installed.source.manifestPath, JSON.stringify({ ...priorManifest, version: '1.2.2' }), 'utf8');

    activeClient = updateFixture.client;
    const result = await requestCuratedUpdate({
      service,
      fixture: updateFixture,
      source: marketplaceSource,
    });
    expect(result).toMatchObject({ kind: 'reviewRequired' });
    if (result.kind !== 'reviewRequired') throw new Error('Expected unverifiable prior-manifest review');
    await service.decidePluginChange({ pendingChangeId: result.pendingChangeId, decision: 'cancel' });
  });

  it('requires review when a same-channel automatic update widens required or optional access', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-access-update-home-'));
    roots.push(happyHomeDir);
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
      hostAccess: {
        required: [{
          id: 'sessions',
          capability: 'sessions',
          reason: 'Read sessions',
          scope: { access: ['read'] },
        }],
        optional: [{
          id: 'secret',
          capability: 'secrets',
          reason: 'Use an optional secret',
          scope: { secretIds: ['token'], access: ['read'] },
        }],
      },
    });
    const widenedRequiredFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'required-update'),
      version: '1.2.4',
      hostAccess: {
        required: [{
          id: 'sessions',
          capability: 'sessions',
          reason: 'Read and write sessions',
          scope: { access: ['read', 'write'] },
        }],
        optional: [{
          id: 'secret',
          capability: 'secrets',
          reason: 'Use an optional secret',
          scope: { secretIds: ['token'], access: ['read'] },
        }],
      },
    });
    const changedOptionalFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'changed-optional-update'),
      version: '1.2.5',
      hostAccess: {
        required: [{
          id: 'sessions',
          capability: 'sessions',
          reason: 'Read sessions',
          scope: { access: ['read'] },
        }],
        optional: [{
          id: 'secret',
          capability: 'secrets',
          reason: 'Use an optional secret',
          scope: { secretIds: ['token', 'other-token'], access: ['read'] },
        }],
      },
    });
    const newOptionalFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'optional-update'),
      version: '1.2.6',
      hostAccess: {
        required: [{
          id: 'sessions',
          capability: 'sessions',
          reason: 'Read sessions',
          scope: { access: ['read'] },
        }],
        optional: [{
          id: 'secret',
          capability: 'secrets',
          reason: 'Use an optional secret',
          scope: { secretIds: ['token'], access: ['read'] },
        }, {
          id: 'another-secret',
          capability: 'secrets',
          reason: 'Use another optional secret',
          scope: { secretIds: ['other-token'], access: ['read'] },
        }],
      },
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({ service, fixture: initialFixture, source: marketplaceSource });

    activeClient = widenedRequiredFixture.client;
    const requiredResult = await requestCuratedUpdate({
      service,
      fixture: widenedRequiredFixture,
      source: marketplaceSource,
    });
    expect(requiredResult).toMatchObject({ kind: 'reviewRequired' });
    if (requiredResult.kind !== 'reviewRequired') throw new Error('Expected widened required-access review');
    await service.decidePluginChange({ pendingChangeId: requiredResult.pendingChangeId, decision: 'cancel' });

    activeClient = changedOptionalFixture.client;
    const changedOptionalResult = await requestCuratedUpdate({
      service,
      fixture: changedOptionalFixture,
      source: marketplaceSource,
    });
    expect(changedOptionalResult).toMatchObject({ kind: 'reviewRequired' });
    if (changedOptionalResult.kind !== 'reviewRequired') throw new Error('Expected changed optional-access review');
    await service.decidePluginChange({
      pendingChangeId: changedOptionalResult.pendingChangeId,
      decision: 'cancel',
    });

    activeClient = newOptionalFixture.client;
    const optionalResult = await requestCuratedUpdate({
      service,
      fixture: newOptionalFixture,
      source: marketplaceSource,
    });
    expect(optionalResult).toMatchObject({ kind: 'reviewRequired' });
    if (optionalResult.kind !== 'reviewRequired') throw new Error('Expected new optional-access review');
    await service.decidePluginChange({ pendingChangeId: optionalResult.pendingChangeId, decision: 'cancel' });
  });

  it('requires review for npm channel or publisher-package substitution and manual policy', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-substitution-update-home-'));
    roots.push(happyHomeDir);
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
    });
    const channelFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'channel-update'),
      version: '1.2.4',
      tarballUrl: 'https://other-registry.example.test/@acme/npm-candidate/-/candidate-1.2.4.tgz',
    });
    const publisherFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'publisher-update'),
      packageName: '@other-publisher/npm-candidate',
      version: '1.2.4',
    });
    const manualFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'manual-update'),
      version: '1.2.4',
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({ service, fixture: initialFixture, source: marketplaceSource });

    activeClient = channelFixture.client;
    const channelResult = await requestCuratedUpdate({
      service,
      fixture: channelFixture,
      source: marketplaceSource,
      registryOrigin: 'https://other-registry.example.test',
      listingOverrides: { registryOrigin: 'https://other-registry.example.test' },
    });
    expect(channelResult).toMatchObject({ kind: 'reviewRequired' });
    if (channelResult.kind !== 'reviewRequired') throw new Error('Expected channel-substitution review');
    await service.decidePluginChange({ pendingChangeId: channelResult.pendingChangeId, decision: 'cancel' });

    activeClient = publisherFixture.client;
    const publisherResult = await requestCuratedUpdate({
      service,
      fixture: publisherFixture,
      source: marketplaceSource,
      listingOverrides: { publisher: { id: 'other-publisher', displayName: 'Other Publisher' } },
    });
    expect(publisherResult).toMatchObject({ kind: 'reviewRequired' });
    if (publisherResult.kind !== 'reviewRequired') throw new Error('Expected publisher-package substitution review');
    await service.decidePluginChange({ pendingChangeId: publisherResult.pendingChangeId, decision: 'cancel' });

    activeClient = manualFixture.client;
    const manualResult = await requestCuratedUpdate({
      service,
      fixture: manualFixture,
      source: marketplaceSource,
      listingOverrides: { updatePolicy: 'manual' },
    });
    expect(manualResult).toMatchObject({ kind: 'reviewRequired' });
    if (manualResult.kind !== 'reviewRequired') throw new Error('Expected manual-policy update review');
    await service.decidePluginChange({ pendingChangeId: manualResult.pendingChangeId, decision: 'cancel' });
  });

  it('requires review when an automatic update expands executable realms or declared integrations', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-integration-update-home-'));
    roots.push(happyHomeDir);
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
      entrypoints: {},
    });
    const realmFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'realm-update'),
      version: '1.2.4',
    });
    const integrationFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'integration-update'),
      version: '1.2.5',
      entrypoints: {},
      contributes: {
        browserTargets: [{
          id: 'docs',
          title: 'Docs',
          url: 'https://example.test/docs',
        }],
      },
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({ service, fixture: initialFixture, source: marketplaceSource });

    activeClient = realmFixture.client;
    const realmResult = await requestCuratedUpdate({
      service,
      fixture: realmFixture,
      source: marketplaceSource,
    });
    expect(realmResult).toMatchObject({ kind: 'reviewRequired' });
    if (realmResult.kind !== 'reviewRequired') throw new Error('Expected executable-realm expansion review');
    await service.decidePluginChange({ pendingChangeId: realmResult.pendingChangeId, decision: 'cancel' });

    activeClient = integrationFixture.client;
    const integrationResult = await requestCuratedUpdate({
      service,
      fixture: integrationFixture,
      source: marketplaceSource,
    });
    expect(integrationResult).toMatchObject({ kind: 'reviewRequired' });
    if (integrationResult.kind !== 'reviewRequired') throw new Error('Expected declared-integration expansion review');
    await service.decidePluginChange({ pendingChangeId: integrationResult.pendingChangeId, decision: 'cancel' });
  });

  it('keeps the prior generation active when an automatic update fails runtime preparation', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-failed-automatic-update-home-'));
    roots.push(happyHomeDir);
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
    });
    const updateFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'update'),
      version: '1.2.4',
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    let failRuntimePreparation = false;
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => {
            if (failRuntimePreparation) throw new Error('candidate activation failed');
            return { abort: async () => undefined, adopt: async () => undefined };
          },
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({ service, fixture: initialFixture, source: marketplaceSource });
    const before = await createPluginRegistryStateStore({ happyHomeDir }).read();

    activeClient = updateFixture.client;
    failRuntimePreparation = true;
    await expect(requestCuratedUpdate({
      service,
      fixture: updateFixture,
      source: marketplaceSource,
    })).resolves.toMatchObject({ kind: 'failed' });

    expect(await createPluginRegistryStateStore({ happyHomeDir }).read()).toEqual(before);
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('returns busy for a concurrent duplicate automatic update and applies the candidate once', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-concurrent-update-home-'));
    roots.push(happyHomeDir);
    const initialFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'initial'),
      version: '1.2.3',
    });
    const updateFixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'update'),
      version: '1.2.4',
    });
    const marketplaceSource = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources[0]!;
    let activeClient = initialFixture.client;
    let blockRuntimePreparation = false;
    let releaseRuntimePreparation!: () => void;
    let reportRuntimePreparationStarted!: () => void;
    const runtimePreparationRelease = new Promise<void>((resolve) => {
      releaseRuntimePreparation = resolve;
    });
    const runtimePreparationStarted = new Promise<void>((resolve) => {
      reportRuntimePreparationStarted = resolve;
    });
    const adopt = vi.fn(async () => undefined);
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => {
            if (blockRuntimePreparation) {
              reportRuntimePreparationStarted();
              await runtimePreparationRelease;
            }
            return { abort: async () => undefined, adopt };
          },
        },
        createClient: () => activeClient,
      }),
    });
    await installReviewedCuratedCandidate({ service, fixture: initialFixture, source: marketplaceSource });

    activeClient = updateFixture.client;
    blockRuntimePreparation = true;
    const first = requestCuratedUpdate({ service, fixture: updateFixture, source: marketplaceSource });
    await runtimePreparationStarted;
    const duplicate = await requestCuratedUpdate({
      service,
      fixture: updateFixture,
      source: marketplaceSource,
    });
    expect(duplicate).toEqual({ kind: 'busy', pluginId: 'acme.npm-candidate' });
    releaseRuntimePreparation();
    await expect(first).resolves.toMatchObject({ kind: 'committed', pluginId: 'acme.npm-candidate' });

    expect(adopt).toHaveBeenCalledTimes(2);
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read())
      .plugins['acme.npm-candidate']?.source.resolvedVersion).toBe('1.2.4');
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('rejects approval when the persisted public curated source changes during review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const sourceStore = createMarketplaceSourceRegistryStore({ happyHomeDir });
    const marketplaceSource = (await sourceStore.read()).sources[0]!;
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
        createClient: () => fixture.client,
      }),
    });

    const result = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      selector: fixture.version,
      registryOrigin: 'https://registry.example.test',
      expectedMarketplaceListing: {
        source: {
          id: marketplaceSource.id,
          kind: 'curated',
          sourceUrl: marketplaceSource.sourceUrl,
        },
        pluginId: 'acme.npm-candidate',
        publisher: { id: 'acme', displayName: 'Acme' },
        packageName: fixture.packageName,
        registryOrigin: 'https://registry.example.test',
        version: fixture.version,
        integrity: fixture.integrity,
        manifestDigest: fixture.manifestDigest,
        review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
        updatePolicy: 'automatic',
      },
    });
    if (result.kind !== 'reviewRequired') throw new Error('Expected curated npm Install and trust review');

    await sourceStore.setSourceEnabled(marketplaceSource.id, false);
    await expect(service.decidePluginChange({
      pendingChangeId: result.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'marketplace-source-changed',
        occurredAtMs: 20,
      },
    })).resolves.toEqual({ kind: 'conflict', pluginId: 'acme.npm-candidate' });

    expect(prepareRuntime).not.toHaveBeenCalled();
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.npm-candidate']).toBeUndefined();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('rejects a nonexistent public curated source before registry access', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const createClient = vi.fn(() => fixture.client);
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const prepare = createDaemonNpmPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: { prepare: prepareRuntime },
      createClient,
    });

    await expect(prepare({
      kind: 'installNpm',
      packageName: fixture.packageName,
      selector: fixture.version,
      registryOrigin: 'https://registry.example.test',
      expectedMarketplaceListing: {
        source: {
          id: 'marketplace:missing-curated-source',
          kind: 'curated',
          sourceUrl: 'https://marketplace.example.test/missing-catalog.json',
        },
        pluginId: 'acme.npm-candidate',
        publisher: { id: 'acme', displayName: 'Acme' },
        packageName: fixture.packageName,
        registryOrigin: 'https://registry.example.test',
        version: fixture.version,
        integrity: fixture.integrity,
        manifestDigest: fixture.manifestDigest,
        review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
        updatePolicy: 'automatic',
      },
    })).rejects.toMatchObject({ code: 'source_changed' });

    expect(createClient).not.toHaveBeenCalled();
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('uses the exact persisted private profile id through the shared npm resolver and currentness path', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-private-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const profiles = createNpmRegistryProfileService({
      happyHomeDir,
      probe: async () => ({ status: 'available' }),
    });
    await profiles.mutate({
      action: 'add', machineId: 'machine-1', expectedRevision: 0, mutationId: 'mutation-add-private',
      profileId: 'registry_private',
      profile: {
        displayName: 'Private', origin: 'https://registry.example.test', scopes: ['@acme'],
        useAsDefault: false, allowPrivateNetwork: false,
      },
    });
    await profiles.mutate({
      action: 'login', machineId: 'machine-1', expectedRevision: 1, mutationId: 'mutation-login-private',
      profileId: 'registry_private', credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    });
    await profiles.mutate({
      action: 'test', machineId: 'machine-1', expectedRevision: 2, mutationId: 'mutation-test-private',
      profileId: 'registry_private',
    });
    const sourceStore = createMarketplaceSourceRegistryStore({ happyHomeDir });
    const seededSource = (await sourceStore.read()).sources[0]!;
    const marketplaceSource = await sourceStore.upsertSource({
      sourceUrl: seededSource.sourceUrl,
      registryProfileId: 'registry_private',
    });
    const createClient = vi.fn((options: Readonly<{
      registryOrigin: string;
      authorizationHeader?: string;
      allowPrivateNetwork?: boolean;
    }>) => {
      expect(options).toMatchObject({ authorizationHeader: 'Bearer boundary-secret' });
      return fixture.client;
    });
    const prepare = createDaemonNpmPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) },
      npmRegistryProfiles: profiles,
      createClient,
    });
    const request = {
      kind: 'installNpm',
      packageName: fixture.packageName,
      selector: fixture.version,
      registryOrigin: 'https://registry.example.test',
      registryProfileId: 'registry_private',
      expectedMarketplaceListing: {
        source: { id: marketplaceSource.id, kind: 'curated', sourceUrl: marketplaceSource.sourceUrl },
        pluginId: 'acme.npm-candidate',
        publisher: { id: 'acme', displayName: 'Acme' },
        packageName: fixture.packageName,
        registryOrigin: 'https://registry.example.test',
        registryProfileId: 'registry_private',
        version: fixture.version,
        integrity: fixture.integrity,
        manifestDigest: fixture.manifestDigest,
        review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
        updatePolicy: 'automatic',
      },
    } as const;

    const prepared = await prepare(request);
    if (!prepared.review) throw new Error('Expected private npm installation review');
    expect(prepared.review.updateChannel).toEqual({
      kind: 'npm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
      registryProfileId: 'registry_private',
      marketplaceSource: {
        id: marketplaceSource.id,
        kind: 'curated',
        sourceUrl: marketplaceSource.sourceUrl,
      },
    });
    await expect(prepared.apply({
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'private-marketplace', occurredAtMs: 20 },
      optionalSelections: [],
    })).resolves.toMatchObject({ kind: 'committed' });
    const installedBeforeLogout = await createPluginRegistryStateStore({ happyHomeDir }).read();
    expect(createClient).toHaveBeenCalledOnce();
    expect(installedBeforeLogout.plugins['acme.npm-candidate']?.install.trust?.distribution).toEqual({
      kind: 'npm',
      registryOrigin: 'https://registry.example.test',
      registryProfileId: 'registry_private',
      packageName: fixture.packageName,
    });
    expect(JSON.stringify(installedBeforeLogout.plugins['acme.npm-candidate'])).not.toContain('boundary-secret');

    await sourceStore.upsertSource({ sourceUrl: marketplaceSource.sourceUrl, registryProfileId: 'registry_other' });
    await expect(prepare(request)).rejects.toMatchObject({ code: 'source_changed' });
    await sourceStore.upsertSource({ sourceUrl: marketplaceSource.sourceUrl, registryProfileId: 'registry_private' });

    await profiles.mutate({
      action: 'logout', machineId: 'machine-1', expectedRevision: 3, mutationId: 'mutation-logout-private',
      profileId: 'registry_private',
    });
    await expect(prepare(request)).rejects.toMatchObject({ code: 'authentication_required' });
    expect(createClient).toHaveBeenCalledOnce();
    await expect(createPluginRegistryStateStore({ happyHomeDir }).read()).resolves.toEqual(installedBeforeLogout);
  });

  it('binds an implicitly resolved registry profile and rejects approval after that profile mapping rebounds', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-inferred-private-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const profiles = createNpmRegistryProfileService({
      happyHomeDir,
      probe: async () => ({ status: 'available' }),
    });
    await profiles.mutate({
      action: 'add',
      machineId: 'machine-1',
      expectedRevision: 0,
      mutationId: 'mutation-add-inferred-private-a',
      profileId: 'registry_private_a',
      profile: {
        displayName: 'Private A',
        origin: 'https://registry.example.test',
        scopes: ['@acme'],
        useAsDefault: false,
        allowPrivateNetwork: false,
      },
    });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
        },
        npmRegistryProfiles: profiles,
        createClient: () => fixture.client,
      }),
    });

    const requested = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      selector: fixture.version,
    });
    expect(requested).toMatchObject({
      kind: 'reviewRequired',
      review: {
        updateChannel: {
          kind: 'npm',
          registryProfileId: 'registry_private_a',
        },
      },
    });
    if (requested.kind !== 'reviewRequired') throw new Error('Expected inferred-profile installation review');

    await profiles.mutate({
      action: 'remove',
      machineId: 'machine-1',
      expectedRevision: 1,
      mutationId: 'mutation-remove-inferred-private-a',
      profileId: 'registry_private_a',
    });
    await profiles.mutate({
      action: 'add',
      machineId: 'machine-1',
      expectedRevision: 2,
      mutationId: 'mutation-add-inferred-private-b',
      profileId: 'registry_private_b',
      profile: {
        displayName: 'Private B',
        origin: 'https://registry.example.test',
        scopes: ['@acme'],
        useAsDefault: false,
        allowPrivateNetwork: false,
      },
    });

    await expect(service.decidePluginChange({
      pendingChangeId: requested.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: 'inferred-private-install',
        occurredAtMs: 30,
      },
    })).resolves.toEqual({
      kind: 'conflict',
      pluginId: 'acme.npm-candidate',
    });
    expect(
      (await createPluginRegistryStateStore({ happyHomeDir }).read())
        .plugins['acme.npm-candidate'],
    ).toBeUndefined();
  });

  it.each([
    ['package name', { packageName: '@acme/not-the-listing' }],
    ['version', { version: '1.2.4' }],
    ['integrity', { integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` }],
    ['manifest digest', { manifestDigest: `sha256:${'b'.repeat(64)}` }],
    ['plugin id', { pluginId: 'acme.not-the-listing' }],
  ] as const)('rejects a curated marketplace candidate with mismatched %s before runtime preparation', async (_label, override) => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const marketplaceSource = (
      await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()
    ).sources[0]!;
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const prepare = createDaemonNpmPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: { prepare: prepareRuntime },
      createClient: () => fixture.client,
    });

    await expect(prepare({
      kind: 'installNpm',
      packageName: fixture.packageName,
      selector: fixture.version,
      registryOrigin: 'https://registry.example.test',
      expectedMarketplaceListing: {
        source: {
          id: marketplaceSource.id,
          kind: 'curated',
          sourceUrl: marketplaceSource.sourceUrl,
        },
        pluginId: 'acme.npm-candidate',
        publisher: { id: 'acme', displayName: 'Acme' },
        packageName: fixture.packageName,
        registryOrigin: 'https://registry.example.test',
        version: fixture.version,
        integrity: fixture.integrity,
        manifestDigest: fixture.manifestDigest,
        review: { status: 'approved', reviewedAt: '2026-07-21T00:00:00.000Z' },
        updatePolicy: 'automatic',
        ...override,
      },
    })).rejects.toThrow(/marketplace listing/i);

    expect(prepareRuntime).not.toHaveBeenCalled();
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.npm-candidate']).toBeUndefined();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('reviews an exact npm candidate before committing it through the supplied daemon runtime lifecycle', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const markerPath = join(happyHomeDir, 'lifecycle-script-ran');
    const fixture = await createNpmPackageFixture({ markerPath });
    const adopt = vi.fn(async () => undefined);
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt }));
    const createClient = vi.fn(() => fixture.client);
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
        createClient,
      }),
      createPendingChangeId: () => 'pending-npm-candidate',
    });

    const begun = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    });

    expect(begun).toEqual(expect.objectContaining({
      kind: 'reviewRequired',
      review: expect.objectContaining({
        pluginId: 'acme.npm-candidate',
        version: fixture.version,
        source: expect.objectContaining({ kind: 'npm', integrity: fixture.integrity }),
        executableRealms: ['daemon'],
      }),
    }));
    expect(prepareRuntime).not.toHaveBeenCalled();
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${markerPath}.lifecycle`)).rejects.toMatchObject({ code: 'ENOENT' });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected npm installation review');

    const committed = await service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'npm-review', occurredAtMs: 10 },
    });
    expect(committed).toEqual(expect.objectContaining({
      kind: 'committed',
      pluginId: 'acme.npm-candidate',
      desiredGeneration: expect.any(String),
      appliedGeneration: expect.any(String),
    }));
    if (committed.kind !== 'committed') throw new Error('Expected npm candidate commit');
    expect(committed.appliedGeneration).toBe(committed.desiredGeneration);

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      registryOrigin: 'https://registry.example.test',
    }));
    expect(prepareRuntime).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledTimes(1);
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${markerPath}.lifecycle`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await candidateRoots(happyHomeDir)).toEqual([]);

    const installed = (await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.npm-candidate'];
    expect(installed).toMatchObject({
      source: {
        kind: 'package',
        locator: fixture.packageName,
        resolvedVersion: fixture.version,
      },
      install: {
        mode: 'managed_install',
        trust: {
          distribution: {
            kind: 'npm',
            registryOrigin: 'https://registry.example.test',
            packageName: fixture.packageName,
          },
        },
      },
    });
    const installedPackage = JSON.parse(await readFile(join(installed!.install.installedPath!, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(installedPackage.dependencies).toEqual({ 'ordinary-runtime-dependency': '^1.0.0' });
    await expect(readFile(join(installed!.install.installedPath!, 'dist', 'runtimeDependency.mjs'), 'utf8'))
      .resolves.toContain('bundledDependency = true');
  });

  it('reports outcomeUnknown when an npm generation may be durable but adoption cannot be confirmed', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: {
          prepare: async () => ({
            abort: async () => undefined,
            adopt: async () => {
              throw new Error('serving swap failed');
            },
          }),
        },
        createClient: () => fixture.client,
      }),
      createPendingChangeId: () => 'pending-npm-adoption',
    });
    const begun = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected npm installation review');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'npm-adoption', occurredAtMs: 11 },
    })).resolves.toMatchObject({
      kind: 'outcomeUnknown',
      pluginId: 'acme.npm-candidate',
      expectedCandidate: expect.any(String),
    });
  });

  it('rejects staged-byte substitution after review without invoking the runtime or publishing currentness', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: prepareRuntime },
        createClient: () => fixture.client,
      }),
      createPendingChangeId: () => 'pending-tamper',
    });
    const begun = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected npm installation review');
    const rootsBeforeDecision = await candidateRoots(happyHomeDir);
    expect(rootsBeforeDecision).toHaveLength(1);
    await writeFile(await findFile(rootsBeforeDecision[0]!, 'payload.txt'), 'substituted bytes');

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'tampered-review', occurredAtMs: 11 },
    })).resolves.toEqual({ kind: 'conflict', pluginId: 'acme.npm-candidate' });

    expect(prepareRuntime).not.toHaveBeenCalled();
    expect((await createPluginRegistryStateStore({ happyHomeDir }).read()).plugins['acme.npm-candidate']).toBeUndefined();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('rejects when the same installed plugin changes after npm review', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const runtimeLifecycle = {
      prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }),
    };
    const prepare = createDaemonNpmPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle,
      createClient: () => fixture.client,
    });
    const service = createDaemonPluginChangeService({ prepare });
    const initial = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    });
    if (initial.kind !== 'reviewRequired') throw new Error('Expected initial npm review');
    await service.decidePluginChange({
      pendingChangeId: initial.pendingChangeId,
      decision: 'installAndTrust',
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'initial', occurredAtMs: 1 },
    });

    const prepared = await prepare({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    });
    const takeoverStore = createPluginRegistryStateStore({ happyHomeDir, runtimeLifecycle });
    await takeoverStore.update((state) => ({
      ...state,
      plugins: {
        ...state.plugins,
        'acme.npm-candidate': {
          ...state.plugins['acme.npm-candidate']!,
          state: { ...state.plugins['acme.npm-candidate']!.state, enabled: false },
        },
      },
    }));

    await expect(prepared.apply({
      actorEvidence: { kind: 'authenticatedLocalUser', interactionId: 'replacement', occurredAtMs: 2 },
      optionalSelections: [],
    })).resolves.toEqual({ kind: 'conflict', pluginId: 'acme.npm-candidate' });
    await prepared.cleanup();
  });

  it('cleans daemon-owned temporary bytes when staging rejects the package contract', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({
      markerPath: join(happyHomeDir, 'never'),
      packageJsonName: '@acme/substituted-package',
    });
    const prepareRuntime = vi.fn(async () => ({ abort: async () => undefined, adopt: async () => undefined }));
    const prepare = createDaemonNpmPluginChangePreparer({
      happyHomeDir,
      runtimeLifecycle: { prepare: prepareRuntime },
      createClient: () => fixture.client,
    });

    await expect(prepare({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    })).rejects.toThrow(/package_identity_mismatch/);

    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(await candidateRoots(happyHomeDir)).toEqual([]);
  });

  it('cleans a reviewed candidate once when the user cancels', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-change-home-'));
    roots.push(happyHomeDir);
    const fixture = await createNpmPackageFixture({ markerPath: join(happyHomeDir, 'never') });
    const service = createDaemonPluginChangeService({
      prepare: createDaemonNpmPluginChangePreparer({
        happyHomeDir,
        runtimeLifecycle: { prepare: async () => ({ abort: async () => undefined, adopt: async () => undefined }) },
        createClient: () => fixture.client,
      }),
      createPendingChangeId: () => 'pending-cancel',
    });
    const begun = await service.requestPluginChange({
      kind: 'installNpm',
      packageName: fixture.packageName,
      registryOrigin: 'https://registry.example.test',
    });
    if (begun.kind !== 'reviewRequired') throw new Error('Expected npm installation review');
    expect(await candidateRoots(happyHomeDir)).toHaveLength(1);

    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'cancel',
    })).resolves.toEqual({ kind: 'cancelled' });

    expect(await candidateRoots(happyHomeDir)).toEqual([]);
    await expect(service.decidePluginChange({
      pendingChangeId: begun.pendingChangeId,
      decision: 'cancel',
    })).resolves.toEqual({ kind: 'expired' });
  });
});

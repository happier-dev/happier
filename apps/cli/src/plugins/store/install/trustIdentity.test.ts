import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArchivePluginDistributionIdentity,
  createPluginCuratedUpdateSourceBinding,
  createLocalPathPluginDistributionIdentity,
  createNpmPluginDistributionIdentity,
  createPluginTrustRecord,
  isPluginTrustRecordAuthorized,
  PluginCuratedUpdateSourceBindingSchema,
  PluginTrustRecordSchema,
  pluginDistributionIdentitiesEqual,
  pluginDistributionRollbackLineagesEqual,
} from './trustIdentity';

const temporaryDirectories: string[] = [];
const archiveIntegrityA = `sha256-${Buffer.alloc(32, 0x61).toString('base64')}`;
const archiveIntegrityB = `sha256-${Buffer.alloc(32, 0x62).toString('base64')}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('whole-plugin installation trust identity', () => {
  it('retains curated automatic-update authority as canonical source facts, not publisher metadata', () => {
    const binding = createPluginCuratedUpdateSourceBinding({
      id: 'marketplace:curated',
      sourceUrl: 'HTTPS://marketplace.example.test:443/catalog.json',
      registryProfileId: 'registry_private',
    });

    expect(binding).toEqual({
      id: 'marketplace:curated',
      sourceUrl: 'https://marketplace.example.test/catalog.json',
      registryProfileId: 'registry_private',
    });
    expect(PluginCuratedUpdateSourceBindingSchema.safeParse({
      ...binding,
      publisher: { id: 'publisher:untrusted' },
    }).success).toBe(false);
  });

  it('binds npm trust to plugin id, registry origin, exact registry profile, and package name but not update policy', () => {
    const distribution = createNpmPluginDistributionIdentity({
      registryOrigin: 'https://registry.example.test/',
      registryProfileId: 'registry_private',
      packageName: '  @acme/plugin  ',
    });
    const trust = createPluginTrustRecord({ pluginId: 'acme.plugin', distribution, approvedAtMs: 17 });

    expect(distribution).toEqual({
      kind: 'npm',
      registryOrigin: 'https://registry.example.test',
      registryProfileId: 'registry_private',
      packageName: '@acme/plugin',
    });
    expect(isPluginTrustRecordAuthorized(trust, { pluginId: 'acme.plugin', distribution })).toBe(true);
    expect(isPluginTrustRecordAuthorized(trust, {
      pluginId: 'acme.other',
      distribution,
    })).toBe(false);
    expect(isPluginTrustRecordAuthorized(trust, {
      pluginId: 'acme.plugin',
      distribution: createNpmPluginDistributionIdentity({
        registryOrigin: 'https://other-registry.example.test',
        packageName: '@acme/plugin',
      }),
    })).toBe(false);
    expect(isPluginTrustRecordAuthorized(trust, {
      pluginId: 'acme.plugin',
      distribution: createNpmPluginDistributionIdentity({
        registryOrigin: 'https://registry.example.test',
        registryProfileId: 'registry_other',
        packageName: '@acme/plugin',
      }),
    })).toBe(false);
    expect(isPluginTrustRecordAuthorized(trust, {
      pluginId: 'acme.plugin',
      distribution: createNpmPluginDistributionIdentity({
        registryOrigin: 'https://registry.example.test',
        registryProfileId: 'registry_private',
        packageName: '@acme/other',
      }),
    })).toBe(false);

    const automatic = { trust, updatePolicy: 'automatic' as const };
    const pinned = { trust, updatePolicy: 'pinned' as const };
    expect(automatic.trust).toEqual(pinned.trust);
  });

  it('binds local trust to the canonical filesystem path and covers every executable realm once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-plugin-trust-identity-'));
    temporaryDirectories.push(directory);
    const distribution = await createLocalPathPluginDistributionIdentity(directory);
    const trust = createPluginTrustRecord({ pluginId: 'acme.plugin', distribution, approvedAtMs: 23 });

    expect(distribution).toEqual({ kind: 'localPath', canonicalPath: await realpath(directory) });
    for (const realm of ['daemon', 'reactNative', 'reactNativeWeb', 'hostedWeb', 'declarative'] as const) {
      expect(isPluginTrustRecordAuthorized(trust, { pluginId: 'acme.plugin', distribution, realm })).toBe(true);
    }
  });

  it('uses the canonical home-expansion owner for both separator spellings', async () => {
    const expected = { kind: 'localPath', canonicalPath: await realpath(homedir()) };
    await expect(createLocalPathPluginDistributionIdentity('~/')).resolves.toEqual(expected);
    await expect(createLocalPathPluginDistributionIdentity('~\\')).resolves.toEqual(expected);
  });

  it('compares canonical Windows distribution paths case-insensitively without folding POSIX or sibling paths', () => {
    const windowsPath = {
      kind: 'localPath' as const,
      canonicalPath: 'C:\\Users\\Alice\\plugins\\acme',
    };
    const windowsCaseVariant = {
      kind: 'localPath' as const,
      canonicalPath: 'c:\\users\\alice\\PLUGINS\\ACME',
    };
    const windowsSibling = {
      kind: 'localPath' as const,
      canonicalPath: 'C:\\Users\\Alice\\plugins\\acme2',
    };
    const posixPath = {
      kind: 'localPath' as const,
      canonicalPath: '/Users/Alice/plugins/acme',
    };
    const posixCaseVariant = {
      kind: 'localPath' as const,
      canonicalPath: '/users/alice/plugins/acme',
    };

    expect(PluginTrustRecordSchema.safeParse({
      pluginId: 'acme.plugin',
      distribution: windowsPath,
      state: 'trusted',
      approvedAtMs: 1,
    }).success).toBe(true);
    expect(pluginDistributionIdentitiesEqual(windowsPath, windowsCaseVariant)).toBe(true);
    expect(pluginDistributionRollbackLineagesEqual(windowsPath, windowsCaseVariant)).toBe(true);
    expect(pluginDistributionIdentitiesEqual(windowsPath, windowsSibling)).toBe(false);
    expect(pluginDistributionIdentitiesEqual(posixPath, posixCaseVariant)).toBe(false);

    const windowsArchive = {
      kind: 'archive' as const,
      source: { kind: 'localFile' as const, canonicalPath: windowsPath.canonicalPath },
      integrity: archiveIntegrityA,
    };
    const windowsArchiveCaseVariant = {
      kind: 'archive' as const,
      source: { kind: 'localFile' as const, canonicalPath: windowsCaseVariant.canonicalPath },
      integrity: archiveIntegrityA,
    };
    expect(pluginDistributionIdentitiesEqual(windowsArchive, windowsArchiveCaseVariant)).toBe(true);
    expect(pluginDistributionRollbackLineagesEqual(windowsArchive, windowsArchiveCaseVariant)).toBe(true);
  });

  it('binds archive trust to canonical source and algorithm-qualified integrity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-plugin-archive-trust-'));
    const otherDirectory = await mkdtemp(join(tmpdir(), 'happier-plugin-other-archive-trust-'));
    temporaryDirectories.push(directory, otherDirectory);
    const local = await createArchivePluginDistributionIdentity({
      source: { kind: 'localFile', path: directory },
      integrity: archiveIntegrityA,
    });
    const remote = await createArchivePluginDistributionIdentity({
      source: { kind: 'remoteUrl', url: 'HTTPS://EXAMPLE.TEST:443/plugins/acme.tgz' },
      integrity: archiveIntegrityA,
    });

    expect(local).toEqual({
      kind: 'archive',
      source: { kind: 'localFile', canonicalPath: await realpath(directory) },
      integrity: archiveIntegrityA,
    });
    expect(remote).toEqual({
      kind: 'archive',
      source: { kind: 'remoteUrl', canonicalUrl: 'https://example.test/plugins/acme.tgz' },
      integrity: archiveIntegrityA,
    });
    const substitutedIntegrity = await createArchivePluginDistributionIdentity({
      source: { kind: 'localFile', path: directory },
      integrity: archiveIntegrityB,
    });
    const substitutedSource = await createArchivePluginDistributionIdentity({
      source: { kind: 'localFile', path: otherDirectory },
      integrity: archiveIntegrityB,
    });
    expect(pluginDistributionIdentitiesEqual(local, substitutedIntegrity)).toBe(false);
    expect(pluginDistributionRollbackLineagesEqual(local, substitutedIntegrity)).toBe(true);
    expect(pluginDistributionRollbackLineagesEqual(local, substitutedSource)).toBe(false);
    expect(pluginDistributionRollbackLineagesEqual(local, remote)).toBe(false);
    await expect(createArchivePluginDistributionIdentity({
      source: { kind: 'remoteUrl', url: 'https://example.test/plugins/acme.tgz' },
      integrity: 'YWJj',
    })).rejects.toThrow(/integrity/i);
  });

  it('fails closed for malformed or missing trust records', () => {
    const distribution = createNpmPluginDistributionIdentity({
      registryOrigin: 'https://registry.example.test',
      packageName: 'acme-plugin',
    });
    expect(isPluginTrustRecordAuthorized(null, { pluginId: 'acme.plugin', distribution })).toBe(false);
    expect(isPluginTrustRecordAuthorized({
      pluginId: 'acme.plugin', distribution, state: 'trusted', approvedAtMs: -1,
    }, { pluginId: 'acme.plugin', distribution })).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      pluginId: 'acme.plugin',
      distribution: { kind: 'npm', registryOrigin: 'https://registry.example.test/', packageName: 'acme-plugin' },
      state: 'trusted', approvedAtMs: 1,
    }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      pluginId: 'acme.plugin',
      distribution: { kind: 'localPath', canonicalPath: 'relative/plugin' },
      state: 'trusted', approvedAtMs: 1,
    }).success).toBe(false);
  });

  it('rejects non-canonical persisted identities, unsafe timestamps, and malformed archive integrity', () => {
    const base = {
      pluginId: 'acme.plugin',
      distribution: { kind: 'localPath' as const, canonicalPath: '/plugins/acme' },
      state: 'trusted' as const,
      approvedAtMs: 1,
    };

    expect(PluginTrustRecordSchema.safeParse({ ...base, pluginId: ' acme.plugin ' }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({ ...base, approvedAtMs: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      ...base,
      distribution: { kind: 'localPath', canonicalPath: '/plugins/../plugins/acme' },
    }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      ...base,
      distribution: { kind: 'localPath', canonicalPath: '/plugins/acme/' },
    }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      ...base,
      distribution: { kind: 'localPath', canonicalPath: 'C:\\Users/alice\\plugin' },
    }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      ...base,
      distribution: {
        kind: 'archive',
        source: { kind: 'remoteUrl', canonicalUrl: 'https://example.test/acme.tgz' },
        integrity: 'sha256-A',
      },
    }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      ...base,
      distribution: {
        kind: 'archive',
        source: { kind: 'remoteUrl', canonicalUrl: 'https://example.test/acme.tgz' },
        integrity: 'sha256-YWJj',
      },
    }).success).toBe(false);
    expect(PluginTrustRecordSchema.safeParse({
      ...base,
      distribution: {
        kind: 'archive',
        source: { kind: 'remoteUrl', canonicalUrl: 'https://example.test/acme.tgz' },
        integrity: 'md5-YWJj',
      },
    }).success).toBe(false);
  });

  it('does not authorize a non-canonical candidate plugin identity', () => {
    const distribution = createNpmPluginDistributionIdentity({
      registryOrigin: 'https://registry.example.test',
      packageName: 'acme-plugin',
    });
    const trust = createPluginTrustRecord({ pluginId: 'acme.plugin', distribution, approvedAtMs: 1 });
    expect(isPluginTrustRecordAuthorized(trust, { pluginId: ' acme.plugin ', distribution })).toBe(false);
  });
});

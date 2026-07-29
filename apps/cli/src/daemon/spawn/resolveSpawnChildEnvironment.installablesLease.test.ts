import { describe, expect, it, vi } from 'vitest';

import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol/installables';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { resolveSpawnHookInstallablesRegistry } from './spawnHookInstallablesRegistry';

describe('resolveSpawnHookInstallablesRegistry', () => {
  it('fails closed instead of resolving a parallel contribution registry without an applied snapshot', async () => {
    const resolveMergedContributionRegistry = vi.fn(async () => ({
      managedDependencies: Object.freeze([]),
    }) as unknown as ResolvedContributionRegistry);

    const registry = await resolveSpawnHookInstallablesRegistry('/happy-home', {
      resolveMergedContributionRegistry,
    });

    expect(registry).toBeUndefined();
    expect(resolveMergedContributionRegistry).not.toHaveBeenCalled();
  });

  it('projects installable descriptors from the applied spawn snapshot instead of a stale parallel resolver', async () => {
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: 'antigravity-localharness',
      key: 'antigravity-localharness',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.antigravity-localharness',
      display: {
        name: 'Antigravity Localharness',
      },
      description: 'Managed localharness runtime contributed by a plugin',
      source: {
        kind: 'github_release_binary',
        repo: 'acme/localharness',
        distTag: 'latest',
      },
      binary: {
        commands: ['localharness'],
        systemFirst: false,
        managedFallback: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
    });
    const appliedContributions = {
      managedDependencies: Object.freeze([
        {
          provenance: 'first_party',
          source: { kind: 'bundled' },
          pluginId: 'antigravity',
          manifestPath: '/plugins/antigravity/plugin.json',
          manifestDigest: 'sha256:antigravity',
          daemonEntryPath: '/plugins/antigravity/daemon.mjs',
          sourceSpec: {
            kind: 'path',
            locator: '/plugins/antigravity',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
          },
          definition: descriptor,
        },
      ]),
    } as unknown as ResolvedContributionRegistry;
    const resolveMergedContributionRegistry = vi.fn(async () => ({
      managedDependencies: Object.freeze([]),
    }) as unknown as ResolvedContributionRegistry);

    const registry = await resolveSpawnHookInstallablesRegistry('/happy-home', {
      contributions: appliedContributions,
      resolveMergedContributionRegistry,
    } as never);

    expect(registry?.descriptors.map((candidate) => candidate.descriptor.key)).toContain('antigravity-localharness');
    expect(registry?.descriptorsByKey['antigravity-localharness']?.owner.pluginId).toBe('antigravity');
    expect(resolveMergedContributionRegistry).not.toHaveBeenCalled();
  });
});

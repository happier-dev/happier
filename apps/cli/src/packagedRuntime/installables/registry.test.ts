import { describe, expect, it } from 'vitest';

import {
  GH_DEP_ID,
  INSTALLABLE_KEYS,
  InstallableDependencyDescriptorSchema,
  resolveInstallablesRegistry,
  type InstallableKey,
} from '@happier-dev/protocol/installables';

import { getRuntimeInstallableAdapter } from './registry';

describe('getRuntimeInstallableAdapter', () => {
  it('resolves gh through the generic installables registry', async () => {
    const adapter = await getRuntimeInstallableAdapter(INSTALLABLE_KEYS.GH);

    expect(adapter.key).toBe(INSTALLABLE_KEYS.GH);
    expect(adapter.capabilityId).toBe(GH_DEP_ID);
  });

  it('resolves descriptors from the provided installables registry and rejects unsupported plugin sources as non-executable', async () => {
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: 'acme-manual-tool',
      key: 'acme-manual-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.acme-manual-tool',
      display: {
        name: 'Acme Manual Tool',
      },
      description: 'Manual tool contributed by a plugin',
      source: {
        kind: 'manual_only',
        setupUrl: 'https://example.com/acme-manual-tool',
      },
      binary: {
        commands: ['acme-manual-tool'],
        systemFirst: true,
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
    const installablesRegistry = resolveInstallablesRegistry({
      externalPlugins: [{
        owner: {
          provenance: 'external_plugin',
          ownerId: 'acme.installables',
          pluginId: 'acme.installables',
        },
        descriptor,
      }],
    });

    await expect(
      getRuntimeInstallableAdapter('acme-manual-tool' as InstallableKey, { installablesRegistry } as never),
    ).rejects.toThrow(/manual_only.*not executable/i);
  });

  it('resolves plugin-contributed github_release_binary descriptors through the generic source adapter', async () => {
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: 'acme-release-tool',
      key: 'acme-release-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.acme-release-tool',
      display: {
        name: 'Acme Release Tool',
      },
      description: 'GitHub release binary contributed by a plugin',
      source: {
        kind: 'github_release_binary',
        repo: 'acme/release-tool',
        distTag: 'latest',
      },
      binary: {
        commands: ['acme-release-tool'],
        systemFirst: true,
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
    const installablesRegistry = resolveInstallablesRegistry({
      externalPlugins: [{
        owner: {
          provenance: 'external_plugin',
          ownerId: 'acme.installables',
          pluginId: 'acme.installables',
        },
        descriptor,
      }],
    });

    const adapter = await getRuntimeInstallableAdapter('acme-release-tool' as InstallableKey, { installablesRegistry } as never);

    expect(adapter.key).toBe('acme-release-tool');
    expect(adapter.capabilityId).toBe('dep.acme-release-tool');
  });
});

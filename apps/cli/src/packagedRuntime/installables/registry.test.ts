import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GH_DEP_ID,
  INSTALLABLE_KEYS,
  InstallableDependencyDescriptorSchema,
  resolveInstallablesRegistry,
  type InstallableKey,
  type InstallablesRegistry,
} from '@happier-dev/protocol/installables';
import { CODEX_ACP_INSTALLABLE_DESCRIPTOR } from '@happier-dev/plugins-codex/agent/installables/codexAcp';

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

  it('uses descriptor runtime policy instead of a codex-acp key branch for codex-owned launch resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-installable-policy-'));
    try {
      const overridePath = join(root, process.platform === 'win32' ? 'custom-codex-acp.cmd' : 'custom-codex-acp');
      await writeFile(overridePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(overridePath, 0o755);
      }

      const descriptor = {
        ...CODEX_ACP_INSTALLABLE_DESCRIPTOR,
        id: 'codex-acp-shadow',
        key: 'codex-acp-shadow',
        capabilityId: 'dep.codex-acp-shadow',
        display: {
          ...CODEX_ACP_INSTALLABLE_DESCRIPTOR.display,
          name: 'Codex ACP Shadow',
        },
      } as typeof CODEX_ACP_INSTALLABLE_DESCRIPTOR;
      const installablesRegistry = resolveInstallablesRegistry({
        bundledFirstPartyPlugins: [{
          owner: {
            provenance: 'bundled_first_party_plugin',
            ownerId: 'happier.agent.codex',
            pluginId: 'happier.agent.codex',
          },
          descriptor,
        }],
      });

      const adapter = await getRuntimeInstallableAdapter('codex-acp-shadow' as InstallableKey, { installablesRegistry } as never);

      await expect(adapter.resolveLaunchCommand?.({
        env: {
          PATH: '',
          HAPPIER_CODEX_ACP_BIN: overridePath,
        } as NodeJS.ProcessEnv,
      })).resolves.toEqual({
        ok: true,
        command: overridePath,
        args: [],
        source: 'user_config',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses externally-owned managed PyPI wheel assets even when a registry object is hand-built', async () => {
    const descriptor = InstallableDependencyDescriptorSchema.parse({
      id: 'acme-pypi-wheel-tool',
      key: 'acme-pypi-wheel-tool',
      kind: 'dep',
      version: '1',
      capabilityId: 'dep.acme-pypi-wheel-tool',
      display: {
        name: 'Acme PyPI Wheel Tool',
      },
      description: 'PyPI wheel asset contributed by an external plugin',
      source: {
        kind: 'managed_pypi_wheel_asset',
        distribution: 'acme-tool',
        versionSpecifier: '>=1.0.0,<2.0.0',
        assetPathByPlatform: {
          'darwin-arm64': 'acme/bin/tool',
        },
        executable: true,
        installConsent: 'host_managed_required',
        autoUpdateMode: 'auto',
      },
      binary: {
        commands: ['acme-tool'],
        systemFirst: false,
        managedFallback: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: false,
        autoUpdateMode: 'auto',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
    });
    const entry = {
      owner: {
        provenance: 'external_plugin' as const,
        ownerId: 'acme.installables',
        pluginId: 'acme.installables',
      },
      descriptor,
    };
    const installablesRegistry = {
      descriptors: [entry],
      descriptorsByKey: { [descriptor.key]: entry },
      descriptorsByCapabilityId: { [descriptor.capabilityId]: entry },
      diagnostics: [],
    } satisfies InstallablesRegistry;

    await expect(
      getRuntimeInstallableAdapter('acme-pypi-wheel-tool' as InstallableKey, { installablesRegistry }),
    ).rejects.toThrow(/curated first-party/i);
  });
});

// MCH-2: the managed browser-chromium source is a per-platform archive, not a dep.* system CLI,
// so it routes through a separate archive-download adapter keyed by the product-source key.
describe('getArchiveDownloadInstallableAdapter', () => {
  it('resolves the browser-chromium archive-download adapter', async () => {
    const {
      getArchiveDownloadInstallableAdapter,
      BROWSER_CHROMIUM_INSTALLABLE_KEY,
      ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND,
    } = await import('./registry');

    const adapter = getArchiveDownloadInstallableAdapter(BROWSER_CHROMIUM_INSTALLABLE_KEY);
    expect(adapter).not.toBeNull();
    expect(adapter?.key).toBe(BROWSER_CHROMIUM_INSTALLABLE_KEY);
    expect(adapter?.sourceKind).toBe(ARCHIVE_DOWNLOAD_INSTALLABLE_SOURCE_KIND);
    expect(adapter?.installOrUpgrade).toBeTypeOf('function');
    expect(adapter?.resolveInstalledExecutable).toBeTypeOf('function');
  });

  it('returns null for an unknown archive-download key (fails closed)', async () => {
    const { getArchiveDownloadInstallableAdapter } = await import('./registry');
    expect(getArchiveDownloadInstallableAdapter('not-a-known-source')).toBeNull();
  });
});

import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { readBundledPluginPackageNames, syncCliBundledPluginMembership } from './bundledPluginMembership';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../src/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { readBundledPluginManifest } from '../../src/plugins/projection/registry/builtIn/manifestFile';

const rootDir = fileURLToPath(new URL('../../../..', import.meta.url));

it('includes Machine services in workspace discovery and CLI bundled membership', () => {
  expect(readBundledPluginPackageNames(rootDir)).toContain('@happier-dev/plugins-machine-services');
  expect(() => syncCliBundledPluginMembership({ rootDir, mode: 'check' })).not.toThrow();
});

it('publishes Machine services with its daemon and saved-health setup declaration', () => {
  const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === 'happier.machine.services');
  expect(locator).toBeDefined();
  if (!locator) throw new Error('Machine services bundled locator is missing');
  expect(locator.daemonEntryPath).toBeTruthy();
  const manifest = PluginManifestV2Schema.parse(readBundledPluginManifest(locator));
  expect(manifest.contributes?.actions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'health/setup', execution: { target: 'daemon' } }),
  ]));
  expect(manifest.contributes?.projectNativeAdapters).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'systemd', roles: ['nativeServiceLifecycle'] }),
    expect.objectContaining({ id: 'compose', roles: ['nativeServiceLifecycle'] }),
  ]));
});

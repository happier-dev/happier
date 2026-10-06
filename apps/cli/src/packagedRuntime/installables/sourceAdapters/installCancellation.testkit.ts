import { createHash } from 'node:crypto';
import { GH_INSTALLABLE_DESCRIPTOR } from '@happier-dev/protocol/installables/definitions/gh';
import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol/installables/descriptor';
import { resolveInstallablesRegistry } from '@happier-dev/protocol/installables/registry';
import type { InstallableDependencyDescriptor } from '@happier-dev/protocol';

import { getRuntimeInstallableAdapter } from '../registry';

export const cancellationSources: readonly InstallableDependencyDescriptor['source'][] = [
  GH_INSTALLABLE_DESCRIPTOR.source,
  {
    kind: 'managed_pypi_wheel_asset',
    distribution: 'google-antigravity',
    versionSpecifier: '>=0.1.3,<0.2.0',
    assetPathByPlatform: {
      'darwin-arm64': 'google/antigravity/bin/localharness',
      'linux-x64': 'google/antigravity/bin/localharness',
      'linux-arm64': 'google/antigravity/bin/localharness',
      'win32-x64': 'google/antigravity/bin/localharness.exe',
      'win32-arm64': 'google/antigravity/bin/localharness.exe',
    },
    executable: true,
    installConsent: 'host_managed_required',
    autoUpdateMode: 'off',
  },
  {
    kind: 'pinned_archive',
    version: '1.1.1',
    assetsByPlatform: Object.fromEntries(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'].map((platform) => [platform, {
      archiveUrl: 'https://example.invalid/server.zip',
      sha256: createHash('sha256').update('unused pre-aborted archive').digest('hex'),
      executableSubpath: 'agy_acp_server.par',
    }] as const)),
  },
];

export async function createCancellationFixture(source: InstallableDependencyDescriptor['source']) {
  const descriptor = InstallableDependencyDescriptorSchema.parse({
    id: 'dep.cancellation-fixture', key: 'dep.cancellation-fixture', kind: 'dep', version: '1',
    capabilityId: 'dep.cancellation-fixture', display: { name: 'Cancellation fixture' }, description: 'Adapter cancellation fixture',
    source, binary: { commands: ['localharness'], systemFirst: false, managedFallback: true },
    defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'off' },
    consent: { install: 'required', update: 'required' },
  });
  const installablesRegistry = resolveInstallablesRegistry({
    bundledFirstPartyPlugins: [{
      owner: { provenance: 'bundled_first_party_plugin', ownerId: 'happier.antigravity', pluginId: 'happier.antigravity' },
      descriptor,
    }],
  });
  return { descriptor, adapter: await getRuntimeInstallableAdapter(descriptor.key, { installablesRegistry }) };
}

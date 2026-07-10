import { describe, expect, it } from 'vitest';

import { ManagedDependencyDescriptorSchema } from '@happier-dev/plugin-sdk/experimental/managedDependencies';

import { ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_DESCRIPTOR } from './installable.js';

describe('Antigravity localharness installable', () => {
  it('declares google-antigravity 0.1.4+ as a managed PyPI wheel asset without darwin-x64 fallback', () => {
    const descriptor = ManagedDependencyDescriptorSchema.parse(
      ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_DESCRIPTOR,
    );

    expect(descriptor).toMatchObject({
      key: 'dep.antigravity.localharness',
      capabilityId: 'dep.antigravity.localharness',
      source: {
        kind: 'managed_pypi_wheel_asset',
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.4,<0.2.0',
        executable: true,
        compatibilityProbe: 'antigravity-localharness-v1',
        installConsent: 'host_managed_required',
        autoUpdateMode: 'notify',
      },
      binary: {
        commands: ['localharness'],
        systemFirst: false,
        managedFallback: true,
      },
      defaultPolicy: {
        autoInstallWhenNeeded: true,
        autoUpdateMode: 'notify',
      },
      consent: {
        install: 'required',
        update: 'required',
      },
      stability: {
        experimental: true,
        supported: true,
      },
    });
    expect(descriptor.source).toMatchObject({
      assetPathByPlatform: {
        'darwin-arm64': 'google/antigravity/bin/localharness',
        'linux-x64': 'google/antigravity/bin/localharness',
        'linux-arm64': 'google/antigravity/bin/localharness',
        'win32-x64': 'google/antigravity/bin/localharness.exe',
        'win32-arm64': 'google/antigravity/bin/localharness.exe',
      },
    });
    expect(Object.keys(descriptor.source.assetPathByPlatform)).not.toContain('darwin-x64');
    expect(descriptor.binary).not.toHaveProperty('platforms');
    expect(descriptor.binary).not.toHaveProperty('arches');
  });
});

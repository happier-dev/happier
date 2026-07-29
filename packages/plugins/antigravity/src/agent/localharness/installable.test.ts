import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from '../../manifest.js';

describe('Antigravity localharness installable', () => {
  it('declares google-antigravity 0.1.4+ as a managed PyPI wheel asset without darwin-x64 fallback', () => {
    const descriptor = PLUGIN_MANIFEST.contributes.managedDependencies[0]!;

    expect(descriptor).toMatchObject({
      id: 'localharness',
      executable: 'localharness',
      sources: [{
        kind: 'managedPypiWheelAsset',
        installId: 'dep.antigravity.localharness',
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.4,<0.2.0',
        executable: true,
        compatibilityProbe: 'antigravity-localharness-v1',
        installConsent: 'host_managed_required',
        autoUpdateMode: 'notify',
      }],
    });
    expect(descriptor.sources[0]).toMatchObject({
      assetPathByPlatform: {
        'darwin-arm64': 'google/antigravity/bin/localharness',
        'linux-x64': 'google/antigravity/bin/localharness',
        'linux-arm64': 'google/antigravity/bin/localharness',
        'win32-x64': 'google/antigravity/bin/localharness.exe',
        'win32-arm64': 'google/antigravity/bin/localharness.exe',
      },
    });
    expect(Object.keys(descriptor.sources[0].assetPathByPlatform)).not.toContain('darwin-x64');
  });
});

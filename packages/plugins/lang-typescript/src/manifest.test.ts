import { describe, expect, it } from 'vitest';
import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('managed TypeScript language contribution', () => {
  it('enables server-side hints for both language sections while clients retain Off/Parameters/All presentation', () => {
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    if (!admitted.ok) throw new Error('TypeScript declaration was not admitted');
    const server = admitted.manifest.contributes.languageServers[0];
    // Native TypeScript defaults these preferences off, even when it advertises inlayHintProvider.
    for (const section of ['js/ts', 'typescript', 'javascript']) {
      expect(server?.settings ?? {}).toHaveProperty(section, expect.objectContaining({
        inlayHints: {
          parameterNames: { enabled: 'all' },
          variableTypes: { enabled: true },
          functionLikeReturnTypes: { enabled: true },
        },
      }));
    }
  });
  it('admits native language intelligence with type acquisition disabled and complete platform archives', () => {
    const admitted = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(admitted).toMatchObject({ ok: true });
    if (!admitted.ok) return;
    const server = admitted.manifest.contributes.languageServers[0];
    expect(server).toMatchObject({ id: 'typescript',
      languageIds: { typescript: 'typescript', tsx: 'typescriptreact', javascript: 'javascript', jsx: 'javascriptreact' },
      executable: { kind: 'managedDependency', id: 'typescript-native' }, args: ['--lsp', '--stdio'],
      initializationOptions: { userPreferences: { tsserver: { automaticTypeAcquisition: { enabled: false } } }, disablePushDiagnostics: true },
    });
    expect(server).not.toHaveProperty('rootMarkers');
    expect(server?.initializationOptions).not.toHaveProperty('runExternalCode');
    expect(server?.initializationOptions).not.toHaveProperty('enableTelemetry');
    const dependency = admitted.manifest.contributes.managedDependencies.find(entry => entry.id === 'typescript-native');
    const archive = dependency?.sources.find(source => source.kind === 'pinnedArchive');
    expect(archive?.kind).toBe('pinnedArchive');
    if (archive?.kind !== 'pinnedArchive') return;
    expect(archive.version).toBe('7.1.0-beta');
    expect(Object.keys(archive.assetsByPlatform).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
    ]);
    for (const [platform, asset] of Object.entries(archive.assetsByPlatform)) {
      expect(asset?.executableSubpath).toBe(platform.startsWith('win32-') ? 'package/lib/tsc.exe' : 'package/lib/tsc');
      expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
  });
});

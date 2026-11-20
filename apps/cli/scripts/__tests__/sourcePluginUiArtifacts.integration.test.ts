import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildUniversalPluginUiArtifacts } from '../../../../packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts';
import { sourcePluginUiBuildOptions } from '../../../../scripts/workspaces/sourcePluginUiBuildOptions.mjs';
import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';
import { readGeneratedPluginUiArtifactsManifest } from '../../src/plugins/install/ui/generatedArtifacts';
import { publishBundledPluginArtifactsAfterWorkspaceBuild } from '../buildSharedDeps.mjs';
import { bundledPluginManifestAssetRelativePath } from '../build-owned/bundledPlugins/manifestAssetPath.mjs';
import { writeBundledPluginSourceInputs, FIXTURE_PNPM_WORKSPACE_YAML } from './testkit/packageLayoutSandbox';

describe('source CLI Plugin UI preparation with the real compiler', () => {
  it('compiles the bundled Supabase Account entry without a retained artifact', async () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const outputDir = createTempDirSync('happier Supabase Account artifacts-');
    try {
      const directory = 'deployment-supabase';
      const { manifest } = await buildUniversalPluginUiArtifacts(
        join(repoRoot, 'packages/plugins', directory),
        join(repoRoot, 'apps/cli', bundledPluginManifestAssetRelativePath(directory)),
        { ...await sourcePluginUiBuildOptions({ repoRoot }), outputDir },
      );
      expect(manifest.entries).toContainEqual(expect.objectContaining({
        artifactId: 'account-runtime', tier: 'reactNative',
        executable: expect.objectContaining({ exports: expect.arrayContaining(['activateAccount']) }),
      }));
    } finally { removeTempDirSync(outputDir); }
  });

  it('publishes executable graphs from CLI declarations on a cold checkout without packaged manifests', async () => {
    const repoRoot = createTempDirSync('happier source CLI plugin UI-');
    try {
      const packageRoot = writeBundledPluginSourceInputs({ repoRoot, pluginId: 'fixture' });
      mkdirSync(join(repoRoot, 'apps/cli'), { recursive: true });
      mkdirSync(join(repoRoot, 'apps/ui'), { recursive: true });
      writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), FIXTURE_PNPM_WORKSPACE_YAML);
      writeFileSync(join(repoRoot, 'apps/cli/package.json'), JSON.stringify({
        name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/plugins-fixture'],
      }));
      writeFileSync(join(repoRoot, 'apps/ui/package.json'), JSON.stringify({
        dependencies: { '@happier-dev/plugins-fixture': '0.0.0' },
      }));
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@happier-dev/plugins-fixture', version: '0.0.0', type: 'module', exports: {
          './happier-plugin-ui/card': { 'happier-source': './src/card.ts', default: './dist/card.js' },
        },
      }));
      writeFileSync(join(packageRoot, 'src/card.ts'), 'export function renderSurface() { return null; }\n');
      writeFileSync(join(packageRoot, 'tsconfig.json'), '{}\n');
      const graphPath = join(packageRoot, 'dist/happier-plugin-ui/ui-artifacts.json');
      expect(existsSync(graphPath)).toBe(false);
      const prepare = (pluginWorkspaceNames?: string[]) => publishBundledPluginArtifactsAfterWorkspaceBuild({
        repoRoot, workspaceNames: ['plugins-fixture'], env: {},
        ...(pluginWorkspaceNames === undefined ? {} : { pluginWorkspaceNames }),
        // The semantic publisher is a child-process boundary. Its normalized
        // declaration is input to the real compiler, inventory and CLI reader.
        publishBundledPluginArtifactsImpl: async () => {
          const declaration = join(repoRoot, 'apps', 'cli', bundledPluginManifestAssetRelativePath('fixture'));
          mkdirSync(dirname(declaration), { recursive: true });
          writeFileSync(declaration, JSON.stringify({
            schemaVersion: 2, id: 'happier.fixture', version: '0.0.0', displayName: 'Fixture', runtime: { apiVersion: 1 },
            contributes: { ui: { renderers: [{ id: 'card', kind: 'reactNative', artifact: 'card' }],
              views: [{ id: 'card', container: 'appPage', target: { kind: 'app' }, renderer: 'card', title: 'Fixture' }] } },
          }));
          return true;
        },
      });
      writeFileSync(join(packageRoot, 'src/card.ts'), 'export function renderSurface( {\n');
      expect(existsSync(join(packageRoot, '.happier-plugin', 'plugin.json'))).toBe(false);
      await expect(prepare()).rejects.toMatchObject({ code: 'plugin_ui_artifact_invalid' });
      expect(existsSync(graphPath)).toBe(false);
      writeFileSync(join(packageRoot, 'src/card.ts'), 'export function renderSurface() { return null; }\n');
      // TypeScript output can already be current after the UI compiler fails.
      // Retry the selected UI even when no semantic package needs rebuilding.
      expect(await prepare([])).toBe(true);
      const graph = await readGeneratedPluginUiArtifactsManifest(packageRoot);
      expect(graph?.entries.map(entry => entry.artifactId)).toEqual(['card']);
      for (const entry of graph!.entries) {
        expect(existsSync(join(packageRoot, 'dist/happier-plugin-ui', entry.entry))).toBe(true);
      }
      const first = readFileSync(graphPath, 'utf8');
      await prepare();
      expect(readFileSync(graphPath, 'utf8')).toBe(first);
      expect(existsSync(join(repoRoot, 'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js'))).toBe(false);
    } finally { removeTempDirSync(repoRoot); }
  });
});

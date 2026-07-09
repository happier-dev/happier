import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PluginManifestV2Schema, type ParsedPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createPluginApiHost } from '../runtime/api/host';
import { scaffoldLocalPlugin } from './scaffold';

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

describe('scaffoldLocalPlugin', () => {
  it('writes the final TypeScript dev-loop plugin template', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = await readJsonFile<Record<string, unknown>>(result.manifestPath);
    expect(() => PluginManifestV2Schema.parse(manifest)).not.toThrow();
    expect(manifest).toMatchObject({
      id: 'acme.template',
      displayName: 'Acme Template',
      uses: expect.arrayContaining(['actions', 'tools', 'hooks', 'settings']),
      entrypoints: {
        main: './dist/index.js',
        dev: './src/index.ts',
      },
      permissions: {
        required: [],
        optional: [],
      },
    });
    expect(manifest).not.toHaveProperty('runtime');
    expect(manifest).not.toHaveProperty('targets');
    const legacyPermissionsPath = 'capabilities.' + 'permissions';
    expect(manifest).not.toHaveProperty(legacyPermissionsPath);

    const source = await readFile(result.sourceEntryPath, 'utf8');
    expect(result.sourceEntryPath).toBe(join(targetDir, 'src', 'index.ts'));
    expect(source).toContain("from '@happier-dev/plugin-sdk';");
    expect(source).toContain('export function activate(host: PluginApi): void');
    expect(source).toContain('host.registerAction');
    expect(source).toContain('host.registerTool');
    expect(source).toContain('const services = request.context;');
    expect(source).toContain('services.storage.local.set');
  });

  it('activates the generated compiled source without missing-permission diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-activate-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = await readJsonFile<ParsedPluginManifestV2>(result.manifestPath);
    const parsedManifest = PluginManifestV2Schema.parse(manifest);

    // Mirror how the real activation pipeline (resolveActivationPolicy) derives
    // a PluginApiHostPolicy from a manifest, so this exercises the same
    // permission/declared-id enforcement the daemon applies on first install.
    const host = createPluginApiHost({
      pluginId: parsedManifest.id,
      runtimeCapabilities: parsedManifest.uses,
      permissions: parsedManifest.permissions.required.map((permission) => permission.capability),
      declaredActionIds: parsedManifest.contributes.actions?.map((action) => action.id) ?? [],
      declaredActions: parsedManifest.contributes.actions ?? [],
      declaredToolIds: parsedManifest.contributes.tools?.map((tool) => tool.id) ?? [],
      declaredHookIds: parsedManifest.contributes.hooks?.map((hook) => hook.id) ?? [],
      declaredAgentIds: parsedManifest.contributes.agents?.map((agent) => agent.id) ?? [],
    });

    const compiledEntryPath = join(targetDir, 'dist', 'index.js');
    const compiledModule = (await import(pathToFileURL(compiledEntryPath).href)) as {
      activate: (api: unknown) => void;
    };
    compiledModule.activate(host.api);

    const registrations = host.registrations();
    expect(registrations.diagnostics).toEqual([]);
    expect(registrations.actions).toHaveLength(1);
    expect(registrations.tools).toHaveLength(1);
    expect(registrations.hooks).toHaveLength(1);
    expect(registrations.agentRuntimes).toHaveLength(1);
  });

  it('can include a hostedWeb authoring stub', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-ui-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      ui: 'hostedWeb',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = await readJsonFile<Record<string, unknown>>(result.manifestPath);
    expect(() => PluginManifestV2Schema.parse(manifest)).not.toThrow();
    expect(manifest).toMatchObject({
      contributes: {
        hostedWeb: [
          expect.objectContaining({
            id: 'main-web',
            service: { kind: 'staticAssets', assetRootId: 'hosted-web/main-web' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            fallback: { kind: 'unavailable' },
          }),
        ],
      },
    });

    const uiSource = await readFile(join(targetDir, 'src', 'ui', 'index.ts'), 'utf8');
    expect(uiSource).toContain('export const ui');
  });

  it('can include a reactNative authoring stub (F-UI G3)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-rn-'));
    const targetDir = join(root, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      ui: 'reactNative',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = await readJsonFile<Record<string, unknown>>(result.manifestPath);
    expect(() => PluginManifestV2Schema.parse(manifest)).not.toThrow();
    expect(manifest).toMatchObject({
      contributes: {
        reactNativeBundles: [
          expect.objectContaining({
            id: 'main-native',
            bundle: { platform: 'ios', channel: 'development' },
            fallback: { kind: 'unavailable' },
            policy: { allowDevHotReload: true },
          }),
        ],
      },
    });

    expect(result.uiEntryPath).toBe(join(targetDir, 'src', 'ui', 'renderSurface.tsx'));
    const uiSource = await readFile(result.uiEntryPath as string, 'utf8');
    expect(uiSource).toContain('export function renderSurface');

    const packageJson = await readJsonFile<Record<string, unknown>>(join(targetDir, 'package.json'));
    expect(packageJson).toMatchObject({
      scripts: {
        'build:ui': 'happier-plugin-build-ui --project-root .',
      },
      dependencies: {
        react: '19.2.0',
        'react-dom': '19.2.0',
        'react-native': '0.83.4',
        'react-native-web': '^0.21.2',
      },
      devDependencies: {
        vite: '^7.0.0',
        '@vitejs/plugin-react': '^5.0.0',
      },
    });
    const viteConfig = await readFile(join(targetDir, 'vite.config.mjs'), 'utf8');
    expect(viteConfig).toContain('@happier-dev/plugin-sdk/ui/reactNativeWebBuild');
    expect(viteConfig).toContain('createReactNativeWebVitePlugins');
    const uiBuildConfig = await readFile(join(targetDir, 'pluginUiBuild.mjs'), 'utf8');
    expect(uiBuildConfig).toContain('defineReactNativeWebViteBuildPreset');
    expect(uiBuildConfig).toContain('createManagedRuntimeBundlerRunner');
  });

  // DEC-6 redirect (mid-flight scope change): embeddedWeb's future is undecided
  // (likely retired — redundant with RN-on-web + hostedWeb-on-native). The
  // embeddedWeb scaffold variant is PARKED — not shipped — pending that
  // disposition. Only hostedWeb and reactNative are scaffoldable.

  it('activates the generated compiled source cleanly for every shipped ui mode (extends the activation-pipeline pattern)', async () => {
    for (const ui of ['hostedWeb', 'reactNative'] as const) {
      const root = await mkdtemp(join(tmpdir(), `happier-plugin-scaffold-activate-${ui}-`));
      const targetDir = join(root, 'template-plugin');

      const result = await scaffoldLocalPlugin({
        targetDir,
        pluginId: 'acme.template',
        displayName: 'Acme Template',
        ui,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const manifest = await readJsonFile<ParsedPluginManifestV2>(result.manifestPath);
      const parsedManifest = PluginManifestV2Schema.parse(manifest);

      const host = createPluginApiHost({
        pluginId: parsedManifest.id,
        runtimeCapabilities: parsedManifest.uses,
        permissions: parsedManifest.permissions.required.map((permission) => permission.capability),
        declaredActionIds: parsedManifest.contributes.actions?.map((action) => action.id) ?? [],
        declaredActions: parsedManifest.contributes.actions ?? [],
        declaredToolIds: parsedManifest.contributes.tools?.map((tool) => tool.id) ?? [],
        declaredHookIds: parsedManifest.contributes.hooks?.map((hook) => hook.id) ?? [],
        declaredAgentIds: parsedManifest.contributes.agents?.map((agent) => agent.id) ?? [],
      });

      const compiledEntryPath = join(targetDir, 'dist', 'index.js');
      const compiledModule = (await import(pathToFileURL(compiledEntryPath).href)) as {
        activate: (api: unknown) => void;
      };
      compiledModule.activate(host.api);

      const registrations = host.registrations();
      expect(registrations.diagnostics).toEqual([]);
      expect(registrations.actions).toHaveLength(1);
      expect(registrations.tools).toHaveLength(1);
      expect(registrations.hooks).toHaveLength(1);
      expect(registrations.agentRuntimes).toHaveLength(1);
    }
  });

  it('rejects scaffold targets outside the provided base directory', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-workspace-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-outside-'));
    const targetDir = join(outsideRoot, 'template-plugin');

    const result = await scaffoldLocalPlugin({
      targetDir,
      pluginId: 'acme.template',
      displayName: 'Acme Template',
      baseDir: workspaceRoot,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'plugin_scaffold_invalid_input',
          message: expect.stringMatching(/inside the workspace/i),
        },
      ],
    });
    await expect(readFile(join(targetDir, 'package.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

/* @vitest-environment jsdom */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PluginManifestV2Schema } from '@happier-dev/protocol';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { buildUiSurfaceTargets } from '@happier-dev/plugin-sdk/ui/build';
import { describe, expect, it, vi } from 'vitest';

// This renderer adapter is intentionally private to Plugin UI. It is used
// only by this first-party generator integration test to mount emitted RNW
// source; generated author packages keep the public SDK/testkit boundary.
import { createPluginUiRnwSemanticSurfaceAdapter } from '../../../packages/plugin-ui/src/testing/rnwSemanticAdapter.testSupport.js';
import { scaffoldLocalPlugin } from '../src/plugins/scaffold/scaffold.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostedClient = vi.hoisted(() => ({
  applyPluginUiThemeCssVariables: vi.fn(),
  createPluginUiRenderContext: vi.fn(),
}));

vi.mock('@happier-dev/plugin-sdk/ui/client', () => hostedClient);

type GeneratedPluginModule = Readonly<{
  manifest: unknown;
  mainSurface: Parameters<typeof buildUiSurfaceTargets>[0];
}>;
type GeneratedReactNativeSurfaceModule = Readonly<{ renderSurface: RenderSurface }>;
async function importGeneratedModule<TModule>(path: string): Promise<TModule> {
  return await import(pathToFileURL(path).href) as TModule;
}

function resolveGeneratedUiEntry(
  sourceEntryPath: string,
  uiEntryPath: string,
  mainSurface: Parameters<typeof buildUiSurfaceTargets>[0],
): Readonly<{
  entryPath: string;
  target: ReturnType<typeof buildUiSurfaceTargets>[number];
}> {
  const targets = buildUiSurfaceTargets(mainSurface);
  expect(targets).toHaveLength(1);
  const target = targets[0];
  if (!target) throw new Error('Generated UI surface must declare one executable build target.');

  // Build-target entries are project-root-relative. The generated source entry
  // lives at `src/index.ts`, so resolve the declared target from its project
  // root rather than implicitly re-rooting it at `src/`.
  const entryPath = join(dirname(dirname(sourceEntryPath)), target.entry);
  expect(entryPath).toBe(uiEntryPath);
  return { entryPath, target };
}

describe('generated scaffold UI products', () => {
  it('mounts the generated React Native surface through the public entry and its admitted app placement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-ui-semantic-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.generated-rn-surface',
        displayName: 'Generated RN surface',
        ui: 'reactNative',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok || !scaffold.uiEntryPath) return;

      const plugin = await importGeneratedModule<GeneratedPluginModule>(scaffold.sourceEntryPath);
      const manifest = PluginManifestV2Schema.parse(plugin.manifest);
      expect(manifest.contributes.ui.views).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'main',
          container: 'appPage',
          target: { kind: 'app' },
          renderer: 'main-renderer',
        }),
      ]));

      const { entryPath, target } = resolveGeneratedUiEntry(
        scaffold.sourceEntryPath,
        scaffold.uiEntryPath,
        plugin.mainSurface,
      );
      expect(target).toMatchObject({
        kind: 'reactNative',
        rendererId: 'main-renderer',
        entry: 'src/ui/renderSurface.tsx',
      });
      const generatedSurface = await importGeneratedModule<GeneratedReactNativeSurfaceModule>(entryPath);
      expect(generatedSurface.renderSurface).toEqual(expect.any(Function));
      const executeAction = vi.fn(async () => ({ note: 'hello' }));
      const fixture = await createPluginUiTestkit({
        identity: {
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          viewId: 'main',
          generation: 'generated-rn-scaffold',
        },
        surface: generatedSurface.renderSurface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction },
      });

      try {
        await expect(fixture.getByText('Hello from Generated RN surface')).resolves.toEqual({
          content: 'Hello from Generated RN surface',
        });
        await fixture.press(await fixture.getByRole('button', { name: 'Save note' }));
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'save-note',
          input: { note: 'hello' },
          signal: expect.any(AbortSignal),
        }));
      } finally {
        await fixture.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a changed emitted React Native entry instead of substituting scaffold semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-ui-mutant-'));
    try {
      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.generated-rn-mutant',
        displayName: 'Generated RN mutant',
        ui: 'reactNative',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok || !scaffold.uiEntryPath) return;

      const plugin = await importGeneratedModule<GeneratedPluginModule>(scaffold.sourceEntryPath);
      const manifest = PluginManifestV2Schema.parse(plugin.manifest);
      const { entryPath } = resolveGeneratedUiEntry(
        scaffold.sourceEntryPath,
        scaffold.uiEntryPath,
        plugin.mainSurface,
      );
      await writeFile(entryPath, [
        "import * as React from 'react';",
        "import { Card, defineUiSurface, Text } from '@happier-dev/plugin-ui';",
        '',
        'function BrokenSurface() {',
        '  return <Card><Text value="Broken emitted entry" /></Card>;',
        '}',
        '',
        'export const renderSurface = defineUiSurface(BrokenSurface);',
        '',
      ].join('\n'), 'utf8');

      const generatedSurface = await importGeneratedModule<GeneratedReactNativeSurfaceModule>(entryPath);
      const fixture = await createPluginUiTestkit({
        identity: {
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          viewId: 'main',
          generation: 'generated-rn-mutant',
        },
        surface: generatedSurface.renderSurface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      });

      try {
        // This mutation discriminator fails if the harness ever fabricates a
        // semantic snapshot instead of mounting the resolved emitted entry.
        await expect(fixture.getByText('Hello from Generated RN mutant')).rejects.toThrow();
        await expect(fixture.getByRole('button', { name: 'Save note' })).rejects.toThrow();
      } finally {
        await fixture.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs the generated hosted bootstrap against the public client and declared build target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-plugin-scaffold-hosted-semantic-'));
    document.body.replaceChildren();
    hostedClient.applyPluginUiThemeCssVariables.mockReset();
    hostedClient.createPluginUiRenderContext.mockReset();

    try {
      const surface = createSurfaceContextFixture({ locale: 'de-CH' });
      const watchContext = vi.fn(async () => ({ dispose() {} }));
      const executeAction = vi.fn(async () => null);
      // This minimal host boundary is deliberately restricted to the public
      // methods the generated hosted bootstrap uses.
      hostedClient.createPluginUiRenderContext.mockResolvedValue({
        plugin: { id: 'acme.generated-hosted-surface', version: '0.1.0' },
        surface,
        hostApi: {
          version: () => ({ methods: ['watchContext'] }),
          watchContext,
          executeAction,
        },
        signal: new AbortController().signal,
      } as unknown as RenderContext);

      const scaffold = await scaffoldLocalPlugin({
        targetDir: join(root, 'plugin'),
        pluginId: 'acme.generated-hosted-surface',
        displayName: 'Generated hosted surface',
        ui: 'hostedWeb',
      });
      expect(scaffold.ok).toBe(true);
      if (!scaffold.ok || !scaffold.uiEntryPath) return;

      const plugin = await importGeneratedModule<GeneratedPluginModule>(scaffold.sourceEntryPath);
      const { entryPath, target } = resolveGeneratedUiEntry(
        scaffold.sourceEntryPath,
        scaffold.uiEntryPath,
        plugin.mainSurface,
      );
      expect(target).toEqual({ rendererId: 'main-renderer', entry: 'src/ui/index.ts', kind: 'hostedWeb' });

      await importGeneratedModule(entryPath);
      await vi.waitFor(() => {
        expect(document.querySelector<HTMLElement>('#root')?.dataset.status).toBe('ready');
      });

      const surfaceRoot = document.querySelector<HTMLElement>('#root');
      expect(surfaceRoot?.lang).toBe('de-CH');
      expect(surfaceRoot?.querySelector('[data-role="title"]')?.textContent).toBe('Hello from Generated hosted surface');
      expect(hostedClient.applyPluginUiThemeCssVariables).toHaveBeenCalledWith(surface.theme, document.documentElement);
      expect(watchContext).toHaveBeenCalledWith(expect.any(Function), {
        signal: expect.any(AbortSignal),
      });

      const save = surfaceRoot?.querySelector<HTMLButtonElement>('[data-role="save"]');
      save?.click();
      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith('save-note', { note: 'hello' }, {
          signal: expect.any(AbortSignal),
        });
      });
      expect(surfaceRoot?.querySelector('[data-role="status"]')?.textContent).toBe('Saved');
    } finally {
      document.body.replaceChildren();
      await rm(root, { recursive: true, force: true });
    }
  });
});

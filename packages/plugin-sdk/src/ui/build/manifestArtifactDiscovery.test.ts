import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverExecutablePluginUiArtifacts,
  isManifestArtifactPathWithinProjectRoot,
} from './manifestArtifactDiscovery.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(exportTarget: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-discovery-'));
  roots.push(root);
  await mkdir(join(root, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      exports: { './happier-plugin-ui/panel': exportTarget },
    }),
    'utf8',
  );
  await writeFile(
    join(root, '.happier-plugin/plugin.json'),
    JSON.stringify({
      contributes: {
        ui: { renderers: [{ kind: 'reactNative', artifact: 'panel' }] },
      },
    }),
    'utf8',
  );
  return root;
}

describe('discoverExecutablePluginUiArtifacts', () => {
  it('discovers declared drag source and drop target activation exports without a renderer or Action', async () => {
    const root = await fixture('./ui/panel.tsx');
    await writeFile(
      join(root, '.happier-plugin/plugin.json'),
      JSON.stringify({
        contributes: {
          dragSources: [
            {
              id: 'entry',
              client: { artifactId: 'panel', exportName: 'activateSources' },
            },
          ],
          dropTargets: [
            {
              id: 'entry',
              client: { artifactId: 'panel', exportName: 'activateTargets' },
            },
          ],
        },
      }),
      'utf8',
    );
    await expect(discoverExecutablePluginUiArtifacts(root)).resolves.toEqual([
      {
        artifactId: 'panel',
        entryPath: join(root, 'ui/panel.tsx'),
        requestedExports: ['activateSources', 'activateTargets'],
      },
    ]);
  });
  it('accepts a child export within the plugin root', async () => {
    const root = await fixture('./ui/panel.tsx');

    await expect(discoverExecutablePluginUiArtifacts(root)).resolves.toEqual([
      {
        artifactId: 'panel',
        entryPath: join(root, 'ui/panel.tsx'),
        requestedExports: ['renderSurface'],
      },
    ]);
  });

  it.each([true, false])(
    'rejects a packaged bundle export without its manifest producer (other producer: %s)',
    async (hasOtherProducer) => {
      const root = await fixture('./ui/panel.tsx');
      if (!hasOtherProducer) {
        await writeFile(
          join(root, '.happier-plugin/plugin.json'),
          JSON.stringify({ contributes: {} }),
          'utf8',
        );
      }
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          exports: {
            './happier-plugin-ui/panel': './ui/panel.tsx',
            './happier-plugin-ui/react-native/glance/entry.cjs.bundle':
              './dist/happier-plugin-ui/react-native/glance/entry.cjs.bundle',
          },
        }),
        'utf8',
      );

      await expect(
        discoverExecutablePluginUiArtifacts(root),
      ).rejects.toMatchObject({
        code: 'artifact_output_export_undeclared',
        contributionId: 'glance',
      });
    },
  );

  it('accepts a packaged bundle export backed by its manifest producer', async () => {
    const root = await fixture('./ui/panel.tsx');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        exports: {
          './happier-plugin-ui/panel': './ui/panel.tsx',
          './happier-plugin-ui/react-native/panel/entry.cjs.bundle':
            './dist/happier-plugin-ui/react-native/panel/entry.cjs.bundle',
        },
      }),
      'utf8',
    );
    await expect(discoverExecutablePluginUiArtifacts(root)).resolves.toEqual([
      {
        artifactId: 'panel',
        entryPath: join(root, 'ui/panel.tsx'),
        requestedExports: ['renderSurface'],
      },
    ]);
  });

  it('rejects a parent escape', async () => {
    const root = await fixture('../outside.tsx');

    await expect(
      discoverExecutablePluginUiArtifacts(root),
    ).rejects.toMatchObject({
      code: 'artifact_export_escapes_root',
    });
  });

  it('rejects a sibling-prefix escape', async () => {
    const root = await fixture('./placeholder.tsx');
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        exports: {
          './happier-plugin-ui/panel': `../${basename(root)}-sibling/panel.tsx`,
        },
      }),
      'utf8',
    );

    await expect(
      discoverExecutablePluginUiArtifacts(root),
    ).rejects.toMatchObject({
      code: 'artifact_export_escapes_root',
    });
  });

  it('rejects divergent relevant conditional export targets', async () => {
    const root = await fixture({
      'react-native': './ui/panel.tsx',
      module: './ui/panel.module.tsx',
      import: './ui/panel.tsx',
      default: './ui/panel.tsx',
    });

    await expect(
      discoverExecutablePluginUiArtifacts(root),
    ).rejects.toMatchObject({
      code: 'artifact_export_conditions_diverge',
      message: expect.stringContaining('one portable source entry'),
    });
  });

  it('selects an explicitly requested authored source while published compilation stays strict', async () => {
    const root = await fixture({
      'happier-source': './src/panel.tsx',
      'react-native': './dist/panel.native.js',
      default: './dist/panel.js',
    });
    await expect(
      discoverExecutablePluginUiArtifacts(root, undefined, ['happier-source']),
    ).resolves.toEqual([
      {
        artifactId: 'panel',
        entryPath: join(root, 'src/panel.tsx'),
        requestedExports: ['renderSurface'],
      },
    ]);
    await expect(
      discoverExecutablePluginUiArtifacts(root),
    ).rejects.toMatchObject({ code: 'artifact_export_conditions_diverge' });
  });

  it('rejects divergent relevant targets nested inside a conditional export', async () => {
    const root = await fixture({
      'react-native': {
        import: './ui/panel.native.tsx',
        default: './ui/panel.tsx',
      },
      default: './ui/panel.tsx',
    });

    await expect(
      discoverExecutablePluginUiArtifacts(root),
    ).rejects.toMatchObject({
      code: 'artifact_export_conditions_diverge',
    });
  });

  it('accepts relevant conditional exports when they select one portable entry', async () => {
    const root = await fixture({
      'react-native': './ui/panel.tsx',
      module: './ui/panel.tsx',
      import: './ui/panel.tsx',
      default: './ui/panel.tsx',
    });

    await expect(discoverExecutablePluginUiArtifacts(root)).resolves.toEqual([
      {
        artifactId: 'panel',
        entryPath: join(root, 'ui/panel.tsx'),
        requestedExports: ['renderSurface'],
      },
    ]);
  });
});

describe('isManifestArtifactPathWithinProjectRoot', () => {
  it('accepts the project root itself', () => {
    expect(
      isManifestArtifactPathWithinProjectRoot(
        '/plugins/example',
        '/plugins/example',
      ),
    ).toBe(true);
  });

  it('accepts a normal Windows child path', () => {
    expect(
      isManifestArtifactPathWithinProjectRoot(
        'C:\\plugins\\example',
        'C:\\plugins\\example\\ui\\panel.tsx',
        win32,
      ),
    ).toBe(true);
  });

  it.each([
    ['parent escape', 'C:\\plugins\\example', 'C:\\plugins\\outside.tsx'],
    [
      'sibling-prefix escape',
      'C:\\plugins\\example',
      'C:\\plugins\\example-sibling\\panel.tsx',
    ],
    [
      'cross-drive escape',
      'C:\\plugins\\example',
      'D:\\plugins\\example\\panel.tsx',
    ],
  ])('rejects a Windows %s', (_label, root, candidate) => {
    expect(
      isManifestArtifactPathWithinProjectRoot(root, candidate, win32),
    ).toBe(false);
  });
});

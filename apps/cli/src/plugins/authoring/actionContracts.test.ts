import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generatePluginActionContracts } from './actionContracts';

describe('generatePluginActionContracts', () => {
  it('projects the exported definePlugin identity map into an identity-only public barrel', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-'));
    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './dist/index.js' },
          contributes: { actions: [{ id: 'publish' }, { id: 'archive' }] },
        },
        actionContracts: Object.freeze({
          publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
          archive: Object.freeze({ pluginId: 'example.producer', localId: 'archive' }),
        }),
      });

      const runtimePath = join(projectRoot, 'dist/actions/index.js');
      const typesPath = join(projectRoot, 'dist/actions/index.d.ts');
      const runtime = await readFile(runtimePath, 'utf8');
      expect(runtime).toContain('pluginId: "example.producer"');
      expect(runtime).toContain('"archive"');
      expect(runtime).not.toContain('schema');
      const types = await readFile(typesPath, 'utf8');
      expect(types).toMatch(/typeof import\(["']\.\.\/index\.js["']\)\.actionContracts/u);
      expect(types).toContain("from '@happier-dev/plugin-sdk/actions'");
      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './dist/index.js' },
          contributes: { actions: [{ id: 'publish' }, { id: 'archive' }] },
        },
        actionContracts: Object.freeze({
          publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
          archive: Object.freeze({ pluginId: 'example.producer', localId: 'archive' }),
        }),
      });
      expect(await readFile(runtimePath, 'utf8')).toBe(runtime);
      expect(await readFile(typesPath, 'utf8')).toBe(types);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes its generated barrel when a previously exported Action is removed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-stale-'));
    try {
      const manifest = {
        id: 'example.producer',
        entrypoints: { daemon: './dist/index.js' },
        contributes: { actions: [{ id: 'publish' }] },
      } as const;
      await generatePluginActionContracts({
        projectRoot,
        manifest,
        actionContracts: Object.freeze({
          publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
        }),
      });
      await generatePluginActionContracts({
        projectRoot,
        manifest: { ...manifest, contributes: { actions: [] } },
        actionContracts: Object.freeze({}),
      });

      await expect(readFile(join(projectRoot, 'dist/actions/index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(projectRoot, 'dist/actions/index.d.ts'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('cleans a generated barrel when a legacy author does not export actionContracts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-legacy-'));
    try {
      const manifest = {
        id: 'example.producer',
        entrypoints: { daemon: './dist/index.js' },
        contributes: { actions: [{ id: 'publish' }] },
      } as const;
      await generatePluginActionContracts({
        projectRoot,
        manifest,
        actionContracts: Object.freeze({
          publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
        }),
      });
      await generatePluginActionContracts({ projectRoot, manifest });

      await expect(readFile(join(projectRoot, 'dist/actions/index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(projectRoot, 'dist/actions/index.d.ts'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes stale generated barrels when a project transitions to a descriptor-only manifest', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-descriptor-transition-'));
    try {
      const actionsDirectory = join(projectRoot, 'dist/actions');
      await mkdir(actionsDirectory, { recursive: true });
      const generated = '// Generated by the Happier plugin authoring toolchain; do not edit.\n';
      await writeFile(join(actionsDirectory, 'index.js'), generated, 'utf8');
      await writeFile(join(actionsDirectory, 'index.d.ts'), generated, 'utf8');

      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          contributes: { actions: [] },
        },
      });

      await expect(readFile(join(actionsDirectory, 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(actionsDirectory, 'index.d.ts'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('removes marker-owned barrels at the daemon-derived output location after a descriptor transition', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-arbitrary-daemon-path-'));
    try {
      const generatedActionsDirectory = join(projectRoot, 'artifacts', 'runtime', 'actions');
      const authorActionsDirectory = join(projectRoot, 'author-output', 'actions');
      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './artifacts/runtime/daemon.mjs' },
          contributes: { actions: [{ id: 'publish' }] },
        },
        actionContracts: Object.freeze({
          publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
        }),
      });
      await mkdir(authorActionsDirectory, { recursive: true });
      await writeFile(join(authorActionsDirectory, 'index.js'), 'export const authorOwned = true;\n', 'utf8');

      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          contributes: { actions: [] },
        },
      });

      await expect(readFile(join(generatedActionsDirectory, 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(generatedActionsDirectory, 'index.d.ts'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(authorActionsDirectory, 'index.js'), 'utf8'))
        .resolves.toBe('export const authorOwned = true;\n');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('retires marker-owned barrels at a prior daemon-derived location before emitting a new one', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-daemon-move-'));
    try {
      const priorActionsDirectory = join(projectRoot, 'artifacts', 'prior', 'actions');
      const currentActionsDirectory = join(projectRoot, 'artifacts', 'current', 'actions');
      const actionContracts = Object.freeze({
        publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
      });

      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './artifacts/prior/daemon.mjs' },
          contributes: { actions: [{ id: 'publish' }] },
        },
        actionContracts,
      });
      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './artifacts/current/daemon.mjs' },
          contributes: { actions: [{ id: 'publish' }] },
        },
        actionContracts,
      });

      await expect(readFile(join(priorActionsDirectory, 'index.js'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(priorActionsDirectory, 'index.d.ts'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(currentActionsDirectory, 'index.js'), 'utf8'))
        .resolves.toContain('pluginId: "example.producer"');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('retains the prior marker-owned barrel when a moved replacement projection is invalid', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-daemon-move-invalid-'));
    try {
      const priorActionsPath = join(projectRoot, 'artifacts', 'prior', 'actions', 'index.js');
      const actionContracts = Object.freeze({
        publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
      });
      await generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './artifacts/prior/daemon.mjs' },
          contributes: { actions: [{ id: 'publish' }] },
        },
        actionContracts,
      });

      await expect(generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './artifacts/current/daemon.mjs' },
          contributes: { actions: [{ id: 'publish' }] },
        },
        actionContracts: Object.freeze({}),
      })).rejects.toThrow('must match manifest contributes.actions');

      await expect(readFile(priorActionsPath, 'utf8'))
        .resolves.toContain('pluginId: "example.producer"');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects Action output directories and files that physically escape the plugin root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-containment-'));
    const projectRoot = join(parent, 'plugin');
    const outsideRoot = join(parent, 'outside');
    try {
      await mkdir(join(projectRoot, 'dist'), { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      await symlink(outsideRoot, join(projectRoot, 'dist', 'actions'));
      await expect(generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './dist/index.js' },
          contributes: { actions: [] },
        },
        actionContracts: Object.freeze({}),
      })).rejects.toThrow('outside the physical plugin root');

      await rm(join(projectRoot, 'dist', 'actions'), { force: true });
      await mkdir(join(projectRoot, 'dist', 'actions'), { recursive: true });
      await writeFile(join(outsideRoot, 'index.js'), 'outside\n', 'utf8');
      await symlink(join(outsideRoot, 'index.js'), join(projectRoot, 'dist', 'actions', 'index.js'));
      await expect(generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './dist/index.js' },
          contributes: { actions: [{ id: 'publish' }] },
        },
        actionContracts: Object.freeze({
          publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
        }),
      })).rejects.toThrow('outside the physical plugin root');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects an exported identity map that diverges from the manifest contribution set', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-action-contracts-mismatch-'));
    try {
      await expect(generatePluginActionContracts({
        projectRoot,
        manifest: {
          id: 'example.producer',
          entrypoints: { daemon: './dist/index.js' },
          contributes: { actions: [{ id: 'publish' }, { id: 'archive' }] },
        },
        actionContracts: Object.freeze({
          publish: Object.freeze({ pluginId: 'example.producer', localId: 'publish' }),
        }),
      })).rejects.toThrow('must match manifest contributes.actions');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

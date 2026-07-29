import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectPluginDevelopmentSource,
  startPluginDevelopmentSourceObserver,
  type StartWatchingPluginDirectory,
} from './sourceObserver';

async function writeProject(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, '.happier-plugin'), { recursive: true });
  await mkdir(join(projectRoot, 'src', 'nested'), { recursive: true });
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
    name: 'happier-plugin-acme-observer',
    version: '0.1.0',
    dependencies: { '@happier-dev/plugin-sdk': '0.1.0' },
  }), 'utf8');
  await writeFile(join(projectRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'acme.observer',
    version: '0.1.0',
    displayName: 'Observer',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/index.js', development: './src/index.ts' },
    contributes: {
      actions: [{
        id: 'hello', title: 'Hello', scopes: ['global'], surfaces: ['cli'],
        placement: 'commandPalette', dangerLevel: 'safe',
      }],
    },
  }), 'utf8');
  await writeFile(
    join(projectRoot, 'src', 'index.ts'),
    "import { message } from './nested/message.js';\nglobalThis.__pluginObserverExecuted = true;\nexport { message };\n",
    'utf8',
  );
  await writeFile(join(projectRoot, 'src', 'nested', 'message.ts'), "export const message = 'one';\n", 'utf8');
}

describe('plugin development source observation', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { __pluginObserverExecuted?: boolean }).__pluginObserverExecuted;
  });

  it('validates and inventories the source/dependency closure without importing plugin modules', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-observer-'));
    try {
      await writeProject(projectRoot);
      const canonicalProjectRoot = await realpath(projectRoot);
      const observation = await inspectPluginDevelopmentSource({
        projectRoot,
        sdkRegistryOrigin: 'https://registry.example.test',
      });

      expect(observation).toMatchObject({
        ok: true,
        request: {
          kind: 'development',
          pluginId: 'acme.observer',
          projectRoot: canonicalProjectRoot,
          sdkRegistryOrigin: 'https://registry.example.test',
        },
      });
      if (!observation.ok) return;
      expect(observation.developmentEntryPath).toBe(join(canonicalProjectRoot, 'src', 'index.ts'));
      expect(observation.observedRelativePaths).toEqual(expect.arrayContaining([
        '.happier-plugin/plugin.json',
        'package.json',
        'src/index.ts',
        'src/nested/message.ts',
      ]));
      expect(observation.declaredDependencies).toEqual({ '@happier-dev/plugin-sdk': '0.1.0' });
      expect((globalThis as { __pluginObserverExecuted?: boolean }).__pluginObserverExecuted).toBeUndefined();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves the declared development entry through the canonical portable path contract', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-portable-entry-'));
    try {
      await writeProject(projectRoot);
      const manifestPath = join(projectRoot, '.happier-plugin', 'plugin.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        entrypoints: { daemon: string; development: string };
      };
      manifest.entrypoints.development = '.\\src\\index.ts';
      await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

      const canonicalProjectRoot = await realpath(projectRoot);
      await expect(inspectPluginDevelopmentSource({ projectRoot })).resolves.toMatchObject({
        ok: true,
        developmentEntryPath: join(canonicalProjectRoot, 'src', 'index.ts'),
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('observes transitive edits and newly created nested modules with portable directory watches', async () => {
    vi.useFakeTimers();
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-watch-'));
    const callbacks = new Map<string, (changedPath: string) => void>();
    const stopped = new Map<string, ReturnType<typeof vi.fn>>();
    const startWatchingDirectory: StartWatchingPluginDirectory = (directoryPath, onChange) => {
      callbacks.set(directoryPath, onChange);
      const stop = vi.fn();
      stopped.set(directoryPath, stop);
      return stop;
    };
    try {
      await writeProject(projectRoot);
      const canonicalProjectRoot = await realpath(projectRoot);
      const observations: string[][] = [];
      const handle = await startPluginDevelopmentSourceObserver({
        projectRoot,
        debounceMs: 10,
        startWatchingDirectory,
        onObservation: async (observation) => {
          if (observation.ok) observations.push([...observation.observedRelativePaths]);
        },
      });

      expect(observations).toHaveLength(1);
      await writeFile(join(projectRoot, 'src', 'nested', 'message.ts'), "export const message = 'two';\n", 'utf8');
      callbacks.get(join(canonicalProjectRoot, 'src', 'nested'))?.(join(canonicalProjectRoot, 'src', 'nested', 'message.ts'));
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(observations).toHaveLength(2));

      await mkdir(join(projectRoot, 'src', 'new', 'deep'), { recursive: true });
      await writeFile(join(projectRoot, 'src', 'new', 'deep', 'module.ts'), "export const value = 1;\n", 'utf8');
      callbacks.get(join(canonicalProjectRoot, 'src'))?.(join(canonicalProjectRoot, 'src', 'new'));
      await vi.advanceTimersByTimeAsync(10);

      await vi.waitFor(() => expect(observations.at(-1)).toContain('src/new/deep/module.ts'));
      expect(callbacks.has(join(canonicalProjectRoot, 'src', 'new'))).toBe(true);
      expect(callbacks.has(join(canonicalProjectRoot, 'src', 'new', 'deep'))).toBe(true);

      handle.stop();
      expect([...stopped.values()].every((stop) => stop.mock.calls.length === 1)).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('observes transitive edits and newly created nested modules through the real filesystem watcher', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-source-watch-live-'));
    try {
      await writeProject(projectRoot);
      const observations: string[][] = [];
      const handle = await startPluginDevelopmentSourceObserver({
        projectRoot,
        debounceMs: 25,
        onObservation: async (observation) => {
          if (observation.ok) observations.push([...observation.observedRelativePaths]);
        },
      });

      try {
        expect(observations).toHaveLength(1);
        await new Promise<void>((resolveReady) => setTimeout(resolveReady, 100));

        await writeFile(join(projectRoot, 'src', 'nested', 'message.ts'), "export const message = 'live-two';\n", 'utf8');
        await vi.waitFor(
          () => expect(observations.length).toBeGreaterThan(1),
          { timeout: 10_000, interval: 50 },
        );
        const afterTransitiveEdit = observations.length;

        await mkdir(join(projectRoot, 'src', 'live-new', 'deep'), { recursive: true });
        await writeFile(
          join(projectRoot, 'src', 'live-new', 'deep', 'module.ts'),
          "export const value = 'live';\n",
          'utf8',
        );
        await vi.waitFor(
          () => expect(
            observations.slice(afterTransitiveEdit).some((paths) => paths.includes('src/live-new/deep/module.ts')),
          ).toBe(true),
          { timeout: 10_000, interval: 50 },
        );
      } finally {
        handle.stop();
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 25_000);
});

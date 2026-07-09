import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installPluginFromLocator } from '@/plugins/projection/catalog/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { createPluginReloadController, type PluginReloadResult } from '@/plugins/runtime/reload/controller';
import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const PLUGIN_ID = 'acme.devloop';
const ACTION_ID = `${PLUGIN_ID}.hello`;
const HOOK_ID = 'session.message.send';

async function writeDevLoopPlugin(rootDir: string, message: string): Promise<void> {
  await mkdir(join(rootDir, '.happier-plugin'), { recursive: true });
  await mkdir(join(rootDir, 'src'), { recursive: true });
  await mkdir(join(rootDir, 'dist'), { recursive: true });
  await writeFile(
    join(rootDir, '.happier-plugin', 'plugin.json'),
    JSON.stringify({
      schemaVersion: 2,
      id: PLUGIN_ID,
      version: '1.0.0',
      displayName: 'Acme Dev Loop',
      description: 'Exercises TypeScript dev reload',
      engines: { happier: '^0.2.0' },
      uses: ['actions', 'hooks'],
      entrypoints: {
        main: './dist/index.js',
        dev: './src/index.ts',
      },
      permissions: {
        required: [],
        optional: [],
      },
      contributes: {
        actions: [{
          id: ACTION_ID,
          title: 'Dev Loop Hello',
          description: 'Returns the current dev-loop message',
          scopes: ['global'],
          surfaces: ['cli'],
          placement: 'commandPalette',
          dangerLevel: 'safe',
          handler: { target: 'plugin', registrationId: ACTION_ID },
        }],
        hooks: [{
          id: HOOK_ID,
          category: 'lifecycle',
          scope: 'session',
          executionKind: 'observe',
          handler: { target: 'plugin', registrationId: HOOK_ID },
        }],
      },
    }, null, 2),
    'utf8',
  );
  await writeFile(join(rootDir, 'dist', 'index.js'), createPluginModuleSource(message), 'utf8');
  await writeFile(join(rootDir, 'src', 'index.ts'), createPluginModuleSource(message), 'utf8');
}

function createPluginModuleSource(message: string): string {
  return [
    `const MESSAGE = ${JSON.stringify(message)};`,
    'const disposeTimer = setInterval(() => undefined, 10_000);',
    'disposeTimer.unref?.();',
    '',
    'export function activate(host) {',
    '  host.registerAction({',
    `    id: ${JSON.stringify(ACTION_ID)},`,
    '    handler: async () => ({',
    '      ok: true,',
    '      data: { message: MESSAGE },',
    '    }),',
    '  });',
    '  host.registerHook({',
    `    hookId: ${JSON.stringify(HOOK_ID)},`,
    '    handler: async () => ({ message: MESSAGE }),',
    '  });',
    '  host.onDispose(async () => {',
    '    clearInterval(disposeTimer);',
    '    const disposeLogPath = process.env.HAPPIER_DEVLOOP_RELOAD_DISPOSE_LOG;',
    '    if (disposeLogPath) {',
    '      const { appendFile } = await import("node:fs/promises");',
    '      await appendFile(disposeLogPath, `${MESSAGE}\\n`, "utf8");',
    '    }',
    '  });',
    '}',
    '',
  ].join('\n');
}

async function invokeHello(
  registry: ResolvedExecutablePluginRuntimeRegistry,
): Promise<unknown> {
  const handler = registry.actionHandlersByActionId.get(ACTION_ID);
  expect(handler).toEqual(expect.any(Function));
  return await handler?.({
    actionId: ACTION_ID,
    pluginId: PLUGIN_ID,
    input: {},
    context: { surface: 'cli' },
    provenance: {},
  });
}

async function readDisposeMessages(path: string): Promise<readonly string[]> {
  try {
    const content = await readFile(path, 'utf8');
    return Object.freeze(content.split('\n').filter((line) => line.length > 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Object.freeze([]);
    }
    throw error;
  }
}

function expectSingleGenerationRegistrations(
  registry: ResolvedExecutablePluginRuntimeRegistry,
): void {
  expect([...registry.actionHandlersByActionId.keys()]).toEqual([ACTION_ID]);
  expect(registry.hookHandlersByHookId.get(HOOK_ID)).toHaveLength(1);
}

function assertReloadOk(result: PluginReloadResult): asserts result is Extract<PluginReloadResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(JSON.stringify({
      diagnostics: result.diagnostics,
      diagnosticsByPluginId: result.diagnosticsByPluginId,
    }, null, 2));
  }
}

describe('plugin dev-loop reload integration', () => {
  it('loads the TypeScript dev entry, activates edits, and rolls syntax errors back to last-known-good', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-devloop-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-devloop-root-'));

    try {
      await writeDevLoopPlugin(pluginRoot, 'one');
      const install = await installPluginFromLocator({
        locator: pluginRoot,
        happyHomeDir,
        skipIfInstalled: true,
        dev: true,
      });
      expect(install.ok).toBe(true);

      const controller = createPluginReloadController({
        happyHomeDir,
        resolveRuntimeRegistry: async () => {
          const pluginContributes = await resolvePluginContributes({ happyHomeDir });
          return await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry(pluginContributes),
          });
        },
      });

      const first = await controller.reload({ pluginId: PLUGIN_ID });
      assertReloadOk(first);
      expect(first).toMatchObject({ ok: true, registryStatus: 'active', generation: 1 });
      await expect(invokeHello(first.registry)).resolves.toEqual({
        ok: true,
        data: { message: 'one' },
      });

      await writeFile(join(pluginRoot, 'src', 'index.ts'), createPluginModuleSource('two'), 'utf8');
      const second = await controller.reload({ pluginId: PLUGIN_ID });
      assertReloadOk(second);
      expect(second).toMatchObject({ ok: true, registryStatus: 'active', generation: 2 });
      await expect(invokeHello(second.registry)).resolves.toEqual({
        ok: true,
        data: { message: 'two' },
      });

      await writeFile(join(pluginRoot, 'src', 'index.ts'), 'export function activate(', 'utf8');
      const failed = await controller.reload({ pluginId: PLUGIN_ID });
      assertReloadOk(failed);
      expect(failed).toMatchObject({
        ok: true,
        generation: 2,
        attemptedGeneration: 3,
        registryStatus: 'last_known_good',
      });
      expect(await invokeHello(failed.registry)).toEqual({
        ok: true,
        data: { message: 'two' },
      });
      expect(JSON.stringify(failed.diagnosticsByPluginId[PLUGIN_ID] ?? [])).toMatch(/activate|Unexpected|Parse|Syntax/i);

      await writeFile(join(pluginRoot, 'src', 'index.ts'), createPluginModuleSource('three'), 'utf8');
      const recovered = await controller.reload({ pluginId: PLUGIN_ID });
      assertReloadOk(recovered);
      expect(recovered).toMatchObject({ ok: true, registryStatus: 'active', generation: 3 });
      await expect(invokeHello(recovered.registry)).resolves.toEqual({
        ok: true,
        data: { message: 'three' },
      });

      await controller.shutdown({ timeoutMs: 100 });
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('keeps stale handlers inert and avoids registration/disposable growth across repeated reloads', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-devloop-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-plugin-devloop-root-'));
    const disposeLogPath = join(pluginRoot, 'dispose.log');
    const originalDisposeLogPath = process.env.HAPPIER_DEVLOOP_RELOAD_DISPOSE_LOG;

    process.env.HAPPIER_DEVLOOP_RELOAD_DISPOSE_LOG = disposeLogPath;
    try {
      await writeDevLoopPlugin(pluginRoot, 'generation-0');
      const install = await installPluginFromLocator({
        locator: pluginRoot,
        happyHomeDir,
        skipIfInstalled: true,
        dev: true,
      });
      expect(install.ok).toBe(true);

      const controller = createPluginReloadController({
        happyHomeDir,
        resolveRuntimeRegistry: async () => {
          const pluginContributes = await resolvePluginContributes({ happyHomeDir });
          return await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry(pluginContributes),
          });
        },
      });

      let current = await controller.reload({ pluginId: PLUGIN_ID });
      assertReloadOk(current);
      expectSingleGenerationRegistrations(current.registry);
      await expect(invokeHello(current.registry)).resolves.toEqual({
        ok: true,
        data: { message: 'generation-0' },
      });

      for (let index = 1; index <= 20; index += 1) {
        const previousActionHandler = current.registry.actionHandlersByActionId.get(ACTION_ID);
        const previousHookHandler = current.registry.hookHandlersByHookId.get(HOOK_ID)?.[0]?.handler;
        const message = `generation-${index}`;
        await writeFile(join(pluginRoot, 'src', 'index.ts'), createPluginModuleSource(message), 'utf8');

        current = await controller.reload({ pluginId: PLUGIN_ID });
        assertReloadOk(current);
        expect(current).toMatchObject({
          ok: true,
          registryStatus: 'active',
          generation: index + 1,
        });
        expectSingleGenerationRegistrations(current.registry);
        await expect(invokeHello(current.registry)).resolves.toEqual({
          ok: true,
          data: { message },
        });
        await expect(previousActionHandler?.({
          actionId: ACTION_ID,
          pluginId: PLUGIN_ID,
          input: {},
          context: { surface: 'cli' },
          provenance: {},
        })).rejects.toThrow(/no longer active/i);
        await expect(previousHookHandler?.({ payload: { index } })).rejects.toThrow(/no longer active/i);
        await expect(readDisposeMessages(disposeLogPath)).resolves.toHaveLength(index);
      }

      await controller.shutdown({ timeoutMs: 100 });
      await expect(readDisposeMessages(disposeLogPath)).resolves.toHaveLength(21);
    } finally {
      if (originalDisposeLogPath === undefined) {
        delete process.env.HAPPIER_DEVLOOP_RELOAD_DISPOSE_LOG;
      } else {
        process.env.HAPPIER_DEVLOOP_RELOAD_DISPOSE_LOG = originalDisposeLogPath;
      }
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });
});

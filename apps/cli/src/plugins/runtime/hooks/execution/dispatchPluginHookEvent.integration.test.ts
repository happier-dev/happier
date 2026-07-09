import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import { createPluginStateStore } from '@/plugins/store/state';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolvePluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { resolvePluginHookHandlerRegistry } from '@/plugins/runtime/resolvePluginHookHandlerRegistry';

import { dispatchPluginHookEvent } from './dispatchPluginHookEvent';

async function writeHookPluginFixture(params: Readonly<{
  pluginRoot: string;
  hookId?: string;
  description?: string;
}>): Promise<void> {
  const hookId = params.hookId ?? 'session.message.send';
  const manifestDir = join(params.pluginRoot, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });

  await writeFile(
    join(params.pluginRoot, 'daemon.mjs'),
    [
      "import { writeFile } from 'node:fs/promises';",
      '',
      'const markerPath = process.env.HOOK_MARKER_PATH;',
      '',
      'export async function recordHookInvocation(event) {',
      '  if (!markerPath) {',
      '    throw new Error("Missing HOOK_MARKER_PATH");',
      '  }',
      '',
      '  await writeFile(markerPath, JSON.stringify(event, null, 2), "utf8");',
      '  return "session-message-hook-fired";',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      createPluginManifestV2Fixture({
        schemaVersion: 2,
        id: 'acme.session.hook',
        version: '1.0.0',
        displayName: 'Acme Session Hook',
        description: params.description ?? 'Exercises product-owned hook dispatch through session.message.send',
        engines: {
          happier: '^0.2.0',
        },
        uses: ['hooks'],
        entrypoints: {
          main: './daemon.mjs',
        },
        contributes: {
          hooks: [
            {
              hookApiVersion: 1,
              id: hookId,
              category: 'lifecycle',
              scope: 'session',
              executionKind: 'observe',
              filters: {
                sessionId: 'sess-1',
                eventNames: [hookId],
              },
              handler: {
                target: 'plugin',
                exportName: 'recordHookInvocation',
              },
            },
          ],
        },
      }),
      null,
      2,
    ),
    'utf8',
  );
}

async function writeEnabledLocalPathPluginState(params: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  pluginId: string;
}>): Promise<void> {
  const stateDir = join(params.happyHomeDir, 'plugins', 'plugins', 'state');
  const installedDir = join(params.happyHomeDir, 'plugins', 'plugins', 'installed');
  const cacheDir = join(params.happyHomeDir, 'plugins', 'plugins', 'cache');
  const logsDir = join(params.happyHomeDir, 'plugins', 'plugins', 'logs');
  const locksDir = join(params.happyHomeDir, 'plugins', 'plugins', 'locks');

  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(installedDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    mkdir(locksDir, { recursive: true }),
  ]);

  await writeFile(
    join(stateDir, 'plugin-state.v1.json'),
    JSON.stringify(
      {
        t: 'happier_plugin_state_v1',
        schemaVersion: 1,
        plugins: {
          [params.pluginId]: {
            source: {
              kind: 'path',
              locator: params.pluginRoot,
              trustPolicy: 'local_trusted',
              installPolicy: 'link',
              resolvedPath: params.pluginRoot,
              manifestPath: join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
            },
            compatibility: {
              status: 'unknown',
              diagnostics: [],
            },
            install: {
              mode: 'link',
              manifestVersion: '1.0.0',
              manifestDigest: null,
              installedPath: null,
            },
            state: {
              enabled: true,
            },
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function resolveFixtureRuntimeRegistry(happyHomeDir: string) {
  const pluginContributes = await resolvePluginContributes({
    happyHomeDir,
    existingProviderIds: new Set(),
    existingBackendIds: new Set(),
  });
  const contributes = createResolvedContributionRegistry(pluginContributes);
  const hookHandlerRegistry = await resolvePluginHookHandlerRegistry({
    registry: contributes,
  });
  return {
    hookHandlersByHookId: hookHandlerRegistry.handlersByHookId,
    readHookEventEnvelopeV1,
  };
}

describe('dispatchPluginHookEvent (integration)', () => {
  it('executes a supported session.message.send hook from the product hook dispatch surface', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-marker-'));
    const markerPath = join(markerDir, 'hook-fired.json');

    try {
      process.env.HOOK_MARKER_PATH = markerPath;

      await writeHookPluginFixture({
        pluginRoot,
        hookId: 'session.message.send',
        description: 'Exercises product-owned hook dispatch through session.message.send',
      });
      await writeEnabledLocalPathPluginState({
        happyHomeDir,
        pluginRoot,
        pluginId: 'acme.session.hook',
      });

      const runtimeRegistry = await resolveFixtureRuntimeRegistry(happyHomeDir);
      const result = await dispatchPluginHookEvent({
        runtimeRegistry,
        event: {
          hookVersion: 1,
          eventId: 'session.message.send',
          category: 'lifecycle',
          scope: 'session',
          happySessionId: 'sess-1',
          machineId: 'machine-1',
          cwd: '/repo',
          timestampMs: 1,
          payload: {
            sessionId: 'sess-1',
            text: 'hello world',
            source: 'user',
            timestampMs: 1,
          },
        },
      });

      expect(result).toEqual(expect.objectContaining({
        eventId: 'session.message.send',
        matchedHandlerCount: 1,
      }));
      expect(await readFile(markerPath, 'utf8')).toContain('"eventId": "session.message.send"');
      expect(await readFile(markerPath, 'utf8')).toContain('"happySessionId": "sess-1"');
    } finally {
      delete process.env.HOOK_MARKER_PATH;
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('does not execute hooks whose product filters do not match the session send event', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-marker-'));
    const markerPath = join(markerDir, 'hook-fired.json');

    try {
      process.env.HOOK_MARKER_PATH = markerPath;

      await writeHookPluginFixture({ pluginRoot });
      await writeEnabledLocalPathPluginState({
        happyHomeDir,
        pluginRoot,
        pluginId: 'acme.session.hook',
      });

      const runtimeRegistry = await resolveFixtureRuntimeRegistry(happyHomeDir);
      const result = await dispatchPluginHookEvent({
        runtimeRegistry,
        event: {
          hookVersion: 1,
          eventId: 'session.message.send',
          category: 'lifecycle',
          scope: 'session',
          happySessionId: 'sess-2',
          machineId: 'machine-1',
          cwd: '/repo',
          timestampMs: 1,
          payload: {
            sessionId: 'sess-2',
            text: 'hello world',
            source: 'user',
            timestampMs: 1,
          },
        },
      });

      expect(result).toEqual(expect.objectContaining({
        eventId: 'session.message.send',
        matchedHandlerCount: 0,
      }));
      await expect(readFile(markerPath, 'utf8')).rejects.toThrow();
    } finally {
      delete process.env.HOOK_MARKER_PATH;
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('executes a supported session.spawned hook from the product hook dispatch surface', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-marker-'));
    const markerPath = join(markerDir, 'hook-fired.json');

    try {
      process.env.HOOK_MARKER_PATH = markerPath;

      await writeHookPluginFixture({
        pluginRoot,
        hookId: 'session.spawned',
        description: 'Exercises product-owned hook dispatch through session.spawned',
      });
      await writeEnabledLocalPathPluginState({
        happyHomeDir,
        pluginRoot,
        pluginId: 'acme.session.hook',
      });

      const runtimeRegistry = await resolveFixtureRuntimeRegistry(happyHomeDir);
      const result = await dispatchPluginHookEvent({
        runtimeRegistry,
        event: {
          hookVersion: 1,
          eventId: 'session.spawned',
          category: 'lifecycle',
          scope: 'session',
          happySessionId: 'sess-1',
          machineId: 'machine-1',
          cwd: '/repo',
          backendTarget: 'agent:claude',
          timestampMs: 1,
          payload: {
            sessionId: 'sess-1',
            agentId: 'claude',
            runtimeTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            path: '/repo',
            backendTargetKey: 'agent:claude',
            modelId: 'gpt-4o',
            title: 'My title',
            timestampMs: 1,
          },
        },
      });

      expect(result).toEqual(expect.objectContaining({
        eventId: 'session.spawned',
        matchedHandlerCount: 1,
      }));
      expect(await readFile(markerPath, 'utf8')).toContain('"eventId": "session.spawned"');
      expect(await readFile(markerPath, 'utf8')).toContain('"happySessionId": "sess-1"');
    } finally {
      delete process.env.HOOK_MARKER_PATH;
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });
});

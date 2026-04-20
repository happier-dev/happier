import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPluginStateStore } from '@/extensions/store/state';
import { resolveExecutablePluginRuntimeRegistry } from '@/extensions/runtime/resolveExecutablePluginRuntimeRegistry';

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
      {
        schemaVersion: 2,
        id: 'acme.session.hook',
        version: '1.0.0',
        displayName: 'Acme Session Hook',
        description: params.description ?? 'Exercises product-owned hook dispatch through session.message.send',
        engines: {
          happier: '^0.2.0',
        },
        runtime: {
          apiVersion: 1,
          capabilities: ['hooks'],
        },
        targets: {
          daemon: {
            entry: './daemon.mjs',
          },
        },
        permissions: [],
        contributions: [
          {
            kind: 'hook',
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
  const stateDir = join(params.happyHomeDir, 'extensions', 'plugins', 'state');
  const installedDir = join(params.happyHomeDir, 'extensions', 'plugins', 'installed');
  const cacheDir = join(params.happyHomeDir, 'extensions', 'plugins', 'cache');
  const logsDir = join(params.happyHomeDir, 'extensions', 'plugins', 'logs');
  const locksDir = join(params.happyHomeDir, 'extensions', 'plugins', 'locks');

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

      const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
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
            messageLength: 11,
            wait: false,
            timeoutSeconds: 30,
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

      const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
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
            messageLength: 11,
            wait: false,
            timeoutSeconds: 30,
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

  it('executes a supported session.spawn_new hook from the product hook dispatch surface', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-hook-dispatch-marker-'));
    const markerPath = join(markerDir, 'hook-fired.json');

    try {
      process.env.HOOK_MARKER_PATH = markerPath;

      await writeHookPluginFixture({
        pluginRoot,
        hookId: 'session.spawn_new',
        description: 'Exercises product-owned hook dispatch through session.spawn_new',
      });
      await writeEnabledLocalPathPluginState({
        happyHomeDir,
        pluginRoot,
        pluginId: 'acme.session.hook',
      });

      const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir });
      const result = await dispatchPluginHookEvent({
        runtimeRegistry,
        event: {
          hookVersion: 1,
          eventId: 'session.spawn_new',
          category: 'lifecycle',
          scope: 'session',
          happySessionId: 'sess-1',
          machineId: 'machine-1',
          cwd: '/repo',
          backendTarget: 'agent:claude',
          timestampMs: 1,
          payload: {
            sessionId: 'sess-1',
            path: '/repo',
            backendTargetKey: 'agent:claude',
            modelId: 'gpt-4o',
            title: 'My title',
          },
        },
      });

      expect(result).toEqual(expect.objectContaining({
        eventId: 'session.spawn_new',
        matchedHandlerCount: 1,
      }));
      expect(await readFile(markerPath, 'utf8')).toContain('"eventId": "session.spawn_new"');
      expect(await readFile(markerPath, 'utf8')).toContain('"happySessionId": "sess-1"');
    } finally {
      delete process.env.HOOK_MARKER_PATH;
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });
});

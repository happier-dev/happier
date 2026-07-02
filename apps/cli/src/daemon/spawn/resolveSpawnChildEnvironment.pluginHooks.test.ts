import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveSpawnChildEnvironment } from './resolveSpawnChildEnvironment';

async function writeLocalExtensionPackageFixture(params: Readonly<{
  pluginRoot: string;
  daemonModuleContents: string;
  manifest: Record<string, unknown>;
}>): Promise<void> {
  const manifestDir = join(params.pluginRoot, '.happier-plugin');
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(params.pluginRoot, 'daemon.mjs'), params.daemonModuleContents, 'utf8');
  await writeFile(join(manifestDir, 'plugin.json'), JSON.stringify(params.manifest, null, 2), 'utf8');
}

async function writeEnabledLocalExtensionPackageState(params: Readonly<{
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

async function writeSpawnHookPluginFixture(params: Readonly<{
  pluginRoot: string;
  pluginId: string;
  markerPath: string;
}>): Promise<void> {
  await writeLocalExtensionPackageFixture({
    pluginRoot: params.pluginRoot,
    daemonModuleContents: [
      'import { appendFile } from "node:fs/promises";',
      '',
      'export async function validateSpawn(event = {}, context = {}) {',
      `  await appendFile(${JSON.stringify(params.markerPath)}, JSON.stringify({ type: "decision", event, hasToolContext: typeof context?.tools?.resolveManagedInstallable === "function" }, null, 2) + "\\n", "utf8");`,
      '  return { allowed: true };',
      '}',
      '',
      'export async function augmentSpawnEnv(event = {}, context = {}) {',
      `  await appendFile(${JSON.stringify(params.markerPath)}, JSON.stringify({ type: "augment", event, hasToolContext: typeof context?.tools?.resolveManagedInstallable === "function" }, null, 2) + "\\n", "utf8");`,
      '  return { HAPPIER_PLUGIN_SPAWN_ENV: "plugin-hook" };',
      '}',
      '',
    ].join('\n'),
    manifest: {
      schemaVersion: 2,
      id: params.pluginId,
      version: '1.0.0',
      displayName: 'Spawn Hook Fixture',
      description: 'Exercises daemon spawn hook dispatch through resolveSpawnChildEnvironment',
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
      capabilities: { permissions: [] },
      contributes: {
        hooks: [
          {
            hookApiVersion: 1,
            id: 'backend.resolveRuntimePrerequisites',
            category: 'decision',
            scope: 'backend',
            executionKind: 'decide',
            handler: {
              target: 'plugin',
              exportName: 'validateSpawn',
            },
          },
          {
            hookApiVersion: 1,
            id: 'spawn.augmentEnv',
            category: 'augmentation',
            scope: 'daemon',
            executionKind: 'augment',
            handler: {
              target: 'plugin',
              exportName: 'augmentSpawnEnv',
            },
          },
        ],
      },
    },
  });
}

describe('resolveSpawnChildEnvironment (plugin hooks)', () => {
  it('runs plugin-owned spawn prerequisite and env augmentation hooks through the executable runtime registry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-marker-'));
    const markerPath = join(markerDir, 'spawn-hook-events.jsonl');
    const pluginId = 'acme.spawn.hook';

    try {
      await writeSpawnHookPluginFixture({
        pluginRoot,
        pluginId,
        markerPath,
      });
      await writeEnabledLocalExtensionPackageState({
        happyHomeDir,
        pluginRoot,
        pluginId,
      });

      const options: SpawnSessionOptions = {
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        codexBackendMode: 'appServer',
      };

      const result = await resolveSpawnChildEnvironment({
        happyHomeDir,
        options,
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: {},
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.extraEnvForChild.HAPPIER_PLUGIN_SPAWN_ENV).toBe('plugin-hook');

      const marker = await readFile(markerPath, 'utf8');
      expect(marker).toContain('"type": "decision"');
      expect(marker).toContain('"type": "augment"');
      expect(marker).toContain('"eventId": "backend.resolveRuntimePrerequisites"');
      expect(marker).toContain('"eventId": "spawn.augmentEnv"');
      expect(marker).toContain('"backendTarget": "backend:codex"');
      expect(marker).toContain('"hasToolContext": true');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });
});

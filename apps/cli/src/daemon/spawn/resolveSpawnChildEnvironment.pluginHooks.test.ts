import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import {
  createPluginReloadController,
  type PluginReloadController,
  type PluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/controller';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
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

async function seedEnabledLocalExtensionPackageState(params: Readonly<{
  happyHomeDir: string;
  pluginRoot: string;
  pluginId: string;
}>): Promise<void> {
  await seedEnabledLocalExtensionPackageStates({
    happyHomeDir: params.happyHomeDir,
    plugins: [params],
  });
}

async function seedEnabledLocalExtensionPackageStates(params: Readonly<{
  happyHomeDir: string;
  plugins: readonly Readonly<{
    pluginRoot: string;
    pluginId: string;
  }>[];
}>): Promise<void> {
  for (const plugin of params.plugins) {
    await seedCurrentLocalPathPluginFixture({
      happyHomeDir: params.happyHomeDir,
      pluginRoot: plugin.pluginRoot,
      pluginId: plugin.pluginId,
      manifestVersion: '1.0.0',
    });
  }
}

type AppliedPluginRuntime = Readonly<{
  controller: PluginReloadController;
  lease: PluginRuntimeRegistryLease;
}>;

async function acquireAppliedPluginRuntime(happyHomeDir: string): Promise<AppliedPluginRuntime> {
  const controller = createPluginReloadController({ happyHomeDir });
  const lease = await controller.acquireRuntimeRegistry();
  if (lease.source !== 'active' || !controller.isRuntimeRegistryCurrent(lease.registry)) {
    await lease.release();
    await controller.shutdown();
    throw new Error('Spawn-hook fixture did not publish an active plugin runtime registry');
  }
  return { controller, lease };
}

async function releaseAppliedPluginRuntime(runtime: AppliedPluginRuntime | null): Promise<void> {
  if (!runtime) return;
  try {
    await runtime.lease.release();
  } finally {
    await runtime.controller.shutdown();
  }
}

async function writeSpawnHookPluginFixture(params: Readonly<{
  pluginRoot: string;
  pluginId: string;
  markerPath: string;
  denySpawn?: boolean;
  agentId?: string;
  registerDecisionHandler?: boolean;
  resolveInstallableInDecision?: string;
}>): Promise<void> {
  if (params.agentId) {
    await writeFile(
      join(params.pluginRoot, 'agentRuntime.mjs'),
      [
        'export function createSpawnHookAgentRuntime() {',
        '  return {',
        '    sessions: {',
        '      async open(request) {',
        '        return {',
        '          async send() { return { status: "admitted" }; },',
        '          watch() { return { dispose() {} }; },',
        '          async dispose() {},',
        '          sessionId: request.sessionId,',
        '        };',
        '      },',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  await writeLocalExtensionPackageFixture({
    pluginRoot: params.pluginRoot,
    daemonModuleContents: [
      'import { appendFile } from "node:fs/promises";',
      ...(params.agentId
        ? ['import { createSpawnHookAgentRuntime } from "./agentRuntime.mjs";']
        : []),
      '',
      'export async function validateSpawn(event = {}, context = {}) {',
      `  await appendFile(${JSON.stringify(params.markerPath)}, JSON.stringify({ type: "decision", event, hasToolContext: typeof context?.tools?.resolveManagedInstallable === "function", hasRunToolContext: typeof context?.tools?.runSystemTool === "function" }) + "\\n", "utf8");`,
      ...(params.resolveInstallableInDecision
        ? [
          `  const installable = await context.tools.resolveManagedInstallable({ installableId: ${JSON.stringify(params.resolveInstallableInDecision)}, reason: "spawn hook fixture" });`,
          `  await appendFile(${JSON.stringify(params.markerPath)}, JSON.stringify({ type: "installable", ok: installable?.ok ?? null, reasonCode: installable?.reasonCode ?? null }) + "\\n", "utf8");`,
        ]
        : []),
      ...(params.denySpawn
        ? ['  return { decision: "deny", reasonCode: "fixture_denied", errorMessage: "fixture spawn denied" };']
        : ['  return { decision: "allow" };']),
      '}',
      '',
      'export async function augmentSpawnEnv(event = {}, context = {}) {',
      `  await appendFile(${JSON.stringify(params.markerPath)}, JSON.stringify({ type: "augment", event, hasToolContext: typeof context?.tools?.resolveManagedInstallable === "function", hasRunToolContext: typeof context?.tools?.runSystemTool === "function" }) + "\\n", "utf8");`,
      '  return { HAPPIER_PLUGIN_SPAWN_ENV: "plugin-hook" };',
      '}',
      '',
      'export function activate(api) {',
      ...(params.agentId
        ? [
          `  api.agents.register(${JSON.stringify(params.agentId)}, createSpawnHookAgentRuntime, {`,
          '    sessionRunnerFactory: {',
          '      module: "./agentRuntime.mjs",',
          '      export: "createSpawnHookAgentRuntime",',
          '      runtimeApiVersion: 1,',
          '    },',
          '  });',
        ]
        : []),
      ...(params.registerDecisionHandler === false
        ? []
        : ['  api.hooks.register("resolve-prerequisites", validateSpawn);']),
      '  api.hooks.register("augment-spawn-env", augmentSpawnEnv);',
      '}',
      '',
    ].join('\n'),
    manifest: createPluginManifestV2Fixture({
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
      },
      entrypoints: {
        daemon: './daemon.mjs',
      },
      hostAccess: { required: [], optional: [] },
      contributes: {
        ...(params.agentId
          ? {
            agents: [
              {
                id: params.agentId,
                title: 'Spawn Hook Owner Fixture',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                  sessions: {
                    open: ['create', 'resume'],
                    delivery: ['newTurn'],
                    cancel: true,
                  },
                },
              },
            ],
          }
          : {}),
        hooks: [
          {
            hookApiVersion: 1,
            id: 'resolve-prerequisites',
            on: 'agent.resolvePrerequisites',
            category: 'decision',
            scope: 'agent',
            executionKind: 'decide',
          },
          {
            hookApiVersion: 1,
            id: 'augment-spawn-env',
            on: 'agent.spawnEnv.augment',
            category: 'augmentation',
            scope: 'daemon',
            executionKind: 'augment',
          },
        ],
      },
    }),
  });
}

async function readMarkerRecords(markerPath: string): Promise<ReadonlyArray<{
  type: string;
  event: Record<string, unknown>;
  hasToolContext?: boolean;
  hasRunToolContext?: boolean;
}>> {
  return (await readFile(markerPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      type: string;
      event: Record<string, unknown>;
      hasToolContext?: boolean;
      hasRunToolContext?: boolean;
    });
}

async function readOptionalMarkerRecords(markerPath: string): Promise<ReadonlyArray<Record<string, unknown>>> {
  try {
    return (await readFile(markerPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

describe('resolveSpawnChildEnvironment (plugin hooks)', () => {
  it('activates the copied bundled Codex prerequisite hook in a fresh daemon registry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-bundled-codex-spawn-hook-home-'));
    let appliedRuntime: AppliedPluginRuntime | null = null;

    try {
      appliedRuntime = await acquireAppliedPluginRuntime(happyHomeDir);

      const result = await resolveSpawnChildEnvironment({
        happyHomeDir,
        pluginRuntimeRegistry: appliedRuntime.lease.registry,
        options: {
          directory: '/repo',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          codexBackendMode: 'appServer',
        },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: { HAPPIER_CODEX_PATH: process.execPath },
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
      });

      expect(result).toMatchObject({ ok: true });
      expect(appliedRuntime.lease.registry.activatedPluginIds).toContain('happier.agent.codex');
      expect(
        appliedRuntime.lease.registry.hookHandlersByHookId.get('agent.resolvePrerequisites'),
      ).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'happier.agent.codex',
          localId: 'resolve-prerequisites',
          handler: expect.any(Function),
        }),
      ]));
    } finally {
      await releaseAppliedPluginRuntime(appliedRuntime);
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('runs plugin-owned spawn prerequisite and env augmentation hooks through the executable runtime registry', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-marker-'));
    const markerPath = join(markerDir, 'spawn-hook-events.jsonl');
    const pluginId = 'acme.spawn.hook';
    let appliedRuntime: AppliedPluginRuntime | null = null;

    try {
      await writeSpawnHookPluginFixture({
        pluginRoot,
        pluginId,
        markerPath,
      });
      await seedEnabledLocalExtensionPackageState({
        happyHomeDir,
        pluginRoot,
        pluginId,
      });
      appliedRuntime = await acquireAppliedPluginRuntime(happyHomeDir);

      const options: SpawnSessionOptions = {
        directory: '/repo',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        codexBackendMode: 'appServer',
      };

      const result = await resolveSpawnChildEnvironment({
        happyHomeDir,
        pluginRuntimeRegistry: appliedRuntime.lease.registry,
        options,
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: { HAPPIER_CODEX_PATH: process.execPath },
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.extraEnvForChild.HAPPIER_PLUGIN_SPAWN_ENV).toBe('plugin-hook');

      const records = await readMarkerRecords(markerPath);
      const decision = records.find((record) => record.type === 'decision');
      const augment = records.find((record) => record.type === 'augment');
      expect(decision?.event).toMatchObject({
        agentId: 'codex',
        backendId: 'codex',
        runtimeTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      });
      expect(augment?.event).toMatchObject({
        agentId: 'codex',
        backendId: 'codex',
        runtimeTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
      });
      expect(decision?.hasToolContext).toBe(true);
      expect(decision?.hasRunToolContext).toBe(true);
      expect(augment?.hasToolContext).toBe(true);
      expect(augment?.hasRunToolContext).toBe(true);
    } finally {
      await releaseAppliedPluginRuntime(appliedRuntime);
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('resolves spawn-hook tool installables without activating unrelated plugin daemon modules', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-tools-home-'));
    const targetPluginRoot = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-tools-target-root-'));
    const unrelatedPluginRoot = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-tools-unrelated-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-tools-marker-'));
    const targetMarkerPath = join(markerDir, 'target-events.jsonl');
    const unrelatedMarkerPath = join(markerDir, 'unrelated-imports.jsonl');
    let appliedRuntime: AppliedPluginRuntime | null = null;

    try {
      await writeSpawnHookPluginFixture({
        pluginRoot: targetPluginRoot,
        pluginId: 'acme.spawn.hook.tools.target',
        markerPath: targetMarkerPath,
        resolveInstallableInDecision: 'acme.missing-installable',
      });
      await writeLocalExtensionPackageFixture({
        pluginRoot: unrelatedPluginRoot,
        daemonModuleContents: [
          'import { appendFile } from "node:fs/promises";',
          `await appendFile(${JSON.stringify(unrelatedMarkerPath)}, JSON.stringify({ type: "imported" }) + "\\n", "utf8");`,
          'export async function validateSpawn() {',
          '  return { decision: "allow" };',
          '}',
          'export function activate(api) {',
          '  api.hooks.register("unrelated-prerequisite", validateSpawn);',
          '}',
          '',
        ].join('\n'),
        manifest: createPluginManifestV2Fixture({
          schemaVersion: 2,
          id: 'acme.spawn.hook.tools.unrelated',
          version: '1.0.0',
          displayName: 'Unrelated Spawn Hook Fixture',
          description: 'Must not be imported when another targeted spawn hook resolves installables.',
          engines: {
            happier: '^0.2.0',
          },
          runtime: {
            apiVersion: 1,
          },
          entrypoints: {
            daemon: './daemon.mjs',
          },
          hostAccess: { required: [], optional: [] },
          contributes: {
            hooks: [
              {
                hookApiVersion: 1,
                id: 'unrelated-prerequisite',
                on: 'agent.resolvePrerequisites',
                category: 'decision',
                scope: 'agent',
                executionKind: 'decide',
                filters: {
                  agentId: 'acme.unrelated',
                },
              },
            ],
          },
        }),
      });
      await seedEnabledLocalExtensionPackageStates({
        happyHomeDir,
        plugins: [
          {
            pluginRoot: targetPluginRoot,
            pluginId: 'acme.spawn.hook.tools.target',
          },
          {
            pluginRoot: unrelatedPluginRoot,
            pluginId: 'acme.spawn.hook.tools.unrelated',
          },
        ],
      });
      appliedRuntime = await acquireAppliedPluginRuntime(happyHomeDir);

      const result = await resolveSpawnChildEnvironment({
        happyHomeDir,
        pluginRuntimeRegistry: appliedRuntime.lease.registry,
        options: {
          directory: '/repo',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          codexBackendMode: 'appServer',
        },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: { HAPPIER_CODEX_PATH: process.execPath },
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
      });

      expect(result.ok).toBe(true);
      const targetRecords = await readOptionalMarkerRecords(targetMarkerPath);
      expect(targetRecords).toContainEqual({
        type: 'installable',
        ok: false,
        reasonCode: 'installable_unavailable',
      });
      expect(await readOptionalMarkerRecords(unrelatedMarkerPath)).toEqual([]);
    } finally {
      await releaseAppliedPluginRuntime(appliedRuntime);
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(targetPluginRoot, { recursive: true, force: true });
      await rm(unrelatedPluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('returns spawn validation failure when a plugin prerequisite hook denies launch', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-deny-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-deny-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-deny-marker-'));
    const markerPath = join(markerDir, 'spawn-hook-events.jsonl');
    const pluginId = 'acme.spawn.hook.deny';
    let appliedRuntime: AppliedPluginRuntime | null = null;

    try {
      await writeSpawnHookPluginFixture({
        pluginRoot,
        pluginId,
        markerPath,
        denySpawn: true,
      });
      await seedEnabledLocalExtensionPackageState({
        happyHomeDir,
        pluginRoot,
        pluginId,
      });
      appliedRuntime = await acquireAppliedPluginRuntime(happyHomeDir);

      const result = await resolveSpawnChildEnvironment({
        happyHomeDir,
        pluginRuntimeRegistry: appliedRuntime.lease.registry,
        options: {
          directory: '/repo',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          codexBackendMode: 'appServer',
        },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: { HAPPIER_CODEX_PATH: process.execPath },
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'fixture spawn denied',
      });

      const records = await readMarkerRecords(markerPath);
      expect(records.map((record) => record.type)).toEqual(['decision']);
    } finally {
      await releaseAppliedPluginRuntime(appliedRuntime);
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('returns spawn validation failure when a fail-closed plugin prerequisite hook handler is unresolved', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-missing-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-missing-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-missing-marker-'));
    const markerPath = join(markerDir, 'spawn-hook-events.jsonl');
    const pluginId = 'acme.spawn.hook.missing';
    let appliedRuntime: AppliedPluginRuntime | null = null;

    try {
      await writeSpawnHookPluginFixture({
        pluginRoot,
        pluginId,
        markerPath,
        registerDecisionHandler: false,
      });
      await seedEnabledLocalExtensionPackageState({
        happyHomeDir,
        pluginRoot,
        pluginId,
      });
      appliedRuntime = await acquireAppliedPluginRuntime(happyHomeDir);

      const result = await resolveSpawnChildEnvironment({
        happyHomeDir,
        pluginRuntimeRegistry: appliedRuntime.lease.registry,
        options: {
          directory: '/repo',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
          codexBackendMode: 'appServer',
        },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: { HAPPIER_CODEX_PATH: process.execPath },
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'SPAWN_VALIDATION_FAILED',
      });
      if (!result.ok) {
        expect(result.errorMessage).toMatch(/plugin.*prerequisite.*unavailable|plugin.*hook/i);
      }
    } finally {
      await releaseAppliedPluginRuntime(appliedRuntime);
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });

  it('sends owning agent identity for plugin spawn hooks', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-owner-home-'));
    const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-owner-root-'));
    const markerDir = await mkdtemp(join(tmpdir(), 'happier-spawn-hook-owner-marker-'));
    const markerPath = join(markerDir, 'spawn-hook-events.jsonl');
    const pluginId = 'acme.spawn.owner';
    const agentId = 'spawn-owner';
    const concreteBackendId = agentId;
    const backendTarget = {
      kind: 'backend',
      backendId: concreteBackendId,
      configuredBackendId: concreteBackendId,
      sourceKind: 'configured',
    } as const;
    let appliedRuntime: AppliedPluginRuntime | null = null;

    try {
      await writeSpawnHookPluginFixture({
        pluginRoot,
        pluginId,
        markerPath,
        agentId,
      });
      await seedEnabledLocalExtensionPackageState({
        happyHomeDir,
        pluginRoot,
        pluginId,
      });
      appliedRuntime = await acquireAppliedPluginRuntime(happyHomeDir);
      const registry = appliedRuntime.lease.registry.contributes;

      expect(registry.pluginDiagnosticsByPluginId[pluginId]).toEqual([]);
      expect(registry.agentDefinitionsById.get(agentId)?.definition.ownedBackendIds).toEqual([]);
      expect(registry).not.toHaveProperty('agentRuntimeDefinitionsById');

      const result = await resolveSpawnChildEnvironment({
        happyHomeDir,
        pluginRuntimeRegistry: appliedRuntime.lease.registry,
        options: {
          directory: '/repo',
          backendTarget,
        },
        profileEnvironmentVariables: {},
        daemonSpawnHooks: null,
        processEnv: {},
        logDebug: () => {},
        logInfo: () => {},
        logWarn: () => {},
        connectedServiceAuth: null,
      });

      if (!result.ok) {
        throw new Error(`${result.errorCode}: ${result.errorMessage}`);
      }
      expect(result.ok).toBe(true);

      const records = await readMarkerRecords(markerPath);
      const decision = records.find((record) => record.type === 'decision');
      const augment = records.find((record) => record.type === 'augment');

      expect(decision?.event).toMatchObject({
        agentId,
        backendId: concreteBackendId,
        targetRef: backendTarget,
        runtimeTarget: {
          kind: 'backend',
          backendId: concreteBackendId,
          configuredBackendId: concreteBackendId,
          sourceKind: 'configured',
        },
      });
      expect(augment?.event).toMatchObject({
        agentId,
        backendId: concreteBackendId,
        runtimeTarget: {
          kind: 'backend',
          backendId: concreteBackendId,
          configuredBackendId: concreteBackendId,
          sourceKind: 'configured',
        },
      });
    } finally {
      await releaseAppliedPluginRuntime(appliedRuntime);
      await rm(happyHomeDir, { recursive: true, force: true });
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(markerDir, { recursive: true, force: true });
    }
  });
});

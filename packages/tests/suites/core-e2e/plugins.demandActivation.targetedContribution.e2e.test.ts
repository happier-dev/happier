import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';
import { rehydratePluginContributionPointSemanticsV1 } from '@happier-dev/protocol/plugins/contributions/targeted';
import { resolveAdmittedTargetedContributions } from '../../../../apps/cli/src/plugins/projection/registry/targetedContributions';

import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import {
  applyTrustedLocalPluginFixture,
  buildPreAttestedExternalSessionLiveEnv,
  reloadTrustedLocalPluginFixture,
  uninstallTrustedLocalPluginFixture,
} from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';

const TARGET_PLUGIN_ID = 'acme.demand-activation-target';
const CONTRIBUTOR_PLUGIN_ID = 'acme.demand-activation-contributor';
const POINT_ID = 'providers';
const PROTOCOL_ID = 'acme.demand-activation/providers';
const PROTOCOL_VERSION = 1;
const TARGET_ACTION_LOCAL_ID = 'execute-provider';
const OPERATION_ROLE = 'setup';
const CONTRIBUTOR_SETUP_ACTION_LOCAL_ID = 'setup';

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

const CONTRIBUTOR_RESULT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['providerId', 'marker'],
  properties: {
    providerId: { type: 'string', minLength: 1 },
    marker: { type: 'string', minLength: 1 },
  },
} as const;

const CONTRIBUTOR_INPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const;

function baseManifest(input: Readonly<{
  pluginId: string;
  displayName: string;
}>): JsonRecord {
  return {
    schemaVersion: 2,
    id: input.pluginId,
    version: '1.0.0',
    displayName: input.displayName,
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './daemon.mjs' },
  };
}

function targetManifest(): JsonRecord {
  return {
    ...baseManifest({ pluginId: TARGET_PLUGIN_ID, displayName: 'Demand activation target' }),
    contributes: {
      actions: [{
        id: TARGET_ACTION_LOCAL_ID,
        title: 'Execute the contributed provider operation',
        scopes: ['global'],
        surfaces: ['cli'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
      }],
      pluginContributionPoints: [{
        id: POINT_ID,
        protocols: [{
          id: PROTOCOL_ID,
          version: PROTOCOL_VERSION,
          operations: {
            [OPERATION_ROLE]: {
              required: true,
              input: { kind: 'contributorDefined' },
              resultSchema: CONTRIBUTOR_RESULT_SCHEMA,
              action: { surfaces: ['plugin'], dangerLevel: 'safe' },
            },
          },
        }],
      }],
    },
  };
}

function contributorManifest(): JsonRecord {
  return {
    ...baseManifest({ pluginId: CONTRIBUTOR_PLUGIN_ID, displayName: 'Demand activation contributor' }),
    contributes: {
      actions: [{
        id: CONTRIBUTOR_SETUP_ACTION_LOCAL_ID,
        title: 'Set up the contributed provider',
        scopes: ['global'],
        surfaces: ['plugin'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
        inputSchema: CONTRIBUTOR_INPUT_SCHEMA,
        resultSchema: CONTRIBUTOR_RESULT_SCHEMA,
      }],
      targetedPluginContributions: [{
        id: 'demand-activation-contributor',
        target: { pluginId: TARGET_PLUGIN_ID, pointId: POINT_ID },
        protocol: { id: PROTOCOL_ID, version: PROTOCOL_VERSION },
        operations: { [OPERATION_ROLE]: CONTRIBUTOR_SETUP_ACTION_LOCAL_ID },
      }],
    },
  };
}

function targetDaemonModule(): string {
  return [
    'let retainedOperation = null;',
    'export function activate(api) {',
    `  api.actions.register(${JSON.stringify(TARGET_ACTION_LOCAL_ID)}, async (input, context) => {`,
    '    let operation = retainedOperation;',
    '    if (input?.useRetainedOperation !== true) {',
    '      const observation = context.services.targetedContributions.observeForSelf(',
    `        { targetPluginId: ${JSON.stringify(TARGET_PLUGIN_ID)}, id: ${JSON.stringify(POINT_ID)}, protocol: { id: ${JSON.stringify(PROTOCOL_ID)}, version: ${PROTOCOL_VERSION} } },`,
    '        { onInvalidated: () => {} },',
    '      );',
    '      try {',
    '        const snapshot = await observation.readCurrent({ signal: context.signal });',
    '        operation = snapshot.contributions[0]?.operations[' + JSON.stringify(OPERATION_ROLE) + '] ?? null;',
    '        if (operation) retainedOperation = operation;',
    '      } finally {',
    '        observation.dispose();',
    '      }',
    '    }',
    "    if (!operation) return { outcome: 'no-contributor' };",
    '    const result = await context.services.actions.executeAdmittedTargetedOperation(operation, {});',
    "    return { outcome: 'executed', result };",
    '  });',
    '}',
    '',
  ].join('\n');
}

function contributorDaemonModule(marker: string): string {
  return [
    'export function activate(api) {',
    `  api.actions.register(${JSON.stringify(CONTRIBUTOR_SETUP_ACTION_LOCAL_ID)}, async () => ({ providerId: 'github', marker: ${JSON.stringify(marker)} }));`,
    '}',
    '',
  ].join('\n');
}

async function writeFixturePlugin(params: Readonly<{
  pluginRoot: string;
  manifest: JsonRecord;
  daemonModule: string;
  pluginId: string;
}>): Promise<void> {
  await mkdir(join(params.pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(
    join(params.pluginRoot, '.happier-plugin', 'plugin.json'),
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(params.pluginRoot, 'daemon.mjs'), params.daemonModule, 'utf8');
  await writeFile(join(params.pluginRoot, 'package.json'), `${JSON.stringify({
    name: params.pluginId,
    version: '1.0.0',
    private: true,
    type: 'module',
  }, null, 2)}\n`, 'utf8');
}

async function executeTargetAction(params: Readonly<{
  daemon: StartedDaemon;
  useRetainedOperation?: boolean;
}>): Promise<JsonRecord> {
  const response = await daemonControlPostJson({
    port: params.daemon.state.httpPort,
    path: '/plugins/actions/execute',
    controlToken: params.daemon.state.controlToken,
    body: {
      actionId: `${TARGET_PLUGIN_ID}/${TARGET_ACTION_LOCAL_ID}`,
      input: params.useRetainedOperation === true ? { useRetainedOperation: true } : {},
      surface: 'cli',
    },
    timeoutMs: 30_000,
  });
  const data = asRecord(response.data);
  if (response.status !== 200 || data?.matched !== true) {
    throw new Error(`Demand activation execute failed (${JSON.stringify(response.data)})`);
  }
  const execution = asRecord(data.result) ?? {};
  // The daemon control route returns the canonical Action execution envelope.
  // Preserve typed execution failures for currentness assertions, while exposing
  // a successful Action's domain result to the lifecycle assertions below.
  return execution.ok === true
    ? asRecord(execution.result) ?? {}
    : execution;
}

describe('core e2e: plugin demand activation through the real daemon boundary', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await daemon?.stop().catch(() => undefined);
    daemon = null;
    await server?.stop().catch(() => undefined);
    server = null;
    for (const root of temporaryRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses a canonically rehydratable target protocol in the cold manifests', () => {
    const targetContributes = asRecord(targetManifest().contributes);
    const points = targetContributes?.pluginContributionPoints;
    const point = Array.isArray(points) ? asRecord(points[0]) : null;
    const protocols = point?.protocols;
    const candidate = Array.isArray(protocols) ? protocols[0] : null;
    expect(rehydratePluginContributionPointSemanticsV1(candidate as never)).not.toBeNull();

    const contributorContributes = asRecord(contributorManifest().contributes);
    const contributions = contributorContributes?.targetedPluginContributions;
    const contribution = Array.isArray(contributions) ? contributions[0] : null;
    const actions = contributorContributes?.actions;
    const action = Array.isArray(actions) ? actions[0] : null;
    const normalizedAction = asRecord(action);
    const admission = resolveAdmittedTargetedContributions({
      pluginContributionPoints: [{ pluginId: TARGET_PLUGIN_ID, definition: point }],
      targetedPluginContributions: [{ pluginId: CONTRIBUTOR_PLUGIN_ID, definition: contribution }],
      actions: [{
        pluginId: CONTRIBUTOR_PLUGIN_ID,
        definition: {
          ...normalizedAction,
          outputSchema: normalizedAction?.resultSchema,
          contributionSurfaces: normalizedAction?.surfaces,
        },
      }],
      uiRenderersV2: [],
      immutableGenerationIdsByPluginId: {
        [TARGET_PLUGIN_ID]: 'target-generation',
        [CONTRIBUTOR_PLUGIN_ID]: 'contributor-generation',
      },
    } as never);
    expect(admission.diagnosticsByPluginId).toEqual({});
    expect(admission.read({
      targetPluginId: TARGET_PLUGIN_ID,
      pointId: POINT_ID,
      protocol: { id: PROTOCOL_ID, version: PROTOCOL_VERSION },
    })?.contributions).toHaveLength(1);
  });

  it('demand-activates contributor B for target A and fences update, restart, uninstall, and reinstall to current generation C', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-demand-activation-e2e-'));
    temporaryRoots.push(testDir);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const targetRoot = resolve(join(testDir, 'target'));
    const contributorRoot = resolve(join(testDir, 'contributor'));
    await mkdir(daemonHomeDir, { recursive: true });
    await writeFixturePlugin({
      pluginRoot: targetRoot,
      manifest: targetManifest(),
      daemonModule: targetDaemonModule(),
      pluginId: TARGET_PLUGIN_ID,
    });
    await writeFixturePlugin({
      pluginRoot: contributorRoot,
      manifest: contributorManifest(),
      daemonModule: contributorDaemonModule('one'),
      pluginId: CONTRIBUTOR_PLUGIN_ID,
    });

    const preAttestedEnv = buildPreAttestedExternalSessionLiveEnv();
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: preAttestedEnv,
    });
    const auth = await createTestAuth(server.baseUrl);
    await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: server.baseUrl,
      auth,
      mode: 'dataKey',
    });
    const daemonEnv = {
      ...process.env,
      ...preAttestedEnv,
      CI: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      // This journey owns plugin lifecycle/currentness, not validation of the
      // separately covered isolated node_modules copier. The supported overlay
      // keeps the real daemon boundary runnable on the current dev-stack bytes.
      HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE: 'symlink',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
    });

    // Public target A installs alone; its point observes empty and the Action
    // reports a typed no-contributor outcome instead of crashing.
    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot: targetRoot,
      pluginId: TARGET_PLUGIN_ID,
      interactionId: 'demand-activation-target-install',
    });
    await reloadTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot: targetRoot,
      pluginId: TARGET_PLUGIN_ID,
      changedPaths: ['daemon.mjs'],
    });
    await expect(executeTargetAction({ daemon })).resolves.toEqual({ outcome: 'no-contributor' });

    // Contributor B installs and demand-activates only when A's Action crosses
    // the point; the daemon executes B's operation at B's exact applied
    // generation C.
    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot: contributorRoot,
      pluginId: CONTRIBUTOR_PLUGIN_ID,
      interactionId: 'demand-activation-contributor-install',
    });
    const contributorReload = await reloadTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot: contributorRoot,
      pluginId: CONTRIBUTOR_PLUGIN_ID,
      changedPaths: ['daemon.mjs'],
    });
    const exactGeneration = contributorReload.desiredGeneration;
    if (typeof exactGeneration !== 'string' || exactGeneration.length === 0) {
      throw new Error(`Contributor reload committed without a generation (${JSON.stringify(contributorReload)})`);
    }

    await expect(executeTargetAction({ daemon })).resolves.toEqual({
      outcome: 'executed',
      result: { providerId: 'github', marker: 'one' },
    });

    // Currentness: after B advances to generation C', the old C can no longer
    // execute the operation, and the fresh C' carries the new bytes.
    await writeFile(join(contributorRoot, 'daemon.mjs'), contributorDaemonModule('two'), 'utf8');
    const updatedReload = await reloadTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot: contributorRoot,
      pluginId: CONTRIBUTOR_PLUGIN_ID,
      changedPaths: ['daemon.mjs'],
    });
    const updatedGeneration = updatedReload.desiredGeneration;
    if (typeof updatedGeneration !== 'string' || updatedGeneration.length === 0) {
      throw new Error(`Contributor update committed without a generation (${JSON.stringify(updatedReload)})`);
    }
    await expect(executeTargetAction({
      daemon,
      useRetainedOperation: true,
    })).resolves.toMatchObject({ ok: false });

    await expect(executeTargetAction({
      daemon,
      // No expectation: the admitted current generation executes and proves
      // the reload actually replaced the contributor bytes.
    })).resolves.toEqual({
      outcome: 'executed',
      result: { providerId: 'github', marker: 'two' },
    });

    // A daemon replacement must rehydrate the committed generation and keep
    // the same exact currentness fence across the real daemon boundary.
    daemon = await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: daemonHomeDir,
      env: daemonEnv,
      originalDaemon: daemon,
    });
    await expect(executeTargetAction({ daemon })).resolves.toEqual({
      outcome: 'executed',
      result: { providerId: 'github', marker: 'two' },
    });

    await uninstallTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginId: CONTRIBUTOR_PLUGIN_ID,
    });
    await expect(executeTargetAction({
      daemon,
      useRetainedOperation: true,
    })).resolves.toMatchObject({ ok: false });
    await expect(executeTargetAction({ daemon })).resolves.toEqual({ outcome: 'no-contributor' });

    // Reinstalling the same source is a new materialization/generation. The
    // retired pre-uninstall handle stays refused while the current operation
    // remains reachable through the same public target contribution.
    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot: contributorRoot,
      pluginId: CONTRIBUTOR_PLUGIN_ID,
      interactionId: 'demand-activation-contributor-reinstall',
    });
    const reinstalledReload = await reloadTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot: contributorRoot,
      pluginId: CONTRIBUTOR_PLUGIN_ID,
      changedPaths: ['daemon.mjs'],
    });
    const reinstalledGeneration = reinstalledReload.desiredGeneration;
    if (typeof reinstalledGeneration !== 'string' || reinstalledGeneration.length === 0) {
      throw new Error(`Contributor reinstall committed without a generation (${JSON.stringify(reinstalledReload)})`);
    }
    expect(reinstalledGeneration).not.toBe(updatedGeneration);
    await expect(executeTargetAction({
      daemon,
      useRetainedOperation: true,
    })).resolves.toMatchObject({ ok: false });
    await expect(executeTargetAction({ daemon })).resolves.toEqual({
      outcome: 'executed',
      result: { providerId: 'github', marker: 'two' },
    });
  }, 600_000);
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildQualifiedPluginContributionKey, type PluginAgentContributionV2 } from '@happier-dev/protocol';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

import {
  resolveInactiveSessionCatalogControls,
  resolveInactiveSessionGoalControls,
  resolveInactiveSessionUsageLimitRecoveryControls,
} from './sessionControlAdapters';

const PLUGIN_ID = 'acme.external-controls';
const LOCAL_AGENT_ID = 'assistant';
const AGENT_ID = buildQualifiedPluginContributionKey({ pluginId: PLUGIN_ID, localId: LOCAL_AGENT_ID });

describe('inactive session control adapters for an externally contributed Agent', () => {
  let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  let directory: string | null = null;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'happier-external-inactive-controls-'));
    const pluginRoot = join(directory, 'plugin');
    const happyHomeDir = join(directory, 'home');
    const agent = {
      id: LOCAL_AGENT_ID,
      title: 'External controls Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'], delivery: ['newTurn'], cancel: true,
          goals: {
            inactive: { get: true, set: { fields: ['objective'] }, clear: true },
            source: 'goals',
          },
          catalog: { inactive: ['skills', 'vendorPlugins'] },
          usageLimitRecovery: { inactive: ['checkNow'] },
          workStateSources: [{ id: 'goals', itemKinds: ['goal'] }],
        },
      },
    } satisfies PluginAgentContributionV2;
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(
      createPluginManifestV2Fixture({ id: PLUGIN_ID, contributes: { agents: [agent] } }),
    ));
    await writeFile(join(pluginRoot, 'daemon.mjs'), [
      "const unavailableGoal = async () => ({ status: 'unavailable', diagnostic: { code: 'fixture_no_provider_session', severity: 'error' }, retryable: true });",
      "export async function createRuntime() {",
      "  return { sessions: {",
      "    async open() { return { send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'requested' }), watch: () => ({ dispose() {} }), dispose() {} }; },",
      "    goals: { get: unavailableGoal, set: unavailableGoal, clear: unavailableGoal },",
      "    catalog: { list: async request => ({ status: 'ok', kind: request.kind, items: [] }) },",
      "    usageLimitRecovery: { run: async () => ({ status: 'ready' }) },",
      "  } };",
      "}",
      "export function activate(api) {",
      "  api.agents.register('" + LOCAL_AGENT_ID + "', createRuntime, { sessionRunnerFactory: { module: './daemon.mjs', export: 'createRuntime', runtimeApiVersion: 1 } });",
      "}",
    ].join('\n'));
    await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId: PLUGIN_ID, manifestVersion: '1.0.0' });
    fixture = await createAdmittedPluginRuntimeFixture({
      happyHomeDir,
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: [PLUGIN_ID] },
    });
  });

  afterAll(async () => {
    try {
      await fixture?.dispose();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads the declared capabilities of an Agent only the current runtime registry knows about', async () => {
    await expect(resolveInactiveSessionGoalControls(AGENT_ID)).resolves.not.toBeNull();
    await expect(resolveInactiveSessionCatalogControls(AGENT_ID)).resolves.not.toBeNull();
    await expect(
      resolveInactiveSessionUsageLimitRecoveryControls(AGENT_ID),
    ).resolves.not.toBeNull();
  });

  it('still refuses an Agent that no registry generation declares', async () => {
    await expect(resolveInactiveSessionGoalControls('missing.agent')).resolves.toBeNull();
    await expect(resolveInactiveSessionCatalogControls('missing.agent')).resolves.toBeNull();
    await expect(
      resolveInactiveSessionUsageLimitRecoveryControls('missing.agent'),
    ).resolves.toBeNull();
  });
});

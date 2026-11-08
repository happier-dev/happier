import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

// Filesystem availability is the boundary: keep Triage's artifact unavailable
// while its real declaration, Account selection and Action admission stay live.
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]).replaceAll('\\', '/').endsWith('/triage/dist/happier-plugin-ui/ui-artifacts.json')) {
      throw new Error('Fixture Account artifact unavailable');
    }
    return actual.readFileSync(...args);
  } };
});

it('executes the Account Action returned by Session tool search through the same catalog', async () => {
  const home = await mkdtemp(join(tmpdir(), 'action-tool-catalog-'));
  const app = fastify();
  const { pluginId } = await registerAuthoredAccountActionRelease(app, 'owner');
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: 'http://action-tool-catalog.test' });
  try {
    const executor = createCliActionExecutor({ token: 'fixture',
      credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
      happyHomeDir: home, sessionId: 'catalog-session', mode: 'plain', ctx: null,
      getCurrentSessionMetadata: () => ({ path: '/repo', machineId: 'catalog-machine', workDepth: 0 }),
      serverId: 'action-tool-catalog', serverHttpBaseUrl: 'http://action-tool-catalog.test' });
    for (const surface of ['agent', 'mcp'] as const) {
      const bridge = createActionToolExecutorBridge({ surface, executor });
      const search = await bridge.executeActionByToolName('action_spec_search', { query: `${pluginId}/actions/echo` }, 'catalog-session');
      expect(search, JSON.stringify(search)).toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([
        expect.objectContaining({ id: `${pluginId}/actions/echo` }),
      ]) } });
      if (!search.ok) throw new Error('Expected successful discovery');
      const { actionSpecs } = z.object({ actionSpecs: z.array(z.object({ id: z.string() })) }).parse(search.result);
      const execution = await bridge.executeActionByToolName('action_execute', {
        actionId: actionSpecs.find(action => action.id === `${pluginId}/actions/echo`)!.id,
        input: { key: surface },
      }, 'catalog-session');
      expect(execution, JSON.stringify(execution)).toMatchObject({ ok: true, result: { key: surface, surface } });
    }
  } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
});

it('reads a bundled Account Action from the catalog that advertised it despite a different Machine development declaration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bundled-action-tool-catalog-'));
  const pluginId = 'happier.triage';
  const localId = 'entries/resolve-resource-v1';
  const id = `${pluginId}/actions/${localId}`;
  const declaration = loadCurrentBundledPluginLocatorResult({ pluginIds: [pluginId] }).loadedPlugins
    .find(plugin => plugin.pluginId === pluginId);
  if (!declaration) throw new Error('Missing bundled Triage declaration');
  const pluginRoot = join(home, 'triage-development');
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify({ ...declaration.manifest,
    contributes: { ...declaration.manifest.contributes,
      actions: declaration.manifest.contributes.actions.filter(action => action.id !== localId) } }));
  await writeFile(join(pluginRoot, '.happier-plugin/daemon.js'), 'export function activate() {}');
  await seedCurrentLocalPathPluginFixture({ happyHomeDir: home, pluginRoot, pluginId,
    manifestVersion: declaration.manifest.version, devWatch: true });
  const app = fastify();
  await registerAuthoredAccountActionRelease(app, 'owner', { includeBundledPluginIds: [pluginId] });
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  await app.ready();
  const restore = installAxiosFastifyAdapter({ app, origin: 'http://bundled-action-tool-catalog.test' });
  try {
    const machineCatalog = createActionExecutor(createUnavailableActionTransportDeps());
    const executor = createCliActionExecutor({ token: 'fixture',
      credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
      happyHomeDir: home, sessionId: 'catalog-session', mode: 'plain', ctx: null,
      getCurrentSessionMetadata: () => ({ path: '/repo', machineId: 'catalog-machine', workDepth: 0 }),
      serverId: 'bundled-action-tool-catalog', serverHttpBaseUrl: 'http://bundled-action-tool-catalog.test',
      // Only daemon IPC is replaced. Its catalog has no matching Machine Action;
      // preserve the real metadata owner's typed unknown_action refusal.
      requestPluginActionExecution: async request => request.actionId === 'action.spec.get'
        ? { matched: true, result: await machineCatalog.execute('action.spec.get', request.input, { surface: request.surface }) }
        : { matched: false },
    });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor });
    expect(await bridge.executeActionByToolName('action_spec_search', { query: id }, 'catalog-session'))
      .toMatchObject({ ok: true, result: { actionSpecs: expect.arrayContaining([expect.objectContaining({ id })]) } });
    expect(await bridge.executeActionByToolName('action_spec_get', { id }, 'catalog-session'))
      .toMatchObject({ ok: true, result: { actionSpec: { id } } });
    // Execution must reach Account custody and preserve its typed load cause,
    // rather than reinterpret the Machine catalog's absence as unknown_action.
    const result = await bridge.executeActionByToolName('action_execute', { actionId: id,
      input: { v: 1, resource: { kind: 'issue', url: 'https://github.com/example/repo/issues/1' } } }, 'catalog-session');
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'plugin_daemon_module_load_failed',
      details: { name: 'PluginError', code: 'plugin_daemon_module_load_failed',
        message: 'plugin_account_execution_artifact_unavailable' } });
  } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); }
});

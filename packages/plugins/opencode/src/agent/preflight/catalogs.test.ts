import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentPreflightSessionControlsContributionV1, AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ManagedServiceRequest, ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from './models.js';
import { materializeOpenCodeAuthEnvironment } from '../auth/services/materialize.js';
import { resolveOpenCodeConnectedConfigHomeDir, resolveOpenCodeRequestAuthPluginPath } from '../auth/services/requestAuth/assets.js';
import { buildOpenCodeRequestAuthMarker } from '../auth/services/requestAuth/source.js';
import { asRecord } from '../runtime/server/openCodeParsing.js';

function fixture(options: Readonly<{ generation?: string; version?: string; versionOk?: boolean; failSkills?: boolean; chatgptInventory?: boolean; emptyNativeInventory?: boolean; openaiBaseURL?: unknown }> = {}) {
  const requests: ManagedServiceRequest[] = [];
  const services: ManagedServiceSpec[] = [];
  let disposed = false;
  let ready = false;
  const context: AgentPreflightSessionControlsProbeContextV1 = {
    cwd: '/repo', accountSettings: { opencodeCliGeneration: options.generation ?? 'stable' },
    environment: {}, signal: new AbortController().signal,
    resolveDeclaredSystemTool: async () => ({ executablePath: '/usr/local/bin/opencode' }),
    runDeclaredSystemToolCommand: async () => ({ ok: options.versionOk ?? true, stdout: options.version ?? '1.18.33', stderr: '', exitCode: 0 }),
    probeDeclaredAcpCatalogs: async () => ({ commands: [{ name: 'acp-only' }], skills: null }),
    withDeclaredJsonRpcClient: async () => { throw new Error('JSON-RPC is not the native server boundary'); },
    withDeclaredManagedService: async (spec, inspect) => {
      services.push(spec);
      try {
        return await inspect({ request: async (request) => {
          requests.push(request);
          const route = new URL(request.pathAndQuery, 'http://opencode.invalid');
          const v2 = route.pathname.startsWith('/api/');
          if (v2) expect(route.searchParams.get('location[directory]')).toBe(context.cwd);
          if (route.pathname === '/api/integration') {
            ready = true;
            return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify({ data: [] })).body };
          }
          if (options.failSkills && route.pathname.endsWith('/skill')) throw new Error('skill transport failed');
          if (route.pathname === '/agent' || route.pathname === '/api/agent') {
            const modes = [{ name: 'build', description: 'Native build mode' }, { name: 'custom-review', description: 'Project mode' }];
            return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(v2 ? { data: modes } : modes)).body };
          }
          if (route.pathname === '/provider' || route.pathname === '/api/provider' || route.pathname === '/api/model') {
            const model = { id: 'native-selected', providerID: 'native', name: 'Selected account model', capabilities: { input: ['text'] } };
            const openaiModel = { id: 'gpt-5.4-mini', providerID: 'openai', name: 'GPT-5.4 mini', capabilities: { input: ['text'] } };
            const value = route.pathname === '/provider'
              ? { all: [{ id: 'native', models: options.emptyNativeInventory ? {} : { 'native-selected': model } }, ...(options.chatgptInventory ? [{ id: 'openai', options: { baseURL: options.openaiBaseURL }, models: { 'gpt-5.4-mini': openaiModel } }] : [])], connected: ['native', ...(options.chatgptInventory ? ['openai'] : [])], default: {} }
              : { data: route.pathname === '/api/model' ? [...(options.emptyNativeInventory ? [] : [model]), ...(options.chatgptInventory ? [openaiModel] : [])] : [{ id: 'native', name: 'Native' }, ...(options.chatgptInventory ? [{ id: 'openai', name: 'OpenAI', settings: { baseURL: options.openaiBaseURL } }] : [])] };
            return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(value)).body };
          }
          const items = route.pathname.endsWith('/command')
            ? [{ name: 'review', description: 'Review project', template: 'native template' }]
            : [{ ...(v2 ? { id: 'native-project-skill' } : {}), name: 'project-skill', description: 'Use project skill', location: '/repo/.opencode/skills/project-skill/SKILL.md' }];
          const value = v2 ? { data: ready ? items : [] } : items;
          return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(value)).body };
        } }, context.signal);
      } finally { disposed = true; }
    },
  };
  return { context, requests, services, disposed: () => disposed };
}

async function probe(context: AgentPreflightSessionControlsProbeContextV1) {
  const contribution: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
  if (!contribution.probeCatalogs) throw new Error('OpenCode has no native preflight catalog owner');
  return await contribution.probeCatalogs(context);
}

describe('OpenCode before-session native catalogs', () => {
  it.each([{ generation: 'stable', version: '1.18.33' }, { generation: 'v2', version: '2.0.20' }])('refuses unproven ChatGPT model entitlement while preserving other native providers ($generation)', async selection => {
    const rootDir = await mkdtemp(join(tmpdir(), 'opencode-account-catalog-'));
    try {
      const { configPart } = await materializeOpenCodeAuthEnvironment({
        connectedAccountMaterializationAuthority: 'qualified', materializationId: 'selected-chatgpt', rootDir,
        requestAuth: { capabilityPath: join(rootDir, 'capability.json'), purposeBindings: [{
          purpose: { consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, purpose: 'openai-codex-model-request' },
          target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected-chatgpt' } },
        }] },
      });
      let openaiBaseURL = asRecord(asRecord(asRecord(configPart?.providers)?.openai)?.settings)?.baseURL;
      if (selection.generation === 'stable') {
        const asset = resolveOpenCodeRequestAuthPluginPath(resolveOpenCodeConnectedConfigHomeDir(rootDir), 'openai');
        const modulePath = join(rootDir, 'request-auth.mjs');
        await writeFile(modulePath, await readFile(asset, 'utf8'));
        // Generated JavaScript is an external OpenCode plugin boundary.
        const plugin = await import(pathToFileURL(modulePath).href) as { default: () => Promise<{ auth: { loader: (readAuth: () => Promise<unknown>) => Promise<{ baseURL?: unknown }> } }> };
        const loadedBaseURL = (await (await plugin.default()).auth.loader(async () => ({ type: 'api', key: buildOpenCodeRequestAuthMarker('openai') }))).baseURL;
        openaiBaseURL = asRecord(asRecord(asRecord(configPart?.provider)?.openai)?.options)?.baseURL;
        expect(openaiBaseURL).toBe(loadedBaseURL);
      }
      const f = fixture({ ...selection, chatgptInventory: true, openaiBaseURL });
      const contribution: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
      await expect(contribution.probeModels!(f.context)).resolves.toMatchObject({
        availableModels: [{ id: 'native/native-selected', name: 'Selected account model' }],
        source: 'dynamic', refreshError: true,
        refreshErrorMessage: expect.stringContaining('entitlement'),
      });
      await expect(contribution.probeModels!(fixture({ ...selection, chatgptInventory: true, emptyNativeInventory: true, openaiBaseURL }).context)).resolves.toMatchObject({
        availableModels: [], source: 'unavailable', refreshError: true,
      });
      // Native and API-key routes must not acquire a ChatGPT account restriction.
      await expect(contribution.probeModels!(fixture({ ...selection, chatgptInventory: true, openaiBaseURL: 'https://api.openai.com/v1' }).context)).resolves.toMatchObject([
        { id: 'native/native-selected' }, { id: 'openai/gpt-5.4-mini' },
      ]);
      expect(f.disposed()).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it.each([{ generation: 'stable', version: '1.18.33' }, { generation: 'v2', version: '2.0.20' }])('reads native mode choices without inventing default ($generation)', async (selection) => {
    const f = fixture(selection);
    const contribution: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
    expect(contribution.probeModes).toBeTypeOf('function');
    expect(await contribution.probeModes!(f.context)).toEqual([
      { id: 'build', name: 'build', description: 'Native build mode' },
      { id: 'custom-review', name: 'custom-review', description: 'Project mode' },
    ]);
    expect(f.requests.every(request => request.method === 'GET')).toBe(true);
    expect(f.disposed()).toBe(true);
  });

  it('uses the selected ACP native modes and keeps missing inventory unavailable', async () => {
    const f = fixture();
    const contribution: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
    const context = { ...f.context, accountSettings: { opencodeBackendMode: 'acp' },
      probeDeclaredAcpSessionControls: async () => ({ models: null, modes: [{ id: 'review', name: 'Review' }], configOptions: null }) };
    expect(contribution.probeModes).toBeTypeOf('function');
    expect(await contribution.probeModes!(context)).toEqual([{ id: 'review', name: 'Review' }]);
    expect(await contribution.probeModes!({ ...context, probeDeclaredAcpSessionControls: undefined })).toBeNull();
    expect(f.services).toEqual([]);
  });

  it.each([{ generation: 'stable', version: '1.18.33' }, { generation: 'v2', version: '2.0.20' }])('reads the same native provider catalog as a bound Session ($generation)', async (selection) => {
    const f = fixture(selection);
    const contribution: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
    expect(contribution.probeModels, 'models must use the managed native server, not the standalone CLI catalog').toBeTypeOf('function');
    await expect(contribution.probeModels!(f.context)).resolves.toMatchObject([
      { id: 'native/native-selected', name: 'Selected account model' },
    ]);
    expect(f.requests.some(request => request.pathAndQuery.startsWith(selection.generation === 'v2' ? '/api/model?' : '/provider'))).toBe(true);
    expect(f.disposed()).toBe(true);
  });

  it('reads project-scoped V1 commands and skills through the managed native client without creating a session', async () => {
    const f = fixture();
    await expect(probe(f.context)).resolves.toEqual({
      commands: [{ name: 'review', description: 'Review project', template: 'native template' }],
      skills: [{ name: 'project-skill', displayName: 'project-skill', description: 'Use project skill', path: '/repo/.opencode/skills/project-skill/SKILL.md', origin: 'opencode_native', enabled: true }],
    });
    expect(f.requests.map((r) => [r.method, r.pathAndQuery])).toEqual([
      ['GET', '/command?directory=%2Frepo'], ['GET', '/skill?directory=%2Frepo'],
    ]);
    expect(f.services[0]?.mode).toMatchObject({ kind: 'spawn', launch: { executable: { kind: 'systemTool', id: 'opencode-cli-stable' }, args: ['serve', '--hostname', '127.0.0.1'] } });
    expect(f.disposed()).toBe(true);
  });

  it.each([{ generation: 'v2', version: '2.0.20' }, { generation: 'stable', version: 'opencode v2.0.20' }])('reads cold V2 catalogs even when stable resolves to V2 ($generation)', async (selection) => {
    const f = fixture(selection);
    await expect(probe(f.context)).resolves.toEqual({
      commands: [{ name: 'review', description: 'Review project', template: 'native template' }],
      skills: [{ id: 'native-project-skill', name: 'project-skill', displayName: 'project-skill', description: 'Use project skill', path: '/repo/.opencode/skills/project-skill/SKILL.md', origin: 'opencode_native', enabled: true }],
    });
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(f.requests.some((request) => request.pathAndQuery.startsWith('/api/session'))).toBe(false);
    expect(f.disposed()).toBe(true);
  });

  it.each([{ versionOk: false, version: '' }, { versionOk: true, version: 'unrecognized CLI output' }])('rejects an unproven native generation before opening catalog routes', async (observation) => {
    const f = fixture(observation);
    await expect(probe(f.context)).rejects.toThrow('native generation is unavailable');
    expect(f.services).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('propagates a native catalog failure through the scoped service owner', async () => {
    const f = fixture({ failSkills: true });
    await expect(probe(f.context)).rejects.toThrow('skill transport failed');
    expect(f.disposed()).toBe(true);
  });

  it('uses the canonical declared ACP catalogs for an ACP selection', async () => {
    const f = fixture();
    const context = { ...f.context, accountSettings: { opencodeBackendMode: 'acp' } };
    await expect(probe(context)).resolves.toEqual({ commands: [{ name: 'acp-only' }], skills: null });
    expect(f.services).toEqual([]);
  });

  it('reads ACP models through the host native Session-controls owner and preserves an empty catalog', async () => {
    const f = fixture();
    const contribution: AgentPreflightSessionControlsContributionV1 = OPENCODE_PREFLIGHT_SESSION_CONTROLS;
    let models: readonly unknown[] = [{ id: 'acp/model', name: 'ACP model' }];
    const context = { ...f.context, accountSettings: { opencodeBackendMode: 'acp' },
      probeDeclaredAcpSessionControls: async () => ({ models, modes: null, configOptions: null }) };
    await expect(contribution.probeModels!(context)).resolves.toEqual(models);
    models = [];
    await expect(contribution.probeModels!(context)).resolves.toEqual([]);
    await expect(contribution.probeModels!({ ...context, probeDeclaredAcpSessionControls: undefined })).resolves.toBeNull();
    expect(f.services).toEqual([]);
  });
});

import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPreflightSessionControlsProbeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { OPENCODE_PREFLIGHT_SESSION_CONTROLS } from '../../../../../packages/plugins/opencode/src/agent/preflight/models';
import { materializeOpenCodeAuthEnvironment } from '../../../../../packages/plugins/opencode/src/agent/auth/services/materialize';
import { asRecord } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeParsing';
import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

afterEach(resetAgentModelsProbeCacheForTests);

it.each(['stable', 'v2'] as const)('replaces the same native auth scope cache after a ChatGPT inventory refusal (%s)', async generation => {
  const rootDir = await mkdtemp(join(tmpdir(), 'opencode-warm-catalog-'));
  try {
    const { configPart } = await materializeOpenCodeAuthEnvironment({
      connectedAccountMaterializationAuthority: 'qualified', materializationId: 'selected-chatgpt', rootDir,
      requestAuth: { capabilityPath: join(rootDir, 'capability.json'), purposeBindings: [{
        purpose: { consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' }, purpose: 'openai-codex-model-request' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected-chatgpt' } },
      }] },
    });
    const chatGptBaseURL = generation === 'stable'
      ? asRecord(asRecord(asRecord(configPart?.provider)?.openai)?.options)?.baseURL
      : asRecord(asRecord(asRecord(configPart?.providers)?.openai)?.settings)?.baseURL;
    expect(chatGptBaseURL).toBeTypeOf('string');
    let baseURL: unknown = 'https://api.openai.com/v1';
    let otherProviderPresent = true;
    let transportFailed = false;
    // Only the native managed-service HTTP transport is replaced. The writer,
    // native dialect decoders, plugin catalog, host parser and cache stay real.
    const context: AgentPreflightSessionControlsProbeContextV1 = {
      cwd: '/repo', accountSettings: { opencodeCliGeneration: generation }, environment: {},
      signal: new AbortController().signal,
      resolveDeclaredSystemTool: async () => ({ executablePath: '/usr/local/bin/opencode' }),
      runDeclaredSystemToolCommand: async () => ({ ok: true, stdout: generation === 'stable' ? '1.18.33' : '2.0.20', stderr: '', exitCode: 0 }),
      probeDeclaredAcpCatalogs: async () => { throw new Error('Unexpected ACP transport'); },
      withDeclaredJsonRpcClient: async () => { throw new Error('Unexpected JSON-RPC transport'); },
      withDeclaredManagedService: async (_spec, inspect) => inspect({ request: async request => {
        if (transportFailed) throw new Error('Native inventory transport failed');
        const path = new URL(request.pathAndQuery, 'http://native.invalid').pathname;
        const model = { id: 'gpt-5.4-mini', providerID: 'openai', name: 'GPT-5.4 mini', capabilities: { input: ['text'] } };
        const otherModel = { id: 'other-model', providerID: 'other', name: 'Other model', capabilities: { input: ['text'] } };
        const body = path === '/provider'
          ? { all: [{ id: 'openai', options: { baseURL }, models: { 'gpt-5.4-mini': model } }, ...(otherProviderPresent ? [{ id: 'other', models: { 'other-model': otherModel } }] : [])], connected: ['openai', 'other'], default: {} }
          : { data: path === '/api/model' ? [model, ...(otherProviderPresent ? [otherModel] : [])]
            : path === '/api/provider' ? [{ id: 'openai', settings: { baseURL } }, ...(otherProviderPresent ? [{ id: 'other' }] : [])] : [] };
        return { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(body)).body };
      } }, context.signal),
    };
    const catalogEntry = {
      id: 'example.opencode-cache/agent', cliSubcommand: 'example.opencode-cache/agent', vendorResumeSupport: 'unsupported',
      getPreflightSessionControlsProbeAdapter: async () => ({ probeModelsRaw: async () => OPENCODE_PREFLIGHT_SESSION_CONTROLS.probeModels(context) }),
    } satisfies AgentCatalogEntry;
    // Native `auth login` changes the endpoint, not this existing cache scope.
    const params = { agentId: catalogEntry.id, catalogEntry, cwd: context.cwd };
    const api = await probeAgentModelsBestEffort(params);
    expect(api.availableModels.map(model => model.id)).toContain('openai/gpt-5.4-mini');
    baseURL = chatGptBaseURL;
    const partial = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
    expect(partial).toMatchObject({ source: 'dynamic', refreshError: true, cacheable: false });
    expect(partial).not.toHaveProperty('catalogObserved');
    expect(partial.availableModels.map(model => model.id)).toEqual(['default', 'other/other-model']);
    expect(await probeAgentModelsBestEffort(params)).toEqual(partial);
    otherProviderPresent = false;
    const unavailable = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
    expect(unavailable).toMatchObject({ source: 'unavailable', availableModels: [], refreshError: true, cacheable: false });
    expect(unavailable).not.toHaveProperty('catalogObserved');
    resetAgentModelsProbeCacheForTests();
    expect(await probeAgentModelsBestEffort(params)).toMatchObject({ source: 'unavailable', availableModels: [], refreshError: true });
    baseURL = 'https://api.openai.com/v1';
    const recovered = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
    expect(recovered.availableModels.map(model => model.id)).toContain('openai/gpt-5.4-mini');
    expect(recovered).not.toHaveProperty('refreshError');
    transportFailed = true;
    const failed = await probeAgentModelsBestEffort({ ...params, bypassCache: true });
    expect(failed.availableModels).toEqual(recovered.availableModels);
    expect(failed).toMatchObject({ refreshError: true, cacheable: false });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

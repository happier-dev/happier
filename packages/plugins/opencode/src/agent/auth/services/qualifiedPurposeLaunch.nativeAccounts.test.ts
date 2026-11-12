import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createKimiConnectedAccountRuntime } from '../../../../../kimi/src/connectedAccounts/runtime.js';
import { xaiConnectedAccountRuntime } from '../../../../../grok/src/connectedAccounts/runtime.js';
import { museAccountRuntimeDefinition } from '../../../../../muse/src/connectedAccounts/museAccountRuntime.js';
import { geminiConnectedAccountRuntime } from '../../../../../gemini/src/connectedAccounts/runtime.js';
import { materializeGithubCredential } from '../../../../../scm-github/src/auth/credentialMaterialization.js';
import { prepareOpenCodeQualifiedConnectedAccounts } from './qualifiedPurposeLaunch.js';
import { createOpenCodeAgentRuntime } from '../../runtime/nativeRuntime.js';
import { createContextFixture } from '../../runtime/server/assembly.managedServices.testkit.js';

type Materialize = ConnectedAccountRuntime['materialize'];
function producerContext(values: Record<string, string>, modeId = 'api-key'): Parameters<Materialize>[1] {
  // Credential custody is the host boundary; vendor parsing/materialization stays real.
  return { invokedAtMs: 1000, signal: new AbortController().signal,
    configuration: { target: { modeId }, values: {} },
    credentials: { async get(key: string) { return values[key] ?? null; } },
    services: { http: { async request() { throw new Error('Launch must not call a vendor'); } } },
  } as Parameters<Materialize>[1];
}
const cases = [
  { purpose: 'kimi-api-key', service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, provider: 'kimi-code-plan-global', model: 'kimi-for-coding',
    materialize: createKimiConnectedAccountRuntime().materialize,
    context: producerContext({ accessToken: 'fake-kimi-selected', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' }),
    key: 'fake-kimi-selected', baseURL: 'https://api.kimi.ai/coding/v1' },
  { purpose: 'xai-api-key', service: { pluginId: 'happier.agent.grok', localId: 'xai' }, provider: 'xai', model: 'grok-4',
    materialize: xaiConnectedAccountRuntime.materialize,
    context: producerContext({ xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai-selected' }) }), key: 'fake-xai-selected' },
  { purpose: 'gemini', service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }, provider: 'google', model: 'gemini-2.5-pro',
    materialize: geminiConnectedAccountRuntime.materialize,
    context: producerContext({ apiKey: 'fake-google-selected' }), key: 'fake-google-selected' },
  { purpose: 'github-copilot', service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, provider: 'github-copilot', model: 'gpt-4o',
    materialize: materializeGithubCredential, context: producerContext({ token: 'gho_fake_selected' }), key: 'gho_fake_selected' },
] as const;
const serviceAccountJson = JSON.stringify({ type: 'service_account', client_id: '123', client_email: 'fake@example.iam.gserviceaccount.com',
  project_id: 'fake-project', private_key: 'fake-private-key' });
function launchFixture(row: { purpose: string; service: { pluginId: string; localId: string }; materialize: Materialize; context: Parameters<Materialize>[1] }) {
  let acquisitions = 0;
  const context: Parameters<typeof prepareOpenCodeQualifiedConnectedAccounts>[1] = { services: { connectedAccounts: {
    async getBinding(purpose) { return purpose === row.purpose ? { purpose, service: row.service,
      account: { service: row.service, accountId: 'selected' }, target: { kind: 'account', displayName: 'Selected' } } : null; },
    async materialize(purpose, request) { if (purpose !== row.purpose) throw new Error('Unselected account acquired'); acquisitions += 1;
      return row.materialize(request, row.context); },
    watch(_purpose, listener) { void listener({ kind: 'resync', authorityChanged: false }); return { dispose() {} }; },
  } } };
  return { context, acquisitions: () => acquisitions };
}
function request(provider: string, model: string) {
  return { configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: `${provider}/${model}`, updatedAtMs: 1 },
    permissionIntent: { value: null, updatedAtMs: 0 }, options: {} },
    launchEnvironment: { values: { XAI_API_KEY: 'fake-ambient', GOOGLE_API_KEY: 'fake-ambient', KIMI_API_KEY: 'fake-ambient',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ xai: { type: 'api', key: 'fake-ambient' } }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ['ollama'] }) } } };
}
describe('OpenCode selected native accounts', () => {
  it.each(['muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'])('launches %s through the managed Provider config without raw Muse auth', async model => {
    const directory = await mkdtemp(join(tmpdir(), 'OPENCODE-MANAGED-MUSE-'));
    const provider = 'happier_managed_muse';
    const config = { enabled_providers: [provider], model: `${provider}/${model}`,
      provider: { [provider]: { npm: '@ai-sdk/openai', options: { baseURL: 'http://127.0.0.1:8317/v1',
        apiKey: '{env:HAPPIER_OPENCODE_PROVIDER_API_KEY}' }, models: { [model]: { name: model } } } } };
    await mkdir(join(directory, 'opencode'));
    await writeFile(join(directory, 'opencode/opencode.json'), JSON.stringify(config));
    const f = launchFixture({ purpose: 'meta-inference',
      service: { pluginId: 'happier.agent.muse', localId: 'muse-account' },
      materialize: museAccountRuntimeDefinition.materialize,
      context: producerContext({ credentialMode: 'native', inferenceKey: 'fake-raw-muse', accountToken: 'fake-identity' }) });
    const boundary = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49213', managedServerRequest: async input => {
      const path = input.pathAndQuery.split('?')[0]!;
      if (path === '/event') return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' },
        body: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
          input.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }) };
      const body = path === '/session' || path === '/session/oc-managed-muse' ? { id: 'oc-managed-muse' }
        : path === '/agent' ? [{ name: 'build', mode: 'primary' }]
          : path === '/provider' ? { all: [{ id: provider, models: { [model]: { id: model } } }], connected: [provider] }
            : path.endsWith('/message') ? [] : {};
      return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(body)).body };
    } });
    const signal = new AbortController().signal;
    const context = { signal, session: { id: 'managed-muse' }, services: {
      ...f.context.services, exec: boundary.exec, logger: boundary.logger, managedServices: boundary.managedServices,
      storage: boundary.storage, interactions: { askQuestions: boundary.ui.askQuestions,
        requestApproval: boundary.sessions.current.permissions.requestDecision },
    } } as unknown as AgentRuntimeContext;
    const runtime = createOpenCodeAgentRuntime({ plugin: { id: 'happier.agent.opencode', version: '0.0.0' }, agent: { id: 'opencode' }, signal });
    try {
      const session = await runtime.sessions!.open({ kind: 'create', sessionId: 'managed-muse', cwd: '/repo',
        providerBinding: { connectionId: ProviderConnectionIdSchema.parse('pc_managed_muse'), adapterBindingKey: provider,
          model: { id: model, name: model }, materialization: { v: 1, kind: 'configFile', rootPath: directory, relativePaths: ['opencode/opencode.json'] } },
        launchEnvironment: { values: { HAPPIER_OPENCODE_PROVIDER_API_KEY: 'fake-route-secret' }, unset: ['META_API_KEY'] },
        runtimeDescriptorV1: { v: 1, agentId: 'opencode', agent: { backendMode: 'server' } },
      }, context);
      try {
        const spec = vi.mocked(boundary.managedServices.supervise).mock.calls[0]![0];
        if (spec.mode.kind !== 'spawn') throw new Error('Expected managed native launch');
        const env = spec.mode.launch.env!;
        expect(env.HAPPIER_OPENCODE_PROVIDER_API_KEY).toBe('fake-route-secret');
        expect(env).not.toHaveProperty('META_API_KEY');
        expect(env).not.toHaveProperty('OPENCODE_AUTH_CONTENT');
        expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).provider[provider].options).toEqual(config.provider[provider].options);
        expect(f.acquisitions()).toBe(0);
      } finally { await session.dispose(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each([...cases, { ...cases[2], provider: 'google-vertex',
    context: producerContext({ serviceAccountJson }, 'service-account'), serviceAccountJson }])(
    'passes the selected $purpose credential through the real Session entry to managed launch', async row => {
    const f = launchFixture(row);
    const observations: Array<() => void> = [];
    const watch = f.context.services.connectedAccounts.watch;
    const connectedAccounts: typeof f.context.services.connectedAccounts = {
      ...f.context.services.connectedAccounts,
      watch(purpose, listener) {
        observations.push(() => { void listener({ kind: 'resync', authorityChanged: true }); });
        return watch(purpose, listener);
      },
    };
    const boundary = createContextFixture({ managedServerBaseUrl: 'http://127.0.0.1:49213',
      managedServerRequest: async input => {
        const path = input.pathAndQuery.split('?')[0]!;
        if (path === '/session' && row.purpose === 'xai-api-key') {
          for (const observe of observations) observe();
        }
        if (path === '/event') return { ok: true, status: 200, headers: { 'content-type': 'text/event-stream' },
          body: new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
            input.signal?.addEventListener('abort', () => controller.close(), { once: true });
          } }) };
        // OpenCode 1.19.0 filters /provider by enabled_providers after auth loading.
        // nl1's global filter was [ollama]; a selected-account launch must enable its native provider.
        const spec = vi.mocked(boundary.managedServices.supervise).mock.calls[0]?.[0];
        const config = spec?.mode.kind === 'spawn'
          ? JSON.parse(spec.mode.launch.env?.OPENCODE_CONFIG_CONTENT ?? '{}') : {};
        const selectedProviderEnabled = Array.isArray(config.enabled_providers) && config.enabled_providers.includes(row.provider);
        const body = path === '/session' || path === '/session/oc-native-account' ? { id: 'oc-native-account' }
          : path === '/agent' ? [{ name: 'build', mode: 'primary' }]
            : path === '/provider' ? (!selectedProviderEnabled ? { all: [{ id: 'ollama', models: {} }], connected: ['ollama'] } : { all: [{ id: row.provider,
              models: { [row.model]: { id: row.model } },
              options: { apiKey: 'fake-private-provider-key' } }], connected: [row.provider] })
            : path.endsWith('/message') ? [] : {};
        return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: new Response(JSON.stringify(body)).body };
      } });
    const signal = new AbortController().signal;
    // The fake host supplies OS/service transports; every plugin owner stays real.
    const context = { signal, session: { id: 'native-account' }, services: {
      ...f.context.services, connectedAccounts, exec: boundary.exec, logger: boundary.logger, managedServices: boundary.managedServices,
      storage: boundary.storage, interactions: { askQuestions: boundary.ui.askQuestions,
        requestApproval: boundary.sessions.current.permissions.requestDecision },
    } } as unknown as AgentRuntimeContext;
    const runtime = createOpenCodeAgentRuntime({ plugin: { id: 'happier.agent.opencode', version: '0.0.0' }, agent: { id: 'opencode' }, signal });
    const launch = request(row.provider, row.model);
    const opening = runtime.sessions!.open({ ...launch, kind: 'create', sessionId: 'native-account', cwd: '/repo',
      runtimeDescriptorV1: { v: 1, agentId: 'opencode', agent: { backendMode: 'server' } } }, context);
    const session = await opening;
    let adcFile: string | undefined;
    try {
      const spec = vi.mocked(boundary.managedServices.supervise).mock.calls[0]![0];
      if (spec.mode.kind !== 'spawn') throw new Error('Expected managed native launch');
      const env = spec.mode.launch.env!;
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).enabled_providers).toContain(row.provider);
      const auth = JSON.parse(env.OPENCODE_AUTH_CONTENT!);
      if ('serviceAccountJson' in row) {
        adcFile = env.GOOGLE_APPLICATION_CREDENTIALS!;
        expect(await readFile(adcFile, 'utf8')).toBe(row.serviceAccountJson);
        expect(env.GOOGLE_CLOUD_PROJECT).toBe('fake-project');
        expect(env.GOOGLE_CLOUD_LOCATION).toBe('global');
        expect(auth).toEqual({});
      } else {
        expect(auth[row.provider]).toEqual(row.provider === 'github-copilot'
          ? { type: 'oauth', refresh: row.key, access: '', expires: 0 } : { type: 'api', key: row.key });
      }
      expect(JSON.stringify(env)).not.toContain('fake-ambient');
      expect(f.acquisitions()).toBe('serviceAccountJson' in row ? 2 : 1);
    } finally { await session.dispose(); }
    if (adcFile) await expect(stat(adcFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([null, 'openai/gpt-5'])('requires a selected-account model before acquiring secrets (%s)', async modelId => {
    const f = launchFixture(cases[1]);
    const launch = request('openai', 'gpt-5');
    await expect(prepareOpenCodeQualifiedConnectedAccounts({ ...launch, configuration: {
      ...launch.configuration, model: { value: modelId, updatedAtMs: 1 },
    } }, f.context)).rejects.toMatchObject({
      code: 'agent_startup_model_reconciliation_failed',
      details: { failureCause: { code: 'opencode_connected_account_model_required', failureReason: 'model_selection_required' } },
    });
    expect(f.acquisitions()).toBe(0);
  });
  it.each([...cases, { ...cases[0], provider: 'kimi-code-plan-cn',
    context: producerContext({ accessToken: 'fake-kimi-selected', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.com/coding/v1' }),
    baseURL: 'https://api.kimi.com/coding/v1' }])('delivers $purpose from the real producer without ambient credentials or unselected acquisition', async row => {
    const f = launchFixture(row);
    const prepared = await prepareOpenCodeQualifiedConnectedAccounts(request(row.provider, row.model), f.context);
    try {
      const env = prepared.request.launchEnvironment!.values;
      const auth = JSON.parse(env.OPENCODE_AUTH_CONTENT!);
      expect(auth[row.provider]).toEqual(row.provider === 'github-copilot'
        ? { type: 'oauth', refresh: row.key, access: '', expires: 0 }
        : { type: 'api', key: row.key });
      expect(JSON.stringify(env)).not.toContain('fake-ambient');
      expect(f.acquisitions()).toBe(1);
      if ('baseURL' in row) {
        const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
        expect(config.providers[row.provider].settings.baseURL).toBe(row.baseURL);
        expect(config.provider[row.provider].options.baseURL).toBe(row.baseURL);
      }
    } finally { await prepared.dispose(); }
  });
  it.each([
    { ...cases[0], context: producerContext({ accessToken: 'fake-oauth-secret', credentialKind: 'oauth', apiKind: 'code' }) },
    { ...cases[0], context: producerContext({ accessToken: 'fake-platform-secret', credentialKind: 'token', apiKind: 'platform' }) },
    { ...cases[1], context: producerContext({ xaiCredential: JSON.stringify({ mode: 'subscription', accessToken: 'fake-subscription-secret' }) }) },
    { ...cases[3], context: producerContext({ token: 'ghp_fake_classic_secret' }) },
  ])('rejects unsupported credential modes for $purpose without falling back to ambient auth', async row => {
    const f = launchFixture(row);
    await expect(prepareOpenCodeQualifiedConnectedAccounts(request(row.provider, row.model), f.context)).rejects.toThrow();
    expect(f.acquisitions()).toBe(1);
  });
  it('delivers opaque service-account ADC, project and location and removes the file on disposal', async () => {
    const json = JSON.stringify({ type: 'service_account', client_id: '123', client_email: 'fake@example.iam.gserviceaccount.com',
      project_id: 'fake-project', private_key: 'fake-private-key' });
    const f = launchFixture({ purpose: 'gemini', service: cases[2].service, materialize: geminiConnectedAccountRuntime.materialize,
      context: producerContext({ serviceAccountJson: json }, 'service-account') });
    const prepared = await prepareOpenCodeQualifiedConnectedAccounts(request('google-vertex', 'gemini-2.5-pro'), f.context);
    const env = prepared.request.launchEnvironment!.values;
    const file = env.GOOGLE_APPLICATION_CREDENTIALS!;
    try {
      expect(await readFile(file, 'utf8')).toBe(json);
      expect(env.GOOGLE_CLOUD_PROJECT).toBe('fake-project');
      expect(env.GOOGLE_CLOUD_LOCATION).toBe('global');
      expect(JSON.stringify(env)).not.toContain('fake-ambient');
      expect(JSON.parse(env.OPENCODE_AUTH_CONTENT!)).toEqual({});
      expect(f.acquisitions()).toBe(2);
    } finally { await prepared.dispose(); }
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses a Vertex model with an API key instead of treating it as ADC', async () => {
    const f = launchFixture(cases[2]);
    await expect(prepareOpenCodeQualifiedConnectedAccounts(request('google-vertex', 'gemini-2.5-pro'), f.context)).rejects.toMatchObject({
      code: 'agent_startup_model_reconciliation_failed',
      details: { failureCause: { failureReason: 'model_selection_required' } },
    });
    expect(f.acquisitions()).toBe(1);
  });
});

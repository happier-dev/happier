import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { geminiConnectedAccountRuntime } from '../../../../gemini/src/connectedAccounts/runtime.js';
import { createKimiConnectedAccountRuntime } from '../../../../kimi/src/connectedAccounts/runtime.js';
import { xaiConnectedAccountRuntime } from '../../../../grok/src/connectedAccounts/runtime.js';
import { museAccountRuntimeDefinition } from '../../../../muse/src/connectedAccounts/museAccountRuntime.js';
import { materializeGithubCredential } from '../../../../scm-github/src/auth/credentialMaterialization.js';
import { preparePiQualifiedConnectedAccounts } from './qualifiedConnectedAccounts.js';
import { buildPiRpcArgs } from './rpc/args.js';
import { createPiAgentRuntime } from './engine.js';
import { hostBoundaries } from './nativeProcess.test-support.js';

type Accounts = AgentRuntimeContext['services']['connectedAccounts'];
const cases = [
  { purpose: 'kimi-api-key', service: { pluginId: 'happier.agent.kimi', localId: 'kimi-code' }, provider: 'kimi-coding', key: 'KIMI_API_KEY', mode: 'api-key', runtime: createKimiConnectedAccountRuntime(), credentials: { accessToken: 'fake-kimi', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.com/coding/v1' } },
  { purpose: 'xai-api-key', service: { pluginId: 'happier.agent.grok', localId: 'xai' }, provider: 'xai', key: 'XAI_API_KEY', mode: 'api-key', runtime: xaiConnectedAccountRuntime, credentials: { xaiCredential: JSON.stringify({ mode: 'api-key', accessToken: 'fake-xai' }) } },
  { purpose: 'gemini', service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }, provider: 'google', key: 'GEMINI_API_KEY', mode: 'api-key', runtime: geminiConnectedAccountRuntime, credentials: { apiKey: 'fake-google' } },
  { purpose: 'github-copilot', service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, provider: 'github-copilot', key: 'COPILOT_GITHUB_TOKEN', mode: 'manual', runtime: { authentication: { modes: {} }, materialize: materializeGithubCredential }, credentials: { token: 'gho_fake-copilot' } },
] as const;

type AccountCase = { purpose: string; provider: string; service: { pluginId: string; localId: string }; runtime: ConnectedAccountRuntime; credentials: Readonly<Record<string, string>>; mode: string };

function accountBoundary(input: AccountCase) {
  const signal = new AbortController().signal;
  // Sealed credential storage is the system boundary; the service serializer remains real.
  const materializationContext = { signal, invokedAtMs: 1, configuration: { target: { modeId: input.mode }, values: {} },
    credentials: { async get(key: string) { return input.credentials[key] ?? null; } },
    services: { http: { async request() { throw new Error('Native credential preparation must not mint or call upstream'); } } },
  } as unknown as Parameters<ConnectedAccountRuntime['materialize']>[1];
  const accounts = {
    async getBinding(purpose) { return purpose === input.purpose ? { purpose, service: input.service,
      account: { service: input.service, accountId: 'selected' }, target: { kind: 'account', displayName: 'Selected' } } : null; },
    async materialize(_purpose, request) { return input.runtime.materialize(request, materializationContext); },
    watch(_purpose, listener) { void listener({ kind: 'resync', authorityChanged: false }); return { dispose() {} }; },
  } satisfies Pick<Accounts, 'getBinding' | 'materialize' | 'watch'>;
  return { signal, accounts };
}

async function prepare(input: AccountCase, directory: string, model = `${input.provider}/selected-model`) {
  const { signal, accounts } = accountBoundary(input);
  return preparePiQualifiedConnectedAccounts({ launchEnvironment: { values: { PI_CODING_AGENT_DIR: directory,
    OPENAI_API_KEY: 'ambient-wrong', META_API_KEY: 'ambient-wrong' }, unset: [] },
    request: { kind: 'create', configuration: { model: { value: model, updatedAtMs: 1 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} } },
    context: { signal, services: { connectedAccounts: accounts } } });
}

describe('Pi native selected accounts through service materialization and launch', () => {
  it.each(['create', 'resume'] as const)('keeps managed Muse Provider authority through native %s without reading raw account credentials', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'PI-MANAGED-MUSE-'));
    const boundary = hostBoundaries();
    const models = JSON.stringify({ providers: { 'happier-provider': {
      api: 'openai-responses', baseUrl: 'http://127.0.0.1:8317/v1',
      apiKey: '${HAPPIER_PI_PROVIDER_API_KEY}', models: [{ id: 'muse-spark-1.3-contributor' }],
    } } });
    await writeFile(join(directory, 'models.json'), models);
    const { accounts } = accountBoundary({ purpose: 'meta-inference', provider: 'meta',
      service: { pluginId: 'happier.agent.muse', localId: 'muse-account' }, mode: 'api-key',
      runtime: museAccountRuntimeDefinition, credentials: { credentialMode: 'manual', inferenceKey: 'fake-raw-muse' } });
    const session = await createPiAgentRuntime().sessions.open({
      kind, ...(kind === 'resume' ? { providerSessionId: 'pi-shared' } : {}), sessionId: 'managed-muse', cwd: directory,
      providerBinding: { connectionId: ProviderConnectionIdSchema.parse('pc_managed_muse'),
        model: { id: 'muse-spark-1.3-contributor', name: 'Muse Spark' },
        materialization: { v: 1, kind: 'configFile', rootPath: directory, relativePaths: ['models.json'] } },
      launchEnvironment: { values: { PI_CODING_AGENT_DIR: directory, HAPPIER_PI_PROVIDER_API_KEY: 'fake-route-secret' }, unset: ['META_API_KEY'] },
    }, { ...boundary.context, services: { ...boundary.context.services,
      connectedAccounts: { ...boundary.context.services.connectedAccounts, ...accounts,
        async getBinding() { throw new Error('An admitted Provider must not acquire native account authority'); },
      } } });
    try {
      const launch = boundary.spawn.mock.calls[0]![0].launch;
      expect(launch.args).toEqual(expect.arrayContaining(['happier-provider', 'muse-spark-1.3-contributor']));
      expect(launch.env).toMatchObject({ HAPPIER_PI_PROVIDER_API_KEY: 'fake-route-secret' });
      expect(launch.env).not.toHaveProperty('META_API_KEY');
      expect(await readFile(join(directory, 'models.json'), 'utf8')).toBe(models);
      await expect(readFile(join(directory, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await session.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each(cases)('$purpose reaches native process launch through the registered Session runtime', async row => {
    const directory = await mkdtemp(join(tmpdir(), 'N-PI-OPENCODE-'));
    const boundary = hostBoundaries();
    const { accounts } = accountBoundary(row);
    const session = await createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'native-account', cwd: directory,
      launchEnvironment: { values: { PI_CODING_AGENT_DIR: directory }, unset: [] },
      configuration: { model: { value: `${row.provider}/selected-model`, updatedAtMs: 1 },
        mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
    }, { ...boundary.context, services: { ...boundary.context.services,
      connectedAccounts: { ...boundary.context.services.connectedAccounts, ...accounts } } });
    try {
      const launch = boundary.spawn.mock.calls[0]![0].launch;
      expect(launch.args).toContain(row.provider);
      expect(launch.env?.OPENAI_API_KEY).toBeUndefined();
      expect(boundary.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'set_model', provider: row.provider, modelId: 'selected-model' }));
    } finally { await session.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each(cases)('$purpose replaces ambient auth with selected native material', async row => {
    const directory = await mkdtemp(join(tmpdir(), 'N-PI-OPENCODE-'));
    try {
      const prepared = await prepare(row, directory);
      const selectedKey = row.provider === 'github-copilot' ? 'gho_fake-copilot' : prepared.launchEnvironment.values[row.key];
      if (row.provider === 'github-copilot') expect(prepared.launchEnvironment.values[row.key]).toBeUndefined();
      else expect(selectedKey).toMatch(/^fake-/u);
      expect(prepared.launchEnvironment.values.OPENAI_API_KEY).toBeUndefined();
      const auth = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
      expect(auth[row.provider]).toEqual(row.provider === 'github-copilot'
        ? { type: 'oauth', refresh: selectedKey, access: '', expires: 0 }
        : { type: 'api_key', key: prepared.launchEnvironment.values[row.key] });
      expect(auth.openai).toBeUndefined();
      expect(buildPiRpcArgs({ connectedServiceId: row.service.localId, env: prepared.launchEnvironment.values })).toContain(row.provider);
      const args = buildPiRpcArgs({ env: prepared.launchEnvironment.values });
      expect(args[args.indexOf('--model') + 1]).toBe('selected-model');
      await prepared.dispose();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('delivers Vertex ADC as a private file with project/location and selects google-vertex', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'N-PI-OPENCODE-'));
    const adc = JSON.stringify({ type: 'service_account', client_id: '123', client_email: 'fake@example.test', project_id: 'fake-project', private_key: 'fake-private-key' });
    try {
      const prepared = await prepare({ purpose: 'gemini', provider: 'google-vertex', service: cases[2].service,
        runtime: geminiConnectedAccountRuntime, mode: 'service-account', credentials: { serviceAccountJson: adc } }, directory);
      expect(await readFile(prepared.launchEnvironment.values.GOOGLE_APPLICATION_CREDENTIALS!, 'utf8')).toBe(adc);
      expect(prepared.launchEnvironment.values.GOOGLE_CLOUD_PROJECT).toBe('fake-project');
      expect(prepared.launchEnvironment.values.GOOGLE_CLOUD_LOCATION).toBe('global');
      expect(buildPiRpcArgs({ connectedServiceId: 'gemini-account', env: prepared.launchEnvironment.values })).toContain('google-vertex');
      await prepared.dispose();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(cases)('$purpose requires an explicit compatible model before launch', async row => {
    const directory = await mkdtemp(join(tmpdir(), 'N-PI-OPENCODE-'));
    try {
      for (const model of ['default', 'unrelated/model']) {
        await expect(prepare(row, directory, model)).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed' });
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves the Kimi Code account region in native models configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'N-PI-OPENCODE-'));
    try {
      const prepared = await prepare({ ...cases[0], credentials: { ...cases[0].credentials, apiBase: 'https://api.kimi.ai/coding/v1' } }, directory);
      expect(JSON.parse(await readFile(join(directory, 'models.json'), 'utf8')).providers['kimi-coding'].baseUrl).toBe('https://api.kimi.ai/coding/v1');
      await prepared.dispose();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    { ...cases[0], credentials: { ...cases[0].credentials, credentialKind: 'oauth' }, expectedCode: 'kimi_code_api_key_unavailable' },
    { ...cases[0], credentials: { ...cases[0].credentials, apiKind: 'platform' }, expectedCode: 'kimi_code_api_key_unavailable' },
    { ...cases[1], credentials: { xaiCredential: JSON.stringify({ mode: 'subscription', accessToken: 'fake-subscription' }) }, expectedCode: undefined },
    { ...cases[3], credentials: { token: 'ghp_fake-classic-token' }, expectedCode: 'github_copilot_token_unsupported' },
  ])('refuses unsupported credentials for $purpose at the service boundary', async row => {
    const directory = await mkdtemp(join(tmpdir(), 'N-PI-OPENCODE-'));
    try {
      const attempt = prepare(row, directory);
      if (row.expectedCode) await expect(attempt).rejects.toMatchObject({ code: row.expectedCode });
      else await expect(attempt).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

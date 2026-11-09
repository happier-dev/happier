import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH, type RequestAuthHeadersV1 } from '@happier-dev/protocol';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('registered Kilo subscription startup', () => {
  it('uses the same selected-account model refusal during native preflight', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const prepare = activation.registration('agents', 'kilo')?.preflightSessionControls?.prepareLaunchEnvironment;
      expect(prepare).toBeTypeOf('function');
      if (!prepare) throw new Error('Missing native account preparation');
      // The host already admitted and projected this request-auth capability.
      const connectedAccounts = {
        getBinding: async () => { throw new Error('Preparation must consume the admitted capability'); },
        materialize: async () => { throw new Error('Preparation must consume the admitted capability'); },
        watch: () => { throw new Error('Preflight must not subscribe'); },
      };
      const signal = new AbortController().signal;
      await expect(prepare({ environment: { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/capability.json' }, connectedAccounts, signal })).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
        details: { failureCause: { phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
      const environment = { KILO_AUTH_CONTENT: 'native-auth' };
      const native = await prepare({ environment, connectedAccounts, signal });
      expect(native.environment).toEqual(environment);
      await native.dispose();
    } finally { await activation.dispose(); }
  });

  it.each([
    { value: null, selectionSource: 'explicit' as const },
    { value: null, selectionSource: 'inherited' as const },
  ])('requires a resolved account model before native effects ($selectionSource)', async model => {
    const root = await mkdtemp(join(tmpdir(), 'kilo-account-default-'));
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const agent = activation.registration('agents', 'kilo')!;
      const runtime = await agent.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kilo' }, signal: new AbortController().signal });
      const open = vi.fn(async () => ({}));
      await expect(runtime.sessions.open({ kind: 'create', sessionId: 'fixture', cwd: root,
        launchEnvironment: { values: { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(root, 'capability.json') }, unset: [] },
        configuration: { model: { ...model, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
      }, { protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext)).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
        details: { failureCause: { phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
      expect(open).not.toHaveBeenCalled();
    } finally { await activation.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('preserves the native default and auth route without a selected Account', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const agent = activation.registration('agents', 'kilo')!;
      const runtime = await agent.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kilo' }, signal: new AbortController().signal });
      const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => ({}));
      const request: AgentSessionOpenRequest = { kind: 'create', sessionId: 'native-default', cwd: '/workspace',
        launchEnvironment: { values: { KILO_AUTH_CONTENT: 'native-auth', KILO_CONFIG_CONTENT: '{"model":"native/default"}' }, unset: [] },
        configuration: { model: { value: null, updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
      };
      await runtime.sessions.open(request, { protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext);
      expect(open.mock.calls[0]![0].configuration?.model.value).toBeNull();
      expect(open.mock.calls[0]![0].launchEnvironment).toEqual(request.launchEnvironment);
      const transport = open.mock.calls[0]![1].transport;
      expect(transport).toMatchObject({ kind: 'stdio', args: ['acp'] });
      if (transport.kind !== 'stdio') throw new Error('Expected native stdio');
      expect(transport.env).not.toHaveProperty('KILO_AUTH_CONTENT');
      expect(transport.env).not.toHaveProperty('KILO_CONFIG_CONTENT');
    } finally { await activation.dispose(); }
  });

  it('refuses a foreign initial model through the subscription model policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kilo-account-model-'));
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const agent = activation.registration('agents', 'kilo')!;
      const runtime = await agent.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kilo' }, signal: new AbortController().signal });
      const open = vi.fn(async () => ({}));
      await expect(runtime.sessions.open({ kind: 'create', sessionId: 'fixture', cwd: root,
        launchEnvironment: { values: { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(root, 'capability.json') }, unset: [] },
        configuration: { model: { value: 'anthropic/foreign-model', selectionSource: 'explicit', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
      }, { protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext)).rejects.toMatchObject({ code: 'plugin_kilo_subscription_model_unsupported' });
      expect(open).not.toHaveBeenCalled();
    } finally { await activation.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['create', 'resume'] as const)('prepares %s with request auth and no exported credentials', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'kilo-account-'));
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const agent = activation.registration('agents', 'kilo')!;
      const runtime = await agent.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kilo' }, signal: new AbortController().signal });
      const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => ({}));
      const request: AgentSessionOpenRequest = {
        ...(kind === 'create' ? { kind } : { kind, providerSessionId: 'ses_fixture' }),
        sessionId: 'fixture', cwd: root,
        launchEnvironment: { values: { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(root, 'capability.json') }, unset: [] },
        configuration: { model: { value: 'openai/gpt-5.4', ...(kind === 'create' ? { selectionSource: 'inherited' as const } : {}), updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
      };
      await runtime.sessions.open(request, { protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext);
      const env = open.mock.calls[0]![1].transport;
      if (env.kind !== 'stdio') throw new Error('Expected native stdio');
      const auth = JSON.parse(env.env!.KILO_AUTH_CONTENT!);
      expect(auth).toMatchObject({ openai: { type: 'oauth', refresh: '', expires: 0 } });
      const config = JSON.parse(env.env!.KILO_CONFIG_CONTENT!);
      expect(config.enabled_providers).toEqual(['openai']);
      const pluginSource = await readFile(new URL(config.plugin[0]), 'utf8');
      expect(pluginSource).toContain('lookupConnectedAccountRequestAuth');
      expect(agent.connectedAccountLaunch?.requestAuthUses).toMatchObject([{ purpose: 'openai-codex-model-request' }]);
      expect(PLUGIN_MANIFEST.contributes.agents[0]?.connectedAccounts).toMatchObject([{ credentialKinds: ['oauth'] }]);
      expect(() => open.mock.calls[0]![1].definition?.models?.resolveModelUpdate?.({ modelId: 'anthropic/claude-sonnet-4-5', modelState: null })).toThrowError(expect.objectContaining({ code: 'plugin_kilo_subscription_model_unsupported' }));
    } finally { await activation.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it('uses the real SDK transport for every request and preserves typed host refusal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kilo-account-wire-'));
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    let lookups = 0;
    let denied = false;
    const authFailures: unknown[] = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      if (req.url === CONNECTED_ACCOUNT_REQUEST_AUTH_FAILURE_PATH) {
        authFailures.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, value: { status: 'current_changed' } }));
        return;
      }
      expect(JSON.parse(body)).toMatchObject({ purpose: { consumer: { pluginId: 'happier.agent.kilo', localId: 'kilo' }, purpose: 'openai-codex-model-request' } });
      lookups += 1;
      res.writeHead(denied ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(denied ? { ok: false, error: { code: 'request_auth_unavailable' } } : { ok: true, value: {
        headers: { Authorization: `Bearer access-${lookups}`, 'ChatGPT-Account-Id': 'fixture-account' }, facts: { plan: 'fixture-plan' },
        credentialContext: { account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixture' }, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
      } satisfies RequestAuthHeadersV1 }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected port');
      const capability = join(root, 'capability.json');
      await writeFile(capability, JSON.stringify({ v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION, materializationId: 'fixture', subjectScopeDigest: 'a'.repeat(64), capability: 'b'.repeat(43), httpPort: address.port }));
      vi.stubEnv(CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV, capability);
      let options: AgentAcpRuntimeOptions | undefined;
      const agent = activation.registration('agents', 'kilo')!;
      const runtime = await agent.factory!({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'kilo' }, signal: new AbortController().signal });
      await runtime.sessions.open({ kind: 'create', sessionId: 'fixture', cwd: root,
        launchEnvironment: { values: { [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capability }, unset: [] },
        configuration: { model: { value: 'openai/gpt-5.4', selectionSource: 'explicit', updatedAtMs: 0 }, mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} },
      }, { protocols: { acp: { open: async (_request: AgentSessionOpenRequest, value: AgentAcpRuntimeOptions) => { options = value; return {}; } } } } as unknown as AgentSessionRuntimeContext);
      if (options?.transport.kind !== 'stdio') throw new Error('Expected native stdio');
      const config = JSON.parse(options.transport.env!.KILO_CONFIG_CONTENT!);
      const mod = await import(/* @vite-ignore */ config.plugin[0]);
      const hooks = await mod.default();
      const loader = await hooks.auth.loader(async () => JSON.parse(options!.transport.kind === 'stdio' ? options!.transport.env!.KILO_AUTH_CONTENT! : '{}').openai);
      const nativeFetch = globalThis.fetch;
      let upstreamStatus = 200;
      const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('data: [DONE]\n\n', { status: upstreamStatus, headers: { 'content-type': 'text/event-stream' } }));
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => String(input).startsWith('http://127.0.0.1:') ? nativeFetch(input, init) : upstream(input, init));
      for (let index = 0; index < 2; index += 1) {
        await loader.fetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}', headers: { authorization: 'stale', 'chatgpt-account-id': 'stale' } });
        const [url, init] = upstream.mock.calls[index]!;
        expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
        expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer access-${index + 1}`);
        expect(new Headers(init!.headers).get('chatgpt-account-id')).toBe('fixture-account');
        expect(new Headers(init!.headers).get('plan')).toBeNull();
      }
      upstreamStatus = 401;
      expect((await loader.fetch('https://api.openai.com/v1/responses', { body: '{}' })).status).toBe(401);
      expect(authFailures).toMatchObject([{
        credentialContext: { account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixture' }, credentialRevision: 'csr_abcdefghijklmnopqrstuv' },
        normalizedFailure: { class: 'authentication', evidence: { httpStatus: 401 } },
      }]);
      expect(upstream).toHaveBeenCalledTimes(3);
      upstreamStatus = 200;
      await loader.fetch('https://api.openai.com/v1/responses', { body: '{}' });
      expect(new Headers(upstream.mock.calls[3]![1]!.headers).get('authorization')).toBe('Bearer access-4');
      denied = true;
      await expect(loader.fetch('https://api.openai.com/v1/responses', { body: '{}' })).rejects.toMatchObject({ code: 'request_auth_unavailable' });
      expect(upstream).toHaveBeenCalledTimes(4);
      expect(lookups).toBe(5);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await activation.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});

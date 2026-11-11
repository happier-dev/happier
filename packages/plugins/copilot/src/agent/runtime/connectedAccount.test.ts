import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpRuntimeOptions, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { openAiCodexConnectedAccountRuntime } from '../../../../codex/src/connectedAccounts/openAiCodexRuntime.js';
import { COPILOT_PLUGIN } from '../../manifest.js';

const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'synthetic-account' };
const signal = new AbortController().signal;
const configuration = { mode: { value: null, updatedAtMs: 1 },
  model: { value: 'subscription-only-model', updatedAtMs: 2, selectionSource: 'inherited' as const },
  permissionIntent: { value: 'read-only' as const, updatedAtMs: 3 }, options: {} };
const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())); });

async function fixture(missingAccount = false) {
  const credentials = new Map([['accessToken', 'synthetic-access-only'], ['refreshToken', 'never-export-refresh'],
    ['expiresAtMs', String(Date.now() + 3_600_000)], ['providerAccountId', 'synthetic-provider-account']]);
  if (missingAccount) credentials.delete('providerAccountId');
  // Only credential persistence is replaced; the service's credential decoder is real.
  const materializationContext = { account, signal, services: {},
    configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'config-1', values: {}, async getSecret() { return null; } },
    credentials: { async get(key: string) { return credentials.get(key) ?? null; } },
  } as Parameters<ConnectedAccountRuntime['materialize']>[1];
  const connectedAccounts = {
    getBinding: async (purpose: string) => purpose === 'openai-codex'
      ? ({ purpose: 'openai-codex', service: account.service, account, target: { kind: 'account' as const, displayName: 'ChatGPT' } }) : null,
    materialize: vi.fn<ConnectedAccountsService['materialize']>(async (_purpose, request, options) => (
      openAiCodexConnectedAccountRuntime.materialize(request, materializationContext, options)
    )),
  };
  const activation = await createPluginTestkit({ manifest: COPILOT_PLUGIN.manifest, module: COPILOT_PLUGIN });
  disposals.push(() => activation.dispose());
  const registration = activation.registration('agents', 'copilot')!;
  const runtime = await registration.factory!({ plugin: { id: COPILOT_PLUGIN.manifest.id, version: COPILOT_PLUGIN.manifest.version }, agent: { id: 'copilot' }, signal });
  let marker = 'initial';
  const native = Object.freeze({
    send: async () => ({ status: 'admitted' as const }),
    watch() { return { dispose() {} }; },
    dispose: vi.fn(),
    get nativeMarker() { return marker; },
  } satisfies AgentSessionRuntime & { readonly nativeMarker: string });
  // Supporting lifecycle boundary: the root composed test owns the real ACP consumer.
  const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => native);
  const context = { signal, services: { connectedAccounts }, protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext;
  return { runtime, registration, native, open, context, connectedAccounts, setMarker(value: string) { marker = value; } };
}

describe('Copilot ChatGPT static native launch', () => {
  it('prepares selected model preflight with the native provider file and catalog confidence', async () => {
    const { registration, connectedAccounts } = await fixture();
    const prepare = registration.preflightSessionControls?.prepareLaunchEnvironment;
    if (!prepare) throw new Error('Missing native account preparation');
    const input = { environment: { COPILOT_MODEL: 'ambient', COPILOT_GITHUB_TOKEN: 'ambient' }, connectedAccounts: {
      ...connectedAccounts, watch: () => ({ dispose() {} }),
    }, signal, modelId: configuration.model.value };
    const prepared = await prepare(input);
    try {
      expect(prepared.environment.COPILOT_MODEL).toBe('happier-chatgpt/subscription-only-model');
      expect(prepared.environment.COPILOT_GITHUB_TOKEN).toBeUndefined();
      expect(prepared.unset).toContain('COPILOT_GITHUB_TOKEN');
      expect(prepared.catalogConfidence).toBe('account_unverified');
      const settings = JSON.parse(await readFile(prepared.environment.COPILOT_PROVIDERS_CONFIG!, 'utf8'));
      expect(settings.models[0].id).toBe(configuration.model.value);
      expect(settings.providers[0].bearerToken).toBe('synthetic-access-only');
    } finally { await prepared.dispose(); }
  });

  it('uses the same selected-account default refusal before preflight starts native ACP', async () => {
    const { registration, connectedAccounts } = await fixture();
    const prepare = registration.preflightSessionControls?.prepareLaunchEnvironment;
    expect(prepare).toBeTypeOf('function');
    if (!prepare) throw new Error('Missing native account preparation');
    const input = { environment: { COPILOT_MODEL: 'ambient' }, connectedAccounts: {
      ...connectedAccounts, watch: () => ({ dispose() {} }),
    }, signal };
    await expect(prepare(input)).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed',
      details: { failureCause: { failureReason: 'model_selection_required', retryable: false } } });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    const native = await prepare({ ...input, connectedAccounts: { ...input.connectedAccounts, getBinding: async () => null } });
    expect(native.environment).toEqual(input.environment);
    await native.dispose();
  });

  it.runIf(process.env.HAPPIER_COPILOT_NATIVE_PROBE_BINARY)('Copilot 1.0.107 consumes the generated config as a subscription-compatible Responses request', async () => {
    const { runtime, context, open } = await fixture();
    const opened = await runtime.sessions.open({ kind: 'create', sessionId: 'native-probe', cwd: '/workspace', configuration }, context);
    const prepared = open.mock.calls[0]![0];
    const configPath = prepared.launchEnvironment!.values.COPILOT_PROVIDERS_CONFIG!;
    const home = await mkdtemp(join(tmpdir(), 'copilot-native-probe-'));
    let resolveRequest!: (value: { path: string; headers: Readonly<Record<string, string | string[] | undefined>>; body: Record<string, unknown> }) => void;
    let rejectRequest!: (reason: Error) => void;
    const captured = new Promise<Parameters<typeof resolveRequest>[0]>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const server = createServer((request, response) => {
      if (request.method !== 'POST') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: Record<string, unknown> = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"synthetic probe rejection","type":"authentication_error"}}');
        resolveRequest({ path: request.url!, headers: request.headers, body });
      })().catch(error => rejectRequest(error instanceof Error ? error : new Error('Probe request could not be decoded')));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local dummy endpoint');
    // Only the network boundary changes: native config, token and model come from the real writer.
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.providers[0].baseUrl = `http://127.0.0.1:${address.port}/backend-api/codex`;
    await writeFile(configPath, JSON.stringify(config));
    const child = spawn(process.env.HAPPIER_COPILOT_NATIVE_PROBE_BINARY!, [
      '--allow-all-tools', '--model', prepared.launchEnvironment!.values.COPILOT_MODEL!, '-p', 'Reply briefly.',
    ], { cwd: home, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), COPILOT_HOME: join(home, 'copilot'),
      ...prepared.launchEnvironment!.values, COPILOT_OFFLINE: 'true', TERM: 'dumb', NO_COLOR: '1' }, stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.once('error', rejectRequest);
    child.once('exit', code => rejectRequest(new Error(`Native Copilot exited before request observation (${code})`)));
    disposals.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await opened.dispose();
      await rm(home, { recursive: true, force: true });
    });
    const observed = await captured;
    expect(observed.path).toBe('/backend-api/codex/responses');
    expect(observed.headers).toMatchObject({ authorization: 'Bearer synthetic-access-only', 'chatgpt-account-id': 'synthetic-provider-account',
      'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' });
    expect(observed.body).toMatchObject({ model: 'subscription-only-model', store: false, stream: true, include: ['reasoning.encrypted_content'] });
    expect(observed.body.instructions).toEqual(expect.any(String));
    expect(String(observed.body.instructions).length).toBeGreaterThan(0);
    expect(observed.body).not.toHaveProperty('max_output_tokens');
    expect(observed.body).not.toHaveProperty('max_tokens');
    expect(JSON.stringify(observed.body)).not.toContain('never-export-refresh');
    process.stdout.write(`${JSON.stringify({ fixture: 'copilot-native-chatgpt', cliVersion: '1.0.107', path: observed.path,
      model: observed.body.model, store: observed.body.store, include: observed.body.include, nativeInstructionsPresent: true,
      maxOutputTokensAbsent: true, accessOnly: true })}\n`);
  });

  it('writes only current access material, isolates model routing and retains the native handle until disposal', async () => {
    const { runtime, context, open, native, setMarker } = await fixture();
    const opened = await runtime.sessions.open({ kind: 'create', sessionId: 'copilot-chatgpt', cwd: '/workspace', configuration,
      launchEnvironment: { values: { PATH: '/bin', COPILOT_PROVIDER_BEARER_TOKEN: 'inherited-secret', COPILOT_PROVIDERS_CONFIG: '/unrelated/providers.json' }, unset: ['UNRELATED'] },
    }, context);
    const [request, options] = open.mock.calls[0]!;
    const path = request.launchEnvironment!.values.COPILOT_PROVIDERS_CONFIG!;
    const serialized = await readFile(path, 'utf8');
    const config = JSON.parse(serialized);
    expect(config).toEqual({ providers: [{ name: 'happier-chatgpt', type: 'openai', baseUrl: 'https://chatgpt.com/backend-api/codex',
      bearerToken: 'synthetic-access-only', wireApi: 'responses', headers: { 'chatgpt-account-id': 'synthetic-provider-account', 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' } }],
      models: [{ id: 'subscription-only-model', provider: 'happier-chatgpt', maxOutputTokens: 0 }] });
    expect(serialized).not.toContain('never-export-refresh');
    expect(request).not.toHaveProperty('providerBinding');
    expect(request.launchEnvironment!.values).toEqual({ PATH: '/bin', COPILOT_PROVIDERS_CONFIG: path, COPILOT_MODEL: 'happier-chatgpt/subscription-only-model' });
    expect(request.launchEnvironment!.unset).toContain('COPILOT_PROVIDER_BEARER_TOKEN');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o077).toBe(0);
    const models = options.definition!.models!;
    const modelState = models.projectModelState!({ normalizedModelState: { currentModelId: 'happier-chatgpt/subscription-only-model',
      availableModels: [{ id: 'happier-chatgpt/subscription-only-model', name: 'Selected' }, { id: 'native-default', name: 'Native' }] } });
    expect(modelState).toEqual({ currentModelId: 'subscription-only-model', availableModels: [{ id: 'subscription-only-model', name: 'Selected' }] });
    expect(models.resolveModelUpdate!({ modelId: 'subscription-only-model', modelState })).toEqual({ modelId: 'happier-chatgpt/subscription-only-model' });
    expect(() => models.resolveModelUpdate!({ modelId: 'native-default', modelState })).toThrow();
    expect(await opened.send({ input: { text: 'Hi' } } as Parameters<AgentSessionRuntime['send']>[0])).toEqual({ status: 'admitted' });
    expect(Reflect.get(opened, 'nativeMarker')).toBe('initial');
    setMarker('updated');
    expect(Reflect.get(opened, 'nativeMarker')).toBe('updated');
    await opened.dispose();
    expect(native.dispose).toHaveBeenCalledOnce();
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['missing-model', 'empty-model', 'default-model', 'missing-account'] as const)('refuses %s before the native consumer opens', async failure => {
    const { runtime, context, open } = await fixture(failure === 'missing-account');
    await expect(runtime.sessions.open({ kind: 'create', sessionId: 'refused', cwd: '/workspace',
      configuration: failure === 'missing-model' ? undefined : failure === 'empty-model'
        ? { ...configuration, model: { ...configuration.model, value: '' } } : failure === 'default-model'
          ? { ...configuration, model: { ...configuration.model, value: 'default' } } : configuration,
    }, context).then(async opened => { await opened.dispose(); return opened; })).rejects.toMatchObject({ code: failure === 'missing-account' ? 'copilot_account_materialization_unavailable' : 'agent_startup_model_reconciliation_failed' });
    expect(open).not.toHaveBeenCalled();
  });

  it('removes access material if the native consumer fails to open', async () => {
    const { runtime, context, open } = await fixture();
    let path: string | undefined;
    open.mockImplementationOnce(async request => { path = request.launchEnvironment!.values.COPILOT_PROVIDERS_CONFIG; throw new Error('native launch failed'); });
    await expect(runtime.sessions.open({ kind: 'resume', providerSessionId: 'native-id', sessionId: 'copilot', cwd: '/workspace', configuration }, context)).rejects.toThrow('native launch failed');
    expect(path).toBeDefined();
    await expect(access(path!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('proves native resume through ACP session/load without claiming account adoption or creating a broker', async () => {
    const { registration } = await fixture();
    const launch = registration.connectedAccountLaunch!;
    expect(launch.requestAuthUses).toBeUndefined();
    expect(launch.stateSharingDescriptor).toBeUndefined();
    expect(launch.continuity!.runtimeAuthAdapter!.canHotApply({ target: { agentId: 'copilot' }, selection: {} })).toMatchObject({ supported: false, recovery: 'restart_resume' });
    expect(await launch.continuity!.runtimeAuthAdapter!.verifyActiveAccount!({ target: { agentId: 'copilot' }, selection: {} })).toMatchObject({ status: 'unavailable', retryable: false });
    const requests: Array<{ method: string; params: unknown }> = [];
    const result = await launch.continuity!.verifyResumeReachable!({
      vendorResumeId: 'native-session',
      sessionFiles: { verifyDeclaredPaths: async () => ({ found: false }), findDeclaredCandidate: async () => ({ found: false }) },
      nativeInspection: { cwd: '/real/copilot/workspace', withDeclaredJsonRpcClient: async (_command, inspect) => await inspect({
        request: async (method, params) => { requests.push({ method, params }); return {}; },
        notify: async () => undefined, onNotification: () => () => undefined, onRequest: () => () => undefined,
      }, new AbortController().signal) },
    } as never);
    expect(result).toEqual({ ok: true, proof: 'native_session' });
    expect(requests.map(request => request.method)).toEqual(['initialize', 'session/load']);
    expect(requests[1]?.params).toMatchObject({ sessionId: 'native-session', cwd: '/real/copilot/workspace', mcpServers: [] });
  });
});

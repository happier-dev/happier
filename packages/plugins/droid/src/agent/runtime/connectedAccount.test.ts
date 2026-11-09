import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountsService, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentAcpRuntimeOptions, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentSessionOpenRequest, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { openAiCodexConnectedAccountRuntime } from '../../../../codex/src/connectedAccounts/openAiCodexRuntime.js';
import { DROID_PLUGIN } from '../../manifest.js';
import { AGENT_DEFINITION } from '../definition.js';

const purpose = 'openai-codex';
const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'selected-chatgpt' };
const signal = new AbortController().signal;
const configuration = { mode: { value: null, updatedAtMs: 1 }, model: { value: 'gpt-5.3-codex', updatedAtMs: 2, selectionSource: 'explicit' as const },
  permissionIntent: { value: 'read-only' as const, updatedAtMs: 3 }, options: {} };
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())); vi.unstubAllEnvs(); });

async function fixture(options: { bound?: boolean; materialization?: 'environment' | 'missing-account' } = {}) {
  const credentials = new Map([['accessToken', 'synthetic-droid-token'], ['expiresAtMs', String(Date.now() + 3_600_000)], ['providerAccountId', 'synthetic-chatgpt-id']]);
  const materializationContext = { account, configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'config-1', values: {}, async getSecret() { return null; } },
    signal, services: {}, credentials: { async get(key: string) { return credentials.get(key) ?? null; } } } as Parameters<ConnectedAccountRuntime['materialize']>[1];
  // Host service port preserves the real Connected Account credential decoder;
  // only its persistent credential store is an in-memory boundary fixture.
  const connectedAccounts = {
    getBinding: vi.fn(async () => options.bound === false ? null : { purpose, service: account.service, account, target: { kind: 'account' as const, displayName: 'ChatGPT' } }),
    materialize: vi.fn<ConnectedAccountsService['materialize']>(async (requestedPurpose, request, materializeOptions) => {
      expect(requestedPurpose).toBe(purpose);
      expect(materializeOptions?.expectedAccount).toEqual(account);
      expect(request).toEqual({ kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'] });
      if (options.materialization === 'environment') return { kind: 'environment', env: {} };
      if (options.materialization === 'missing-account') credentials.delete('providerAccountId');
      return openAiCodexConnectedAccountRuntime.materialize(request, materializationContext, materializeOptions);
    }),
  };
  const activation = await createPluginTestkit({ manifest: DROID_PLUGIN.manifest, module: DROID_PLUGIN });
  disposals.push(() => activation.dispose());
  const registration = activation.registration('agents', 'droid')!;
  const runtime = await registration.factory!({ plugin: { id: DROID_PLUGIN.manifest.id, version: DROID_PLUGIN.manifest.version }, agent: { id: 'droid' }, signal });
  let sessionListing = 'unsupported';
  const session = Object.freeze({ get runtimeCapabilities() { return { sessionCapabilities: { sessionListing } }; },
    send: async () => ({ status: 'admitted' as const }), cancel: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose: vi.fn() });
  const open = vi.fn(async (_request: AgentSessionOpenRequest, _options: AgentAcpRuntimeOptions) => session);
  const context = { signal, services: { connectedAccounts }, protocols: { acp: { open } } } as unknown as AgentSessionRuntimeContext;
  return { registration, runtime, connectedAccounts, context, open, session, enableSessionListing() { sessionListing = 'supported'; } };
}

describe('Droid ChatGPT static access launch', () => {
  it('uses the same model refusal for selected-account preflight before materialization', async () => {
    const { registration, connectedAccounts } = await fixture();
    const prepare = registration.preflightSessionControls?.prepareLaunchEnvironment;
    expect(prepare).toBeTypeOf('function');
    if (!prepare) throw new Error('Missing native account preparation');
    const input = { environment: { FACTORY_API_KEY: 'ambient' }, connectedAccounts: {
      ...connectedAccounts, watch: () => ({ dispose() {} }),
    }, signal };
    await expect(prepare(input)).rejects.toMatchObject({ code: 'model_selection_required' });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    connectedAccounts.getBinding.mockResolvedValueOnce(null);
    const native = await prepare(input);
    expect(native.environment).toEqual(input.environment);
    await native.dispose();
  });

  it('keeps negotiated runtime capabilities live after launch', async () => {
    const { runtime, context, enableSessionListing } = await fixture();
    const opened = await runtime.sessions!.open({ kind: 'create', sessionId: 'capabilities', cwd: '/workspace', configuration }, context);
    expect(Reflect.get(opened, 'runtimeCapabilities').sessionCapabilities.sessionListing).toBe('unsupported');
    enableSessionListing();
    expect(Reflect.get(opened, 'runtimeCapabilities').sessionCapabilities.sessionListing).toBe('supported');
    await opened.dispose();
  });

  it.each(['create', 'resume'] as const)('materializes selected ChatGPT once for %s and cleans process settings on dispose', async kind => {
    const { runtime, context, open, connectedAccounts, session } = await fixture();
    const request: AgentSessionOpenRequest = { ...(kind === 'create' ? { kind } : { kind, providerSessionId: 'native-session' }), sessionId: 'droid-chatgpt', cwd: '/workspace', configuration,
      launchEnvironment: { values: { PATH: '/bin', FACTORY_API_KEY: 'inherited-native-secret' }, unset: ['UNRELATED'] } };
    const opened = await runtime.sessions!.open(request, context);
    const [prepared, options] = open.mock.calls[0]!;
    expect(connectedAccounts.getBinding).toHaveBeenCalledTimes(1);
    expect(connectedAccounts.materialize).toHaveBeenCalledTimes(1);
    expect(prepared).not.toHaveProperty('providerBinding');
    expect(prepared.launchEnvironment).toEqual({ values: { PATH: '/bin', HAPPIER_DROID_PROVIDER_API_KEY: 'synthetic-droid-token' }, unset: ['UNRELATED', 'FACTORY_API_KEY'] });
    expect(options.transport.kind).toBe('stdio');
    if (options.transport.kind !== 'stdio') throw new Error('Expected native stdio transport');
    const settings = options.transport.args!.at(-1)!;
    expect(options.transport.args).toEqual(['exec', '--output-format', 'acp', '--settings', settings]);
    const serialized = await readFile(settings, 'utf8');
    expect(serialized).not.toContain('synthetic-droid-token');
    expect(JSON.parse(serialized)).toEqual({ customModels: [{ model: 'gpt-5.3-codex', displayName: 'Happier provider: gpt-5.3-codex', baseUrl: 'https://chatgpt.com/backend-api/codex',
      provider: 'openai', apiKey: '${HAPPIER_DROID_PROVIDER_API_KEY}', extraHeaders: { 'chatgpt-account-id': 'synthetic-chatgpt-id', 'openai-beta': 'responses=experimental', originator: 'codex_cli_rs' } }] });
    if (process.platform !== 'win32') expect((await stat(settings)).mode & 0o077).toBe(0);
    const native = { id: 'custom:Happier-provider-gpt-5.3-codex-0', name: 'Happier provider: gpt-5.3-codex' };
    const projected = options.definition!.models!.projectModelState!({ normalizedModelState: { currentModelId: native.id,
      availableModels: [{ id: 'native-ineligible-model', name: 'Native model' }, native] } });
    expect(projected).toEqual({ currentModelId: 'gpt-5.3-codex', availableModels: [{ id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' }] });
    expect(options.definition!.models!.resolveModelUpdate!({ modelId: 'gpt-5.3-codex', modelState: projected })).toEqual({ modelId: native.id });
    await opened.dispose('runtime_recovery');
    expect(session.dispose).toHaveBeenCalledExactlyOnceWith('runtime_recovery');
    await expect(access(dirname(settings))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['open', 'openConversation'] as const)('uses the same materialization for Run %s', async entry => {
    const { runtime, connectedAccounts } = await fixture();
    const run = { send: async () => ({ status: 'admitted' as const }), stop: async () => ({ status: 'requested' as const }), watch: () => ({ dispose() {} }), dispose() {} };
    const open = vi.fn(async (_request: AgentExecutionRunOpenRequest, _options: AgentAcpRuntimeOptions) => run);
    const context = { signal, services: { connectedAccounts }, protocols: { acp: { openExecutionRunV1: open, openExecutionRunConversationV1: open } } } as unknown as AgentExecutionRunRuntimeContextV1;
    const opened = await runtime.sessions!.executionRunContextV1![entry]!({ kind: 'create', runId: 'droid-run', cwd: '/workspace', profile: { pluginId: DROID_PLUGIN.manifest.id, localId: 'default' }, input: { text: 'Hi' }, configuration }, context);
    expect(connectedAccounts.materialize).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0].launchEnvironment?.values.HAPPIER_DROID_PROVIDER_API_KEY).toBe('synthetic-droid-token');
    await opened.dispose();
  });

  it.each(['missing-model', 'inherited-model', 'provider-binding', 'wrong-materialization', 'missing-account'] as const)('refuses %s before native launch', async failure => {
    const { runtime, context, open, connectedAccounts } = await fixture({ ...(failure === 'wrong-materialization' ? { materialization: 'environment' } : failure === 'missing-account' ? { materialization: 'missing-account' } : {}) });
    const request: AgentSessionOpenRequest = { kind: 'create', sessionId: 'refused', cwd: '/workspace', configuration: failure === 'missing-model' ? undefined : failure === 'inherited-model'
      ? { ...configuration, model: { ...configuration.model, selectionSource: 'inherited' } } : configuration,
      ...(failure === 'provider-binding' ? { providerBinding: { connectionId: 'selected-provider', upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example/v1', credential: 'none' },
        model: { id: 'other', name: 'Other' }, materialization: { v: 1, kind: 'configFile', rootPath: '/private/provider', relativePaths: ['droid/settings.json'] } } } : {}) };
    await expect(runtime.sessions!.open(request, context)).rejects.toMatchObject({ code: failure === 'provider-binding' ? 'droid_connected_account_provider_conflict'
      : failure === 'missing-model' || failure === 'inherited-model' ? 'model_selection_required' : 'droid_connected_account_materialization_invalid' });
    expect(open).not.toHaveBeenCalled();
    expect(connectedAccounts.materialize).toHaveBeenCalledTimes(failure === 'wrong-materialization' || failure === 'missing-account' ? 1 : 0);
  });

  it('cleans its settings after a native launch failure', async () => {
    const { runtime, context, open } = await fixture();
    let settings: string | undefined;
    open.mockImplementationOnce(async (_request, options) => {
      if (options.transport.kind === 'stdio') settings = options.transport.args!.at(-1);
      throw new Error('synthetic native failure');
    });
    await expect(runtime.sessions!.open({ kind: 'create', sessionId: 'failed', cwd: '/workspace', configuration }, context)).rejects.toThrow('synthetic native failure');
    expect(settings).toBeDefined();
    await expect(access(dirname(settings!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves native launch when unbound', async () => {
    const { runtime, context, open, connectedAccounts } = await fixture({ bound: false });
    const request: AgentSessionOpenRequest = { kind: 'create', sessionId: 'native', cwd: '/workspace' };
    await runtime.sessions!.open(request, context);
    expect(open.mock.calls[0]![0]).toBe(request);
    expect(open.mock.calls[0]![1].transport).toMatchObject({ args: ['exec', '--output-format', 'acp'] });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
  });

  it('declares static-access restart semantics and refuses unproven resume even with default-home history', async () => {
    const { registration } = await fixture();
    expect(DROID_PLUGIN.manifest.contributes.agents[0]!.connectedAccounts).toEqual([{ purpose, service: account.service, credentialKinds: ['oauth'], materializationKinds: ['httpHeaders'] }]);
    expect(AGENT_DEFINITION.modelConfig.supportsFreeform).toBe(true);
    const launch = registration.connectedAccountLaunch!;
    expect(launch.switchContinuity).toMatchObject({ continuityMode: 'restart_same_home' });
    expect(launch.stateSharingDescriptor).toBeUndefined();
    expect(launch.requestAuthUses).toBeUndefined();
    expect(launch.continuity!.runtimeAuthAdapter!.canHotApply({ target: { agentId: 'droid' }, selection: {} })).toMatchObject({ supported: false, recovery: 'restart_resume' });
    const verify = launch.continuity!.verifyResumeReachable!;
    const sessionFiles = { async verifyDeclaredPaths() { return { found: false }; }, async findDeclaredCandidate() { return { found: false }; } };
    expect(await verify({ vendorResumeId: null, sessionFiles })).toMatchObject({ ok: false });
    const home = await mkdtemp(join(tmpdir(), 'happier-droid-resume-'));
    disposals.push(() => rm(home, { recursive: true, force: true }));
    vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
    const directory = join(home, '.factory', 'sessions', '-workspace');
    await mkdir(directory, { recursive: true });
    expect(await verify({ vendorResumeId: 'session-fixture', sessionFiles })).toMatchObject({ ok: false });
    await copyFile(new URL('../externalSessions/__fixtures__/droid-0.170.0-transcript-v2.jsonl', import.meta.url), join(directory, 'session-fixture.jsonl'));
    expect(await verify({ vendorResumeId: 'session-fixture', sessionFiles })).toEqual({ ok: false, reason: 'droid_native_resume_home_unproven' });
    expect(await verify({ vendorResumeId: 'not-present', sessionFiles })).toMatchObject({ ok: false });
  });
});

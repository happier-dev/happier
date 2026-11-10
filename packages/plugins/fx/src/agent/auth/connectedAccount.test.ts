import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV, type ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION } from '@happier-dev/protocol/connect/connected-account-request-auth';

import type { AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1, AgentSessionConfigurationSnapshot, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { buildExecutionRunConfiguration } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { FX_PLUGIN } from '../../manifest.js';
import { createFxAgentRuntime } from '../runtime/factory.js';
import { FX_TERMINAL_CONTRIBUTION } from '../terminal/contribution.js';
import { FX_NATIVE_AUTH_CODEC, prepareFxConnectedAccount } from './connectedAccount.js';

const selectedConfiguration: AgentSessionConfigurationSnapshot = {
  model: { value: 'gpt-selected', updatedAtMs: 1, selectionSource: 'explicit' },
  mode: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(expiresAt: number | null = Date.now() + 3_600_000, authorization = 'Bearer fixture-access') {
  const home = await mkdtemp(join(tmpdir(), 'fx-connected-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: unknown[] = [];
  // The daemon's private HTTP transport is the system boundary; the real SDK
  // capability reader, request encoder and response decoder run beneath it.
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, value: {
      headers: { Authorization: authorization, 'chatgpt-account-id': 'fixture-account' }, facts: {},
      ...(expiresAt === null ? {} : { expiresAt }),
      credentialContext: { account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixture-profile' }, credentialRevision: `csr_${'a'.repeat(22)}` },
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
  const capability = join(home, 'capability.json');
  await writeFile(capability, JSON.stringify({ v: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_VERSION, materializationId: 'fx-fixture', subjectScopeDigest: 'd'.repeat(64), capability: 'c'.repeat(43), httpPort: address.port }));
  return { home, requests, expiresAt, launchEnvironment: { values: { HOME: home, [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capability }, unset: [] } };
}

describe('FX connected-account native launch', () => {
  it('refuses the unresolved default model before acquiring credentials', async () => {
    const input = await fixture();
    await expect(prepareFxConnectedAccount(input.launchEnvironment, undefined, 'default')).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed',
      details: { failureCause: { failureReason: 'model_selection_required', retryable: false } } });
    expect(input.requests).toEqual([]);
    await expect(readFile(join(input.home, '.fx/chatgpt-auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['session', 'run', 'conversation', 'terminal'] as const)('returns typed model-pick guidance before credentials or native effects for a fresh selected-account %s', async lane => {
    const input = await fixture();
    const open = vi.fn(async () => ({} as never));
    const signal = new AbortController().signal;
    const runtime = await createFxAgentRuntime({ plugin: { id: 'happier.agent.fx', version: '0.0.0' }, agent: { id: 'fx' }, signal });
    const request = { cwd: '/workspace', launchEnvironment: input.launchEnvironment };
    const context = { signal, protocols: { acp: { open, openExecutionRunV1: open, openExecutionRunConversationV1: open } } };
    const run: AgentExecutionRunOpenRequest = { ...request, kind: 'create', runId: 'default-refusal',
      profile: { pluginId: 'happier.agent.fx', localId: 'default' }, input: { text: 'Hello' } };
    const opened = lane === 'terminal'
      ? FX_TERMINAL_CONTRIBUTION.resolveLaunch({ ...request, sessionId: 'default-refusal', metadata: {}, modelSelection: null })
      : lane === 'session'
        ? runtime.sessions!.open({ ...request, kind: 'create', sessionId: 'default-refusal' }, context as unknown as AgentSessionRuntimeContext)
        : lane === 'run'
          ? runtime.sessions!.executionRunContextV1!.open(run, context as unknown as AgentExecutionRunRuntimeContextV1)
          : runtime.sessions!.executionRunContextV1!.openConversation!(run, context as unknown as AgentExecutionRunRuntimeContextV1);
    const failure = await Promise.resolve(opened).catch(error => sanitizeNativeAgentSessionBoundaryError(error, true));
    expect(readSessionPreparationFailureDiagnostic(failure).failureCause).toMatchObject({
      code: 'agent_startup_model_reconciliation_failed', phase: 'client_start',
      failureReason: 'model_selection_required', retryable: false,
    });
    expect(input.requests).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    await expect(readFile(join(input.home, '.fx/chatgpt-auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['session', 'run', 'conversation'] as const)('passes the resolved account model to native %s startup', async lane => {
    const input = await fixture();
    const open = vi.fn(async (request: { launchEnvironment?: { values: Readonly<Record<string, string>> } }) => {
      expect(request.launchEnvironment?.values).toMatchObject({ FX_PROVIDER: 'codex', FX_MODEL: 'gpt-selected' });
      return {} as never;
    });
    const signal = new AbortController().signal;
    const runtime = await createFxAgentRuntime({ plugin: { id: 'happier.agent.fx', version: '0.0.0' }, agent: { id: 'fx' }, signal });
    const resolvedConfiguration = lane === 'session' ? selectedConfiguration : buildExecutionRunConfiguration({
      backendTarget: { kind: 'backend', backendId: 'fx' }, modelId: 'gpt-selected',
      permissionMode: 'default', updatedAtMs: 1,
    }).configuration;
    // Some finite callers carry the resolved value without provenance.
    const configuration = lane === 'conversation' ? { ...resolvedConfiguration, model: {
      value: resolvedConfiguration.model.value, updatedAtMs: resolvedConfiguration.model.updatedAtMs,
    } } : resolvedConfiguration;
    const request = { cwd: '/workspace', launchEnvironment: input.launchEnvironment, configuration };
    const context = { signal, protocols: { acp: { open, openExecutionRunV1: open, openExecutionRunConversationV1: open } } };
    if (lane === 'session') await runtime.sessions!.open({ ...request, kind: 'create', sessionId: 'selected-model' }, context as unknown as AgentSessionRuntimeContext);
    else {
      const run: AgentExecutionRunOpenRequest = { ...request, kind: 'create', runId: 'selected-model',
        profile: { pluginId: 'happier.agent.fx', localId: 'default' }, input: { text: 'Hello' } };
      if (lane === 'run') await runtime.sessions!.executionRunContextV1!.open(run, context as unknown as AgentExecutionRunRuntimeContextV1);
      else await runtime.sessions!.executionRunContextV1!.openConversation!(run, context as unknown as AgentExecutionRunRuntimeContextV1);
    }
    expect(open).toHaveBeenCalled();
    expect(input.requests).toHaveLength(1);
  });

  it('does not adopt ambient FX_MODEL without a resolved model for the selected Account', async () => {
    const input = await fixture();
    await expect(FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'inherited-model', cwd: '/workspace', metadata: {}, modelSelection: null,
      launchEnvironment: { ...input.launchEnvironment, values: { ...input.launchEnvironment.values, FX_MODEL: 'ambient-model' } },
    })).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed',
      details: { failureCause: { failureReason: 'model_selection_required', retryable: false } } });
    expect(input.requests).toEqual([]);
  });

  it('uses the same default refusal for registered preflight while preserving native-unbound environment', async () => {
    const activation = await createPluginTestkit({ manifest: FX_PLUGIN.manifest, module: { activate: FX_PLUGIN.activate } });
    try {
      const prepare = activation.registration('agents', 'fx')?.preflightSessionControls?.prepareLaunchEnvironment;
      expect(prepare).toBeTypeOf('function');
      if (!prepare) throw new Error('Missing FX launch preparation');
      const signal = new AbortController().signal;
      const connectedAccounts = { getBinding: async () => { throw new Error('Already admitted'); },
        materialize: async () => { throw new Error('Already admitted'); }, watch: () => { throw new Error('No subscription'); } };
      await expect(prepare({ environment: { HOME: '/private', [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]: '/private/capability.json' },
        connectedAccounts, signal })).rejects.toMatchObject({ code: 'agent_startup_model_reconciliation_failed',
        details: { failureCause: { failureReason: 'model_selection_required', retryable: false } } });
      const environment = { FX_MODEL: 'native-default' };
      const native = await prepare({ environment, connectedAccounts, signal });
      expect(native.environment).toEqual(environment);
      await native.dispose();
    } finally { await activation.dispose(); }
  });

  it('launches terminal FX with qualified access-only auth in its prepared home', async () => {
    const input = await fixture();
    await mkdir(join(input.home, '.fx'), { mode: 0o755 });
    const plan = await FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null, configuration: selectedConfiguration, launchEnvironment: input.launchEnvironment });
    const auth = JSON.parse(await readFile(join(input.home, '.fx/chatgpt-auth.json'), 'utf8'));
    expect(auth).toEqual({ version: 1, access_token: 'fixture-access', refresh_token: 'happier-host-managed-no-refresh', account_id: 'fixture-account', expires_at_ms: input.expiresAt });
    if (process.platform !== 'win32') expect((await stat(join(input.home, '.fx'))).mode & 0o777).toBe(0o700);
    expect(plan.environment?.values).toMatchObject({ FX_PROVIDER: 'codex', FX_AUTH_MODE: 'local', FX_MODEL: 'gpt-selected' });
    expect(input.requests).toEqual([expect.objectContaining({ purpose: { consumer: { pluginId: 'happier.agent.fx', localId: 'fx' }, purpose: 'openai-codex' } })]);
  });

  it('refuses a native launch when the lease cannot establish its expiry', async () => {
    const input = await fixture(null);
    await expect(FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null, configuration: selectedConfiguration, launchEnvironment: input.launchEnvironment })).rejects.toMatchObject({ code: 'fx_connected_account_expiry_unavailable' });
    await expect(readFile(join(input.home, '.fx/chatgpt-auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses non-Bearer material before writing native token auth', async () => {
    const input = await fixture(Date.now() + 3_600_000, 'Basic fixture');
    await expect(FX_TERMINAL_CONTRIBUTION.resolveLaunch({ sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null, configuration: selectedConfiguration, launchEnvironment: input.launchEnvironment })).rejects.toMatchObject({ code: 'fx_connected_account_bearer_unavailable' });
    await expect(readFile(join(input.home, '.fx/chatgpt-auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not verify a matching token inside a file rejected by the native schema', () => {
    const credential = { v: 1, kind: 'oauth', serviceId: 'openai-codex', profileId: 'fixture-profile', createdAt: 0, updatedAt: 0, expiresAt: Date.now() + 3_600_000,
      oauth: { accessToken: 'fixture-access', refreshToken: 'real-owner-refresh-never-exported', providerAccountId: 'fixture-account', providerEmail: null, idToken: null, scope: null, tokenType: null } } satisfies ConnectedServiceCredentialRecordV1;
    const files = { '.fx/chatgpt-auth.json': new TextEncoder().encode(JSON.stringify({ version: 2, access_token: 'fixture-access', account_id: 'fixture-account' })) };
    expect(FX_NATIVE_AUTH_CODEC.inspect({ selection: {}, credential, files })).toMatchObject({ status: 'mismatch' });
  });
});

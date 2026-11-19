import { readFile, writeFile } from 'node:fs/promises';

import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginExecSpawnRequest,
  PluginProcessResult,
  ResolvedSystemTool as PluginResolvedSystemTool } from '@happier-dev/plugin-sdk/exec';
import type {
  PluginServices,
} from '@happier-dev/plugin-sdk';
import { ReviewFindingsV2Schema, ReviewScmScopeV1Schema } from '@happier-dev/plugin-sdk/reviews';
import { AgentProviderBindingMaterializationV1Schema, resolveProviderBindingCompatibilityWithFingerprintV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { DEEPSEC_PROVIDER_ENV_KEYS } from './agent/providerBinding.js';
import { buildGitSnapshot } from '../../scm-git/src/statusSnapshot.js';
import { claudeSubscriptionConnectedAccountRuntime } from '../../claude/src/connectedAccounts/claudeSubscriptionRuntime.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function processResult(exitCode = 0): PluginProcessResult {
  return {
    termination: {
      observed: { kind: 'exit', exitCode },
      requestedBy: { kind: 'none' },
    },
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createRuntimeContext(params?: Readonly<{
  resolvedTool?: PluginResolvedSystemTool;
  run?: (request: PluginExecSpawnRequest & { timeoutMs?: number }, options?: { signal?: AbortSignal }) => Promise<PluginProcessResult>;
  stat?: (path: Readonly<{ root: 'workspace'; relativePath: string }>, options?: { signal?: AbortSignal }) => Promise<Readonly<{
    kind: 'file' | 'directory';
    size: number;
    modifiedAtMs: number;
  }>>;
  connectedAccounts?: Pick<PluginServices['connectedAccounts'], 'getBinding' | 'materialize' | 'resolveSelection'>;
  checkReadiness?: (request: Readonly<{
    candidates: readonly string[];
    requirement: 'any' | 'all';
    cwd?: string;
    projectId?: string;
    workspaceId?: string;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ launchable: readonly Readonly<{ agentId: string }>[] }>>;
}>): Readonly<{
  context: AgentRuntimeContext;
  resolve: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  checkReadiness: ReturnType<typeof vi.fn>;
}> {
  const resolvedTool = params?.resolvedTool ?? {
    executable: { kind: 'systemTool', id: 'deepsec-cli' },
    executablePath: '/usr/local/bin/deepsec',
  };
  const resolve = vi.fn(async () => resolvedTool);
  const run = vi.fn(params?.run ?? (async request => {
    if (request.args?.[0] === 'export') {
      const outIndex = request.args.indexOf('--out');
      const outPath = outIndex < 0 ? undefined : request.args[outIndex + 1];
      if (!outPath) throw new Error('Expected native export output path');
      await writeFile(outPath, '[]', 'utf8');
    }
    return processResult();
  }));
  const stat = vi.fn(params?.stat ?? (async () => ({
    kind: 'file' as const,
    size: 0,
    modifiedAtMs: 0,
  })));
  const checkReadiness = vi.fn(params?.checkReadiness ?? (async () => ({
    launchable: [{ agentId: 'claude' }],
  })));
  const services = {
    availability: (id: string) => id === 'exec' || id === 'fs'
      ? { status: 'available' as const }
      : { status: 'unavailable' as const },
    connectedAccounts: params?.connectedAccounts ?? { getBinding: async () => null,
      resolveSelection: async () => ({ credentialSource: 'machineLogin' as const }) },
    exec: {
      agentCli: { checkReadiness },
      systemTools: { resolve },
      run,
    },
    fs: { stat },
  } as unknown as PluginServices;
  const unavailable = async (): Promise<never> => {
    throw new Error('unavailable');
  };
  return {
    context: {
      plugin: { id: 'happier.review.deepsec', version: '0.0.0' },
      contribution: {
        id: 'deepsec',
        qualifiedId: 'happier.review.deepsec/agents/deepsec',
      },
      surface: 'agent',
      signal: new AbortController().signal,
      services,
      ui: {
        askQuestions: unavailable,
        confirm: unavailable,
        notify: unavailable,
        status: { set: unavailable },
        widget: { set: unavailable },
        title: { set: unavailable },
        composer: { replace: unavailable },
      },
      agent: { id: 'deepsec' },
      protocols: { acp: { open: unavailable } },
    },
    resolve,
    run,
    stat,
    checkReadiness,
  };
}

async function createNativeDeepSecRuntime() {
  const activation = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate },
  });
  const factory = activation.registration('agents', 'deepsec')?.factory;
  if (!factory) throw new Error('Expected DeepSec Agent registration');
  const runtime = await factory({
    plugin: { id: 'happier.review.deepsec', version: '0.0.0' },
    agent: { id: 'deepsec' },
    signal: new AbortController().signal,
  });
  const registrations = activation.registrations();
  await activation.dispose();
  return { registrations, runtime };
}

function createSupportedScmReviewScope(
  paths: readonly string[] = ['src/auth.ts'],
  worktreeRoot = '/repo',
): Record<string, unknown> {
  const changedPaths = paths.map((path) => ({
    path,
    previousPath: null,
    kind: 'modified',
    hasCommittedDelta: false,
    hasUncommittedDelta: true,
    diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false },
  }));
  return {
    kind: 'review_scm_scope.v1',
    status: 'supported',
    scmBackendId: 'git',
    scmMode: '.git',
    repositoryRoot: worktreeRoot,
    worktreeRoot,
    baseRef: { source: 'branch_upstream', ref: 'origin/main' },
    selectedPaths: paths,
    committedPaths: [],
    uncommittedPaths: changedPaths,
    changedPaths,
    diff: { committedAvailable: false, uncommittedAvailable: true },
    diagnostics: [],
  };
}

function createOpenRequest(params?: Readonly<{
  runId?: string;
  mode?: 'current_diff' | 'selected_files';
  includeExplicitMode?: boolean;
  confirmedCostWarning?: boolean;
  profileLocalId?: string;
  paths?: readonly string[];
  scmReviewScope?: unknown;
  cwd?: string;
  engineSelectedFiles?: readonly string[];
}>): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  const paths = params?.paths ?? ['src/auth.ts'];
  return {
    kind: 'create',
    runId: params?.runId ?? 'run-1',
    cwd: params?.cwd ?? '/repo',
    profile: {
      pluginId: 'happier.review.deepsec',
      localId: params?.profileLocalId ?? 'review',
    },
    launchEnvironment: {
      values: { AI_GATEWAY_API_KEY: 'gateway-key' },
      unset: [],
    },
    input: {
      text: 'Review the current diff.',
      structuredInput: {
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        reviewers: [{ kind: 'engine', engineId: 'deepsec' }],
        instructions: 'Review the current diff.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
        scmReviewScope: params?.scmReviewScope ?? createSupportedScmReviewScope(paths),
        engines: {
          deepsec: {
            ...(params?.includeExplicitMode === false
              ? {}
              : { mode: params?.mode ?? 'current_diff' }),
            ...(params?.confirmedCostWarning ? { confirmedCostWarning: true } : {}),
            ...(params?.engineSelectedFiles ? { selectedFiles: params.engineSelectedFiles } : {}),
          },
        },
      },
    },
  };
}

async function watchToTerminal(runtime: AgentExecutionRunRuntime): Promise<readonly AgentExecutionRunEvent[]> {
  const events: AgentExecutionRunEvent[] = [];
  runtime.watch((event) => events.push(event));
  await vi.waitFor(() => expect(['run-complete', 'run-failed', 'run-cancelled']).toContain(events.at(-1)?.kind));
  return events;
}

function readStructuredOutput(events: readonly AgentExecutionRunEvent[]) {
  const output = events.find((event): event is Extract<AgentExecutionRunEvent, { kind: 'output-delta' }> => (
    event.kind === 'output-delta' && event.channel === 'assistant'
  ));
  if (!output) throw new Error('Expected DeepSec output event');
  return ReviewFindingsV2Schema.parse(JSON.parse(output.text));
}

function createClaudeAccountFixture(modeId: 'oauth' | 'native-import' | 'setup-token', available = true) {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const account = { service, accountId: 'fixture-claude' };
  const credentials = new Map<string, string>([['refreshToken', 'host-only-refresh']]);
  if (available) credentials.set(modeId === 'setup-token' ? 'setupToken' : 'accessToken', 'fixture-access-only');
  const readCredential = vi.fn(async (key: string) => credentials.get(key) ?? null);
  const context = {
    account,
    configuration: { target: { kind: 'account', account, modeId }, revision: 'fixture-1', values: {}, async getSecret() { return null; } },
    credentials: { get: readCredential, async set() {}, async delete() {} },
    signal: new AbortController().signal,
    services: {},
  } as unknown as Parameters<typeof claudeSubscriptionConnectedAccountRuntime.materialize>[1];
  // Only the host service transport is replaced; the credential decoder and
  // environment writer are the real Claude Connected Account implementation.
  const materialize = vi.fn(async (_purpose: string, request: Parameters<typeof claudeSubscriptionConnectedAccountRuntime.materialize>[0]) =>
    claudeSubscriptionConnectedAccountRuntime.materialize(request, context));
  return { account, readCredential, connectedAccounts: {
    getBinding: async (purpose: string) => ({ purpose, service, account, target: { kind: 'account' as const, displayName: 'Claude' } }),
    resolveSelection: async (purpose: string) => ({ credentialSource: 'connectedAccount' as const,
      binding: { purpose, service, account, target: { kind: 'account' as const, displayName: 'Claude' } } }),
    materialize,
  } };
}

describe('activate', () => {
  it.each([
    { route: 'Machine login', audit: false },
    { route: 'Machine login', audit: true },
    { route: 'Gateway', audit: false },
    { route: 'Gateway', audit: true },
    { route: 'Claude subscription', audit: false },
    { route: 'Claude subscription', audit: true },
  ])('keeps the admitted model on the $route route (audit=$audit)', async ({ route, audit }) => {
    const claude = route === 'Claude subscription' ? createClaudeAccountFixture('oauth') : null;
    const fixture = createRuntimeContext({ connectedAccounts: claude?.connectedAccounts });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(audit ? {
      profileLocalId: 'repository-security-audit', includeExplicitMode: false, confirmedCostWarning: true,
    } : {}),
      modelSelection: { agentTargetKey: 'agent:happier.review.deepsec/deepsec', providerConnectionId: null, modelId: 'selected/nondefault-model' },
      launchEnvironment: { values: route === 'Gateway' ? { AI_GATEWAY_API_KEY: 'fixture-gateway' } : {}, unset: [] },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(readStructuredOutput(events)).toMatchObject({ reviewOutcome: 'complete' });
    const investigations = fixture.run.mock.calls.filter(([request]) => request.args?.[0] === 'process');
    expect(investigations).toHaveLength(1);
    expect(investigations[0]?.[0].args).toEqual(expect.arrayContaining(['--model', 'selected/nondefault-model']));
    expect(fixture.run.mock.calls.filter(([request]) => request.args?.[0] !== 'process')
      .every(([request]) => !request.args?.includes('--model'))).toBe(true);
  });

  it.each(['oauth', 'native-import', 'setup-token'] as const)('runs both audit stages with a real %s Claude materializer and no Gateway key', async modeId => {
    const claude = createClaudeAccountFixture(modeId);
    const fixture = createRuntimeContext({ connectedAccounts: claude.connectedAccounts });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest({
      profileLocalId: 'repository-security-audit', includeExplicitMode: false, confirmedCostWarning: true,
    }), launchEnvironment: { values: {}, unset: [] } }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(readStructuredOutput(events)).toMatchObject({ reviewOutcome: 'complete' });
    expect(claude.connectedAccounts.materialize).toHaveBeenCalledTimes(1);
    expect(claude.connectedAccounts.materialize).toHaveBeenCalledWith('claude-subscription',
      { kind: 'environment', keys: ['ANTHROPIC_OAUTH_TOKEN'] }, expect.objectContaining({ expectedAccount: claude.account }));
    expect(claude.readCredential.mock.calls.map(([key]) => key)).not.toContain('refreshToken');
    expect(fixture.checkReadiness).toHaveBeenCalledWith(expect.objectContaining({ candidates: ['claude'] }));
    expect(fixture.run.mock.calls.map(([request]) => request.args?.[0])).toEqual(['scan', 'process', 'export']);
    const processRequest = fixture.run.mock.calls[1]?.[0];
    expect(processRequest?.args).toEqual(expect.arrayContaining(['--agent', 'claude', '--ai-provider', 'anthropic', '--ai-base-url', 'https://api.anthropic.com']));
    expect(processRequest?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'fixture-access-only',
      ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '', VERCEL_OIDC_TOKEN: '' });
    expect(JSON.stringify(events)).not.toContain('fixture-access-only');
    expect(JSON.stringify(events)).not.toContain('host-only-refresh');
    expect(JSON.stringify(processRequest?.args)).not.toContain('fixture-access-only');
  });

  it.each(['missing', 'codex'] as const)('refuses a Claude Connected Account with %s credentials or harness before launch', async mode => {
    const claude = createClaudeAccountFixture('oauth', mode !== 'missing');
    const fixture = createRuntimeContext({ connectedAccounts: claude.connectedAccounts });
    const { runtime } = await createNativeDeepSecRuntime();
    const original = createOpenRequest();
    const opened = await runtime.executionRuns?.open({ ...original, input: { ...original.input,
      structuredInput: { ...original.input.structuredInput as Record<string, unknown>,
        engines: { deepsec: { mode: 'current_diff', ...(mode === 'codex' ? { agentCli: 'codex' } : {}) } } } } }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: {
      code: mode === 'missing' ? 'plugin_connected_account_claude_subscription_credentials_unavailable' : 'deepsec_connected_account_harness_mismatch',
    } });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(claude.readCredential.mock.calls.map(([key]) => key)).not.toContain('refreshToken');
    expect(JSON.stringify(events)).not.toContain('fixture-access-only');
  });
  it('routes an activated Responses Provider binding into both audit stages without shared credential config', async () => {
    const protocol = 'openai-responses' as const;
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const registration = activation.registration('agents', 'deepsec');
      const adapter = registration?.providerBinding;
      expect(adapter).toBeDefined();
      if (!adapter || !registration?.factory) throw new Error('DeepSec Provider adapter missing');
      const requirements = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;
      if (!requirements) throw new Error('DeepSec Provider requirements missing');
      const transport = { id: 'key', protocols: [protocol], uses: ['runtime' as const], destination: {
        kind: 'httpHeader' as const, name: 'authorization', format: 'bearer' as const,
      } };
      const model = { id: 'exact/custom-model', name: 'Selected model', capabilities: { toolRoundTrips: 'supported' as const } };
      const baseUrl = 'https://provider.example.test/codex/v1';
      const compatibility = resolveProviderBindingCompatibilityWithFingerprintV1({
        agentTargetKey: 'agent:happier.review.deepsec/deepsec', adapterVersion: adapter.adapterVersion, agent: requirements,
        endpoints: [{ id: 'custom', protocol, baseUrl, capabilities: {
          streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown',
        } }], model, credential: { kind: 'apiKey', required: true, transports: [transport] },
      });
      expect(compatibility.result).toMatchObject({ status: 'experimental', selectedProtocol: protocol });
      const materialized = AgentProviderBindingMaterializationV1Schema.parse(await adapter.materialize({
        v: 1, prepared: adapter.prepare({ v: 1, agentTargetKey: 'agent:happier.review.deepsec/deepsec', bindingKey: 'fixture' }),
        credential: { kind: 'apiKey', transport, value: 'fixture-provider-secret' },
        binding: { v: 1, agentTargetKey: 'agent:happier.review.deepsec/deepsec', selection: { bindingKey: 'fixture', model },
          contributionKey: null, endpoint: { endpointTemplateId: 'custom', protocol, normalizedUrl: baseUrl, publicHeaders: {} },
          runtimeCredentialTransport: transport, compatibilityFingerprint: compatibility.compatibilityFingerprint },
      }));
      expect(materialized.kind).toBe('spawnEnv');
      const binding = { connectionId: 'pc_fixture', model, upstream: { protocol, normalizedUrl: baseUrl, credential: 'apiKey' as const },
        materialization: { v: 1 as const, kind: 'spawnEnv' as const } };
      expect(JSON.stringify(binding)).not.toContain('fixture-provider-secret');
      const fixture = createRuntimeContext({
        connectedAccounts: { getBinding: async () => { throw new Error('Explicit Provider must bypass conflicting linked selection'); },
          resolveSelection: async () => { throw new Error('Explicit Provider must bypass conflicting linked selection'); },
          materialize: async () => { throw new Error('Explicit Provider must bypass linked credentials'); } },
        checkReadiness: async (request) => ({ launchable: request.candidates.map(agentId => ({ agentId })) }),
      });
      const runtime = await registration.factory({ plugin: { id: 'happier.review.deepsec', version: '0.0.0' }, agent: { id: 'deepsec' }, signal: new AbortController().signal });
      const opened = await runtime.executionRuns?.open({ ...createOpenRequest(
        { profileLocalId: 'repository-security-audit', includeExplicitMode: false, confirmedCostWarning: true }), providerBinding: binding,
        launchEnvironment: { values: Object.fromEntries(materialized.env.filter(row => row.value !== null).map(row => [row.name, row.value!])), unset: [] },
      }, fixture.context);
      if (!opened) throw new Error('Expected DeepSec execution');
      const events = await watchToTerminal(opened);
      await opened.dispose();
      expect(readStructuredOutput(events)).toMatchObject({ reviewOutcome: 'complete' });
      const expectedAgent = 'codex';
      expect(fixture.checkReadiness).toHaveBeenCalledWith(expect.objectContaining({ candidates: [expectedAgent] }));
      const processRequest = fixture.run.mock.calls.find(([request]) => request.args?.[0] === 'process')?.[0];
      expect(processRequest).toBeDefined();
      if (!processRequest) throw new Error('Expected DeepSec process launch');
      expect(fixture.run.mock.calls[0]?.[0].args).toEqual(['scan', '--root', '/repo']);
      expect(processRequest.args).toEqual(expect.arrayContaining(['--agent', expectedAgent, '--model', model.id,
        '--ai-provider', 'openai', '--ai-base-url', baseUrl]));
      expect(processRequest.env).toMatchObject({ AI_GATEWAY_API_KEY: '', VERCEL_OIDC_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '',
        OPENAI_API_KEY: 'fixture-provider-secret', OPENAI_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '' });
      expect(JSON.stringify(processRequest.args)).not.toContain('fixture-provider-secret');
    } finally { await activation.dispose(); }
  });

  it('refuses incompatible protocols and unauthenticated endpoints through shared typed compatibility', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents[0]?.providerRequirements;
    expect(agent).toBeDefined();
    if (!agent) throw new Error('DeepSec Provider requirements missing');
    const resolve = (protocol: 'openai-chat' | 'anthropic' | 'openai-responses') => resolveProviderBindingCompatibilityWithFingerprintV1({
      agentTargetKey: 'agent:happier.review.deepsec/deepsec', adapterVersion: 1, agent,
      credential: undefined, endpoints: [{ id: 'custom', protocol, baseUrl: 'https://provider.example.test', capabilities: {
        streaming: 'supported', toolRoundTrips: 'supported', statefulResponses: 'unknown', reasoningControls: 'unknown',
      } }], model: { id: 'custom', name: 'Custom', capabilities: { toolRoundTrips: 'supported' } },
    }).result;
    expect(resolve('openai-chat')).toMatchObject({ status: 'incompatible', reasons: ['no_compatible_protocol'] });
    expect(resolve('anthropic')).toMatchObject({ status: 'incompatible', reasons: ['no_compatible_protocol'] });
    expect(resolve('openai-responses')).toMatchObject({ status: 'incompatible', reasons: ['no_auth_unsupported'] });
  });

  it('refuses an explicitly conflicting harness before process launch with a typed reason', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const original = createOpenRequest();
    const opened = await runtime.executionRuns?.open({ ...original,
      launchEnvironment: { values: { OPENAI_API_KEY: 'fixture-provider-secret' }, unset: [] },
      providerBinding: { connectionId: 'pc_fixture', model: { id: 'custom', name: 'Custom' },
        upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example.test/v1', credential: 'apiKey' },
        materialization: { v: 1, kind: 'spawnEnv' } },
      input: { ...original.input, structuredInput: { ...original.input.structuredInput as Record<string, unknown>,
        engines: { deepsec: { mode: 'current_diff', agentCli: 'claude' } } } },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_provider_harness_mismatch' } });
    expect(fixture.checkReadiness).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unset'] as const)('does not fall back to gateway or native login when the bound key is %s', async (mode) => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(),
      providerBinding: { connectionId: 'pc_fixture', model: { id: 'custom', name: 'Custom' },
        upstream: { protocol: 'openai-responses', normalizedUrl: 'https://provider.example.test/v1', credential: 'apiKey' },
        materialization: { v: 1, kind: 'spawnEnv' } },
      launchEnvironment: { values: { AI_GATEWAY_API_KEY: 'unrelated-gateway-key',
        ...(mode === 'unset' ? { OPENAI_API_KEY: 'revoked-provider-key' } : {}) },
        unset: mode === 'unset' ? ['openai_api_key'] : [] },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_execution_failed' } });
    expect(fixture.checkReadiness).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('revoked-provider-key');
    expect(JSON.stringify(events)).not.toContain('unrelated-gateway-key');
  });

  it('registers a native execution-run runtime without a V1 compatibility session', async () => {
    const { registrations, runtime } = await createNativeDeepSecRuntime();

    expect(registrations).toContainEqual({ family: 'agents', localId: 'deepsec' });
    expect(runtime.sessions).toBeUndefined();
    expect(runtime.executionRuns).toEqual(expect.objectContaining({ open: expect.any(Function) }));
  });

  it.each([true, false])('reviews exactly the canonical uncommitted paths including new files (explicit mode: %s)', async (includeExplicitMode) => {
    // Use the real Git status producer: pending paths include untracked files,
    // while an index-only change belongs to the other review area.
    const snapshot = buildGitSnapshot({ projectKey: 'machine:/repo', fetchedAt: 123, rootPath: '/repo',
      statusOutput: '# branch.head feature\0# branch.upstream origin/main\0'
        + '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/auth.ts\0'
        + '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/other-area.ts\0'
        + '? src/brand-new.ts\0? src/brand-new.test.ts\0',
      includedNumStatOutput: '', pendingNumStatOutput: '',
    });
    const pendingEntries = snapshot.entries.filter(entry => entry.hasPendingDelta);
    expect(pendingEntries.filter(entry => entry.kind === 'untracked').map(entry => entry.path)).toEqual([
      'src/brand-new.test.ts', 'src/brand-new.ts',
    ]);
    const selectedPaths = pendingEntries.map(entry => entry.path);
    let filesFromContents = '';
    const commentOutMarkdown = [
      '## 🔎 deepsec found 1 finding',
      '',
      '### 🔴 CRITICAL · `src/auth.ts:L2`',
      '',
      '<sub>slug: `CWE-601` · confidence: high</sub>',
      '',
      'Validate redirect destinations before use.',
    ].join('\n');
    const fixture = createRuntimeContext({
      async run(request) {
        const filesFromIndex = request.args?.indexOf('--files-from') ?? -1;
        const filesFromPath = filesFromIndex >= 0 ? request.args?.[filesFromIndex + 1] : undefined;
        if (filesFromPath) filesFromContents = await readFile(filesFromPath, 'utf8');
        const commentOutIndex = request.args?.indexOf('--comment-out') ?? -1;
        const commentOutPath = commentOutIndex >= 0 ? request.args?.[commentOutIndex + 1] : undefined;
        if (commentOutPath) await writeFile(commentOutPath, commentOutMarkdown, 'utf8');
        return processResult();
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ includeExplicitMode, paths: selectedPaths,
      engineSelectedFiles: ['outside/engine-controlled.ts'],
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'output-delta', 'run-complete']);
    expect(fixture.resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'deepsec-cli',
      purpose: 'review security findings',
      cwd: '/repo',
    }));
    expect(fixture.run).toHaveBeenCalledWith(expect.objectContaining({
      executable: { kind: 'systemTool', id: 'deepsec-cli' },
      cwd: { root: 'workspace', relativePath: '' },
      env: expect.objectContaining({ AI_GATEWAY_API_KEY: 'gateway-key' }),
      args: ['process', '--files-from', expect.any(String), '--no-ignore', '--comment-out', expect.any(String),
        '--agent', 'claude', '--ai-provider', 'anthropic', '--ai-base-url', 'https://ai-gateway.vercel.sh'],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(filesFromContents.split('\n').filter(Boolean)).toEqual(selectedPaths);
    expect(filesFromContents).not.toContain('other-area.ts');
    expect(fixture.stat.mock.calls.map(([path]) => path.relativePath)).toEqual(selectedPaths);
    expect(readStructuredOutput(events)).toMatchObject({
      runRef: { runId: 'run-1', callId: 'deepsec:run-1' },
      reviewOutcome: 'complete',
      findings: [expect.objectContaining({
        severity: 'blocker',
        category: 'security',
        filePath: 'src/auth.ts',
        startLine: 2,
        ruleId: 'CWE-601',
      })],
      proposedComments: [expect.objectContaining({
        body: 'Validate redirect destinations before use.',
        anchor: { kind: 'line', filePath: 'src/auth.ts', line: 2 },
        severity: 'critical',
        tags: ['deepsec'],
      })],
    });
  });

  it('publishes process failure evidence as a structured failed outcome', async () => {
    const fixture = createRuntimeContext({
      async run() {
        return processResult(7);
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ runId: 'run-process-failed' }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_process_failed' } });
    expect(readStructuredOutput(events)).toMatchObject({
      status: 'failed',
      error: { code: 'deepsec_process_failed' },
      reviewOutcome: 'failed',
      diagnostics: [{
        code: 'deepsec_process_failed',
        severity: 'error',
        messageKey: 'plugins.deepsec.runtime.failed',
        detail: { exitCode: 7, signal: null },
      }],
    });
  });

  it('selects repository audit mode from the canonical execution-run profile', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-repository-audit-profile',
      profileLocalId: 'repository-security-audit',
      includeExplicitMode: false,
      confirmedCostWarning: true,
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(fixture.run.mock.calls.map(([request]) => request.args)).toEqual([
      ['scan', '--root', '/repo'],
      expect.arrayContaining(['process', '--root', '/repo', '--agent', 'claude',
        '--ai-provider', 'anthropic', '--ai-base-url', 'https://ai-gateway.vercel.sh']),
      ['export', '--format', 'json', '--out', expect.any(String)],
    ]);
    expect(readStructuredOutput(events)).toMatchObject({ reviewOutcome: 'complete', findings: [] });
  });

  it('fails required confirmation without launching and lets the caller retry explicitly', async () => {
    const profile = PLUGIN_MANIFEST.contributes?.executionRunProfiles?.find(profile => profile.id === 'repository-security-audit');
    const consentOption = profile?.metadata?.reviewCostConsentOption;
    expect(consentOption).toBe('confirmedCostWarning');
    if (typeof consentOption !== 'string') throw new Error('Expected per-start cost consent option');
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-confirmation-required',
      profileLocalId: 'repository-security-audit',
      includeExplicitMode: false,
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_confirmation_required' } });
    expect(readStructuredOutput(events)).toMatchObject({
      status: 'failed',
      error: { code: 'deepsec_confirmation_required' },
      warning: { status: 'requires_confirmation' },
    });
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();

    const acceptedRequest = createOpenRequest({
      runId: 'run-confirmed-retry',
      profileLocalId: 'repository-security-audit',
      includeExplicitMode: false,
    });
    const retried = await runtime.executionRuns?.open({ ...acceptedRequest, input: { ...acceptedRequest.input,
      structuredInput: { ...acceptedRequest.input.structuredInput as Record<string, unknown>,
        engines: { deepsec: { [consentOption]: true } } },
    } }, fixture.context);
    if (!retried) throw new Error('Expected explicit DeepSec retry');
    const retryEvents = await watchToTerminal(retried);
    await retried.dispose();
    expect(retryEvents.at(-1)?.kind).toBe('run-complete');
    expect(fixture.run.mock.calls.map(([request]) => request.args?.[0])).toEqual(['scan', 'process', 'export']);

    const next = await runtime.executionRuns?.open(createOpenRequest({ runId: 'run-next-unconfirmed',
      profileLocalId: 'repository-security-audit', includeExplicitMode: false,
    }), fixture.context);
    if (!next) throw new Error('Expected next DeepSec review');
    const nextEvents = await watchToTerminal(next);
    await next.dispose();
    expect(nextEvents.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_confirmation_required' } });
    expect(fixture.run.mock.calls.map(([request]) => request.args?.[0])).toEqual(['scan', 'process', 'export']);
  });

  it.each([false, true])('delivers repository audit partial findings to host normalization (findings present: %s)', async hasFindings => {
    const fixture = createRuntimeContext({
      async run(request) {
        if (request.args?.[0] === 'process') return processResult(2);
        if (request.args?.[0] === 'export') {
          const outIndex = request.args.indexOf('--out');
          const outPath = request.args[outIndex + 1];
          if (!outPath) throw new Error('Expected native export output path');
          await writeFile(outPath, JSON.stringify(hasFindings ? [{
            title: 'Validate redirects', description: 'Validate redirect destinations before use.', severity: 'CRITICAL',
            metadata: { filePath: 'src/auth.ts', lineNumbers: [2] },
          }] : []), 'utf8');
        }
        return processResult();
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-partial-repository-audit',
      profileLocalId: 'repository-security-audit',
      includeExplicitMode: false,
      confirmedCostWarning: true,
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(readStructuredOutput(events)).toMatchObject({
      reviewOutcome: 'partial',
      findings: hasFindings ? [expect.objectContaining({ filePath: 'src/auth.ts', startLine: 2 })] : [],
      diagnostics: [{
        code: 'deepsec_process_failed',
        severity: 'warning',
        messageKey: 'plugins.deepsec.runtime.partial',
        detail: { exitCode: 2, signal: null },
      }],
      limits: { findingsTruncated: true, patchesTruncated: false },
    });
  });

  it('uses only host-resolved selected review-scope paths for selected-file reviews', async () => {
    let filesFromContents = '';
    const fixture = createRuntimeContext({
      async run(request) {
        const filesFromIndex = request.args?.indexOf('--files-from') ?? -1;
        const filesFromPath = filesFromIndex >= 0 ? request.args?.[filesFromIndex + 1] : undefined;
        if (filesFromPath) filesFromContents = await readFile(filesFromPath, 'utf8');
        return processResult();
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-selected-scope',
      mode: 'selected_files',
      paths: ['src/auth.ts', 'src/api.ts'],
      engineSelectedFiles: ['outside/engine-controlled.ts'],
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(filesFromContents).toBe('src/auth.ts\nsrc/api.ts\n');
    expect(fixture.stat).toHaveBeenNthCalledWith(1, {
      root: 'workspace',
      relativePath: 'src/auth.ts',
    }, { signal: expect.any(AbortSignal) });
    expect(fixture.stat).toHaveBeenNthCalledWith(2, {
      root: 'workspace',
      relativePath: 'src/api.ts',
    }, { signal: expect.any(AbortSignal) });
  });

  it('maps host SCM paths from the worktree root into the admitted workspace before writing the file list', async () => {
    let filesFromContents = '';
    const fixture = createRuntimeContext({
      async run(request) {
        const filesFromIndex = request.args?.indexOf('--files-from') ?? -1;
        const filesFromPath = filesFromIndex >= 0 ? request.args?.[filesFromIndex + 1] : undefined;
        if (filesFromPath) filesFromContents = await readFile(filesFromPath, 'utf8');
        return processResult();
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-selected-subdirectory',
      cwd: '/repo/packages/mobile',
      mode: 'selected_files',
      scmReviewScope: createSupportedScmReviewScope(['packages/mobile/src/auth.ts']),
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(filesFromContents).toBe('src/auth.ts\n');
    expect(fixture.stat).toHaveBeenCalledWith({
      root: 'workspace',
      relativePath: 'src/auth.ts',
    }, { signal: expect.any(AbortSignal) });
  });

  it('fails selected-file scope before readiness or process launch when host filesystem containment rejects a path', async () => {
    const fixture = createRuntimeContext({
      async stat() {
        throw Object.assign(new Error('path resolves outside workspace'), {
          code: 'plugin_fs_path_denied',
        });
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-selected-symlink-escape',
      mode: 'selected_files',
      paths: ['src/link-outside.ts'],
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_scope_failed' } });
    expect(readStructuredOutput(events)).toMatchObject({
      status: 'failed',
      error: { code: 'deepsec_scope_failed' },
      summary: 'DeepSec selected-file scope validation failed.',
      diagnostics: [{
        code: 'scope_path_unavailable',
        severity: 'error',
        messageKey: 'plugins.fs.scopedPathList.scopeUnavailable',
        path: 'src/link-outside.ts',
      }],
    });
    expect(fixture.stat).toHaveBeenCalledWith({
      root: 'workspace',
      relativePath: 'src/link-outside.ts',
    }, { signal: expect.any(AbortSignal) });
    expect(fixture.checkReadiness).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('rejects a selected directory before readiness or process launch', async () => {
    const fixture = createRuntimeContext({
      async stat() {
        return { kind: 'directory', size: 0, modifiedAtMs: 0 };
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-selected-directory',
      mode: 'selected_files',
      paths: ['src'],
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(readStructuredOutput(events)).toMatchObject({
      status: 'failed',
      error: { code: 'deepsec_scope_failed' },
      diagnostics: [expect.objectContaining({
        code: 'scope_path_unavailable',
        path: 'src',
      })],
    });
    expect(fixture.checkReadiness).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('rejects unsupported host SCM scope before readiness or executable resolution', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-unsupported-scope',
      scmReviewScope: {
        kind: 'review_scm_scope.v1',
        status: 'unsupported',
        scmBackendId: null,
        scmMode: null,
        repositoryRoot: null,
        worktreeRoot: null,
        baseRef: { source: 'unavailable', ref: null },
        selectedPaths: [],
        committedPaths: [],
        uncommittedPaths: [],
        changedPaths: [],
        diff: { committedAvailable: false, uncommittedAvailable: false },
        diagnostics: [{
          code: 'not_repository',
          severity: 'error',
          message: 'The selected path is not a source-control repository.',
        }],
      },
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)).toMatchObject({
      kind: 'run-failed',
      diagnostic: { message: expect.stringMatching(/source-control repository/i) },
    });
    expect(fixture.checkReadiness).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('uses host Agent CLI readiness without undeclared system-tool probes', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest(), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(fixture.checkReadiness).toHaveBeenCalledWith(expect.objectContaining({
      candidates: ['claude', 'codex'],
      requirement: 'any',
      cwd: '/repo',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      signal: expect.any(AbortSignal),
    }));
    expect(fixture.resolve.mock.calls.map(([request]) => request.toolId)).toEqual(['deepsec-cli']);
    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(JSON.stringify(readStructuredOutput(events))).not.toContain('claude-or-codex');
  });

  it.each([
    { ready: ['claude'], agent: 'claude', provider: 'anthropic', key: 'ANTHROPIC_API_KEY' },
    { ready: ['codex'], agent: 'codex', provider: 'openai', key: 'OPENAI_API_KEY' },
    { ready: ['claude', 'codex'], agent: 'codex', provider: 'openai', key: 'OPENAI_API_KEY' },
  ])('uses the host-selected Machine login with blank competing credentials on the ready $agent harness after a Gateway unset', async ({ ready, agent, provider, key }) => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'ambient-key-must-not-be-used');
    const fixture = createRuntimeContext({ checkReadiness: async () => ({ launchable: ready.map(agentId => ({ agentId })) }) });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({
      ...createOpenRequest({ runId: 'run-unset' }),
      launchEnvironment: {
        values: { AI_GATEWAY_API_KEY: 'projected-key' },
        unset: ['ai_gateway_api_key'],
      },
    }, fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)).toMatchObject({ kind: 'run-complete' });
    expect(fixture.run).toHaveBeenCalled();
    for (const [request] of fixture.run.mock.calls) {
      expect(request.env).toMatchObject(Object.fromEntries(DEEPSEC_PROVIDER_ENV_KEYS.map(name => [name, ''])));
      expect(request.args).toEqual(expect.arrayContaining([
        '--agent', agent, '--ai-provider', provider, '--ai-api-key-env', key,
      ]));
    }
  });

  it('does not infer Machine login from an older host null binding read', async () => {
    const fixture = createRuntimeContext({ connectedAccounts: { getBinding: async () => null,
      materialize: async () => { throw new Error('No selected account'); } } });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(), launchEnvironment: { values: {}, unset: [] } }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_model_access_unavailable' } });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('does not use Machine login or an unrelated Gateway when the host cannot resolve a selected account', async () => {
    const fixture = createRuntimeContext({ connectedAccounts: {
      getBinding: async () => null,
      resolveSelection: async () => { throw new PluginError({ code: 'plugin_connected_account_binding_unavailable',
        message: 'Selected account unavailable' }); },
      materialize: async () => { throw new Error('No credential acquisition is authorized'); },
    } });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest(), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'plugin_connected_account_binding_unavailable' } });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('blanks all unused credential keys for the admitted Gateway route', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest(), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    const environment = fixture.run.mock.calls[0]?.[0].env;
    expect(environment).toEqual(Object.fromEntries(DEEPSEC_PROVIDER_ENV_KEYS.map(name =>
      [name, name === 'AI_GATEWAY_API_KEY' ? 'gateway-key' : ''])));
  });

  it.each([
    { ready: ['claude'], agent: 'claude', provider: 'anthropic', baseUrl: 'https://ai-gateway.vercel.sh' },
    { ready: ['codex'], agent: 'codex', provider: 'openai', baseUrl: 'https://ai-gateway.vercel.sh/v1' },
    { ready: ['claude', 'codex'], agent: 'codex', provider: 'openai', baseUrl: 'https://ai-gateway.vercel.sh/v1' },
  ])('pins the selected Gateway route against repository model config using the ready $agent harness', async ({ ready, agent, provider, baseUrl }) => {
    const fixture = createRuntimeContext({ checkReadiness: async () => ({ launchable: ready.map(agentId => ({ agentId })) }) });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest(), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    // Native 2.3.12 applies repository model routes unless an explicit base
    // flag is present, including switching Gateway to a stored local login.
    expect(fixture.run.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining([
      '--agent', agent, '--ai-provider', provider, '--ai-base-url', baseUrl,
    ]));
  });

  it('delivers the selected thinking level through the execution entry point', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const request = createOpenRequest();
    const opened = await runtime.executionRuns?.open({ ...request, input: { ...request.input,
      structuredInput: { ...request.input.structuredInput as Record<string, unknown>,
        engines: { deepsec: { mode: 'current_diff', thinkingLevel: 'xhigh' } } } } }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(fixture.run.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(['--thinking-level', 'xhigh']));
  });

  it.each([
    { comparison: { id: 'captured-review', source: { kind: 'branch', base: 'base', head: 'head' },
      endpoints: { before: 'captured-before', after: 'captured-after' } } },
    { revisionRange: { kind: 'revisionRange', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) } },
  ])('refuses captured subjects it cannot honor before invoking an ambient review (%#)', async captured => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      ...('comparison' in captured ? { profileLocalId: 'repository-security-audit', includeExplicitMode: false,
        confirmedCostWarning: true } : {}),
      scmReviewScope: ReviewScmScopeV1Schema.parse({ ...createSupportedScmReviewScope(), ...captured }),
    }), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_execution_failed' } });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('cancels the managed process and publishes one native terminal event', async () => {
    const fixture = createRuntimeContext({
      async run(_request, options) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          ...processResult(),
          termination: {
            observed: { kind: 'signal', signal: 'SIGTERM' },
            requestedBy: { kind: 'abort' },
          },
        };
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ runId: 'run-cancel' }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');
    const events: AgentExecutionRunEvent[] = [];
    opened.watch((event) => events.push(event));

    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledOnce());
    await expect(opened.stop()).resolves.toEqual({ status: 'requested' });
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('run-cancelled'));
    await opened.dispose();

    expect(events.filter((event) => ['run-complete', 'run-failed', 'run-cancelled'].includes(event.kind)))
      .toEqual([expect.objectContaining({ kind: 'run-cancelled' })]);
  });
});

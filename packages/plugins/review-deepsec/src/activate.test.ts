import { readFile, writeFile } from 'node:fs/promises';

import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type {
  PluginExecSpawnRequest,
  PluginProcessResult,
  ResolvedSystemTool as PluginResolvedSystemTool } from '@happier-dev/plugin-sdk/exec';
import type {
  PluginServices,
} from '@happier-dev/plugin-sdk';
import { ReviewFindingsV2Schema, ReviewScmScopeV1Schema } from '@happier-dev/plugin-sdk/reviews';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { DEEPSEC_PROVIDER_ENV_KEYS } from './agent/providerBinding.js';
import { buildGitSnapshot } from '../../scm-git/src/statusSnapshot.js';
import type { DeepSecReviewMode } from './agent/reviews/command.js';

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
  scmSnapshot?: (options?: { signal?: AbortSignal }) => Promise<PluginActionResultById['scm.status.snapshot']>;
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
  scm: ReturnType<typeof vi.fn>;
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
  // SCM Actions cross the host transport boundary; scope decisions stay in the real adapter.
  const scm = vi.fn(async (_action: string, _input: unknown, options?: { signal?: AbortSignal }) =>
    params?.scmSnapshot ? params.scmSnapshot(options) : liveCheckoutSnapshot());
  const services = {
    availability: (id: string) => id === 'exec' || id === 'fs' || id === 'actions'
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
    actions: { execute: scm },
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
    scm,
  };
}

const liveHead = 'b'.repeat(40);
const capturedBase = 'a'.repeat(40);
function liveCheckoutSnapshot(status = '', rootPath = '/repo'): PluginActionResultById['scm.status.snapshot'] {
  return { success: true, snapshot: buildGitSnapshot({ projectKey: `machine:${rootPath}`, fetchedAt: 1, rootPath,
    statusOutput: `# branch.oid ${liveHead}\0# branch.head feature\0${status}`,
    includedNumStatOutput: '', pendingNumStatOutput: '',
  }) };
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
  mode?: DeepSecReviewMode;
  includeExplicitMode?: boolean;
  confirmedCostWarning?: boolean;
  profileLocalId?: string;
  paths?: readonly string[];
  scmReviewScope?: unknown;
  cwd?: string;
  engineSelectedFiles?: readonly string[];
  engineId?: string;
}>): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  const paths = params?.paths ?? ['src/auth.ts'];
  const engineId = params?.engineId ?? 'deepsec';
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
        reviewers: [{ kind: 'engine', engineId }],
        instructions: 'Review the current diff.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
        scmReviewScope: params?.scmReviewScope ?? createSupportedScmReviewScope(paths),
        engines: {
          [engineId]: {
            ...(params?.includeExplicitMode === false
              ? {}
              : { mode: params?.mode ?? 'current_diff' }),
            ...(params?.confirmedCostWarning !== false ? { confirmedCostWarning: true } : {}),
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
  if (!output) throw new Error(`Expected DeepSec output event; terminal: ${JSON.stringify(events.at(-1))}`);
  return ReviewFindingsV2Schema.parse(JSON.parse(output.text));
}

describe('activate', () => {
  it('honors the qualified reviewer cost consent delivered by public review.start', async () => {
    // Shape captured from replay73-deepsec-codex-consented, after dispatch binds one reviewer.
    const engineId = 'agent:happier.review.deepsec/deepsec';
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const request = createOpenRequest({ engineId, profileLocalId: 'repository-security-audit' });
    const opened = await runtime.executionRuns?.open({ ...request, input: { ...request.input, structuredInput: {
      instructions: 'Review this repository for correctness and report findings only. Do not change files.',
      permissionMode: 'read_only', changeType: 'all', base: { kind: 'none' }, scope: 'repository', engineId,
      reviewers: [{ kind: 'engine', engineId, options: { confirmedCostWarning: true } }],
      engines: { [engineId]: { confirmedCostWarning: true } },
    } } }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    try {
      const events = await watchToTerminal(opened);
      expect(events.at(-1)?.kind).toBe('run-complete');
      expect(fixture.run.mock.calls.map(([request]) => request.args?.[0])).toEqual(['scan', 'process', 'export']);
    } finally { await opened.dispose(); }
  });

  it('preserves the host process diagnostic when the native review cannot run', async () => {
    const diagnostic = { code: 'permission_denied', severity: 'error' as const,
      message: 'The selected Role does not permit this process.', details: { requestId: 'deepsec-process-request' } };
    const fixture = createRuntimeContext({ run: async () => ({ ...processResult(),
      termination: { observed: { kind: 'failed', diagnostic }, requestedBy: { kind: 'none' } },
    }) });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest(), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    try {
      const events = await watchToTerminal(opened);
      expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic });
      expect(readStructuredOutput(events)).toMatchObject({ error: { code: diagnostic.code }, diagnostics: [diagnostic] });
    } finally { await opened.dispose(); }
  });
  it.each([
    { runner: 'claude', purpose: 'model_upstream_api_key', values: { ANTHROPIC_API_KEY: 'selected-key' }, baseUrl: 'https://api.anthropic.com' },
    { runner: 'claude', purpose: 'kimi-code-api-key', values: { ANTHROPIC_API_KEY: 'selected-key', ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding' }, baseUrl: 'https://api.kimi.com/coding' },
    { runner: 'codex', purpose: 'openai-api-key', values: { HAPPIER_CODEX_PROVIDER_API_KEY: 'selected-key' }, baseUrl: 'https://api.openai.com/v1' },
    { runner: 'codex', purpose: 'kimi-code-api-key', values: { HAPPIER_CODEX_PROVIDER_API_KEY: 'selected-key' }, baseUrl: 'https://api.kimi.com/coding/v1' },
  ])('preserves selected $runner $purpose instead of an ambient Machine login', async ({ runner, purpose, values, baseUrl }) => {
    const fixture = createRuntimeContext({ checkReadiness: async request => ({ launchable: request.candidates.map(agentId => ({ agentId })) }) });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(),
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: `happier.agent.${runner}`, localId: runner } },
      runnerConnectedAccountPurposes: [purpose],
      runnerConnectedAccountMaterialization: runner === 'claude' ? { v: 1, kind: 'spawnEnv' } : {
        v: 1, kind: 'engineConfig', engineConfig: { modelProvider: 'selected', config: {
          'model_providers.selected': { base_url: baseUrl, env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY', wire_api: 'responses' },
        } },
      },
      modelSelection: { modelId: 'selected-model' },
      launchEnvironment: { values: { ...values, CLAUDE_CONFIG_DIR: '/machine/claude', CODEX_HOME: '/machine/codex' }, unset: ['CLAUDE_CODE_OAUTH_TOKEN'] },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    const process = fixture.run.mock.calls.find(([request]) => request.args?.[0] === 'process')?.[0];
    expect(process?.args).toEqual(expect.arrayContaining(['--agent', runner, '--ai-base-url', baseUrl, '--model', 'selected-model']));
    expect(process?.env).toMatchObject(runner === 'claude' ? { ANTHROPIC_API_KEY: 'selected-key', OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '' }
      : { OPENAI_API_KEY: 'selected-key', OPENAI_BASE_URL: baseUrl, AI_GATEWAY_API_KEY: '' });
    expect(process?.args).not.toContain('--ai-api-key-env');
    expect(JSON.stringify(events)).not.toContain('selected-key');
  });
  it('refuses a bound account without a supported transport before considering Machine login or Gateway', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(),
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      runnerConnectedAccountPurposes: ['unsupported-purpose'],
      launchEnvironment: { values: { CODEX_HOME: '/machine/codex', AI_GATEWAY_API_KEY: 'machine-gateway' }, unset: [] },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_runner_account_unsupported' } });
    expect(fixture.run).not.toHaveBeenCalled();
  });
  it('pins an admitted Codex subscription home and suppresses an ambient Gateway', async () => {
    const fixture = createRuntimeContext({ checkReadiness: async request => ({ launchable: request.candidates.map(agentId => ({ agentId })) }) });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(),
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      runnerConnectedAccountPurposes: ['primary'],
      runnerConnectedAccountMaterialization: { v: 1, kind: 'configFile', rootPath: '/selected/codex', relativePaths: ['auth.json'] },
      launchEnvironment: { values: { CODEX_HOME: '/selected/codex', AI_GATEWAY_API_KEY: 'ambient-gateway' }, unset: [] },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    const process = fixture.run.mock.calls.find(([request]) => request.args?.[0] === 'process')?.[0];
    expect(process?.env).toMatchObject({ CODEX_HOME: '/selected/codex', OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '' });
    expect(process?.args).toEqual(expect.arrayContaining(['--agent', 'codex', '--ai-api-key-env', 'OPENAI_API_KEY']));
  });
  it('translates the host Codex Provider config while retaining its projected native home', async () => {
    const fixture = createRuntimeContext({ checkReadiness: async request => ({ launchable: request.candidates.map(agentId => ({ agentId })) }) });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(),
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      providerBinding: { connectionId: 'host-provider', model: { id: 'selected-model', name: 'Selected' },
        upstream: { protocol: 'openai-responses', normalizedUrl: 'https://selected.example/codex/v1', credential: 'apiKey' },
        materialization: { v: 1, kind: 'engineConfig', engineConfig: { modelProvider: 'selected', config: {
          'model_providers.selected': { base_url: 'https://selected.example/codex/v1', env_key: 'HOST_PROVIDER_KEY', wire_api: 'responses' },
        } } } },
      launchEnvironment: { values: { HOST_PROVIDER_KEY: 'host-provider-secret', CODEX_HOME: '/host/codex' }, unset: [] },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    const process = fixture.run.mock.calls.find(([request]) => request.args?.[0] === 'process')?.[0];
    expect(process?.args).toEqual(expect.arrayContaining(['--agent', 'codex', '--ai-base-url', 'https://selected.example/codex/v1', '--model', 'selected-model']));
    expect(process?.env).toMatchObject({ OPENAI_API_KEY: 'host-provider-secret', CODEX_HOME: '/host/codex', AI_GATEWAY_API_KEY: '' });
    expect(JSON.stringify(events)).not.toContain('host-provider-secret');
    expect(JSON.stringify(process?.args)).not.toContain('host-provider-secret');
  });
  it('consumes the host Claude runner and access token without selecting or acquiring an account again', async () => {
    const fixture = createRuntimeContext({ connectedAccounts: {
      getBinding: async () => { throw new Error('Host already admitted this account'); },
      resolveSelection: async () => { throw new Error('Host already admitted this account'); },
      materialize: async () => { throw new Error('Host already materialized this account'); },
    } });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(),
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      launchEnvironment: { values: { CLAUDE_CODE_OAUTH_TOKEN: 'host-access-only', CLAUDE_CONFIG_DIR: '/host/claude' }, unset: [] },
      runnerConnectedAccountPurposes: ['model_upstream'], runnerConnectedAccountMaterialization: { v: 1, kind: 'spawnEnv' },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    const process = fixture.run.mock.calls.find(([request]) => request.args?.[0] === 'process')?.[0];
    expect(process?.args).toEqual(expect.arrayContaining(['--agent', 'claude', '--ai-provider', 'anthropic']));
    expect(process?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'host-access-only', CLAUDE_CONFIG_DIR: '/host/claude',
      OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '' });
    expect(JSON.stringify(events)).not.toContain('host-access-only');
  });
  it('refuses a selected Claude native home without its token rather than using the Machine login', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(),
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      launchEnvironment: { values: { CLAUDE_CONFIG_DIR: '/selected/claude', AI_GATEWAY_API_KEY: 'unrelated-gateway' }, unset: [] },
    }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_provider_transport_unsupported' } });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.checkReadiness).not.toHaveBeenCalled();
  });
  it.each([
    { route: 'Machine login', audit: false },
    { route: 'Machine login', audit: true },
    { route: 'Gateway', audit: false },
    { route: 'Gateway', audit: true },
    { route: 'Claude subscription', audit: false },
    { route: 'Claude subscription', audit: true },
  ])('keeps the admitted model on the $route route (audit=$audit)', async ({ route, audit }) => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({ ...createOpenRequest(audit ? {
      profileLocalId: 'repository-security-audit', includeExplicitMode: false, confirmedCostWarning: true,
    } : {}),
      modelSelection: { agentTargetKey: 'agent:happier.review.deepsec/deepsec', providerConnectionId: null, modelId: 'selected/nondefault-model' },
      launchEnvironment: { values: route === 'Gateway' ? { AI_GATEWAY_API_KEY: 'fixture-gateway' }
        : route === 'Claude subscription' ? { CLAUDE_CODE_OAUTH_TOKEN: 'host-access-only' } : {}, unset: [] },
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
        engines: { deepsec: { mode: 'current_diff', confirmedCostWarning: true, agentCli: 'claude' } } } },
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
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_provider_transport_unsupported' } });
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
        + '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/auth café.ts\0'
        + '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/other-area.ts\0'
        + '? src/brand-new.ts\0? src/brand-new.test.ts\0',
      includedNumStatOutput: '', pendingNumStatOutput: '',
    });
    const pendingEntries = snapshot.entries.filter(entry => entry.hasPendingDelta);
    expect(pendingEntries.filter(entry => entry.kind === 'untracked').map(entry => entry.path)).toEqual([
      'src/brand-new.test.ts', 'src/brand-new.ts',
    ]);
    const selectedPaths = pendingEntries.map(entry => entry.path);
    expect(selectedPaths).toContain('src/auth café.ts');
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

  it.each(['scan', 'process', 'export'] as const)('retains the safe native %s failure through its terminal outcome', async phase => {
    const secret = 'deepsec-native-private-credential';
    const reason = `Native ${phase} failed: api_key=${secret}; /private/deepsec/workspace/token.log`;
    const fixture = createRuntimeContext({
      async run(request) {
        if (request.args?.[0] === phase) return {
          ...processResult(7),
          ...(phase === 'process' ? { termination: {
            observed: { kind: 'signal' as const, signal: 'SIGTERM' }, requestedBy: { kind: 'none' as const },
          } } : {}),
          stderr: new TextEncoder().encode(reason),
          stderrTruncated: true,
        };
        if (request.args?.[0] === 'export') {
          const outPath = request.args[request.args.indexOf('--out') + 1];
          await writeFile(outPath, '[]', 'utf8');
        }
        return processResult();
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-process-failed', mode: 'repository_security_audit',
      profileLocalId: 'repository-security-audit', confirmedCostWarning: true,
      engineId: 'agent:happier.review.deepsec/deepsec',
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    const diagnostic = {
      code: 'deepsec_process_failed', severity: phase === 'process' ? 'warning' : 'error',
      message: expect.stringContaining(`Native ${phase} failed:`),
      details: { phase, exitCode: phase === 'process' ? null : 7, signal: phase === 'process' ? 'SIGTERM' : null,
        stdoutTruncated: false, stderrTruncated: true },
    };
    expect(events.at(-1)).toMatchObject(phase === 'process'
      ? { kind: 'run-complete' } : { kind: 'run-failed', diagnostic });
    expect(readStructuredOutput(events)).toMatchObject({
      reviewOutcome: phase === 'process' ? 'partial' : 'failed', diagnostics: [diagnostic],
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('/private/deepsec/workspace/token.log');
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

  it.each([
    { profileLocalId: 'review', engineId: 'agent:happier.review.deepsec/deepsec', commands: ['process'] },
    { profileLocalId: 'repository-security-audit', engineId: 'deepsec', commands: ['scan', 'process', 'export'] },
  ])('requires fresh paid-start consent and allows an explicit retry ($profileLocalId)', async ({ profileLocalId, engineId, commands }) => {
    const profile = PLUGIN_MANIFEST.contributes?.executionRunProfiles?.find(profile => profile.id === profileLocalId);
    const consentOption = profile?.metadata?.reviewCostConsentOption;
    expect(consentOption).toBe('confirmedCostWarning');
    if (typeof consentOption !== 'string') throw new Error('Expected per-start cost consent option');
    const fixture = createRuntimeContext();
    const context = fixture.context;
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-confirmation-required',
      profileLocalId, engineId,
      includeExplicitMode: false,
      confirmedCostWarning: false,
    }), context);
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
      profileLocalId, engineId,
      includeExplicitMode: false,
      confirmedCostWarning: false,
    });
    const retried = await runtime.executionRuns?.open({ ...acceptedRequest, input: { ...acceptedRequest.input,
      structuredInput: { ...acceptedRequest.input.structuredInput as Record<string, unknown>,
        engines: { [engineId]: { [consentOption]: true } } },
    } }, context);
    if (!retried) throw new Error('Expected explicit DeepSec retry');
    const retryEvents = await watchToTerminal(retried);
    await retried.dispose();
    expect(retryEvents.at(-1)?.kind).toBe('run-complete');
    expect(fixture.run.mock.calls.map(([request]) => request.args?.[0])).toEqual(commands);

    const next = await runtime.executionRuns?.open(createOpenRequest({ runId: 'run-next-unconfirmed',
      profileLocalId, engineId, includeExplicitMode: false, confirmedCostWarning: false,
    }), context);
    if (!next) throw new Error('Expected next DeepSec review');
    const nextEvents = await watchToTerminal(next);
    await next.dispose();
    expect(nextEvents.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_confirmation_required' } });
    expect(fixture.run.mock.calls.map(([request]) => request.args?.[0])).toEqual(commands);
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
        details: { exitCode: 2, signal: null, phase: 'process' },
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

  it('leaves lexical traversal to the host filesystem boundary, its one containment decider', async () => {
    const fixture = createRuntimeContext({
      async stat() {
        throw Object.assign(new Error('Filesystem path traversal is not allowed'), {
          code: 'plugin_fs_path_denied',
        });
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-selected-traversal',
      mode: 'selected_files',
      paths: ['../outside.ts'],
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(readStructuredOutput(events)).toMatchObject({
      status: 'failed',
      error: { code: 'deepsec_scope_failed' },
      diagnostics: [{ code: 'scope_path_unavailable', path: '../outside.ts' }],
    });
    expect(fixture.stat).toHaveBeenCalledWith({ root: 'workspace', relativePath: '../outside.ts' },
      { signal: expect.any(AbortSignal) });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['src/auth.ts ', ' src/auth.ts'])('refuses native-unrepresentable selected path %j after host admission', async selectedPath => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ mode: 'selected_files', paths: [selectedPath] }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_execution_failed' } });
    expect(fixture.stat).toHaveBeenCalledWith({ root: 'workspace', relativePath: selectedPath },
      { signal: expect.any(AbortSignal) });
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
        engines: { deepsec: { mode: 'current_diff', confirmedCostWarning: true, thinkingLevel: 'xhigh' } } } } }, fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(fixture.run.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining(['--thinking-level', 'xhigh']));
  });

  it.each(['ordinary', 'working-tree', 'committed', 'revision-range'] as const)(
    'reviews captured live checkout files without broadening the native selection (%s)', async subject => {
      const nativeFiles: string[] = [];
      const fixture = createRuntimeContext({
        // Unrelated untracked files do not change a committed capture's selected tracked bytes.
        scmSnapshot: async () => liveCheckoutSnapshot('? unrelated.ts\0'),
        async run(request) {
          const listIndex = request.args?.indexOf('--files-from') ?? -1;
          if (listIndex < 0 || !request.args?.[listIndex + 1]) throw new Error('Expected host-selected native file list');
          nativeFiles.push(await readFile(request.args[listIndex + 1]!, 'utf8'));
          return processResult();
        },
      });
      const captured = subject === 'ordinary' ? {} : subject === 'working-tree'
        ? { comparison: { id: 'captured-live', source: { kind: 'workingTree', area: 'both' },
          endpoints: { before: liveHead, after: 'captured-worktree-tree' } } }
        : subject === 'committed' ? { comparison: { id: 'captured-live', source: { kind: 'branch', base: 'main', head: 'feature' },
          endpoints: { before: capturedBase, after: liveHead } } }
        : { revisionRange: { kind: 'revisionRange', baseOid: capturedBase, headOid: liveHead } };
      const { runtime } = await createNativeDeepSecRuntime();
      const opened = await runtime.executionRuns?.open(createOpenRequest({
        ...(subject === 'committed' ? { mode: 'staged' } : {}),
        scmReviewScope: ReviewScmScopeV1Schema.parse({ ...createSupportedScmReviewScope(), ...captured }),
      }), fixture.context);
      if (!opened) throw new Error('Expected DeepSec execution');
      const events = await watchToTerminal(opened);
      await opened.dispose();
      expect(events.at(-1)).toMatchObject({ kind: 'run-complete' });
      expect(nativeFiles).toEqual(['src/auth.ts\n']);
      expect(fixture.run.mock.calls[0]?.[0].args).toContain('--no-ignore');
      expect(fixture.scm).toHaveBeenCalledTimes(subject === 'ordinary' ? 0 : 1);
      if (subject !== 'ordinary') expect(fixture.scm).toHaveBeenCalledWith('scm.status.snapshot',
        { cwd: '/repo', ...(subject === 'working-tree' ? { detail: 'facts' } : {}), includeWorktreeStatus: false },
        expect.objectContaining({ signal: expect.any(AbortSignal) }));
    },
  );

  it.each([
    { source: { kind: 'workingTree', area: 'both' }, endpoints: { before: 'old-head', after: 'tree' } },
    { source: { kind: 'workingTree', area: 'included' }, endpoints: { before: liveHead, after: 'index' } },
    { source: { kind: 'workingTree', area: 'pending' }, endpoints: { before: 'index', after: 'tree' } },
    { source: { kind: 'branch', base: 'main', head: 'feature' }, endpoints: { before: capturedBase, after: 'old-head' } },
    { source: { kind: 'branch', base: 'main', head: 'feature' }, endpoints: { after: liveHead } },
    { source: { kind: 'session', sessionId: 'source-session' }, endpoints: { before: capturedBase, after: liveHead } },
  ])('refuses a captured subject outside the live checkout scope before native launch (%#)', async comparison => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ scmReviewScope: ReviewScmScopeV1Schema.parse({
      ...createSupportedScmReviewScope(), comparison: { id: 'unsupported-capture', ...comparison },
    }) }), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_execution_failed',
      message: expect.stringMatching(/captured.*checkout|checkout.*captured/),
    } });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['different-root', 'unavailable'] as const)('refuses captured checkout facts that are %s', async state => {
    const fixture = createRuntimeContext({ scmSnapshot: async () => state === 'unavailable'
      ? { success: false } : liveCheckoutSnapshot('', '/different-repository') });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ scmReviewScope: ReviewScmScopeV1Schema.parse({
      ...createSupportedScmReviewScope(), comparison: { id: 'captured-live', source: { kind: 'workingTree' },
        endpoints: { before: liveHead, after: 'captured-worktree-tree' } },
    }) }), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'deepsec_execution_failed',
      message: expect.stringMatching(/checkout|SCM/),
    } });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['pending', 'included'] as const)('refuses tracked %s edits for a captured committed head before native launch', async area => {
    const fixture = createRuntimeContext({ scmSnapshot: async () => liveCheckoutSnapshot(
      `1 ${area === 'pending' ? '.M' : 'M.'} N... 100644 100644 100644 aaaaaaa bbbbbbb src/auth.ts\0`),
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ scmReviewScope: ReviewScmScopeV1Schema.parse({
      ...createSupportedScmReviewScope(), comparison: { id: 'captured-live',
        source: { kind: 'branch', base: 'main', head: 'feature' }, endpoints: { before: capturedBase, after: liveHead } },
    }) }), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const events = await watchToTerminal(opened);
    await opened.dispose();
    expect(events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: {
      code: 'deepsec_execution_failed', message: expect.stringMatching(/tracked|clean/),
    } });
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it.each(['reject', 'result'] as const)('cancels while captured checkout facts settle (%s)', async settlement => {
    const fixture = createRuntimeContext({ scmSnapshot: options => new Promise((resolve, reject) => {
      const aborted = () => settlement === 'reject' ? reject(options?.signal?.reason) : resolve({ success: false });
      if (options?.signal?.aborted) aborted();
      else options?.signal?.addEventListener('abort', aborted, { once: true });
    }) });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ scmReviewScope: ReviewScmScopeV1Schema.parse({
      ...createSupportedScmReviewScope(), comparison: { id: 'captured-live', source: { kind: 'workingTree' },
        endpoints: { before: liveHead, after: 'captured-worktree-tree' } },
    }) }), fixture.context);
    if (!opened) throw new Error('Expected DeepSec execution');
    const terminal = watchToTerminal(opened);
    try {
      await vi.waitFor(() => expect(fixture.scm).toHaveBeenCalledOnce());
      await opened.stop();
      expect((await terminal).at(-1)).toMatchObject({ kind: 'run-cancelled' });
      expect(fixture.run).not.toHaveBeenCalled();
    } finally { await opened.dispose(); }
  });

  it.each([
    { comparison: { id: 'captured-review', source: { kind: 'branch', base: 'base', head: 'head' },
      endpoints: { before: 'captured-before', after: 'captured-after' } } },
    { revisionRange: { kind: 'revisionRange', baseOid: 'a'.repeat(40), headOid: 'c'.repeat(40) } },
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

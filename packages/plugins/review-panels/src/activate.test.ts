import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import { ReviewFindingsV2Schema } from '@happier-dev/plugin-sdk/reviews';
import { describe, expect, it, vi } from 'vitest';
import selectedReview from './agent/reviews/fixtures/selected-review.json';
import { activate, PLUGIN_MANIFEST } from './manifest.js';

function completed(stdout = '', exitCode = 0): PluginProcessResult {
  return { stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } } };
}

async function runFixture(options: { engineId?: string; failedMember?: boolean; unableToReview?: boolean; cancel?: boolean; missingDocument?: boolean; captured?: boolean; pullRequest?: boolean; selectedPaths?: string[]; selectedFiles?: string[]; workingTreeCapture?: boolean; sessionCapture?: boolean; commitCapture?: boolean; turnCapture?: boolean; cleanupFailure?: boolean;
  providerBinding?: AgentExecutionRunOpenRequest['providerBinding']; launchEnvironment?: AgentExecutionRunOpenRequest['launchEnvironment']; nativeAgent?: string; model?: string; panel?: string; providerConnectionId?: string;
  runnerAgentTarget?: AgentExecutionRunOpenRequest['runnerAgentTarget'];
  runnerConnectedAccountPurposes?: AgentExecutionRunOpenRequest['runnerConnectedAccountPurposes'];
  runnerConnectedAccountMaterialization?: AgentExecutionRunOpenRequest['runnerConnectedAccountMaterialization'];
} = {}) {
  const engineId = options.engineId ?? 'roborev';
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = activation.registration('agents', 'roborev')?.factory;
  if (!factory) throw new Error('Expected roborev reviewer Agent registration');
  const controller = new AbortController();
  const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'roborev' }, signal: controller.signal });
  const record = structuredClone(selectedReview);
  if (options.failedMember) record.panel.members[1]!.status = 'failed';
  if (options.unableToReview) record.structured_output.verdict = 'unable_to_review';
  let waitStarted!: () => void;
  const waiting = new Promise<void>(resolve => { waitStarted = resolve; });
  // The process and durable-directory services are the genuine OS boundaries.
  const run = vi.fn<ExecService['run']>(async ({ args }, invocation) => {
    if (options.cleanupFailure && args?.[1] === 'stop') return completed('', 1);
    if (args?.[0] === 'review') return completed('Enqueued job 3 (panel: fixture, 2 reviewers) for review\n');
    if (args?.[1] === 'list') return completed('[{"id":3,"job_type":"synthesis"}]');
    if (args?.[1] === 'wait') {
      waitStarted();
      if (options.cancel) await new Promise<void>(resolve => invocation?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      invocation?.signal?.throwIfAborted();
      return completed('', 1);
    }
    if (args?.[1] === 'show') return completed(JSON.stringify(options.missingDocument ? { job_id: 3 } : record));
    return completed();
  });
  const writeFile = vi.fn<FileSystemService['writeFile']>(async () => {});
  const context = { plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, contribution: { id: 'roborev', qualifiedId: `${PLUGIN_MANIFEST.id}/agents/roborev` },
    surface: 'agent', signal: controller.signal, agent: { id: 'roborev' }, services: { availability: () => ({ status: 'available' }),
      exec: { run }, fs: { getPluginDataDirectory: async () => '/plugin-data/runs/test', writeFile } },
  } as unknown as AgentRuntimeContext;
  const request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> = {
    kind: 'create', runId: 'test', cwd: '/workspace', profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'review' },
    launchEnvironment: { values: { SELECTED_OVERLAY: 'value' }, unset: ['SELECTED_OVERLAY'] },
    ...(options.launchEnvironment ? { launchEnvironment: options.launchEnvironment } : {}),
    ...(options.providerBinding ? { providerBinding: options.providerBinding } : {}),
    ...(options.runnerAgentTarget ? { runnerAgentTarget: options.runnerAgentTarget } : {}),
    ...(options.runnerConnectedAccountPurposes ? { runnerConnectedAccountPurposes: options.runnerConnectedAccountPurposes } : {}),
    ...(options.runnerConnectedAccountMaterialization ? { runnerConnectedAccountMaterialization: options.runnerConnectedAccountMaterialization } : {}),
    ...(options.model ? { modelSelection: { agentTargetKey: options.nativeAgent === 'claude-code' ? 'backend:claude' : 'backend:codex', providerConnectionId: options.providerConnectionId ?? null, modelId: options.model } } : {}),
    input: { text: 'Review this change.', structuredInput: { reviewers: [{ kind: 'engine', engineId }], instructions: 'Review this change.',
      ...(options.selectedPaths ? { selectedPaths: options.selectedPaths } : {}),
      ...(options.selectedFiles ? { selectedFiles: options.selectedFiles } : {}),
      scope: 'changes', changeType: 'uncommitted', base: { kind: 'none' }, engines: { [engineId]: { panel: options.panel ?? 'fixture', reviewType: 'security', agent: options.nativeAgent ?? 'codex', reasoning: 'high' } },
      scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
        repositoryRoot: '/workspace', worktreeRoot: '/workspace', baseRef: { source: 'unavailable', ref: null },
        selectedPaths: [], committedPaths: [], uncommittedPaths: [], changedPaths: [], diagnostics: [],
        diff: { committedAvailable: false, uncommittedAvailable: true },
        ...(options.captured ? { comparison: { id: 'captured', source: { kind: 'branch', head: 'feature', base: 'main' }, endpoints: { before: 'base-oid', after: 'head-oid' } } } : {}),
        ...(options.workingTreeCapture ? { comparison: { id: 'captured-worktree', source: { kind: 'workingTree' }, endpoints: { before: 'base-oid', after: 'snapshot-tree-oid' } } } : {}),
        ...(options.sessionCapture ? { comparison: { id: 'captured-session', source: { kind: 'session', sessionId: 'source-session' }, endpoints: { before: 'checkpoint-commit-oid', after: 'snapshot-tree-oid' } } } : {}),
        ...(options.commitCapture ? { comparison: { id: 'captured-root-commit', source: { kind: 'commit', commit: 'captured-commit-oid' }, endpoints: { before: 'empty-tree-oid', after: 'captured-commit-oid' } } } : {}),
        ...(options.turnCapture ? { comparison: { id: 'captured-turn', source: { kind: 'turnCheckpoint', sessionId: 'source-session', turnId: 'source-turn' }, endpoints: { before: 'start-checkpoint-commit-oid', after: 'final-checkpoint-commit-oid' } } } : {}),
        ...(options.pullRequest ? { revisionRange: { kind: 'revisionRange', baseOid: 'pr-base-oid', headOid: 'pr-head-oid' } } : {}),
      } } },
  };
  const runtime = await agent.executionRuns?.open(request, context);
  if (!runtime) throw new Error('Expected finite review runtime');
  const events: AgentExecutionRunEvent[] = [];
  runtime.watch(event => events.push(event));
  if (options.cancel) { await waiting; await runtime.stop(); }
  await vi.waitFor(() => expect(['run-complete', 'run-failed', 'run-cancelled']).toContain(events.at(-1)?.kind));
  // The finite runtime must not settle before native cleanup finishes.
  if (run.mock.calls.length) expect(run.mock.calls.at(-1)?.[0].args).toEqual(['daemon', 'stop']);
  const output = events.filter(event => event.kind === 'output-delta' && event.channel === 'assistant').map(event => event.text).join('');
  await runtime.dispose();
  await activation.dispose();
  return { events, output: output ? ReviewFindingsV2Schema.parse(JSON.parse(output)) : null, run, writeFile };
}

describe('activated roborev reviewer', () => {
  it('refuses missing selected-account materialization despite an ambient Machine home', async () => {
    const result = await runFixture({ panel: 'none', model: 'selected-model',
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      runnerConnectedAccountPurposes: ['openai-api-key'], launchEnvironment: { values: { CODEX_HOME: '/machine/codex' }, unset: [] },
    });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_runner_account_unsupported' } });
    expect(result.run).not.toHaveBeenCalled();
  });
  it.each(['model_upstream_api_key', 'kimi-code-api-key'])('refuses selected Claude %s before native auth stripping can use Machine login', async purpose => {
    const result = await runFixture({ panel: 'none', nativeAgent: 'claude-code', model: 'selected-model',
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      runnerConnectedAccountPurposes: [purpose], runnerConnectedAccountMaterialization: { v: 1, kind: 'spawnEnv' },
      launchEnvironment: { values: { ANTHROPIC_API_KEY: 'selected-key', CLAUDE_CONFIG_DIR: '/machine/claude' }, unset: [] },
    });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_runner_account_unsupported' } });
    expect(result.run).not.toHaveBeenCalled();
  });
  it.each(['openai-api-key', 'kimi-code-api-key'])('preserves the selected Codex %s through native config', async purpose => {
    const result = await runFixture({ panel: 'none', model: 'selected-model',
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      runnerConnectedAccountPurposes: [purpose], runnerConnectedAccountMaterialization: { v: 1, kind: 'engineConfig', engineConfig: {
        modelProvider: 'selected', config: { 'model_providers.selected': { base_url: 'https://selected.example/v1', env_key: 'SELECTED_KEY', wire_api: 'responses' } },
      } },
      launchEnvironment: { values: { SELECTED_KEY: 'selected-key', CODEX_HOME: '/machine/codex' }, unset: ['OPENAI_API_KEY'] },
    });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    const config = result.writeFile.mock.calls.map(call => new TextDecoder().decode(call[1])).join('');
    expect(config).toContain('model_provider = "selected"');
    expect(config).toContain('SELECTED_KEY');
    expect(config).not.toContain('selected-key');
    expect(result.run.mock.calls[0]?.[0].env).toMatchObject({ SELECTED_KEY: 'selected-key', OPENAI_API_KEY: '' });
  });
  it('uses the admitted Claude runner instead of a stale engine agent and preserves its host login', async () => {
    const result = await runFixture({ panel: 'none', nativeAgent: 'codex', model: 'selected-claude',
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      launchEnvironment: { values: { CLAUDE_CODE_OAUTH_TOKEN: 'selected-subscription' }, unset: [] },
      runnerConnectedAccountPurposes: ['model_upstream'], runnerConnectedAccountMaterialization: { v: 1, kind: 'spawnEnv' },
    });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    const review = result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0];
    expect(review?.args).toEqual(expect.arrayContaining(['--agent', 'claude-code', '--model', 'selected-claude']));
    expect(review?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'selected-subscription' });
  });
  it('runs the selected Codex Provider with its host-projected home and native config', async () => {
    const result = await runFixture({ panel: 'none', model: 'selected-model',
      launchEnvironment: { values: { CODEX_HOME: '/host/selected-codex', SELECTED_PROVIDER_KEY: 'selected-secret' }, unset: [] },
      providerBinding: { connectionId: 'selected-provider', upstream: { protocol: 'openai-responses', normalizedUrl: 'https://selected.example/v1', credential: 'apiKey' },
        model: { id: 'selected-model', name: 'Selected' }, materialization: { v: 1, kind: 'engineConfig', engineConfig: {
          v: 1, modelProvider: 'selected', config: { 'model_providers.selected': { name: 'Selected', base_url: 'https://selected.example/v1', wire_api: 'responses', env_key: 'SELECTED_PROVIDER_KEY', requires_openai_auth: false } },
        } } },
    });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.run.mock.calls[0]?.[0].env).toMatchObject({ CODEX_HOME: '/host/selected-codex', SELECTED_PROVIDER_KEY: 'selected-secret' });
    const config = new TextDecoder().decode(result.writeFile.mock.calls[0]?.[1]);
    expect(config).toContain('model_provider = "selected"');
    expect(config).toMatch(/"?env_key"? = "SELECTED_PROVIDER_KEY"/);
    expect(config).not.toContain('selected-secret');
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args).toContain('selected-model');
  });
  it('translates the materialized Claude bearer route to the supported native proxy transport', async () => {
    const result = await runFixture({ panel: 'none', nativeAgent: 'claude-code', model: 'selected-claude',
      launchEnvironment: { values: { ANTHROPIC_BASE_URL: 'https://selected.example', ANTHROPIC_AUTH_TOKEN: 'selected-secret', CLAUDE_CONFIG_DIR: '/host/selected-claude' }, unset: ['ANTHROPIC_API_KEY'] },
      providerBinding: { connectionId: 'selected-provider', upstream: { protocol: 'anthropic', normalizedUrl: 'https://selected.example', credential: 'apiKey' },
        model: { id: 'selected-claude', name: 'Selected' }, materialization: { v: 1, kind: 'spawnEnv' } },
    });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.run.mock.calls[0]?.[0].env).toMatchObject({ ROBOREV_CLAUDE_PROXY_TOKEN: 'selected-secret', CLAUDE_CONFIG_DIR: '/host/selected-claude' });
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args).toContain('selected-claude@https://selected.example');
    expect(result.writeFile.mock.calls.map(call => new TextDecoder().decode(call[1])).join('')).not.toContain('selected-secret');
  });
  it('keeps selected Claude transports that roborev cannot preserve from falling back to Machine login', async () => {
    const result = await runFixture({ panel: 'none', nativeAgent: 'claude-code', model: 'selected-claude',
      launchEnvironment: { values: { ANTHROPIC_BASE_URL: 'https://selected.example', ANTHROPIC_API_KEY: 'selected-secret' }, unset: [] },
      providerBinding: { connectionId: 'selected-provider', upstream: { protocol: 'anthropic', normalizedUrl: 'https://selected.example', credential: 'apiKey' },
        model: { id: 'selected-claude', name: 'Selected' }, materialization: { v: 1, kind: 'spawnEnv' } },
    });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_provider_transport_unsupported' } });
    expect(result.run).not.toHaveBeenCalled();
  });
  it('never substitutes Machine login when the selected Provider materialization is missing', async () => {
    const result = await runFixture({ panel: 'none', model: 'selected-model', providerConnectionId: 'selected-provider' });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_provider_materialization_missing' } });
    expect(result.run).not.toHaveBeenCalled();
  });
  it('refuses to apply one selected account to a repository-defined native panel', async () => {
    const result = await runFixture({ panel: 'repository-panel', model: 'selected-model',
      providerBinding: { connectionId: 'selected-provider', upstream: { protocol: 'openai-responses', normalizedUrl: 'https://selected.example/v1', credential: 'apiKey' },
        model: { id: 'selected-model', name: 'Selected' }, materialization: { v: 1, kind: 'configFile', rootPath: '/host/codex', relativePaths: ['config.toml'] } },
    });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_panel_account_unsupported' } });
    expect(result.run).not.toHaveBeenCalled();
  });
  it('preserves the host-materialized Claude subscription without choosing a proxy', async () => {
    const result = await runFixture({ panel: 'none', nativeAgent: 'claude-code', model: 'sonnet',
      launchEnvironment: { values: { CLAUDE_CODE_OAUTH_TOKEN: 'selected-oauth', CLAUDE_CONFIG_DIR: '/host/selected-claude' }, unset: [] },
    });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.run.mock.calls[0]?.[0].env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'selected-oauth', CLAUDE_CONFIG_DIR: '/host/selected-claude' });
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args).toContain('sonnet');
    expect(result.run.mock.calls[0]?.[0].env?.ROBOREV_CLAUDE_PROXY_TOKEN).toBeFalsy();
  });
  it.each([
    { selectedPaths: ['selected.ts'] },
    { selectedFiles: ['selected.ts'] },
    { captured: true, selectedPaths: ['selected.ts'] },
    { pullRequest: true, selectedPaths: ['selected.ts'] },
    { workingTreeCapture: true },
    { sessionCapture: true },
  ])('refuses subjects the native whole-worktree command cannot preserve: %j', async options => {
    const result = await runFixture(options);
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_scope_unsupported' } });
    expect(result.run).not.toHaveBeenCalled();
    expect(result.output).toBeNull();
  });
  it('runs selected native panel/type and exposes attributed findings through the shared result schema', async () => {
    const result = await runFixture({ selectedPaths: [], selectedFiles: [] });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: 'complete', findings: [{ extensions: { 'happier.review.roborev': {
      verdict: 'fail', sources: [1], members: [{ name: 'first' }, { name: 'second' }],
    } } }] });
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args)
      .toEqual(['review', '--dirty', '--panel', 'fixture', '--type', 'security', '--agent', 'codex', '--reasoning', 'high', '--quiet']);
    expect(result.run.mock.calls[0]?.[0].env).toMatchObject({ SELECTED_OVERLAY: '' });
    expect(result.writeFile).toHaveBeenCalledWith({ root: 'pluginData', relativePath: 'runs/test/config.toml' },
      new TextEncoder().encode('review_guidelines = "Review this change."\n'), { signal: expect.any(AbortSignal) });
  });
  it('translates captured endpoints without re-resolving the ambient branch', async () => {
    const result = await runFixture({ captured: true, engineId: 'happier.review.roborev/roborev' });
    expect(result.output?.comparisonId).toBe('captured');
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args)
      .toEqual(['review', '--sha', 'base-oid..head-oid', '--panel', 'fixture', '--type', 'security', '--agent', 'codex', '--reasoning', 'high', '--quiet']);
  });
  it('translates the admitted pull-request range without using checkout HEAD', async () => {
    const result = await runFixture({ pullRequest: true });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args)
      .toEqual(['review', '--sha', 'pr-base-oid..pr-head-oid', '--panel', 'fixture', '--type', 'security', '--agent', 'codex', '--reasoning', 'high', '--quiet']);
  });
  it('preserves a captured root commit without sending its empty-tree base to native git log', async () => {
    const result = await runFixture({ commitCapture: true });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args)
      .toEqual(['review', '--sha', 'captured-commit-oid', '--panel', 'fixture', '--type', 'security', '--agent', 'codex', '--reasoning', 'high', '--quiet']);
  });
  it('retains the committed checkpoint endpoints of a captured turn', async () => {
    const result = await runFixture({ turnCapture: true });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args)
      .toEqual(['review', '--sha', 'start-checkpoint-commit-oid..final-checkpoint-commit-oid', '--panel', 'fixture', '--type', 'security', '--agent', 'codex', '--reasoning', 'high', '--quiet']);
  });
  it.each([
    { options: { failedMember: true }, outcome: 'partial', secondMemberStatus: 'failed' },
    { options: { unableToReview: true }, outcome: 'failed', secondMemberStatus: 'done' },
  ])('completes the transport so the host can materialize a $outcome review and its findings', async ({ options, outcome, secondMemberStatus }) => {
    const result = await runFixture(options);
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: outcome, findings: [{ extensions: { 'happier.review.roborev': {
      members: [{ status: 'done' }, { status: secondMemberStatus }],
    } } }] });
  });
  it('refuses missing structured data through the real finite runtime', async () => {
    const result = await runFixture({ missingDocument: true });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_document_unsupported' } });
    expect(result.output).toBeNull();
  });
  it('cancels the selected job before stopping its daemon and settling Stop', async () => {
    const result = await runFixture({ cancel: true });
    expect(result.events.at(-1)?.kind).toBe('run-cancelled');
    expect(result.run.mock.calls.slice(-2).map(([request]) => request.args)).toEqual([['job', 'cancel', '3'], ['daemon', 'stop']]);
  });
  it('keeps failed native cleanup visible when Stop was requested', async () => {
    const result = await runFixture({ cancel: true, cleanupFailure: true });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-cancelled' });
    expect(result.events).toContainEqual(expect.objectContaining({ kind: 'output-delta', channel: 'reasoning', text: expect.stringContaining('cleanup') }));
  });
  it('preserves completed findings and reports daemon cleanup failure beside the result', async () => {
    const result = await runFixture({ cleanupFailure: true });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: 'complete', findings: [expect.objectContaining({ title: expect.any(String) })] });
    expect(result.events).toContainEqual(expect.objectContaining({ kind: 'output-delta', channel: 'reasoning', text: expect.stringContaining('cleanup') }));
  });
  it('preserves the typed primary refusal when daemon cleanup also fails', async () => {
    const result = await runFixture({ missingDocument: true, cleanupFailure: true });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'roborev_document_unsupported' } });
    expect(result.events).toContainEqual(expect.objectContaining({ kind: 'output-delta', channel: 'reasoning', text: expect.stringContaining('cleanup') }));
  });
});

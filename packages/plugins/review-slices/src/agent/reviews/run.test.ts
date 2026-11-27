import { describe, expect, it, vi } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runClawpatchReview } from './run.js';
import { createClawpatchProcessFixture as fixture } from './run.testkit.js';
import { createClawpatchExecutionRunFactory } from './execution.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, PLUGIN_MANIFEST } from '../../manifest.js';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { ReviewFindingsV2Schema } from '@happier-dev/plugin-sdk/reviews';

describe('native clawpatch review', () => {
  it('preserves native findings and reports process cleanup failure', async () => {
    const f = await fixture('success', undefined, true);
    const onCleanupFailure = vi.fn();
    const result = await runClawpatchReview({ exec: f.exec, fs: { getPluginDataDirectory: async () => f.state },
      cwd: f.directory, stateRelativePath: 'repository-a', signal: f.controller.signal, onCleanupFailure });
    expect(result).toMatchObject({ status: 'completed', findings: [expect.objectContaining({ id: expect.any(String) }), expect.objectContaining({ id: expect.any(String) })] });
    expect(onCleanupFailure).toHaveBeenCalledOnce();
  });
  it('refuses missing selected-account materialization despite an ambient Machine home', async () => {
    const f = await fixture();
    const runtime = await createClawpatchExecutionRunFactory().open({ kind: 'create', runId: 'missing-material', cwd: f.directory,
      profile: { pluginId: 'happier.review.clawpatch', localId: 'review' },
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      runnerConnectedAccountPurposes: ['openai-api-key'], launchEnvironment: { values: { CODEX_HOME: '/machine/codex' }, unset: [] },
      input: { text: 'Review', structuredInput: { scope: 'repository', engines: {}, scmReviewScope: { scope: 'repository', status: 'supported', worktreeRoot: f.directory } } },
    }, { agent: { id: 'clawpatch' }, signal: f.controller.signal, services: { exec: f.exec, fs: { getPluginDataDirectory: async () => f.state } } } as unknown as AgentExecutionRunRuntimeContextV1);
    try {
      const terminal = await new Promise<AgentExecutionRunEvent>(resolve => { runtime.watch(event => {
        if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve(event);
      }); });
      expect(terminal).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'clawpatch_runner_account_unsupported' } });
      expect(f.commands).toEqual([]);
    } finally { await runtime.dispose(); }
  });
  it.each(['openai-api-key', 'kimi-code-api-key'])('uses the translated Codex %s configuration instead of Machine login', async purpose => {
    const f = await fixture();
    const runtime = await createClawpatchExecutionRunFactory().open({ kind: 'create', runId: purpose, cwd: f.directory,
      profile: { pluginId: 'happier.review.clawpatch', localId: 'review' },
      runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      runnerConnectedAccountPurposes: [purpose], runnerConnectedAccountMaterialization: { v: 1, kind: 'engineConfig', engineConfig: {
        modelProvider: 'selected', config: { 'model_providers.selected': { base_url: 'https://selected.example/v1', env_key: 'SELECTED_KEY', wire_api: 'responses' } },
      } },
      modelSelection: { modelId: 'selected-model' }, launchEnvironment: { values: { SELECTED_KEY: 'selected-key', CODEX_HOME: '/machine/codex' }, unset: ['OPENAI_API_KEY'] },
      input: { text: 'Review', structuredInput: { scope: 'repository', engines: {}, scmReviewScope: { scope: 'repository', status: 'supported', worktreeRoot: f.directory } } },
    }, { agent: { id: 'clawpatch' }, signal: f.controller.signal, services: { exec: f.exec, fs: { getPluginDataDirectory: async () => f.state } } } as unknown as AgentExecutionRunRuntimeContextV1);
    try {
      const terminal = await new Promise<AgentExecutionRunEvent>(resolve => { runtime.watch(event => {
        if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve(event);
      }); });
      expect(terminal.kind).toBe('run-complete');
      expect(f.configs).toContainEqual(expect.objectContaining({ provider: expect.objectContaining({ codexConfig: expect.objectContaining({ model_provider: 'selected', 'model_providers.selected.env_key': 'SELECTED_KEY' }) }) }));
      expect(JSON.stringify(f.configs)).not.toContain('selected-key');
      for (const environment of f.environments) expect(environment).toMatchObject({ SELECTED_KEY: 'selected-key', OPENAI_API_KEY: '' });
    } finally { await runtime.dispose(); }
  });
  // U9/F5 replaces the former blanket Provider refusal with the admitted runner route.
  it.each(['codex-account', 'claude-account', 'claude-api-key-account', 'claude-kimi-account', 'codex-provider', 'claude-provider'] as const)(
    'runs the selected model with the host-materialized %s route', async route => {
      const f = await fixture();
      const provider = route.startsWith('claude') ? 'claude' : 'codex';
      const modelProvider = 'happier_0123456789abcdef0123456789abcdef';
      const binding: AgentExecutionRunOpenRequest['providerBinding'] = route === 'codex-provider' ? {
        connectionId: 'selected-provider', upstream: { protocol: 'openai-responses', normalizedUrl: 'https://example.com/codex/v1', credential: 'apiKey' },
        model: { id: 'selected-model', name: 'Selected model' }, materialization: { v: 1, kind: 'engineConfig', engineConfig: {
          v: 1, modelProvider, config: { [`model_providers.${modelProvider}`]: {
            name: 'Happier provider', base_url: 'https://example.com/codex/v1', wire_api: 'responses',
            env_key: 'HAPPIER_CODEX_PROVIDER_API_KEY', requires_openai_auth: false, supports_websockets: false,
          }, model_context_window: 200000 },
        } },
      } : route === 'claude-provider' ? {
        connectionId: 'selected-provider', upstream: { protocol: 'anthropic', normalizedUrl: 'https://example.com', credential: 'apiKey' },
        model: { id: 'selected-model', name: 'Selected model' }, materialization: { v: 1, kind: 'spawnEnv' },
      } : undefined;
      const values = { CODEX_HOME: '/host/projected-codex', CLAUDE_CONFIG_DIR: '/host/projected-claude',
        CLAUDE_CODE_OAUTH_TOKEN: route === 'claude-account' ? 'fixture-subscription-token' : '',
        ANTHROPIC_API_KEY: route === 'claude-api-key-account' || route === 'claude-kimi-account' ? 'fixture-selected-key' : '',
        ANTHROPIC_AUTH_TOKEN: route === 'claude-provider' ? 'fixture-provider-token' : '',
        HAPPIER_CODEX_PROVIDER_API_KEY: route === 'codex-provider' ? 'fixture-provider-token' : '',
        ANTHROPIC_BASE_URL: route === 'claude-kimi-account' ? 'https://api.kimi.com/coding' : route === 'claude-provider' ? 'https://example.com' : '', OPENAI_API_KEY: 'must-be-unset' };
      const context = { agent: { id: 'clawpatch' }, signal: f.controller.signal,
        services: { exec: f.exec, fs: { getPluginDataDirectory: async () => f.state } } } as unknown as AgentExecutionRunRuntimeContextV1;
      const runtime = await createClawpatchExecutionRunFactory().open({ kind: 'create', runId: route, cwd: f.directory,
        profile: { pluginId: 'happier.review.clawpatch', localId: 'review' },
        runnerAgentTarget: { kind: 'agent', identity: { pluginId: `happier.agent.${provider}`, localId: provider } },
        // Team-bound launches carry the selected model in the materialized binding,
        // without the legacy Provider-connection selection field.
        ...(!binding ? { modelSelection: { modelId: 'selected-model' } } : {}),
        ...(binding ? { providerBinding: binding } : {}), launchEnvironment: { values, unset: ['OPENAI_API_KEY'] },
        ...(!binding ? { runnerConnectedAccountPurposes: [route === 'codex-account' ? 'primary' : route === 'claude-api-key-account' ? 'model_upstream_api_key' : route === 'claude-kimi-account' ? 'kimi-code-api-key' : 'model_upstream'],
          runnerConnectedAccountMaterialization: provider === 'claude' ? { v: 1 as const, kind: 'spawnEnv' as const }
            : { v: 1 as const, kind: 'configFile' as const, rootPath: '/host/projected-codex', relativePaths: ['auth.json'] } } : {}),
        input: { text: 'Review', structuredInput: { scope: 'repository', engines: { clawpatch: { provider: provider === 'claude' ? 'codex' : 'claude', model: 'stale-model' } },
          scmReviewScope: { scope: 'repository', status: 'supported', worktreeRoot: f.directory } } },
      }, context);
      try {
        const terminal = await new Promise<AgentExecutionRunEvent>(resolve => { runtime.watch(event => {
          if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve(event);
        }); });
        expect(terminal.kind).toBe('run-complete');
        expect(f.commands.map(args => args[0])).toEqual(['init', 'map', 'review']);
        for (const args of f.commands.slice(1)) expect(args).toEqual(expect.arrayContaining(['--provider', provider, '--model', 'selected-model']));
        for (const environment of f.environments) expect(environment).toMatchObject({ ...values, OPENAI_API_KEY: '',
          ...(provider === 'claude' ? { CLAWPATCH_CLAUDE_AUTH_CONTEXT: 'host' } : {}) });
        if (route === 'codex-provider') {
          expect(f.configs).toHaveLength(2);
          for (const config of f.configs) {
            expect(config).toMatchObject({ review: { preservedNativeSetting: true }, provider: { name: 'codex', codexConfig: {
              model_provider: modelProvider, [`model_providers.${modelProvider}.base_url`]: 'https://example.com/codex/v1',
              [`model_providers.${modelProvider}.env_key`]: 'HAPPIER_CODEX_PROVIDER_API_KEY', model_context_window: 200000,
            } } });
            expect(JSON.stringify(config)).not.toContain('fixture-provider-token');
          }
        }
        expect(await readdir(join(f.state, 'findings'))).toContain('old.json');
      } finally { await runtime.dispose(); }
    });
  it.each([
    { workspaceWrites: 'deny', unset: [], expected: 'read-only' },
    { workspaceWrites: 'allow', unset: [], expected: 'bypass' },
    { workspaceWrites: undefined, unset: [], expected: 'bypass' },
  ] as const)('binds the admitted $workspaceWrites policy to the native Codex sandbox', async ({ workspaceWrites, unset, expected }) => {
    const f = await fixture();
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const factory = activation.registration('agents', 'clawpatch')?.factory;
      if (!factory) throw new Error('Missing clawpatch reviewer registration');
      const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'clawpatch' }, signal: f.controller.signal });
      // Host OS/process services are the boundary; registered factory and finite flow remain real.
      const context = { agent: { id: 'clawpatch' }, signal: f.controller.signal, services: {
        exec: f.exec, fs: { getPluginDataDirectory: async () => f.state },
      } } as unknown as AgentExecutionRunRuntimeContextV1;
      const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'native-write-policy', cwd: f.directory,
        profile: { pluginId: 'happier.review.clawpatch', localId: 'review' },
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: null, updatedAtMs: 0 }, options: {}, ...(workspaceWrites ? { workspaceWrites } : {}) },
        launchEnvironment: { values: { CLAWPATCH_CODEX_SANDBOX: 'bypass', NATIVE_REVIEW_MARKER: 'retained' }, unset: [...unset] },
        input: { text: 'Review the repository', structuredInput: { scope: 'repository',
          engines: { clawpatch: { provider: 'mock' } }, scmReviewScope: {
            scope: 'repository', status: 'supported', worktreeRoot: f.directory,
          } } } };
      const runtime = await agent.executionRuns!.open(request, context);
      try {
        const terminal = await new Promise<AgentExecutionRunEvent>(resolve => { runtime.watch(event => {
          if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve(event);
        }); });
        expect(terminal.kind).toBe('run-complete');
        expect(f.commands.map(args => args[0])).toEqual(['init', 'map', 'review']);
        for (const environment of f.environments) expect(environment).toMatchObject({
          CLAWPATCH_CODEX_SANDBOX: expected, NATIVE_REVIEW_MARKER: 'retained',
        });
      } finally { await runtime.dispose(); }
    } finally { await activation.dispose(); }
  });
  it('streams both native slice starts and completions before the finite result is available', async () => {
    let releaseReview = () => {};
    const reviewCompletion = new Promise<void>(resolve => { releaseReview = resolve; });
    const f = await fixture('success', reviewCompletion);
    const context = { agent: { id: 'clawpatch' }, signal: f.controller.signal, services: { exec: f.exec, fs: { getPluginDataDirectory: async () => f.state } } } as unknown as AgentExecutionRunRuntimeContextV1;
    const runtime = await createClawpatchExecutionRunFactory().open({ kind: 'create', runId: 'live-progress', cwd: f.directory,
      profile: { pluginId: 'happier.review.clawpatch', localId: 'review' }, input: { text: 'Review the repository', structuredInput: {
        scope: 'repository', engines: { clawpatch: { provider: 'mock' } }, scmReviewScope: {
          scope: 'repository', status: 'supported', worktreeRoot: f.directory,
        },
      } } }, context);
    const events: AgentExecutionRunEvent[] = [];
    const terminal = new Promise<void>(resolve => { runtime.watch(event => {
      events.push(event); if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve();
    }); });
    try {
      await vi.waitFor(() => {
        const progress = events.filter(event => event.kind === 'output-delta' && event.channel === 'reasoning');
        expect(progress).toHaveLength(4);
        expect(progress).toMatchObject([
          { text: expect.stringContaining('slice-a (1/2)') }, { text: expect.stringContaining('slice-a (1/2)') },
          { text: expect.stringContaining('slice-b (2/2)') }, { text: expect.stringContaining('slice-b (2/2)') },
        ]);
      });
      expect(events.some(event => event.kind === 'run-complete' || event.kind === 'run-failed'
        || (event.kind === 'output-delta' && event.channel === 'assistant'))).toBe(false);
    } finally {
      releaseReview();
      await terminal;
      await runtime.dispose();
    }
    expect(events.at(-1)?.kind).toBe('run-complete');
    const output = events.find(event => event.kind === 'output-delta' && event.channel === 'assistant');
    if (!output || output.kind !== 'output-delta') throw new Error('Missing canonical review result');
    expect(ReviewFindingsV2Schema.parse(JSON.parse(output.text)).findings).toHaveLength(2);
  });
  it.each(['success', 'failed'] as const)('publishes substantive native findings for host normalization when the native result is %s', async mode => {
    const engineId = mode === 'success' ? 'happier.review.clawpatch/clawpatch' : 'clawpatch';
    const f = await fixture(mode);
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'clawpatch')?.factory;
    if (!factory) throw new Error('Missing clawpatch reviewer registration');
    const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'clawpatch' }, signal: f.controller.signal });
    // Only host I/O services are substituted; the runtime, scope schema and adapter remain real.
    const context = { agent: { id: 'clawpatch' }, signal: f.controller.signal, services: {
      exec: f.exec, fs: { getPluginDataDirectory: async () => f.state },
      managedServices: { dependencies: { ensure: async () => ({ state: 'ready', id: 'review-executable', version: '0.8.4', sourceId: 'test' }) } },
    } } as unknown as AgentExecutionRunRuntimeContextV1;
    const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'host-run', cwd: f.directory,
      profile: { pluginId: 'happier.review.clawpatch', localId: 'review' }, input: { text: 'Find lost writes', structuredInput: {
        reviewers: [{ kind: 'engine', engineId }], instructions: 'Find lost writes', scope: 'repository', engines: { [engineId]: { provider: 'mock' } },
        scmReviewScope: { kind: 'review_scm_scope.v1', scope: 'repository', status: 'supported', scmBackendId: 'git', scmMode: '.git',
          repositoryRoot: f.directory, worktreeRoot: f.directory, baseRef: { source: 'unavailable', ref: null },
          selectedPaths: [], committedPaths: [], uncommittedPaths: [], changedPaths: [], diagnostics: [],
          diff: { committedAvailable: false, uncommittedAvailable: false } },
      } } };
    const runtime = await agent.executionRuns!.open(request, context);
    const events: AgentExecutionRunEvent[] = [];
    await new Promise<void>(resolve => { runtime.watch(event => {
      events.push(event); if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve();
    }); });
    expect(events.at(-1)?.kind).toBe('run-complete');
    const output = events.find(event => event.kind === 'output-delta' && event.channel === 'assistant');
    if (!output || output.kind !== 'output-delta') throw new Error('Missing canonical review output');
    const review = ReviewFindingsV2Schema.parse(JSON.parse(output.text));
    expect(review.reviewOutcome).toBe(mode === 'failed' ? 'failed' : 'complete');
    expect(review.findings[0]?.extensions?.['happier.review.clawpatch']).toMatchObject({
      nativeFindingId: 'one', featureId: 'slice-a', confidence: 'high', reproduction: 'Run two concurrent writes.',
    });
    expect(f.commands.at(-1)).toContain('--prompt-file');
    expect(f.commands.at(-1)).toEqual(expect.arrayContaining(['--provider', 'mock']));
    await runtime.dispose();
    await activation.dispose();
  });
  it('explicitly reviews every active slice and joins only the selected run IDs to full finding evidence', async () => {
    const f = await fixture(); const result = await f.run();
    expect(f.selected()).toEqual(['slice-a', 'slice-b']);
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ id: 'clawpatch-1', filePath: 'slice-a.ts', startLine: 4, severity: 'blocker',
      summary: 'The write is lost before commit.', suggestion: 'Commit before returning.' });
    expect(result.findings[0]?.confidence).toBeUndefined();
    expect(result.findingEvidence[0]).toMatchObject({ runId: 'native-run', featureId: 'slice-a', confidence: 'high',
      reproduction: 'Run two concurrent writes.', suggestedRegressionTest: 'Run concurrent writers.' });
    expect(f.commands.map(args => args[0])).toEqual(['init', 'map', 'review']);
    expect(await readdir(join(f.state, 'findings'))).toContain('old.json');
  });
  it('refuses counts-only success without the full native run record', async () => {
    const f = await fixture('counts-only'); await expect(f.run()).rejects.toThrow();
  });
  it('retains substantive evidence from a failed native run without calling it a clean review', async () => {
    const f = await fixture('failed'); const result = await f.run();
    expect(result.status).toBe('failed'); expect(result.findings).toHaveLength(2);
    expect(result.errors).toEqual([{ message: 'provider unavailable', code: 'provider-failed' }]);
  });
});

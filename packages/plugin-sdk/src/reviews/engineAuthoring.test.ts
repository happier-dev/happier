import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { createFiniteExecutionRunHostRuntime, type AgentExecutionRunEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { ReviewFindingSchema } from '@happier-dev/plugin-sdk/reviews';

describe('third-party Review engine authoring through the public SDK', () => {
  it('admits runner Agents, native account purposes, scopes and engine options without a bundled identity', () => {
    const runner = { agentTarget: { kind: 'agent' as const,
      identity: { pluginId: 'com.acme.runner', localId: 'reviewer' } },
      providerProtocols: ['acme-review'], connectedAccountPurposes: ['model'] };
    const plugin = definePlugin({
      id: 'com.acme.review', version: '1.0.0',
      agents: { engine: { declaration: {
        title: 'Acme reviewer', primary: 'executionRuns', runtime: { kind: 'custom' },
        capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } },
        runnerAgents: [runner], runnerSelection: 'perMember',
        connectedAccounts: [{ purpose: 'native', service: { pluginId: 'com.acme.account', localId: 'review' },
          required: true, materializationKinds: ['files'], credentialKinds: ['oauth'] }],
      }, factory: () => ({ executionRuns: { open: () => { throw new Error('Declaration inspection never opens a Run'); } } }) } },
      executionRunProfiles: { review: {
        id: 'review', intent: 'review', title: 'Acme review', promptAsset: 'instructions', compatibleAgents: ['engine'],
        defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
        metadata: { reviewScopes: ['repository', 'worktree', 'paths'] },
        optionsSchema: { type: 'object', additionalProperties: false, properties: { thorough: { type: 'boolean' } } },
        optionsInputHints: { fields: [{ path: 'thorough', title: 'Thorough review', widget: 'boolean' }] },
      } },
      resources: { prompt: { source: 'packaged', kind: 'template', path: './review.md', contentType: 'text/markdown' } },
      promptAssets: { instructions: { kind: 'systemPrompt', resource: 'prompt', target: { kind: 'agent', agent: 'engine' } } },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes?.agents?.[0]).toMatchObject({
      runnerAgents: [runner], runnerSelection: 'perMember', connectedAccounts: [{ purpose: 'native', credentialKinds: ['oauth'] }],
    });
    expect(parsed.manifest.contributes?.executionRunProfiles?.[0]).toMatchObject({
      metadata: { reviewScopes: ['repository', 'worktree', 'paths'] }, optionsInputHints: { fields: [{ path: 'thorough' }] },
    });
  });

  it('publishes progress and namespaced findings through the ordinary finite Run lifecycle', async () => {
    const finding = ReviewFindingSchema.parse({ id: 'acme-1', title: 'Missing validation', severity: 'high',
      category: 'correctness', summary: 'Unvalidated input reaches the operation.', filePath: 'src/input.ts', startLine: 7,
      extensions: { 'com.acme.review': { evidenceId: 'native-42' } } });
    const runtime = createFiniteExecutionRunHostRuntime({
      request: { kind: 'create', runId: 'acme-run', cwd: '/workspace',
        profile: { pluginId: 'com.acme.review', localId: 'review' }, input: { text: 'Review the captured changes.' } },
      execute: async ({ emit }) => {
        emit({ kind: 'run-progress' });
        emit({ kind: 'output-delta', channel: 'assistant', text: JSON.stringify({ findings: [finding] }) });
        return { status: 'complete' };
      },
      mapFailure: () => ({ code: 'acme_failed', severity: 'error' }),
      unsupportedSendDiagnostic: { code: 'acme_finite', severity: 'error' },
    });
    const events: AgentExecutionRunEvent[] = [];
    runtime.watch(event => events.push(event));
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('run-complete'));
    expect(events.map(event => event.kind)).toEqual(['run-start', 'run-progress', 'output-delta', 'run-complete']);
    const output = events.find(event => event.kind === 'output-delta');
    if (output?.kind !== 'output-delta') throw new Error('Expected the public findings output');
    expect(JSON.parse(output.text).findings).toEqual([finding]);
    await runtime.dispose();
  });
});

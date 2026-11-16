import { describe, expect, it } from 'vitest';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';

import { TestInteractions } from '../../../../apps/cli/src/agent/acp/testkit/interactionsFixture';
import { writeAcpTestAgentScript } from '../../../../apps/cli/src/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '../../../../apps/cli/src/testkit/fs/tempDir';
import { createAgentSessionTurnInvariant } from '../../../../apps/cli/src/agent/runtime/session/turn/agentSessionTurnInvariant';
import { handleGrokPromptComplete } from '../../../plugins/grok/src/agent/acp/completion';
import { GROK_PROMPT_USAGE } from '../../../plugins/grok/src/agent/acp/usage';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from '../../../../apps/cli/src/agent/acp/runtime/publicSession/createPublicAcpSession';
import { resolveScopedUsageContributions, type ScopedUsageEventRow } from '../../../../apps/server/sources/app/usage/query/resolveScopedUsageContributions';
import { addUsageCost, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from '@happier-dev/protocol/usage/usageAggregation';

describe('public ACP prompt usage', () => {
  it.each(['prompt response', 'usage_update', 'both'] as const)('records %s accounting once after completion has settled the turn', async source => {
    await withTempDir('public-acp-late-usage-', async cwd => {
      // Captured QA-MUSE-GATEWAY-1116 prompt response, numeric metadata only.
      // Grok completes through its extension before returning this RPC summary.
      const response = { stopReason: 'end_turn', _meta: {
        totalTokens: 22089, inputTokens: 22040, outputTokens: 41, cachedReadTokens: 640, reasoningTokens: 35,
        usage: { inputTokens: 22040, outputTokens: 41, totalTokens: 22081, cachedReadTokens: 640,
          cacheCreationTokens: 0, reasoningTokens: 35, modelCalls: 1, apiDurationMs: 2527,
          costUsdTicks: 147009200, numTurns: 1 },
      } };
      const script = writeAcpTestAgentScript({ dir: cwd, fileName: 'late-usage.mjs', source: `
        import { createInterface } from 'node:readline';
        const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
        let prompt;
        let promptCount = 0;
        for await (const line of createInterface({ input: process.stdin })) {
          const request = JSON.parse(line);
          if (request.id === undefined) continue;
          if (request.method === 'initialize') send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
          else if (request.method === 'session/new') send({ id: request.id, result: { sessionId: 'native-session' } });
          else if (request.method === 'session/prompt') {
            prompt = request.id;
            promptCount++;
            send({ method: '_x.ai/session/prompt_complete', params: {
              sessionId: request.params.sessionId, promptId: request.params._meta.promptId, stopReason: 'end_turn',
            } });
          } else if (request.method === 'fixture/release') {
            send({ id: prompt, result: ${JSON.stringify(source !== 'usage_update' ? response : { stopReason: 'end_turn' })} });
            ${source !== 'prompt response' ? `send({ method: 'session/update', params: { sessionId: 'native-session', update: {
              sessionUpdate: 'usage_update', used: 22081, size: 128000,
              inputTokens: 22040 * promptCount, outputTokens: 41 * promptCount, totalTokens: 22081 * promptCount,
              cachedReadTokens: 640 * promptCount, cacheCreationTokens: 0, reasoningTokens: 35 * promptCount,
              cost: { amount: 0.01470092 * promptCount, currency: 'USD' },
            } } });` : ''}
            send({ id: request.id, result: {} });
          } else send({ id: request.id, result: {} });
        }
      ` });
      const dependencies: PublicAcpComposerDependencies = {
        pluginId: 'grok', agentId: 'grok', signal: new AbortController().signal, isCurrent: () => true,
        systemTools: { resolve: async () => ({ toolId: 'fixture', launch: {
          kind: 'binary', executablePath: process.execPath, args: [script],
        } }) },
        interactions: new TestInteractions(async () => { throw new Error('Unexpected interaction'); }),
        media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
        models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
      };
      const runtime = await createPublicAcpSession({ kind: 'create', sessionId: 'host', cwd }, {
        transport: { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture' } },
        definition: { usage: GROK_PROMPT_USAGE, mcp: { policy: 'pass_through' } },
        extensions: { notifications: { '_x.ai/session/prompt_complete': (params, context) => {
          handleGrokPromptComplete(params, context);
        } } },
      }, dependencies);
      const events: AgentSessionRuntimeEvent[] = [];
      const invariant = createAgentSessionTurnInvariant({ sessionId: 'host' });
      const rejected: unknown[] = [];
      const subscription = runtime.watch(event => {
        events.push(event);
        const observation = invariant.observe(event);
        if (observation.status === 'rejected') rejected.push(observation.diagnostic);
      });
      try {
        for (const turnId of ['first', 'second']) {
          await runtime.send({ inputIds: [turnId], input: { text: 'fixture' }, delivery: { kind: 'newTurn', turnId } });
          await expect.poll(() => events.some(event => event.kind === 'turn-complete' && event.turnId === turnId)).toBe(true);
          await runtime.requestExtension!('fixture/release', {});
          await expect.poll(() => events.filter(event => event.kind === 'usage-observed').length)
            .toBe((turnId === 'first' ? 1 : 2) * (source === 'both' ? 2 : 1));
        }
        const usage = events.filter(event => event.kind === 'usage-observed');
        const tokens = { input: 22040, output: 41, total: 22081, cacheRead: 640, cacheWrite: 0, reasoning: 35 };
        if (source !== 'usage_update') expect(usage.filter(event => event.scope === 'turn_delta'))
          .toEqual(['first', 'second'].map(turnId => expect.objectContaining({ turnId, tokens })));
        expect(usage.filter(event => event.scope === 'session_cumulative').every(event => !('turnId' in event))).toBe(true);
        const rows: ScopedUsageEventRow[] = usage.map(event => ({
          id: event.observationId, sessionId: event.sessionId, agentId: 'grok', source: event.source,
          observedAt: new Date(event.emittedAtMs), createdAt: new Date(event.emittedAtMs),
          scope: event.scope, isCumulative: event.scope !== 'turn_delta', turnId: event.turnId ?? null,
          tokens: event.tokens ?? createEmptyUsageTokens(), cost: event.cost ?? createEmptyUsageCost(),
          modelId: event.modelId ?? null, backendMode: null, projectKey: null, workspaceId: null,
          contextUsedTokens: event.context?.usedTokens ?? null, contextWindowTokens: event.context?.windowTokens ?? null,
          metadata: { usageAccounting: { path: 'runtime', runtimeEventOrder: {
            runtimeIncarnationId: 'fixture', sequence: event.sequence,
          } } },
        }));
        const recorded = resolveScopedUsageContributions(rows).totalContributions;
        expect(recorded.reduce((sum, event) => addUsageTokens(sum, event.tokens), createEmptyUsageTokens()))
          .toEqual({ input: 44080, output: 82, total: 44162, cacheRead: 1280, cacheWrite: 0, reasoning: 70 });
        expect(recorded.reduce((sum, event) => addUsageCost(sum, event.cost), createEmptyUsageCost()).reportedUsd)
          .toBeCloseTo(0.02940184, 10);
        expect(events.filter(event => event.kind === 'turn-complete')).toHaveLength(2);
        expect(rejected).toEqual([]);
      } finally {
        subscription.dispose();
        await runtime.dispose();
      }
    });
  });
});

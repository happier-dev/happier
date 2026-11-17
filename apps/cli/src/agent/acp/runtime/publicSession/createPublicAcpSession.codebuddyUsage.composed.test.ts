import { expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRuntimeContext, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createCodeBuddyAgentRuntime } from '../../../../../../../packages/plugins/codebuddy/src/agent/runtime/factory';
import { createCodeBuddyPromptUsage } from '../../../../../../../packages/plugins/codebuddy/src/agent/runtime/usage';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { buildUsageEventIngestRequest } from '@/usage/buildUsageEventIngestRequest';
import { deriveNativeUsageAccountingIdentity } from '@/usage/collector/nativeUsageAccountingIdentity';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createDeferred } from '@/testkit/async/deferred';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AgentMessage } from '@/agent/core';
import { createPublicAcpSession, type PublicAcpComposerDependencies } from './createPublicAcpSession';

it('accounts only the completed native CodeBuddy request, retains inference identity, and prefers direct ACP usage', async () => {
  await withTempDir('codebuddy-usage-', async directory => {
    const project = join(directory, 'projects', 'native-project'); mkdirSync(project, { recursive: true });
    const file = join(project, 'native-session.jsonl');
    const message = (request: string, id: string, input: number) => ({ type: 'message', role: 'assistant', id,
      sessionId: 'native-session', cwd: directory, providerData: { conversationRequestId: request, messageId: id,
        model: 'muse-spark-1.3-contributor', rawUsage: { prompt_tokens: input, completion_tokens: 550,
          total_tokens: input + 550, prompt_tokens_details: { cached_tokens: 113 }, completion_tokens_details: { reasoning_tokens: 505 } } },
      message: { usage: { input_tokens: input, output_tokens: 550, total_tokens: input + 550, cache_read_input_tokens: 113 } } });
    writeFileSync(file, JSON.stringify(message('prior-request', 'prior-message', 999999)) + '\n');
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'native.mjs', source: `
      import { createInterface } from 'node:readline';
      import { appendFileSync, unlinkSync } from 'node:fs';
      let turn = 0;
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line); if (request.id === undefined) continue;
        let result = {};
        if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };
        if (request.method === 'session/new') result = { sessionId: 'native-session' };
        if (request.method === 'session/prompt') {
          turn++;
          const requestId = 'request-' + turn, userMessageId = 'user-' + turn;
          appendFileSync(${JSON.stringify(file)}, JSON.stringify({ type: 'message', role: 'user', id: userMessageId,
            sessionId: 'native-session', cwd: ${JSON.stringify(directory)}, providerData: { conversationRequestId: requestId } }) + '\\n');
          if (turn < 3) {
            const row = ${JSON.stringify(message('CURRENT', 'CURRENT', 25197))};
            row.providerData.conversationRequestId = requestId; row.id = row.providerData.messageId = 'message-' + turn;
            appendFileSync(${JSON.stringify(file)}, JSON.stringify(row) + '\\n' + JSON.stringify(row) + '\\n');
            const tool = { ...row, type: 'function_call', providerData: { ...row.providerData,
              messageId: 'tool-message-' + turn, rawUsage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5,
                prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } } };
            appendFileSync(${JSON.stringify(file)}, JSON.stringify(tool) + '\\n');
          }
          result = { stopReason: 'end_turn', userMessageId, _meta: { 'codebuddy.ai/conversationRequestId': requestId },
            ...(turn === 2 ? { usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } } : {}) };
          if (turn === 4) unlinkSync(${JSON.stringify(file)});
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    const dependencies: PublicAcpComposerDependencies = {
      pluginId: 'happier.agent.codebuddy', agentId: 'codebuddy', signal: new AbortController().signal, isCurrent: () => true,
      systemTools: { resolve: async () => ({ toolId: 'codebuddy-cli', launch: {
        kind: 'binary', executablePath: process.execPath, args: [script], env: { CODEBUDDY_CONFIG_DIR: directory },
      } }) }, interactions: { async request() { throw new Error('Unexpected interaction'); } },
      media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
      models: { bind: () => ({ dispose() {} }) }, modes: { bind: () => ({ dispose() {} }) },
    };
    // Only the native process and Account/network services are substituted.
    const context = { services: { connectedAccounts: { getBinding: async () => null } }, protocols: { acp: {
      open: (request, options) => createPublicAcpSession(request, options, dependencies),
    } } } as unknown as AgentRuntimeContext;
    const session = await createCodeBuddyAgentRuntime().sessions!.open({ kind: 'create', sessionId: 'usage-session', cwd: directory }, context);
    const events: AgentSessionRuntimeEvent[] = [];
    const ingests: ReturnType<typeof buildUsageEventIngestRequest>[] = [];
    const sessionContext = { session: { services: { activeInput: { bind: () => ({ dispose() {} }) },
      models: dependencies.models, modes: dependencies.modes } } } as unknown as AgentSessionRuntimeContext;
    const witness = { authority: { serverId: 'home', accountId: 'account', machineId: 'machine' },
      storage: await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'test-device-key.json') }),
      agent: { pluginId: 'happier.agent.codebuddy', localId: 'codebuddy' }, sourceKey: 'codebuddy-test-source', nativeSessionId: 'native-session' };
    const identity = deriveNativeUsageAccountingIdentity({ ...witness, inferenceId: 'request-1' });
    const bridge = createNativeAgentSessionOperations(session, 'usage-session', undefined, undefined, {
      provider: 'codebuddy', accountingWitness: witness,
      publish: async input => { ingests.push(buildUsageEventIngestRequest({ sessionId: 'usage-session', ...input })); },
    }, undefined, undefined, { context: sessionContext, cwd: directory, connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false }, cancellation: { declared: false },
      configuration: { declared: false }, compaction: { capability: null } });
    const unsubscribe = bridge.subscribeRuntimeEvents(event => events.push(event));
    try {
      await bridge.sendTurnPrompt('first', { localId: 'input-1', turnId: 'host-turn-1' });
      await expect.poll(() => ingests.length).toBe(1);
      expect(ingests[0]).toMatchObject({ sessionId: 'usage-session', turnId: 'host-turn-1', scope: 'turn_delta',
        tokens: { input: 25200, output: 552, total: 25752, cacheRead: 113, reasoning: 505 },
        externalKey: identity.externalKey, metadata: { usageAccounting: { nativeSessionId: identity.nativeSessionKey,
          inferenceId: identity.externalKey, inputIncludesCache: true, outputIncludesReasoning: true } } });
      await bridge.sendTurnPrompt('second', { localId: 'input-2', turnId: 'host-turn-2' });
      await expect.poll(() => ingests.length).toBe(2);
      expect(ingests[1]).toMatchObject({ tokens: { input: 7, output: 2, total: 9 }, turnId: 'host-turn-2' });
      await bridge.sendTurnPrompt('third', { localId: 'input-3', turnId: 'host-turn-3' });
      await expect.poll(() => events.filter(event => event.kind === 'turn-complete').length).toBe(3);
      expect(ingests).toHaveLength(2);
      await bridge.sendTurnPrompt('journal-unavailable', { localId: 'input-4', turnId: 'host-turn-4' });
      await expect.poll(() => events.filter(event => event.kind === 'turn-complete').length).toBe(4);
      expect(ingests).toHaveLength(2);
    } finally { unsubscribe(); await bridge.resetOrDisposeRuntime('runtime_recovery'); }
  });
});

it('leaves usage unavailable when native journal reading is cancelled', async () => {
  await withTempDir('codebuddy-usage-cancel-', async directory => {
    mkdirSync(join(directory, 'projects', 'native-project'), { recursive: true });
    const controller = new AbortController();
    controller.abort(new Error('Native runtime ended'));
    await expect(createCodeBuddyPromptUsage().projectPromptUsage({ usage: null,
      promptResponse: { userMessageId: 'user', _meta: { 'codebuddy.ai/conversationRequestId': 'request' } },
      completion: { providerSessionId: 'native-session', env: { CODEBUDDY_CONFIG_DIR: directory }, signal: controller.signal },
    })).resolves.toBeNull();
  });
});

it('retains immutable usage from an asynchronous native completion after a later turn starts', async () => {
  await withTempDir('acp-async-usage-', async directory => {
    const script = writeAcpTestAgentScript({ dir: directory, fileName: 'agent.mjs', source: `
      import { createInterface } from 'node:readline';
      let turn = 0;
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line); if (request.id === undefined) continue;
        const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
          : request.method === 'session/new' ? { sessionId: 'native-async' }
          : request.method === 'session/prompt' ? { stopReason: 'end_turn', usage: { inputTokens: ++turn, outputTokens: 2 } } : {};
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      }
    ` });
    const entered = createDeferred(), release = createDeferred();
    const messages: AgentMessage[] = [];
    const backend = createAcpBackend({ agentName: 'fixture', cwd: directory, command: process.execPath, args: [script],
      // The public plugin projection is asynchronous; native transport and normalization stay real.
      projectPromptUsage: async ({ usage }) => {
        if (usage && typeof usage === 'object' && 'inputTokens' in usage && usage.inputTokens === 1) {
          entered.resolve(); await release.promise;
        }
        return usage;
      },
    });
    backend.onMessage(message => messages.push(message));
    try {
      await backend.startSession();
      const first = backend.sendPrompt('native-async', 'first', { metadata: { promptId: 'first-turn' } });
      await entered.promise;
      await backend.sendPrompt('native-async', 'second', { metadata: { promptId: 'second-turn' } });
      release.resolve(); await first;
      await expect.poll(() => messages.filter(message => message.type === 'token-count')).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: 'first-turn', tokens: expect.objectContaining({ input: 1, output: 2 }) }),
        expect.objectContaining({ turnId: 'second-turn', tokens: expect.objectContaining({ input: 2, output: 2 }) }),
      ]));
    } finally { release.resolve(); await backend.dispose(); }
  });
});

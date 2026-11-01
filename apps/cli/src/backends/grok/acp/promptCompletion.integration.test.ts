import { describe, expect, it } from 'vitest';

import { AcpBackend } from '@/agent/acp/AcpBackend';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { buildGrokExtensionHandlers } from './extensionHandlers';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createBasicSessionClientWithOverrides } from '@/testkit/backends/sessionFixtures';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import type { SessionTurnMutationV1 } from '@/api/session/mutations/sessionMutationTypes';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe('correlated ACP prompt completion', () => {
  it.each(['completion-retry', 'completion-error-retry', 'request-retry', 'request-reset'] as const)('retains provider limit category and retry timing through the primary turn lifecycle (%s)', async (failurePath) => {
    await withTempDir('happier-acp-limit-evidence-', async (dir) => {
      const resetAtMs = Date.now() + 120_000;
      const scriptPath = writeAcpTestAgentScript({ dir, fileName: 'quota-agent.cjs', source: `
        let buffer = '';
        const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
        process.stdin.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            const respond = result => send({ jsonrpc: '2.0', id: message.id, result });
            if (message.method === 'initialize') respond({ protocolVersion: 1, authMethods: [] });
            else if (message.method === 'session/new') respond({ sessionId: 'quota-session' });
            else if (message.method === 'session/prompt') {
              const evidence = { status: 429, ${failurePath === 'request-reset' ? `resetAt: ${resetAtMs}` : 'retryAfterMs: 120000'}, token: 'provider-secret-value' };
              if (${JSON.stringify(failurePath)}.startsWith('completion')) send({ jsonrpc: '2.0', method: 'x.ai/session/prompt_complete',
                params: { sessionId: 'quota-session', promptId: message.params._meta.promptId, stopReason: ${JSON.stringify(failurePath === 'completion-error-retry' ? 'error' : 'rate_limit')}, agentResult: evidence } });
              else send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Provider request rejected', data: evidence } });
            } else if (message.method === 'session/cancel') respond({});
          }
        });
      ` });
      const backend = new AcpBackend({ agentName: 'test', cwd: dir, command: process.execPath, args: [scriptPath],
        promptCompletion: { buildRequestMeta: ({ correlationId }) => ({ promptId: correlationId }) },
        extensionHandlers: buildGrokExtensionHandlers({}),
      });
      const mutations: SessionTurnMutationV1[] = [];
      const sessionTurnLifecycle = createSessionTurnLifecycle({ sessionId: 'quota-host-session',
        enqueueSessionTurn: async (mutation) => { mutations.push(mutation); } });
      const runtime = createTestAcpRuntime({ provider: 'grok', directory: dir,
        session: { ...createBasicSessionClientWithOverrides(), sessionTurnLifecycle },
        messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      try {
        await runtime.startOrLoad({});
        await sessionTurnLifecycle.beginTurn({ provider: 'grok' });
        runtime.beginTurn();
        const failure = await runtime.sendPrompt('continue').then(() => null, (error: unknown) => error);
        expect(failure).not.toBeNull();
        await runtime.failTurn(failure);
        await runtime.flushTurn();
        expect(mutations.filter((mutation) => mutation.action === 'fail')).toEqual([
          expect.objectContaining({ issue: expect.objectContaining({ source: 'usage_limit',
            usageLimit: expect.objectContaining({ limitCategory: 'rate_limit',
              ...(failurePath === 'request-reset' ? { resetAtMs } : { resetAtMs: null, retryAfterMs: 120_000 }),
            }),
          }) }),
        ]);
        expect(JSON.stringify(mutations)).not.toContain('provider-secret-value');
        expect(String(failure)).not.toContain('provider-secret-value');
      } finally { await runtime.reset(); }
    });
  }, 15_000);

  it('finalizes accepted provider completion through the canonical turn lifecycle', async () => {
    await withTempDir('happier-acp-xai-prompt-complete-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-xai-prompt-complete-agent.cjs',
        source: `
          let buffer = '';
          function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
          function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
          process.stdin.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const message = JSON.parse(line);
              if (message.method === 'initialize') {
                respond(message.id, { protocolVersion: 1, authMethods: [] });
              } else if (message.method === 'session/new') {
                respond(message.id, { sessionId: 'provider-session-1' });
              } else if (message.method === 'session/prompt') {
                const promptId = message.params?._meta?.promptId;
                send({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'provider-session-1',
                    update: {
                      sessionUpdate: 'plan_update',
                      plan: {
                        type: 'items',
                        planId: 'turn-plan',
                        entries: [{ content: 'Finish the turn', status: 'in_progress' }],
                      },
                    },
                  },
                });
                send({
                  jsonrpc: '2.0',
                  method: '_x.ai/session/prompt_complete',
                  params: { sessionId: 'provider-session-1', promptId, turnId: 1 },
                });
                setTimeout(() => respond(message.id, { stopReason: 'end_turn' }), 100);
              } else if (message.method === 'session/cancel') {
                respond(message.id, {});
              }
            }
          });
        `,
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        promptCompletion: {
          buildRequestMeta: ({ correlationId }) => ({ promptId: correlationId }),
        },
        extensionHandlers: buildGrokExtensionHandlers({}),
      });
      backend.setPlanStatePublisher(async () => {});

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'finish through provider completion');

        await expect(backend.waitForResponseComplete(1_000)).resolves.toEqual({
          kind: 'completed',
          stopReason: 'end_turn',
        });
        expect(backend.getLastTurnOutcome()).toEqual({
          kind: 'completed',
          stopReason: 'end_turn',
        });
        const internals = backend as unknown as { plans: { activeTurnCount: number } };
        expect(internals.plans.activeTurnCount).toBe(0);

        await new Promise((resolve) => setTimeout(resolve, 125));
        expect(backend.getLastTurnOutcome()).toEqual({
          kind: 'completed',
          stopReason: 'end_turn',
        });
        expect(internals.plans.activeTurnCount).toBe(0);
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('keeps an exactly completed turn stable when the provider process then exits abnormally before the prompt RPC responds', async () => {
    await withTempDir('happier-acp-xai-prompt-complete-exit-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-xai-prompt-complete-exit-agent.cjs',
        source: `
          let buffer = '';
          function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
          function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
          process.stdin.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const message = JSON.parse(line);
              if (message.method === 'initialize') {
                respond(message.id, { protocolVersion: 1, authMethods: [] });
              } else if (message.method === 'session/new') {
                respond(message.id, { sessionId: 'provider-session-1' });
              } else if (message.method === 'session/prompt') {
                const promptId = message.params?._meta?.promptId;
                send({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'provider-session-1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
                  },
                });
                send({
                  jsonrpc: '2.0',
                  method: 'x.ai/session/prompt_complete',
                  params: { sessionId: 'provider-session-1', promptId, stopReason: 'end_turn' },
                });
                setTimeout(() => process.exit(52), 25);
              } else if (message.method === 'session/cancel') {
                respond(message.id, {});
              }
            }
          });
        `,
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        promptCompletion: {
          buildRequestMeta: ({ correlationId }) => ({ promptId: correlationId }),
        },
        extensionHandlers: buildGrokExtensionHandlers({}),
      });
      const processFailureReported = new Promise<void>((resolve) => {
        backend.onMessage((message) => {
          if (message.type === 'status' && message.status === 'error' && message.detail === 'Exit code: 52') {
            resolve();
          }
        });
      });

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'complete before crashing');

        await expect(backend.waitForResponseComplete(1_000)).resolves.toEqual({
          kind: 'completed',
          stopReason: 'end_turn',
        });
        await processFailureReported;

        expect(backend.getLastTurnOutcome()).toEqual({
          kind: 'completed',
          stopReason: 'end_turn',
        });
        await expect(backend.waitForResponseComplete(100)).resolves.toBeUndefined();
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('surfaces provider completion errors instead of fabricating a successful end turn', async () => {
    await withTempDir('happier-acp-xai-prompt-error-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-xai-prompt-error-agent.cjs',
        source: `
          let buffer = '';
          function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
          function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
          process.stdin.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const message = JSON.parse(line);
              if (message.method === 'initialize') {
                respond(message.id, { protocolVersion: 1, authMethods: [] });
              } else if (message.method === 'session/new') {
                respond(message.id, { sessionId: 'provider-session-1' });
              } else if (message.method === 'session/prompt') {
                send({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'provider-session-1',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
                  },
                });
                send({
                  jsonrpc: '2.0',
                  method: 'x.ai/session/prompt_complete',
                  params: {
                    sessionId: 'provider-session-1',
                    promptId: message.params?._meta?.promptId,
                    stopReason: 'error',
                    agentResult: 'provider failed safely',
                  },
                });
              } else if (message.method === 'session/cancel') {
                respond(message.id, {});
              }
            }
          });
        `,
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        promptCompletion: {
          buildRequestMeta: ({ correlationId }) => ({ promptId: correlationId }),
        },
        extensionHandlers: buildGrokExtensionHandlers({}),
      });

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'fail through provider completion');
        await expect(backend.waitForResponseComplete(1_000)).rejects.toThrow('provider failed safely');
        expect(backend.getLastTurnOutcome()).toEqual(expect.objectContaining({ kind: 'failed' }));
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);

  it('does not let a delayed prior-prompt completion settle the active prompt', async () => {
    await withTempDir('happier-acp-xai-stale-prompt-complete-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'fake-xai-stale-prompt-complete-agent.cjs',
        source: `
          let buffer = '';
          let promptCount = 0;
          let firstPromptId = null;
          function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
          function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
          function update() {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'provider-session-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } },
              },
            });
          }
          process.stdin.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const message = JSON.parse(line);
              if (message.method === 'initialize') {
                respond(message.id, { protocolVersion: 1, authMethods: [] });
              } else if (message.method === 'session/new') {
                respond(message.id, { sessionId: 'provider-session-1' });
              } else if (message.method === 'session/prompt') {
                promptCount += 1;
                const promptId = message.params?._meta?.promptId || 'legacy-first-prompt';
                if (promptCount === 1) {
                  firstPromptId = promptId;
                  update();
                  setTimeout(() => respond(message.id, { stopReason: 'end_turn' }), 10);
                } else {
                  update();
                  setTimeout(() => {
                    send({
                      jsonrpc: '2.0',
                      method: 'x.ai/session/prompt_complete',
                      params: {
                        sessionId: 'provider-session-1',
                        promptId: firstPromptId,
                        turnId: 'delayed-prior-turn',
                      },
                    });
                  }, 25);
                }
              } else if (message.method === 'session/cancel') {
                respond(message.id, {});
              }
            }
          });
        `,
      });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        promptCompletion: {
          buildRequestMeta: ({ correlationId }) => ({ promptId: correlationId }),
        },
        extensionHandlers: buildGrokExtensionHandlers({}),
      });

      try {
        const started = await backend.startSession();
        await backend.sendPrompt(started.sessionId, 'first prompt');
        await expect(backend.waitForResponseComplete(1_000)).resolves.toEqual({
          kind: 'completed',
          stopReason: 'end_turn',
        });

        await backend.sendPrompt(started.sessionId, 'second prompt');
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(backend.getLastTurnOutcome()).toBeNull();
        await backend.cancel(started.sessionId);
      } finally {
        await backend.dispose().catch(() => {});
      }
    });
  }, 10_000);
});

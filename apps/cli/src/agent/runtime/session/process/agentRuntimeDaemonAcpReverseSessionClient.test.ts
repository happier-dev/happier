import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

import {
  applyChildAcpReverseOperation,
  openChildAcpReverseSession,
  resolveChildAcpExtensionCallbackResponse,
  type ChildAcpReverseSession,
} from './agentRuntimeDaemonAcpReverseSessionClient';
import type {
  PublicAcpSessionRuntime,
} from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import {
  createAgentRuntimeDaemonAcpCallbackRegistry,
  encodeAgentRuntimeDaemonAcpOptionsV1,
} from './agentRuntimeDaemonAcpReverseSessionOptions';

describe('applyChildAcpReverseOperation', () => {
  it('forwards one ordered history-method request to the child-side ACP dispatcher', async () => {
    const methods = ['x.ai/rewind/execute', '_x.ai/rewind/execute'] as const;
    const params = Object.freeze({
      sessionId: 'provider-1',
      targetPromptIndex: 4,
      force: true,
      mode: 'conversation_only',
    });
    const requestExtension = vi.fn(async () => ({ success: true }));
    const historySessionsById:
      ChildAcpReverseSession['historySessionsById'] = new Map([[
        'history-1',
        Object.freeze({
          getProviderSessionId: () => 'provider-1',
          requestExtension,
        }),
      ]]);
    const session = {
      historySessionsById,
    } as ChildAcpReverseSession;
    const operation = {
      kind: 'acp.historySession.requestExtension',
      effectId: 'effect-history',
      reverseSessionId: 'reverse-1',
      historySessionId: 'history-1',
      methods,
      params,
    } as unknown as Parameters<typeof applyChildAcpReverseOperation>[1];

    await expect(applyChildAcpReverseOperation(session, operation))
      .resolves.toEqual({ success: true });
    expect(requestExtension).toHaveBeenCalledOnce();
    expect(requestExtension).toHaveBeenCalledWith(methods, params, undefined);
  });

  it('does not fall back after an ambiguous history transport failure', async () => {
    const ambiguous = new Error('connection lost after send');
    const requestExtension = vi.fn(async () => {
      throw ambiguous;
    });
    const historySessionsById:
      ChildAcpReverseSession['historySessionsById'] = new Map([[
        'history-1',
        Object.freeze({
          getProviderSessionId: () => 'provider-1',
          requestExtension,
        }),
      ]]);
    const session = {
      historySessionsById,
    } as ChildAcpReverseSession;
    const operation = {
      kind: 'acp.historySession.requestExtension',
      effectId: 'effect-history',
      reverseSessionId: 'reverse-1',
      historySessionId: 'history-1',
      methods: ['x.ai/rewind/execute', '_x.ai/rewind/execute'],
      params: {},
    } as unknown as Parameters<typeof applyChildAcpReverseOperation>[1];

    await expect(applyChildAcpReverseOperation(session, operation)).rejects.toBe(ambiguous);
    expect(requestExtension).toHaveBeenCalledOnce();
  });

  it('fails closed with the canonical listener diagnostic when the daemon rejects an event', async () => {
    await withTempDir('happier-reverse-acp-listener-failure-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'reverse-listener-failure-agent.mjs',
        source: `
          import { createInterface } from 'node:readline';
          const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
          const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
          for await (const line of createInterface({ input: process.stdin })) {
            const request = JSON.parse(line);
            if (request.method === 'initialize') ok(request.id, {
              protocolVersion: 1,
              agentCapabilities: {},
              authMethods: [],
            });
            else if (request.method === 'session/new') {
              ok(request.id, { sessionId: 'provider-reverse-listener-failure' });
            } else if (request.method === 'session/cancel') ok(request.id, {});
            else if (request.id !== undefined) ok(request.id, {});
          }
        `,
      });
      const disposable = () => Object.freeze({ dispose() {} });
      const runtimeController = new AbortController();
      const resolveSystemTool = vi.fn(async () => {
        throw new Error('The daemon-carried child must not resolve executables');
      });
      const runtimeContext = {
        signal: runtimeController.signal,
        services: {
          exec: {
            systemTools: {
              resolve: resolveSystemTool,
            },
          },
          sessions: {
            current: {
              interactions: {
                async request() {
                  return Object.freeze({ kind: 'approval', status: 'cancelled' });
                },
              },
              media: {
                async registerSourceRoot() {
                  return Object.freeze({
                    async publishGenerated() {
                      return Object.freeze({ status: 'published' });
                    },
                    dispose() {},
                  });
                },
              },
            },
          },
        },
        session: {
          services: {
            models: {
              bind() {
                return disposable();
              },
            },
          },
        },
      } as unknown as AgentSessionRuntimeContext;
      const callbacks = createAgentRuntimeDaemonAcpCallbackRegistry();
      const requestDaemon = vi.fn(async () => {
        throw new Error('daemon event rejected');
      });
      const reverse = await openChildAcpReverseSession({
        reverseSessionId: 'reverse-listener-failure',
        request: {
          kind: 'create',
          sessionId: 'host-reverse-listener-failure',
          cwd: dir,
        },
        options: {
          ...encodeAgentRuntimeDaemonAcpOptionsV1({
            transport: {
              kind: 'stdio',
              executable: { kind: 'managedDependency', id: 'fixture-acp' },
            },
          }, callbacks),
          resolvedExecutable: {
            kind: 'managedDependency',
            dependencyId: 'fixture-acp',
            command: process.execPath,
            args: [scriptPath],
          },
        },
        runtimeContext,
        pluginId: 'acme.reverse-listener-failure',
        agentId: 'fixture-acp',
        isCurrent: () => true,
        requestDaemon,
      });

      try {
        await vi.waitFor(() => expect(requestDaemon).toHaveBeenCalledOnce());
        const rejectedEventPost = requestDaemon.mock.results[0]?.value;
        if (!rejectedEventPost) throw new Error('Expected the rejected event POST');
        await expect(rejectedEventPost).rejects.toThrow('daemon event rejected');
        await new Promise<void>((resolveTurn) => {
          setImmediate(resolveTurn);
        });
        await expect(reverse.runtime.send({
          inputIds: ['input-after-listener-failure'],
          input: { text: 'must not reach ACP' },
          delivery: {
            kind: 'newTurn',
            turnId: 'turn-after-listener-failure',
          },
        })).resolves.toMatchObject({
          status: 'unavailable',
          diagnostic: { code: 'agent_runtime_event_listener_failed' },
          retryable: false,
        });
      } finally {
        callbacks.dispose();
        await reverse.dispose();
      }
      expect(resolveSystemTool).not.toHaveBeenCalled();
    });
  });

  it('does not settle the child send effect before pre-response ACP events reach the daemon', async () => {
    await withTempDir('happier-reverse-acp-send-publication-', async (dir) => {
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'reverse-send-publication-agent.mjs',
        source: `
          import { createInterface } from 'node:readline';
          const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
          const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
          for await (const line of createInterface({ input: process.stdin })) {
            const request = JSON.parse(line);
            if (request.method === 'initialize') ok(request.id, {
              protocolVersion: 1,
              agentCapabilities: {},
              authMethods: [],
            });
            else if (request.method === 'session/new') {
              ok(request.id, { sessionId: 'provider-reverse-send-publication' });
            } else if (request.method === 'session/prompt') {
              const sessionId = request.params.sessionId;
              const update = (sessionUpdate) => send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: { sessionId, update: sessionUpdate },
              });
              update({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'before tool' },
              });
              update({
                sessionUpdate: 'tool_call',
                toolCallId: 'tool-before-response',
                title: 'Read',
                kind: 'read',
                status: 'in_progress',
                rawInput: { path: '/workspace/README.md' },
              });
              update({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tool-before-response',
                kind: 'read',
                status: 'completed',
                rawOutput: { text: 'contents' },
              });
              update({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'after tool' },
              });
              setTimeout(() => send({
                jsonrpc: '2.0',
                method: 'x.test/session/prompt_complete',
                params: {
                  sessionId,
                  promptId: request.params._meta.promptId,
                  stopReason: 'end_turn',
                },
              }), 25);
            } else if (request.method === 'session/cancel') ok(request.id, {});
            else if (request.id !== undefined) ok(request.id, {});
          }
        `,
      });
      const disposable = () => Object.freeze({ dispose() {} });
      const runtimeController = new AbortController();
      let releaseFirstTurnEvent = (): void => {};
      const firstTurnEventReleased = new Promise<void>((resolve) => {
        releaseFirstTurnEvent = resolve;
      });
      let firstTurnEventHeld = false;
      const forwardedEvents: Array<Readonly<{ kind: string }>> = [];
      const requestDaemon = vi.fn(async (operation: Readonly<{
        kind: string;
        event?: Readonly<{ kind: string }>;
        context?: unknown;
      }>) => {
        if (operation.kind === 'acp.callback.extension.notification') {
          return {
            completionEvidence: {
              providerSessionId: 'provider-reverse-send-publication',
              promptId: 'turn-send-publication',
              outcome: { kind: 'completed' },
            },
          };
        }
        if (operation.kind !== 'acp.session.event' || !operation.event) return null;
        forwardedEvents.push(operation.event);
        if (operation.event.kind === 'input-accepted') {
          firstTurnEventHeld = true;
          await firstTurnEventReleased;
        }
        return null;
      });
      const callbacks = createAgentRuntimeDaemonAcpCallbackRegistry();
      const reverse = await openChildAcpReverseSession({
        reverseSessionId: 'reverse-send-publication',
        request: {
          kind: 'create',
          sessionId: 'host-reverse-send-publication',
          cwd: dir,
        },
        options: {
          ...encodeAgentRuntimeDaemonAcpOptionsV1({
            transport: {
              kind: 'stdio',
              executable: { kind: 'managedDependency', id: 'fixture-acp' },
            },
            extensions: {
              notifications: {
                'x.test/session/prompt_complete': async () => {},
              },
            },
          }, callbacks),
          resolvedExecutable: {
            kind: 'managedDependency',
            dependencyId: 'fixture-acp',
            command: process.execPath,
            args: [scriptPath],
          },
        },
        runtimeContext: {
          signal: runtimeController.signal,
          services: {
            sessions: {
              current: {
                interactions: {
                  async request() {
                    return Object.freeze({ kind: 'approval', status: 'cancelled' });
                  },
                },
                media: {
                  async registerSourceRoot() {
                    return Object.freeze({
                      async publishGenerated() {
                        return Object.freeze({ status: 'published' });
                      },
                      dispose() {},
                    });
                  },
                },
              },
            },
          },
          session: {
            services: {
              models: {
                bind() {
                  return disposable();
                },
              },
            },
          },
        } as unknown as AgentSessionRuntimeContext,
        pluginId: 'acme.reverse-send-publication',
        agentId: 'fixture-acp',
        isCurrent: () => true,
        requestDaemon,
      });

      try {
        const sending = applyChildAcpReverseOperation(reverse, {
          kind: 'acp.session.send',
          effectId: 'effect-send-publication',
          reverseSessionId: 'reverse-send-publication',
          request: {
            inputIds: ['input-send-publication'],
            input: { text: 'stream before acknowledging' },
            delivery: { kind: 'newTurn', turnId: 'turn-send-publication' },
          },
        });
        await vi.waitFor(() => expect(firstTurnEventHeld).toBe(true)).catch(
          async () => {
            const sendState = await Promise.race([
              sending.then(
                (value) => ({ status: 'settled' as const, value }),
                (error) => ({
                  status: 'rejected' as const,
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
              new Promise<{ status: 'pending' }>((resolve) => {
                setImmediate(() => resolve({ status: 'pending' }));
              }),
            ]);
            const successorState = await reverse.runtime.send({
              inputIds: ['diagnostic-successor'],
              input: { text: 'diagnostic successor' },
              delivery: {
                kind: 'newTurn',
                turnId: 'diagnostic-successor-turn',
              },
            });
            throw new Error(JSON.stringify({
              sendState,
              successorState,
              forwardedEvents,
              requestKinds: requestDaemon.mock.calls.map(([operation]) =>
                ({ kind: operation.kind, context: operation.context })),
            }));
          },
        );
        await expect(Promise.race([
          sending.then(() => 'settled' as const),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
        ])).resolves.toBe('pending');

        releaseFirstTurnEvent();
        await expect(sending).resolves.toEqual({ status: 'admitted' });
        expect(forwardedEvents.map((event) => event.kind)).toEqual([
          'provider-session-id',
          'input-accepted',
          'turn-start',
          'message-delta',
          'tool-call',
          'tool-result',
          'message-delta',
          'turn-complete',
        ]);
      } finally {
        releaseFirstTurnEvent();
        callbacks.dispose();
        await reverse.dispose();
      }
    });
  });

  it('preserves generated-media capability through the reverse session', async () => {
    await withTempDir('happier-reverse-acp-generated-media-', async (dir) => {
      const mediaPath = join(dir, 'provider-session', 'images', 'generated.png');
      const scriptPath = writeAcpTestAgentScript({
        dir,
        fileName: 'reverse-generated-media-agent.mjs',
        source: `
          import { createInterface } from 'node:readline';
          const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
          const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
          for await (const line of createInterface({ input: process.stdin })) {
            const request = JSON.parse(line);
            if (request.method === 'initialize') ok(request.id, {
              protocolVersion: 1,
              agentCapabilities: {},
              authMethods: [],
            });
            else if (request.method === 'session/new') {
              ok(request.id, { sessionId: 'provider-reverse-generated-media' });
            } else if (request.method === 'session/prompt') {
              const sessionId = request.params.sessionId;
              const update = (sessionUpdate) => send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: { sessionId, update: sessionUpdate },
              });
              update({
                sessionUpdate: 'tool_call',
                toolCallId: 'generated-image-1',
                title: 'Generate image',
                status: 'in_progress',
                rawInput: { prompt: 'fixture' },
              });
              update({
                sessionUpdate: 'tool_call_update',
                toolCallId: 'generated-image-1',
                status: 'completed',
                rawOutput: {
                  type: 'ImageGen',
                  path: ${JSON.stringify(mediaPath)},
                  filename: 'generated.png',
                  session_folder: 'images',
                },
              });
              ok(request.id, { stopReason: 'end_turn' });
            } else if (request.method === 'session/cancel') ok(request.id, {});
            else if (request.id !== undefined) ok(request.id, {});
          }
        `,
      });
      const publishGenerated = vi.fn(async () => Object.freeze({
        status: 'published' as const,
      }));
      const registerSourceRoot = vi.fn(async () => Object.freeze({
        publishGenerated,
        dispose() {},
      }));
      const projector = vi.fn(() => Object.freeze([
        Object.freeze({ rootPath: dirname(mediaPath), path: mediaPath }),
      ]));
      const callbacks = createAgentRuntimeDaemonAcpCallbackRegistry();
      const encoded = encodeAgentRuntimeDaemonAcpOptionsV1({
        transport: {
          kind: 'stdio',
          executable: { kind: 'managedDependency', id: 'fixture-acp' },
        },
        definition: {
          mcp: { policy: 'drop' },
          generatedMedia: {
            projectTerminalOutput: projector,
          },
        },
      }, callbacks);
      const requestDaemon = vi.fn(async (operation: Readonly<{
        kind: string;
        callbackId?: string;
        input?: unknown;
      }>) => {
        if (operation.kind !== 'acp.callback.generatedMedia.projectTerminalOutput') {
          return null;
        }
        if (!operation.callbackId) throw new Error('Missing generated-media callback id');
        const callback = callbacks.get(
          'generatedMedia.projectTerminalOutput',
          operation.callbackId,
        ) as (input: unknown) => unknown;
        return callback(operation.input);
      });
      const reverse = await openChildAcpReverseSession({
        reverseSessionId: 'reverse-generated-media',
        request: {
          kind: 'create',
          sessionId: 'host-reverse-generated-media',
          cwd: dir,
        },
        options: {
          ...encoded,
          resolvedExecutable: {
            kind: 'managedDependency',
            dependencyId: 'fixture-acp',
            command: process.execPath,
            args: [scriptPath],
          },
        },
        runtimeContext: {
          signal: new AbortController().signal,
          services: {
            sessions: {
              current: {
                interactions: {
                  async request() {
                    return Object.freeze({ kind: 'approval', status: 'cancelled' });
                  },
                },
                media: {
                  registerSourceRoot,
                },
              },
            },
          },
          session: {
            services: {
              models: {
                bind() {
                  return Object.freeze({ dispose() {} });
                },
              },
            },
          },
        } as unknown as AgentSessionRuntimeContext,
        pluginId: 'acme.reverse-generated-media',
        agentId: 'fixture-acp',
        isCurrent: () => true,
        requestDaemon,
      });

      try {
        await expect(reverse.runtime.send({
          inputIds: ['input-generated-media'],
          input: { text: 'generate' },
          delivery: { kind: 'newTurn', turnId: 'turn-generated-media' },
        })).resolves.toEqual({ status: 'admitted' });
        await vi.waitFor(() => expect(registerSourceRoot).toHaveBeenCalledOnce());
        expect(projector).toHaveBeenCalledOnce();
        expect(registerSourceRoot).toHaveBeenCalledWith({
          rootPath: dirname(mediaPath),
        });
        expect(publishGenerated).toHaveBeenCalledOnce();
        expect(publishGenerated).toHaveBeenCalledWith(expect.objectContaining({
          path: mediaPath,
          toolCallId: 'generated-image-1',
        }));
      } finally {
        callbacks.dispose();
        await reverse.dispose();
      }
    });
  });

  it('threads cancellation into a held ACP history extension request', async () => {
    let observedSignal: AbortSignal | undefined;
    const requestExtension = vi.fn(async (
      _methods: readonly [string, ...string[]],
      _params: JsonValue,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
      observedSignal = options?.signal;
      return await new Promise<{ cancelled: boolean }>((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () => resolve({ cancelled: true }),
          { once: true },
        );
      });
    });
    const send: AgentSessionRuntime['send'] = async () => ({
      status: 'admitted',
    });
    const runtime: AgentSessionRuntime = Object.freeze({
      send,
      watch() {
        return { dispose() {} };
      },
      async dispose() {},
    });
    const methods: ChildAcpReverseSession['methods'] = new Set();
    const completionEvidence:
      ChildAcpReverseSession['completionEvidence'] = { current: null };
    const historySessionsById:
      ChildAcpReverseSession['historySessionsById'] = new Map([[
        'history-1',
        Object.freeze({
          getProviderSessionId: () => null,
          requestExtension,
        }),
      ]]);
    const session: ChildAcpReverseSession = Object.freeze({
      runtime,
      methods,
      completionEvidence,
      historySessionsById,
      async drainForwardedEvents() {},
      async dispose() {},
    });
    const controller = new AbortController();
    const operation = applyChildAcpReverseOperation(session, {
      kind: 'acp.historySession.requestExtension',
      effectId: 'effect-history',
      reverseSessionId: 'reverse-1',
      historySessionId: 'history-1',
      methods: ['x.test/read'],
      params: {},
    }, controller.signal);

    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort();

    await expect(operation).resolves.toEqual({ cancelled: true });
    expect(requestExtension).toHaveBeenCalledOnce();
  });

  it('applies callback-response completion evidence before returning the request value', async () => {
    const submit = vi.fn(() => true);
    const completionEvidenceState = {
      current: {
        id: 'evidence-1',
        turnId: 'turn-1',
        submit,
      },
    };
    const dispose = vi.fn(async () => undefined);
    const runtime = { dispose } as unknown as PublicAcpSessionRuntime;
    const completionEvidence = {
      providerSessionId: 'provider-1',
      promptId: 'turn-1',
      outcome: { kind: 'completed' as const },
    };

    await expect(resolveChildAcpExtensionCallbackResponse({
      wireContext: {
        method: 'x.test/completion',
        providerSessionId: 'provider-1',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'evidence-1',
        },
      },
      signal: new AbortController().signal,
      completionEvidence: completionEvidenceState,
      readRuntime: () => runtime,
      isCurrent: () => true,
      request: async () => ({
        value: { accepted: true },
        completionEvidence,
      }),
      parse: (value) => value as {
        value: { accepted: boolean };
        completionEvidence: typeof completionEvidence;
      },
    })).resolves.toEqual({
      value: { accepted: true },
      completionEvidence,
    });
    expect(submit).toHaveBeenCalledWith(completionEvidence);
    expect(completionEvidenceState.current).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each([
    ['transport rejection', async () => {
      throw new Error('callback transport failed');
    }, (value: unknown) => value as { completionEvidence: null }],
    ['malformed response', async () => ({ future: true }), () => {
      throw new Error('invalid callback response');
    }],
  ])('terminalizes a current-turn notification after %s', async (
    _name,
    request,
    parse,
  ) => {
    const dispose = vi.fn(async () => undefined);
    const runtime = { dispose } as unknown as PublicAcpSessionRuntime;
    await expect(resolveChildAcpExtensionCallbackResponse({
      wireContext: {
        method: 'x.test/completion',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'evidence-1',
        },
      },
      signal: new AbortController().signal,
      completionEvidence: { current: null },
      readRuntime: () => runtime,
      isCurrent: () => true,
      request,
      parse,
    })).rejects.toThrow();
    expect(dispose).toHaveBeenCalledWith('runtime_recovery');
  });

  it('acknowledges exact returned evidence after the retained local turn already settled normally', async () => {
    const submit = vi.fn(() => false);
    const dispose = vi.fn(async () => undefined);
    const runtime = { dispose } as unknown as PublicAcpSessionRuntime;
    const completionEvidence = {
      providerSessionId: 'provider-1',
      promptId: 'turn-1',
      outcome: { kind: 'completed' as const },
    };
    const completionEvidenceState = {
      current: {
        id: 'evidence-1',
        turnId: 'turn-1',
        submit,
      },
    };
    await expect(resolveChildAcpExtensionCallbackResponse({
      wireContext: {
        method: 'x.test/completion',
        providerSessionId: 'provider-1',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'evidence-1',
        },
      },
      signal: new AbortController().signal,
      completionEvidence: completionEvidenceState,
      readRuntime: () => runtime,
      isCurrent: () => true,
      request: async () => ({ completionEvidence }),
      parse: (value) => value as {
        completionEvidence: typeof completionEvidence;
      },
    })).resolves.toEqual({ completionEvidence });
    expect(submit).toHaveBeenCalledWith(completionEvidence);
    expect(completionEvidenceState.current).toBeNull();
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each([
    ['provider session', {
      providerSessionId: 'foreign-provider',
      promptId: 'turn-1',
      outcome: { kind: 'completed' as const },
    }],
    ['prompt', {
      providerSessionId: 'provider-1',
      promptId: 'foreign-turn',
      outcome: { kind: 'completed' as const },
    }],
  ])('rejects returned evidence with a mismatched %s identity', async (
    _identity,
    completionEvidence,
  ) => {
    const submit = vi.fn(() => true);
    const dispose = vi.fn(async () => undefined);
    const runtime = { dispose } as unknown as PublicAcpSessionRuntime;
    await expect(resolveChildAcpExtensionCallbackResponse({
      wireContext: {
        method: 'x.test/completion',
        providerSessionId: 'provider-1',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'evidence-1',
        },
      },
      signal: new AbortController().signal,
      completionEvidence: {
        current: {
          id: 'evidence-1',
          turnId: 'turn-1',
          submit,
        },
      },
      readRuntime: () => runtime,
      isCurrent: () => true,
      request: async () => ({ completionEvidence }),
      parse: (value) => value as {
        completionEvidence: typeof completionEvidence;
      },
    })).rejects.toThrow('rejected by the active turn');
    expect(submit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith('runtime_recovery');
  });

  it('does not apply completion evidence after callback cancellation', async () => {
    const submit = vi.fn(() => true);
    const dispose = vi.fn(async () => undefined);
    const runtime = { dispose } as unknown as PublicAcpSessionRuntime;
    const controller = new AbortController();
    const completionEvidence = {
      providerSessionId: 'provider-1',
      promptId: 'turn-1',
      outcome: { kind: 'completed' as const },
    };

    await expect(resolveChildAcpExtensionCallbackResponse({
      wireContext: {
        method: 'x.test/completion',
        providerSessionId: 'provider-1',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'evidence-1',
        },
      },
      signal: controller.signal,
      completionEvidence: {
        current: {
          id: 'evidence-1',
          turnId: 'turn-1',
          submit,
        },
      },
      readRuntime: () => runtime,
      isCurrent: () => true,
      request: async () => {
        controller.abort();
        return { completionEvidence };
      },
      parse: (value) => value as {
        completionEvidence: typeof completionEvidence;
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(submit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith('runtime_recovery');
  });

  it('rejects stale completion evidence after a successor turn owns the slot', async () => {
    const successorSubmit = vi.fn(() => true);
    const dispose = vi.fn(async () => undefined);
    const runtime = { dispose } as unknown as PublicAcpSessionRuntime;
    const completionEvidence = {
      providerSessionId: 'provider-1',
      promptId: 'turn-1',
      outcome: { kind: 'completed' as const },
    };

    await expect(resolveChildAcpExtensionCallbackResponse({
      wireContext: {
        method: 'x.test/completion',
        providerSessionId: 'provider-1',
        currentTurn: {
          turnId: 'turn-1',
          completionEvidenceId: 'evidence-1',
        },
      },
      signal: new AbortController().signal,
      completionEvidence: {
        current: {
          id: 'evidence-2',
          turnId: 'turn-2',
          submit: successorSubmit,
        },
      },
      readRuntime: () => runtime,
      isCurrent: () => true,
      request: async () => ({ completionEvidence }),
      parse: (value) => value as {
        completionEvidence: typeof completionEvidence;
      },
    })).rejects.toThrow('rejected by the active turn');
    expect(successorSubmit).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledWith('runtime_recovery');
  });

});

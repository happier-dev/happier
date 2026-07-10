import { describe, expect, it, vi } from 'vitest';

import type {
  ExecClientHandleV1,
  LoopbackWebSocketJsonClientV1,
  PluginContextV1,
  RuntimeEventV1,
} from '@happier-dev/plugin-sdk';

import {
  createAntigravityLocalharnessExecutionRunBackend,
  createAntigravityLocalharnessRuntimeFromContext,
  createAntigravityLocalharnessSessionRuntime,
  type AntigravityLocalharnessRuntimeDeps,
} from './sessionRuntime.js';
import { WEBSOCKET_FIXTURE } from '../__fixtures__/localharness-0.1.4.js';

type SentMessage = unknown;

function createFakeLoopbackHandle(): ExecClientHandleV1<LoopbackWebSocketJsonClientV1> & {
  emit(message: unknown): void;
  emitExit(result?: { exitCode?: number | null; signal?: string | null; stderr?: string }): void;
  sent: SentMessage[];
} {
  const listeners = new Set<(message: unknown) => void | Promise<void>>();
  const exitListeners = new Set<(result: { exitCode: number | null; signal: string | null; stdout: string; stderr: string }) => void>();
  const sent: SentMessage[] = [];
  return {
    sent,
    emit(message) {
      for (const listener of Array.from(listeners)) {
        void listener(message);
      }
    },
    emitExit(result = {}) {
      for (const listener of Array.from(exitListeners)) {
        listener({
          exitCode: result.exitCode ?? 1,
          signal: result.signal ?? null,
          stdout: '',
          stderr: result.stderr ?? '',
        });
      }
    },
    status: 'running',
    client: {
      closed: new Promise(() => undefined),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async sendJson(message) {
        sent.push(message);
      },
    },
    process: {
      pid: 123,
      exit: new Promise(() => undefined),
      async writeStdin() {
        return undefined;
      },
      kill() {
        return undefined;
      },
      async dispose() {
        return undefined;
      },
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
    async dispose() {
      return undefined;
    },
  };
}

function createDeps(
  overrides: Partial<AntigravityLocalharnessRuntimeDeps> = {},
): AntigravityLocalharnessRuntimeDeps & { handle: ReturnType<typeof createFakeLoopbackHandle> } {
  const handle = createFakeLoopbackHandle();
  return {
    handle,
    sessionId: 'session-1',
    cwd: '/repo',
    spawnClient: vi.fn(async () => handle),
    requestPermission: vi.fn(async () => ({ decision: 'denied' })),
    elicit: vi.fn(async () => ({ status: 'answered', answers: { answer: 'yes' } })),
    resolveCredentials: vi.fn(async () => ({ mode: 'api_key', apiKey: 'gemini-key' })),
    resolveMcpServers: vi.fn(async () => []),
    now: vi.fn(() => 10),
    ...overrides,
  };
}

function collectEvents(runtime: ReturnType<typeof createAntigravityLocalharnessSessionRuntime>): RuntimeEventV1[] {
  const events: RuntimeEventV1[] = [];
  runtime.events.subscribe((event) => {
    events.push(event);
  });
  return events;
}

describe('Antigravity localharness runtime', () => {
  it('preflights API key and Vertex credentials before spawning localharness', async () => {
    const noKey = createDeps({
      resolveCredentials: vi.fn(async () => ({ mode: 'api_key', apiKey: null })),
    });
    const noKeyRuntime = createAntigravityLocalharnessSessionRuntime(noKey);

    await expect(noKeyRuntime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.stringMatching(/api key/i),
    });
    expect(noKey.spawnClient).not.toHaveBeenCalled();

    const missingVertex = createDeps({
      resolveCredentials: vi.fn(async () => ({ mode: 'vertex', project: 'project-a', location: null })),
    });
    const vertexRuntime = createAntigravityLocalharnessSessionRuntime(missingVertex);

    await expect(vertexRuntime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.stringMatching(/vertex/i),
    });
    expect(missingVertex.spawnClient).not.toHaveBeenCalled();
  });

  it('starts the spawned loopback client, initializes the conversation, and maps protobuf-shaped events', async () => {
    const deps = createDeps({
      encodeInputConfig: vi.fn(() => new Uint8Array([1, 2, 3])),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events = collectEvents(runtime);

    await expect(runtime.send({ v: 1, text: 'read file' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(deps.spawnClient).toHaveBeenCalledWith(expect.objectContaining({
      launch: {
        kind: 'managed-installable',
        installableId: 'dep.antigravity.localharness',
        executableName: 'localharness',
        cwd: '/repo',
        sourcePreference: 'managed-first',
      },
      transport: expect.objectContaining({
        kind: 'spawned-loopback-websocket',
        handshake: expect.objectContaining({
          byteOrder: 'little-endian',
          requestFrames: [new Uint8Array([1, 2, 3])],
        }),
      }),
      protocol: expect.objectContaining({ kind: 'json-websocket' }),
    }));
    expect(deps.encodeInputConfig).toHaveBeenCalledWith(expect.objectContaining({
      storageDirectory: '',
      clientInfo: {
        language: 'happier',
        version: '0.0.0',
        languageVersion: 'typescript',
      },
    }));

    expect(deps.handle.sent).toEqual([
      expect.objectContaining({ config: expect.any(Object) }),
      { userInput: 'read file' },
    ]);

    deps.handle.emit(WEBSOCKET_FIXTURE.outputConversationStep);
    deps.handle.emit(WEBSOCKET_FIXTURE.outputMcpTool);
    deps.handle.emit(WEBSOCKET_FIXTURE.outputUsage);
    deps.handle.emit(WEBSOCKET_FIXTURE.outputIdle);

    expect(runtime.identity.read()).toEqual({ providerSessionId: 'conv-1' });
    expect(events.map((event) => event.kind)).toEqual([
      'turn-start',
      'session-id-publish',
      'message-delta',
      'message-delta',
      'tool-call',
      'token-count',
      'turn-complete',
    ]);
    expect(events[2]).toMatchObject({ delta: { text: 'Hello' } });
    expect(events[3]).toMatchObject({ delta: { text: 'Plan', thinking: true } });
    expect(events[4]).toMatchObject({
      toolCallId: 'traj-1:5',
      toolName: 'mcp__fs__read',
      toolInput: { path: 'a.txt' },
    });
    expect(events[5]).toMatchObject({ totals: { input: 3, output: 4, total: 7 } });
  });

  it('confirms provider acceptance only after localharness emits turn evidence', async () => {
    const deps = createDeps({
      encodeInputConfig: vi.fn(() => new Uint8Array([1, 2, 3])),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const accepted = vi.fn();

    runtime.setOnPromptAcceptedByProvider?.(accepted);

    await expect(runtime.send({ v: 1, text: 'read file' }, {
      turnId: 'turn-1',
      localInputId: 'local-1',
      localInputIds: ['local-1', 'local-2'],
      userMessageSeq: 12,
      userMessageSeqs: [12, 13],
    })).resolves.toMatchObject({
      status: 'accepted',
    });

    expect(accepted).not.toHaveBeenCalled();

    deps.handle.emit(WEBSOCKET_FIXTURE.outputConversationStep);

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith({
      localInputId: 'local-1',
      localInputIds: ['local-1', 'local-2'],
      userMessageSeq: 12,
      userMessageSeqs: [12, 13],
    });

    deps.handle.emit(WEBSOCKET_FIXTURE.outputMcpTool);
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('fails idle-only turns instead of completing without transcript evidence', async () => {
    const deps = createDeps({
      encodeInputConfig: vi.fn(() => new Uint8Array([1, 2, 3])),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events = collectEvents(runtime);

    await expect(runtime.send({ v: 1, text: 'empty' }, { turnId: 'turn-1' })).resolves.toMatchObject({
      status: 'accepted',
    });

    deps.handle.emit(WEBSOCKET_FIXTURE.outputIdle);

    expect(events.map((event) => event.kind)).toEqual([
      'turn-start',
      'turn-failed',
    ]);
    expect(events[1]).toMatchObject({
      kind: 'turn-failed',
      turnId: 'turn-1',
      issue: {
        code: 'antigravity_localharness_empty_response',
        source: 'agent_status_error',
      },
    });
  });

  it('rejects unsupported MCP transports before spawning localharness', async () => {
    const deps = createDeps({
      resolveMcpServers: vi.fn(async () => [
        {
          id: 'stdio-id',
          name: 'stdio-server',
          transport: { kind: 'stdio' },
          scope: { sessionId: 'session-1' },
        },
      ]),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);

    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.stringContaining('stdio-server'),
    });
    expect(deps.spawnClient).not.toHaveBeenCalled();
  });

  it('debounces duplicate tool confirmations and user questions', async () => {
    const deps = createDeps({
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
      elicit: vi.fn(async () => ({
        status: 'answered',
        answers: [
          { multipleChoiceAnswer: { selectedChoiceIndices: [0] } },
        ],
      })),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);

    await runtime.send({ v: 1, text: 'edit' }, { turnId: 'turn-1' });
    deps.handle.emit(WEBSOCKET_FIXTURE.outputToolConfirmation);
    deps.handle.emit(WEBSOCKET_FIXTURE.outputToolConfirmation);
    deps.handle.emit(WEBSOCKET_FIXTURE.outputQuestions);
    deps.handle.emit(WEBSOCKET_FIXTURE.outputQuestions);
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.elicit).toHaveBeenCalledTimes(1);
    expect(deps.handle.sent.slice(2)).toEqual([
      expect.objectContaining({
        toolConfirmation: {
          trajectoryId: 'traj-1',
          stepIndex: 2,
          accepted: false,
        },
      }),
      expect.objectContaining({
        questionResponse: {
          trajectoryId: 'traj-1',
          stepIndex: 3,
          response: {
            answers: [
              { multipleChoiceAnswer: { selectedChoiceIndices: [0] } },
            ],
          },
        },
      }),
    ]);
  });

  it('fails closed for custom client tools and forbidden production paths', async () => {
    const deps = createDeps({
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events = collectEvents(runtime);

    await runtime.send({ v: 1, text: 'custom tool' }, { turnId: 'turn-1' });
    deps.handle.emit(WEBSOCKET_FIXTURE.outputCustomTool);
    await Promise.resolve();

    expect(deps.handle.sent).toContainEqual(expect.objectContaining({
      toolResponse: expect.objectContaining({
        id: 'call-1',
        responseJson: expect.stringMatching(/unsupported_client_tool/),
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'tool-result',
      toolCallId: 'call-1',
      isError: true,
    }));
  });

  it('tears down on cancel without claiming a provider-side cancel acknowledgement', async () => {
    const deps = createDeps({
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);

    await runtime.send({ v: 1, text: 'cancel me' }, { turnId: 'turn-1' });

    await expect(runtime.cancel?.({ reason: 'user' })).resolves.toEqual({
      status: 'unavailable',
      diagnostic: expect.stringMatching(/ack/i),
    });
    expect(deps.handle.sent).toContainEqual(expect.objectContaining({
      haltRequest: true,
    }));
  });

  it('maps sidecar exit during an active turn to a typed turn failure and releases the handle', async () => {
    const deps = createDeps({
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });
    const runtime = createAntigravityLocalharnessSessionRuntime(deps);
    const events = collectEvents(runtime);

    await runtime.send({ v: 1, text: 'crash me' }, { turnId: 'turn-1' });
    deps.handle.emitExit({ exitCode: 1, stderr: 'boom' });

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'turn-failed',
      turnId: 'turn-1',
      issue: expect.objectContaining({
        code: 'sidecar_exited',
        source: 'agent_status_error',
        sanitizedPreview: expect.stringContaining('exit code 1'),
      }),
    }));
    await expect(runtime.send({ v: 1, text: 'after restart' }, { turnId: 'turn-2' })).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(deps.spawnClient).toHaveBeenCalledTimes(2);
  });

  it('uses the execution-run host adapter instead of a hand-rolled run-only backend', () => {
    const backend = createAntigravityLocalharnessExecutionRunBackend({
      ctx: {
        agentRuntime: { exec: { spawnClient: vi.fn() } },
        auth: { services: { materialize: vi.fn(async () => null) } },
        sessions: {
          current: {
            sessionId: 'session-1',
            permissions: { requestDecision: vi.fn() },
            mcp: { elicit: vi.fn() },
          },
        },
        mcp: { resolveForSession: vi.fn(async () => []) },
      } as unknown as PluginContextV1,
      executionRunParams: { cwd: '/repo' },
    });

    expect(backend).toMatchObject({
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      subscribeMessages: expect.any(Function),
    });
    expect(backend).not.toHaveProperty('run');
  });

  it('materializes connected Gemini service env before falling back to explicit session env', async () => {
    const materialize = vi.fn(async () => ({ env: { GEMINI_API_KEY: 'connected-key' } }));
    const handle = createFakeLoopbackHandle();
    const spawnClient = vi.fn(async () => handle);
    const runtime = createAntigravityLocalharnessRuntimeFromContext({
      ctx: {
        agentRuntime: { exec: { spawnClient } },
        auth: { services: { materialize } },
        sessions: {
          current: {
            sessionId: 'session-1',
            permissions: { requestDecision: vi.fn(async () => ({ decision: 'denied' })) },
            mcp: { elicit: vi.fn(async () => ({ status: 'answered' })) },
          },
        },
        mcp: { resolveForSession: vi.fn(async () => []) },
      },
      sessionParams: {
        cwd: '/repo',
        env: { GEMINI_API_KEY: 'explicit-key' },
      },
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });

    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({ status: 'accepted' });

    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: 'gemini',
    }));
    expect(spawnClient).toHaveBeenCalled();
    expect(handle.sent[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        models: [expect.objectContaining({
          geminiApiEndpoint: expect.objectContaining({
            apiKey: 'connected-key',
          }),
        })],
      }),
    }));
  });

  it('serializes selected Gemini display labels as 0.1.4 localharness models for API-key credentials', async () => {
    const handle = createFakeLoopbackHandle();
    const spawnClient = vi.fn(async () => handle);
    const runtime = createAntigravityLocalharnessRuntimeFromContext({
      ctx: {
        agentRuntime: { exec: { spawnClient } },
        sessions: {
          current: {
            sessionId: 'session-1',
            permissions: { requestDecision: vi.fn(async () => ({ decision: 'denied' })) },
            mcp: { elicit: vi.fn(async () => ({ status: 'answered' })) },
          },
        },
        mcp: { resolveForSession: vi.fn(async () => []) },
      },
      sessionParams: {
        cwd: '/repo',
        env: { GEMINI_API_KEY: 'explicit-key' },
        modelId: 'Gemini 3.1 Pro (High)',
      },
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });

    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({ status: 'accepted' });

    expect(handle.sent[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        models: [{
          name: 'gemini-3.1-pro',
          types: ['text'],
          geminiApiEndpoint: {
            apiKey: 'explicit-key',
            options: {
              thinkingLevel: 'high',
            },
          },
        }],
      }),
    }));
    expect(handle.sent[0]).not.toEqual(expect.objectContaining({
      config: expect.objectContaining({
        geminiConfig: expect.anything(),
      }),
    }));
  });

  it('serializes raw Gemini model ids without model options when no thinking level is selected', async () => {
    const handle = createFakeLoopbackHandle();
    const spawnClient = vi.fn(async () => handle);
    const runtime = createAntigravityLocalharnessRuntimeFromContext({
      ctx: {
        agentRuntime: { exec: { spawnClient } },
        sessions: {
          current: {
            sessionId: 'session-1',
            permissions: { requestDecision: vi.fn(async () => ({ decision: 'denied' })) },
            mcp: { elicit: vi.fn(async () => ({ status: 'answered' })) },
          },
        },
        mcp: { resolveForSession: vi.fn(async () => []) },
      },
      sessionParams: {
        cwd: '/repo',
        env: { GEMINI_API_KEY: 'explicit-key' },
        modelId: 'gemini-3.5-flash',
      },
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });

    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({ status: 'accepted' });

    expect(handle.sent[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        models: [{
          name: 'gemini-3.5-flash',
          types: ['text'],
          geminiApiEndpoint: {
            apiKey: 'explicit-key',
          },
        }],
      }),
    }));
  });

  it('serializes selected Gemini display labels as 0.1.4 localharness models for Vertex credentials', async () => {
    const handle = createFakeLoopbackHandle();
    const spawnClient = vi.fn(async () => handle);
    const runtime = createAntigravityLocalharnessRuntimeFromContext({
      ctx: {
        agentRuntime: { exec: { spawnClient } },
        sessions: {
          current: {
            sessionId: 'session-1',
            permissions: { requestDecision: vi.fn(async () => ({ decision: 'denied' })) },
            mcp: { elicit: vi.fn(async () => ({ status: 'answered' })) },
          },
        },
        mcp: { resolveForSession: vi.fn(async () => []) },
      },
      sessionParams: {
        cwd: '/repo',
        env: {
          ANTIGRAVITY_AUTH_MODE: 'vertex',
          GOOGLE_CLOUD_PROJECT: 'project-a',
          GOOGLE_CLOUD_LOCATION: 'us-central1',
        },
        modelId: 'Gemini 3.5 Flash (Low)',
      },
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });

    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({ status: 'accepted' });

    expect(handle.sent[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({
        models: [{
          name: 'gemini-3.5-flash',
          types: ['text'],
          vertexEndpoint: {
            project: 'project-a',
            location: 'us-central1',
            options: {
              thinkingLevel: 'low',
            },
          },
        }],
      }),
    }));
  });

  it('rejects CLI-only model labels before spawning localharness', async () => {
    const handle = createFakeLoopbackHandle();
    const spawnClient = vi.fn(async () => handle);
    const runtime = createAntigravityLocalharnessRuntimeFromContext({
      ctx: {
        agentRuntime: { exec: { spawnClient } },
        sessions: {
          current: {
            sessionId: 'session-1',
            permissions: { requestDecision: vi.fn(async () => ({ decision: 'denied' })) },
            mcp: { elicit: vi.fn(async () => ({ status: 'answered' })) },
          },
        },
        mcp: { resolveForSession: vi.fn(async () => []) },
      },
      sessionParams: {
        cwd: '/repo',
        env: { GEMINI_API_KEY: 'explicit-key' },
        modelId: 'Claude Sonnet 4.6 (Thinking)',
      },
      encodeInputConfig: vi.fn(() => new Uint8Array([1])),
    });

    await expect(runtime.send({ v: 1, text: 'hello' })).resolves.toMatchObject({
      status: 'rejected',
      diagnostic: expect.stringMatching(/sdk.*gemini/i),
    });
    expect(spawnClient).not.toHaveBeenCalled();
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controlClientMock = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  dispatchDaemonAgentRuntimeBridgeRequest: controlClientMock.dispatch,
}));

import {
  tryCreateDaemonAgentRuntimeCarrier,
  tryCreateDaemonSessionModelTransitionProviderAuthorizer,
} from './agentRuntimeDaemonBridgeClient';
import { HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY } from './agentRuntimeDaemonBridgeProtocol';

type PollResult = Readonly<{
  events: readonly AgentSessionRuntimeEvent[];
  effects: readonly unknown[];
}>;

describe('daemon Agent runtime carrier session replacement', () => {
  let root = '';
  let tokenFilePath = '';
  let pollResolvers: Array<(result: PollResult) => void> = [];
  let sessionDisposeError: Error | null = null;

  beforeEach(async () => {
    controlClientMock.dispatch.mockReset();
    pollResolvers = [];
    sessionDisposeError = null;
    root = await mkdtemp(join(tmpdir(), 'happier-runtime-carrier-replacement-'));
    tokenFilePath = join(root, 'handoff.json');
    await writeFile(tokenFilePath, JSON.stringify({
      v: 1,
      token: 'bridge-token',
      descriptor: {
        v: 1,
        pluginId: 'happier.agent.replacement-fixture',
        pluginVersion: '1.2.3',
        agentId: 'replacement-fixture',
        backendId: 'replacement-fixture',
        generation: 'generation-1',
        runtimeSurfaces: {
          terminal: true,
          realtimeConversation: {
            providers: [{
              identity: {
                pluginId: 'happier.agent.replacement-fixture',
                localId: 'realtime-fixture',
              },
              manifestDigest: 'manifest:realtime-fixture',
              generation: 'voice-generation-1',
              declaration: {
                id: 'realtime-fixture',
                title: 'Realtime fixture',
                kind: 'conversation',
                roles: ['realtime_conversation'],
                platforms: ['web'],
                capabilities: {
                  readiness: { requirements: [] },
                  turn: { cancelResponse: false, bargeIn: false },
                },
                execution: {
                  kind: 'experimental_agent_session_realtime',
                  agent: {
                    pluginId: 'happier.agent.replacement-fixture',
                    localId: 'replacement-fixture',
                  },
                },
                settings: {
                  schemaVersion: 2,
                  fields: [],
                  connectedServicesBinding: {
                    id: 'account',
                    title: 'Account',
                    agent: {
                      pluginId: 'happier.agent.replacement-fixture',
                      localId: 'replacement-fixture',
                    },
                    serviceIds: ['openai-codex'],
                  },
                },
                client: {
                  artifactId: 'realtime-fixture',
                  modulePath: './voice',
                  exportName: 'activate',
                },
              },
            }],
          },
        },
        factoryControls: {
          continuation: false,
          goals: false,
          catalog: false,
          usageLimitRecovery: false,
        },
      },
    }), 'utf8');
    controlClientMock.dispatch.mockImplementation(async (request) => {
      switch (request.operation.kind) {
        case 'factory.prepare':
          return { ok: true, result: { controls: [] } };
        case 'session.open':
          return { ok: true, result: { methods: [] } };
        case 'session.send':
          return { ok: true, result: { status: 'admitted' } };
        case 'runtime.terminal.resolveLaunch':
          return {
            ok: true,
            result: {
              argv: ['agy', '--terminal'],
              environment: {
                values: { ANTIGRAVITY_SESSION: 'provider-session-1' },
                unset: [],
              },
            },
          };
        case 'runtime.realtimeConversation.inspect':
          return {
            ok: true,
            result: {
              status: 'available',
              transport: 'webrtc',
            },
          };
        case 'runtime.realtimeConversation.start':
          return {
            ok: true,
            result: {
              status: 'started',
              transport: {
                kind: 'webrtc',
                answerSdp: 'v=0\r\na=answer:daemon-carrier\r\n',
              },
              handleId: 'realtime-handle-1',
            },
          };
        case 'runtime.realtimeConversation.handle.watch':
          return {
            ok: true,
            result: {
              kind: 'terminal',
              reason: 'upstream_closed',
            },
          };
        case 'runtime.realtimeConversation.handle.stop':
          return {
            ok: true,
            result: { status: 'already_stopped' },
          };
        case 'runtime.realtimeConversation.handle.dispose':
          return { ok: true, result: null };
        case 'session.dispose':
          if (sessionDisposeError) throw sessionDisposeError;
          return { ok: true, result: null };
        case 'channel.poll':
          return await new Promise((resolve) => {
            pollResolvers.push((result) => resolve({ ok: true, result }));
          });
        default:
          throw new Error(`Unexpected daemon bridge operation: ${request.operation.kind}`);
      }
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retries only initial prepare while daemon spawn custody is settling', async () => {
    const dispatch = controlClientMock.dispatch.getMockImplementation();
    if (!dispatch) throw new Error('Expected daemon bridge fixture dispatcher');
    let prepareAttempts = 0;
    controlClientMock.dispatch.mockImplementation(async (...args) => {
      const request = args[0];
      if (
        request.operation.kind === 'factory.prepare'
        && prepareAttempts++ === 0
      ) {
        return {
          ok: false,
          error: {
            code: 'agent_runtime_daemon_bridge_forbidden',
            message: 'Agent runtime daemon bridge request is forbidden',
          },
        };
      }
      return await dispatch(...args);
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected daemon Agent runtime sessions');
    }
    const runtime = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-1',
      cwd: root,
    }, {
      signal: new AbortController().signal,
      session: {
        services: {
          features: {
            isEnabled: () => false,
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext);

    expect(prepareAttempts).toBe(2);
    expect(controlClientMock.dispatch.mock.calls.filter(
      ([request]) => request.operation.kind === 'session.open',
    )).toHaveLength(1);
    await runtime.dispose('session_closed');
  });

  it('keeps one exact carrier fenced against an unrelated second session', async () => {
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected daemon Agent runtime sessions');
    }
    const runtimeContext = {
      signal: new AbortController().signal,
      session: {
        services: {
          features: {
            isEnabled: () => false,
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const first = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-exact-owner',
      cwd: root,
    }, runtimeContext);

    await expect(carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-unrelated',
      cwd: root,
    }, runtimeContext)).rejects.toThrow(
      'Daemon Agent runtime carrier cannot prepare multiple sessions',
    );
    expect(controlClientMock.dispatch.mock.calls.filter(
      ([request]) => request.operation.kind === 'factory.prepare',
    )).toHaveLength(1);
    expect(controlClientMock.dispatch.mock.calls.filter(
      ([request]) => request.operation.kind === 'session.open',
    )).toHaveLength(1);

    await first.dispose('session_closed');
  });

  it('proxies the declared terminal launch surface through the daemon carrier', async () => {
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    const terminal = carrier?.runtime.surfaces?.terminal;
    if (!terminal) throw new Error('Expected daemon Agent runtime terminal surface');

    await expect(terminal.resolveLaunch({
      sessionId: 'host-session-1',
      cwd: root,
      metadata: { providerSessionId: 'provider-session-1' },
    })).resolves.toEqual({
      argv: ['agy', '--terminal'],
      environment: {
        values: { ANTIGRAVITY_SESSION: 'provider-session-1' },
        unset: [],
      },
    });
    expect(controlClientMock.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      operation: {
        kind: 'runtime.terminal.resolveLaunch',
        requestId: expect.any(String),
        request: {
          sessionId: 'host-session-1',
          cwd: root,
          metadata: { providerSessionId: 'provider-session-1' },
        },
      },
    }), expect.any(Object));
  });

  it('proxies the declared realtime conversation lifecycle through the daemon carrier', async () => {
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected daemon Agent runtime sessions');
    }
    const runtime = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-realtime',
      cwd: root,
    }, {
      signal: new AbortController().signal,
      session: {
        services: {
          features: {
            isEnabled: () => false,
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext);
    const provider = {
      pluginId: 'happier.agent.replacement-fixture',
      localId: 'realtime-fixture',
    } as const;
    const realtime =
      carrier.agentSessionRealtimeVoiceAuthority?.resolveConversation({
        provider,
        runtime,
      })?.conversation;

    expect(realtime).toBeDefined();
    await expect(realtime?.inspect()).resolves.toEqual({
      status: 'available',
      transport: 'webrtc',
    });
    const started = await realtime?.start({
      transport: {
        kind: 'webrtc',
        offerSdp: 'v=0\r\na=offer:daemon-carrier\r\n',
      },
    });
    expect(started).toMatchObject({
      status: 'started',
      transport: {
        kind: 'webrtc',
        answerSdp: 'v=0\r\na=answer:daemon-carrier\r\n',
      },
    });
    if (started?.status !== 'started' || !started.handle) {
      throw new Error('Expected bridged realtime handle');
    }
    const terminal = new Promise((resolve) => {
      started.handle!.watch(resolve);
    });
    await expect(terminal).resolves.toEqual({
      kind: 'terminal',
      reason: 'upstream_closed',
    });
    await expect(started.handle.stop()).resolves.toEqual({
      status: 'already_stopped',
    });
    await expect(started.handle.dispose()).resolves.toBeUndefined();
    expect(controlClientMock.dispatch.mock.calls.map(
      ([request]) => request.operation.kind,
    )).toEqual(expect.arrayContaining([
      'runtime.realtimeConversation.inspect',
      'runtime.realtimeConversation.start',
      'runtime.realtimeConversation.handle.watch',
      'runtime.realtimeConversation.handle.stop',
      'runtime.realtimeConversation.handle.dispose',
    ]));

    const baseDispatch = controlClientMock.dispatch.getMockImplementation();
    if (!baseDispatch) throw new Error('Expected daemon bridge mock');
    let releaseRemoteDispose!: () => void;
    const remoteDisposeGate = new Promise<void>((resolve) => {
      releaseRemoteDispose = resolve;
    });
    controlClientMock.dispatch.mockImplementation(async (request, options) => {
      if (
        request.operation.kind
          === 'runtime.realtimeConversation.handle.watch'
      ) {
        return await new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      }
      if (
        request.operation.kind
          === 'runtime.realtimeConversation.handle.dispose'
      ) {
        await remoteDisposeGate;
        return { ok: true, result: null };
      }
      if (
        request.operation.kind
          === 'runtime.realtimeConversation.handle.stop'
      ) {
        return {
          ok: true,
          result: { status: 'stopped' },
        };
      }
      return await baseDispatch(request, options);
    });
    const stoppedStarted = await realtime?.start({
      transport: {
        kind: 'webrtc',
        offerSdp: 'v=0\r\na=offer:stopped-before-dispose\r\n',
      },
    });
    if (stoppedStarted?.status !== 'started') {
      throw new Error('Expected stopped-terminal realtime handle');
    }
    const stoppedTerminalListener = vi.fn();
    const stoppedTerminal = new Promise((resolve) => {
      stoppedStarted.handle.watch((event) => {
        stoppedTerminalListener(event);
        resolve(event);
      });
    });
    await expect(stoppedStarted.handle.stop()).resolves.toEqual({
      status: 'stopped',
    });
    const stoppedDisposing = stoppedStarted.handle.dispose();
    await expect(stoppedTerminal).resolves.toEqual({
      kind: 'terminal',
      reason: 'stopped',
    });
    expect(stoppedTerminalListener).toHaveBeenCalledTimes(1);

    const disposingStarted = await realtime?.start({
      transport: {
        kind: 'webrtc',
        offerSdp: 'v=0\r\na=offer:dispose-order\r\n',
      },
    });
    if (disposingStarted?.status !== 'started') {
      throw new Error('Expected disposal-order realtime handle');
    }
    const terminalListener = vi.fn();
    const disposeTerminal = new Promise((resolve) => {
      disposingStarted.handle.watch((event) => {
        terminalListener(event);
        resolve(event);
      });
    });
    const disposing = disposingStarted.handle.dispose();
    await expect(disposeTerminal).resolves.toEqual({
      kind: 'terminal',
      reason: 'aborted',
    });
    expect(terminalListener).toHaveBeenCalledTimes(1);
    releaseRemoteDispose();
    await expect(Promise.all([
      stoppedDisposing,
      disposing,
    ])).resolves.toEqual([undefined, undefined]);
    stoppedStarted.handle.watch(stoppedTerminalListener);
    expect(stoppedTerminalListener).toHaveBeenCalledTimes(2);
    expect(stoppedTerminalListener).toHaveBeenLastCalledWith({
      kind: 'terminal',
      reason: 'stopped',
    });
    disposingStarted.handle.watch(terminalListener);
    expect(terminalListener).toHaveBeenCalledTimes(2);
    expect(terminalListener).toHaveBeenLastCalledWith({
      kind: 'terminal',
      reason: 'aborted',
    });

    await runtime.dispose('session_closed');
  });

  it('reopens the same current generation after a terminal turn and delivers the successor prompt once', async () => {
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) throw new Error('Expected daemon Agent runtime sessions');
    const runtimeContext = {
      signal: new AbortController().signal,
      session: {
        services: {
          features: {
            isEnabled: () => false,
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const first = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-1',
      cwd: root,
    }, runtimeContext);
    const firstEvents: AgentSessionRuntimeEvent[] = [];
    const firstSubscription = first.watch((event) => {
      firstEvents.push(event);
    });

    await expect(first.send({
      inputIds: ['input-first'],
      input: { text: 'first' },
      delivery: { kind: 'newTurn', turnId: 'turn-first' },
    })).resolves.toEqual({ status: 'admitted' });
    await vi.waitFor(() => expect(pollResolvers).toHaveLength(1));
    pollResolvers[0]?.({
      events: [
        {
          sequence: 0,
          sessionId: 'host-session-1',
          emittedAtMs: 1,
          kind: 'input-accepted',
          inputIds: ['input-first'],
          delivery: { kind: 'newTurn', turnId: 'turn-first' },
        },
        {
          sequence: 1,
          sessionId: 'host-session-1',
          emittedAtMs: 2,
          kind: 'turn-start',
          turnId: 'turn-first',
          startedBy: 'host',
        },
        {
          sequence: 2,
          sessionId: 'host-session-1',
          emittedAtMs: 3,
          kind: 'turn-complete',
          turnId: 'turn-first',
        },
      ],
      effects: [],
    });
    await vi.waitFor(() => {
      expect(firstEvents.at(-1)).toMatchObject({
        kind: 'turn-complete',
        turnId: 'turn-first',
      });
    });

    firstSubscription.dispose();
    await first.dispose('runtime_recovery');
    expect(carrier.isCurrent()).toBe(true);

    const second = await carrier.runtime.sessions.open({
      kind: 'resume',
      sessionId: 'host-session-1',
      cwd: root,
      providerSessionId: 'provider-session-1',
    }, runtimeContext);
    const secondEvents: AgentSessionRuntimeEvent[] = [];
    const secondSubscription = second.watch((event) => {
      secondEvents.push(event);
    });
    try {
      await expect(second.send({
        inputIds: ['input-second'],
        input: { text: 'second' },
        delivery: { kind: 'newTurn', turnId: 'turn-second' },
      })).resolves.toEqual({ status: 'admitted' });
      // The predecessor begins its next long poll after publishing the first
      // terminal batch. Its unresolved poll remains fenced by pollStopped; the
      // successor owns the following poll.
      await vi.waitFor(() => expect(pollResolvers).toHaveLength(3));
      pollResolvers[2]?.({
        events: [
          {
            sequence: 0,
            sessionId: 'host-session-1',
            emittedAtMs: 4,
            kind: 'input-accepted',
            inputIds: ['input-second'],
            delivery: { kind: 'newTurn', turnId: 'turn-second' },
          },
          {
            sequence: 1,
            sessionId: 'host-session-1',
            emittedAtMs: 5,
            kind: 'turn-start',
            turnId: 'turn-second',
            startedBy: 'host',
          },
          {
            sequence: 2,
            sessionId: 'host-session-1',
            emittedAtMs: 6,
            kind: 'turn-complete',
            turnId: 'turn-second',
          },
        ],
        effects: [],
      });
      await vi.waitFor(() => {
        expect(secondEvents.at(-1)).toMatchObject({
          kind: 'turn-complete',
          turnId: 'turn-second',
        });
      });
    } finally {
      secondSubscription.dispose();
      await second.dispose('session_closed');
    }

    const sentPrompts = controlClientMock.dispatch.mock.calls
      .map(([request]) => request.operation)
      .filter((operation) => operation.kind === 'session.send');
    expect(sentPrompts).toHaveLength(2);
    expect(sentPrompts.map((operation) => operation.request.input.text)).toEqual([
      'first',
      'second',
    ]);
    const sendRequestOptions = controlClientMock.dispatch.mock.calls
      .filter(([request]) => request.operation.kind === 'session.send')
      .map(([, options]) => options);
    expect(sendRequestOptions).toEqual([
      { timeoutMs: null },
      { timeoutMs: null },
    ]);
    expect(controlClientMock.dispatch.mock.calls
      .map(([request]) => request.operation.kind)
      .filter((kind) => kind === 'factory.prepare')).toHaveLength(2);
    expect(controlClientMock.dispatch.mock.calls
      .map(([request]) => request.operation.kind)
      .filter((kind) => kind === 'session.open')).toHaveLength(2);
  });

  it('keeps the immutable child handoff available to bridge facets after the token file is retired', async () => {
    const env = {
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    };
    const carrier = tryCreateDaemonAgentRuntimeCarrier(env);
    expect(carrier).not.toBeNull();

    await rm(tokenFilePath);

    expect(() =>
      tryCreateDaemonSessionModelTransitionProviderAuthorizer(
        'host-session-late-bridge',
        env,
      ),
    ).not.toThrow();
  });

  it('retires the carrier when daemon session disposal does not prove predecessor retirement', async () => {
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) throw new Error('Expected daemon Agent runtime sessions');
    const runtimeContext = {
      signal: new AbortController().signal,
      session: {
        services: {
          features: {
            isEnabled: () => false,
          },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const first = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-dispose-failure',
      cwd: root,
    }, runtimeContext);
    sessionDisposeError = new Error('daemon disposal unavailable');

    await first.dispose('runtime_recovery');

    expect(carrier.isCurrent()).toBe(false);
    await expect(carrier.runtime.sessions.open({
      kind: 'resume',
      sessionId: 'host-session-dispose-failure',
      cwd: root,
      providerSessionId: 'provider-session-1',
    }, runtimeContext)).rejects.toThrow(/carrier is retired/i);
  });

  it('reports takeover channel loss as outcome unknown without replaying the mutation', async () => {
    controlClientMock.dispatch.mockImplementation(async (request) => {
      if (request.operation.kind === 'session.externalSession.takeover') {
        throw new Error('control channel closed');
      }
      throw new Error(`Unexpected daemon bridge operation: ${request.operation.kind}`);
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier) throw new Error('Expected daemon Agent runtime carrier');
    const port = carrier.externalSessionHostOperations.bindSession(
      'host-session-outcome-unknown',
    );

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(port.executeTakeover({
      ref: {
        agentId: 'replacement-fixture',
        sourceId: 'default',
        remoteSessionId: 'remote-session-before-dispatch',
      },
      source: { kind: 'codexHome', home: 'user' },
      signal: alreadyAborted.signal,
    })).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    expect(controlClientMock.dispatch).not.toHaveBeenCalled();

    await expect(port.executeTakeover({
      ref: {
        agentId: 'replacement-fixture',
        sourceId: 'default',
        remoteSessionId: 'remote-session-1',
      },
      source: { kind: 'codexHome', home: 'user' },
    })).rejects.toMatchObject({
      code: 'plugin_external_takeover_outcome_unknown',
    });
    expect(controlClientMock.dispatch.mock.calls
      .map(([request]) => request.operation.kind)
      .filter((kind) => kind === 'session.externalSession.takeover'))
      .toHaveLength(1);
  });

  it('sends takeover cancellation but awaits the daemon-owned terminal result', async () => {
    let resolveTakeover!: (value: unknown) => void;
    const takeoverResult = new Promise((resolve) => {
      resolveTakeover = resolve;
    });
    controlClientMock.dispatch.mockImplementation(async (request) => {
      if (request.operation.kind === 'session.externalSession.takeover') {
        return await takeoverResult;
      }
      if (request.operation.kind === 'request.cancel') {
        return { ok: true, result: null };
      }
      throw new Error(`Unexpected daemon bridge operation: ${request.operation.kind}`);
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier) throw new Error('Expected daemon Agent runtime carrier');
    const port = carrier.externalSessionHostOperations.bindSession(
      'host-session-cancel-race',
    );
    const caller = new AbortController();
    const pending = port.executeTakeover({
      ref: {
        agentId: 'replacement-fixture',
        sourceId: 'default',
        remoteSessionId: 'remote-session-committing',
      },
      source: { kind: 'codexHome', home: 'user' },
      signal: caller.signal,
    });
    await vi.waitFor(() => {
      expect(controlClientMock.dispatch.mock.calls
        .some(([request]) =>
          request.operation.kind === 'session.externalSession.takeover'))
        .toBe(true);
    });

    caller.abort();
    await vi.waitFor(() => {
      expect(controlClientMock.dispatch.mock.calls
        .some(([request]) => request.operation.kind === 'request.cancel'))
        .toBe(true);
    });
    resolveTakeover({
      ok: true,
      result: {
        sessionId: 'linked-session-committed',
        status: 'takenOver',
      },
    });

    await expect(pending).resolves.toEqual({
      sessionId: 'linked-session-committed',
      status: 'takenOver',
    });
    expect(controlClientMock.dispatch.mock.calls
      .filter(([request]) =>
        request.operation.kind === 'session.externalSession.takeover'))
      .toHaveLength(1);
  });

  it('closes a daemon-held follow when its caller aborts after acquisition', async () => {
    controlClientMock.dispatch.mockImplementation(async (request) => {
      if (request.operation.kind === 'session.externalSession.follow.open') {
        return {
          ok: true,
          result: {
            status: 'following',
            startingCursor: 'cursor-1',
          },
        };
      }
      if (request.operation.kind === 'session.externalSession.follow.close') {
        return { ok: true, result: null };
      }
      throw new Error(`Unexpected daemon bridge operation: ${request.operation.kind}`);
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier) throw new Error('Expected daemon Agent runtime carrier');
    const port = carrier.externalSessionHostOperations.bindSession(
      'host-session-follow-abort',
    );
    const caller = new AbortController();

    const result = await port.executeFollow({
      ref: {
        agentId: 'replacement-fixture',
        sourceId: 'default',
        remoteSessionId: 'remote-session-following',
      },
      source: { kind: 'codexHome', home: 'user' },
      options: { signal: caller.signal },
      listener: vi.fn(),
    });
    expect(result.status).toBe('following');

    caller.abort();

    await vi.waitFor(() => {
      expect(controlClientMock.dispatch.mock.calls
        .filter(([request]) =>
          request.operation.kind === 'session.externalSession.follow.close'))
        .toHaveLength(1);
    });
    await port.retire();
    expect(controlClientMock.dispatch.mock.calls
      .filter(([request]) =>
        request.operation.kind === 'session.externalSession.follow.close'))
      .toHaveLength(1);
  });

  it('opens a provider-session follow without exposing a resolved source to the child', async () => {
    controlClientMock.dispatch.mockImplementation(async (request) => {
      if (
        request.operation.kind
          === 'session.externalSession.follow.openProviderSession'
      ) {
        return {
          ok: true,
          result: {
            status: 'following',
            startingCursor: 'cursor-provider',
          },
        };
      }
      if (request.operation.kind === 'session.externalSession.follow.close') {
        return { ok: true, result: null };
      }
      throw new Error(
        `Unexpected daemon bridge operation: ${request.operation.kind}`,
      );
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier) throw new Error('Expected daemon Agent runtime carrier');
    const port = carrier.externalSessionHostOperations.bindSession(
      'host-session-provider-follow',
    );

    const result = await port.executeProviderSessionFollow({
      agentId: 'replacement-fixture',
      providerSessionId: 'remote-provider-1',
      options: { cursor: 'cursor-provider' },
      listener: vi.fn(),
    });

    expect(result).toMatchObject({
      status: 'following',
      startingCursor: 'cursor-provider',
    });
    expect(controlClientMock.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: {
          kind:
            'session.externalSession.follow.openProviderSession',
          requestId: expect.any(String),
          followId: expect.any(String),
          agentId: 'replacement-fixture',
          providerSessionId: 'remote-provider-1',
          cursor: 'cursor-provider',
        },
      }),
      expect.anything(),
    );
    const openOperation = controlClientMock.dispatch.mock.calls
      .map(([request]) => request.operation)
      .find(
        (operation) =>
          operation.kind
            === 'session.externalSession.follow.openProviderSession',
      );
    expect(openOperation).not.toHaveProperty('ref');
    expect(openOperation).not.toHaveProperty('source');
    if (result.status === 'following') {
      await result.subscription.dispose();
    }
  });

  it('closes a daemon-held follow after acknowledging its terminal event', async () => {
    controlClientMock.dispatch.mockImplementation(async (request) => {
      switch (request.operation.kind) {
        case 'factory.prepare':
          return { ok: true, result: { controls: [] } };
        case 'session.open':
          return { ok: true, result: { methods: [] } };
        case 'session.externalSession.follow.open':
          return {
            ok: true,
            result: {
              status: 'following',
              startingCursor: 'cursor-1',
            },
          };
        case 'session.externalSession.follow.close':
        case 'effect.complete':
        case 'session.dispose':
          return { ok: true, result: null };
        case 'channel.poll':
          return await new Promise((resolve) => {
            pollResolvers.push((result) => resolve({ ok: true, result }));
          });
        default:
          throw new Error(
            `Unexpected daemon bridge operation: ${request.operation.kind}`,
          );
      }
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected daemon Agent runtime sessions');
    }
    const runtimeContext = {
      signal: new AbortController().signal,
      session: { services: { features: { isEnabled: () => false } } },
    } as unknown as AgentSessionRuntimeContext;
    const session = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-follow-terminated',
      cwd: root,
    }, runtimeContext);
    const port = carrier.externalSessionHostOperations.bindSession(
      'host-session-follow-terminated',
    );
    const listener = vi.fn();
    const result = await port.executeFollow({
      ref: {
        agentId: 'replacement-fixture',
        sourceId: 'default',
        remoteSessionId: 'remote-session-follow-terminated',
      },
      source: { kind: 'codexHome', home: 'user' },
      options: {},
      listener,
    });
    expect(result.status).toBe('following');
    await vi.waitFor(() => expect(pollResolvers).toHaveLength(1));

    pollResolvers[0]?.({
      events: [],
      effects: [{
        kind: 'session.externalSession.follow.event',
        effectId: 'terminal-follow-effect',
        followId: controlClientMock.dispatch.mock.calls
          .find(([request]) =>
            request.operation.kind === 'session.externalSession.follow.open')
          ?.[0].operation.followId,
        event: {
          kind: 'terminated',
          reason: 'providerFailure',
          cursor: 'cursor-1',
          code: 'provider_failed',
        },
      }],
    });

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'terminated',
      }));
      const kinds = controlClientMock.dispatch.mock.calls
        .map(([request]) => request.operation.kind);
      expect(kinds).toContain('effect.complete');
      expect(kinds).toContain('session.externalSession.follow.close');
      expect(kinds.indexOf('effect.complete')).toBeLessThan(
        kinds.indexOf('session.externalSession.follow.close'),
      );
    });
    await session.dispose('runtime_recovery');
    await port.retire();
    expect(controlClientMock.dispatch.mock.calls
      .filter(([request]) =>
        request.operation.kind === 'session.externalSession.follow.close'))
      .toHaveLength(1);
  });

  it('keeps an acknowledged follow callback available until daemon close settles', async () => {
    let resolveClose!: (
      value: Readonly<{ ok: true; result: null }>,
    ) => void;
    const closeResult = new Promise<Readonly<{ ok: true; result: null }>>(
      (resolve) => {
        resolveClose = resolve;
      },
    );
    controlClientMock.dispatch.mockImplementation(async (request) => {
      switch (request.operation.kind) {
        case 'factory.prepare':
          return { ok: true, result: { controls: [] } };
        case 'session.open':
          return { ok: true, result: { methods: [] } };
        case 'session.externalSession.follow.open':
          return {
            ok: true,
            result: {
              status: 'following',
              startingCursor: 'cursor-1',
            },
          };
        case 'session.externalSession.follow.close':
          return await closeResult;
        case 'effect.complete':
        case 'effect.fail':
        case 'session.dispose':
          return { ok: true, result: null };
        case 'channel.poll':
          return await new Promise((resolve) => {
            pollResolvers.push((result) => resolve({ ok: true, result }));
          });
        default:
          throw new Error(
            `Unexpected daemon bridge operation: ${request.operation.kind}`,
          );
      }
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected daemon Agent runtime sessions');
    }
    const runtimeContext = {
      signal: new AbortController().signal,
      session: { services: { features: { isEnabled: () => false } } },
    } as unknown as AgentSessionRuntimeContext;
    const session = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-follow-close-drain',
      cwd: root,
    }, runtimeContext);
    const port = carrier.externalSessionHostOperations.bindSession(
      'host-session-follow-close-drain',
    );
    const listener = vi.fn(async () => undefined);
    const result = await port.executeFollow({
      ref: {
        agentId: 'replacement-fixture',
        sourceId: 'default',
        remoteSessionId: 'remote-session-follow-close-drain',
      },
      source: { kind: 'codexHome', home: 'user' },
      options: {},
      listener,
    });
    expect(result.status).toBe('following');
    await vi.waitFor(() => expect(pollResolvers).toHaveLength(1));

    if (result.status !== 'following') {
      throw new Error('Expected External Session follow subscription');
    }
    let disposalSettled = false;
    const disposal = result.subscription.dispose();
    if (!disposal) {
      throw new Error('Expected daemon External Session follow disposal to be awaitable');
    }
    const disposing = disposal.then(() => {
      disposalSettled = true;
    });
    await vi.waitFor(() => {
      expect(controlClientMock.dispatch.mock.calls.some(
        ([request]) =>
          request.operation.kind === 'session.externalSession.follow.close',
      )).toBe(true);
    });
    expect(disposalSettled).toBe(false);
    const followId = controlClientMock.dispatch.mock.calls.find(
      ([request]) =>
        request.operation.kind === 'session.externalSession.follow.open',
    )?.[0].operation.followId;
    pollResolvers[0]?.({
      events: [],
      effects: [{
        kind: 'session.externalSession.follow.event',
        effectId: 'follow-close-drain-effect',
        followId,
        event: {
          kind: 'data',
          items: [{
            id: 'follow-close-drain-item',
            timestampMs: 11,
            kind: 'agent',
            data: { type: 'text', text: 'drain me' },
          }],
          fromCursor: 'cursor-1',
          nextCursor: 'cursor-2',
        },
      }],
    });

    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'data',
        nextCursor: 'cursor-2',
      }));
    });
    resolveClose({ ok: true, result: null });
    await disposing;
    expect(disposalSettled).toBe(true);
    await port.retire();
    await session.dispose('session_closed');
  });

  it('retains follow custody until a rejecting or lost close acknowledgement is retried successfully', async () => {
    let closeAttempts = 0;
    controlClientMock.dispatch.mockImplementation(async (request) => {
      switch (request.operation.kind) {
        case 'factory.prepare':
          return { ok: true, result: { controls: [] } };
        case 'session.open':
          return { ok: true, result: { methods: [] } };
        case 'session.externalSession.follow.open':
          return {
            ok: true,
            result: {
              status: 'following',
              startingCursor: 'cursor-1',
            },
          };
        case 'session.externalSession.follow.close':
          closeAttempts += 1;
          if (closeAttempts === 1) {
            return {
              ok: false,
              error: {
                code: 'plugin_external_follow_close_failed',
                message: 'Daemon source disposal rejected',
              },
            };
          }
          if (closeAttempts === 2) {
            throw new Error('Daemon follow close acknowledgement was lost');
          }
          return { ok: true, result: null };
        case 'effect.complete':
        case 'effect.fail':
        case 'session.dispose':
          return { ok: true, result: null };
        case 'channel.poll':
          return await new Promise((resolve) => {
            pollResolvers.push((result) => resolve({ ok: true, result }));
          });
        default:
          throw new Error(
            `Unexpected daemon bridge operation: ${request.operation.kind}`,
          );
      }
    });
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected daemon Agent runtime sessions');
    }
    const runtimeContext = {
      signal: new AbortController().signal,
      session: { services: { features: { isEnabled: () => false } } },
    } as unknown as AgentSessionRuntimeContext;
    const session = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-follow-close-retry',
      cwd: root,
    }, runtimeContext);
    const port = carrier.externalSessionHostOperations.bindSession(
      'host-session-follow-close-retry',
    );
    const listener = vi.fn(async () => undefined);
    const result = await port.executeFollow({
      ref: {
        agentId: 'replacement-fixture',
        sourceId: 'default',
        remoteSessionId: 'remote-session-follow-close-retry',
      },
      source: { kind: 'codexHome', home: 'user' },
      options: {},
      listener,
    });
    if (result.status !== 'following') {
      throw new Error('Expected External Session follow subscription');
    }

    await expect(result.subscription.dispose()).rejects.toThrow(
      'Daemon source disposal rejected',
    );
    await expect(result.subscription.dispose()).rejects.toThrow(
      'Daemon follow close acknowledgement was lost',
    );
    expect(closeAttempts).toBe(2);

    await vi.waitFor(() => expect(pollResolvers).toHaveLength(1));
    const followId = controlClientMock.dispatch.mock.calls.find(
      ([request]) =>
        request.operation.kind === 'session.externalSession.follow.open',
    )?.[0].operation.followId;
    pollResolvers[0]?.({
      events: [],
      effects: [{
        kind: 'session.externalSession.follow.event',
        effectId: 'follow-close-retry-effect',
        followId,
        event: {
          kind: 'data',
          items: [{
            id: 'follow-close-retry-item',
            timestampMs: 12,
            kind: 'agent',
            data: { type: 'text', text: 'still retained' },
          }],
          fromCursor: 'cursor-1',
          nextCursor: 'cursor-2',
        },
      }],
    });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'data',
        nextCursor: 'cursor-2',
      }));
      expect(controlClientMock.dispatch.mock.calls.some(
        ([request]) =>
          request.operation.kind === 'effect.complete'
          && request.operation.effectId === 'follow-close-retry-effect',
      )).toBe(true);
    });

    await port.retire();
    expect(closeAttempts).toBe(3);
    await expect(result.subscription.dispose()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(3);
    await session.dispose('session_closed');
  });

  it('bounds hung follow close transport and preserves exact custody for retirement retry', async () => {
    vi.useFakeTimers();
    try {
      const closeFollowIds: string[] = [];
      const closeRequestTimeouts: Array<number | null | undefined> = [];
      let closeAttempts = 0;
      controlClientMock.dispatch.mockImplementation(async (request, options) => {
        switch (request.operation.kind) {
          case 'factory.prepare':
            return { ok: true, result: { controls: [] } };
          case 'session.open':
            return { ok: true, result: { methods: [] } };
          case 'session.externalSession.follow.open':
            return {
              ok: true,
              result: {
                status: 'following',
                startingCursor: 'cursor-1',
              },
            };
          case 'session.externalSession.follow.close': {
            closeAttempts += 1;
            closeFollowIds.push(request.operation.followId);
            closeRequestTimeouts.push(options?.timeoutMs);
            if (closeAttempts === 1) {
              const timeoutMs = options?.timeoutMs ?? 300_000;
              return await new Promise((_resolve, reject) => {
                setTimeout(() => {
                  reject(new Error(
                    `Daemon follow close transport timed out after ${timeoutMs}ms`,
                  ));
                }, timeoutMs);
              });
            }
            return { ok: true, result: null };
          }
          case 'effect.complete':
          case 'effect.fail':
          case 'session.dispose':
            return { ok: true, result: null };
          case 'channel.poll':
            return await new Promise((resolve) => {
              pollResolvers.push((result) => resolve({ ok: true, result }));
            });
          default:
            throw new Error(
              `Unexpected daemon bridge operation: ${request.operation.kind}`,
            );
        }
      });
      const carrier = tryCreateDaemonAgentRuntimeCarrier({
        [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
      });
      if (!carrier?.runtime.sessions) {
        throw new Error('Expected daemon Agent runtime sessions');
      }
      const runtimeContext = {
        signal: new AbortController().signal,
        session: { services: { features: { isEnabled: () => false } } },
      } as unknown as AgentSessionRuntimeContext;
      const session = await carrier.runtime.sessions.open({
        kind: 'create',
        sessionId: 'host-session-follow-close-timeout',
        cwd: root,
      }, runtimeContext);
      const port = carrier.externalSessionHostOperations.bindSession(
        'host-session-follow-close-timeout',
      );
      let resolveListener!: () => void;
      const listenerCalled = new Promise<void>((resolve) => {
        resolveListener = resolve;
      });
      const listener = vi.fn(async () => {
        resolveListener();
      });
      const result = await port.executeFollow({
        ref: {
          agentId: 'replacement-fixture',
          sourceId: 'default',
          remoteSessionId: 'remote-session-follow-close-timeout',
        },
        source: { kind: 'codexHome', home: 'user' },
        options: {},
        listener,
      });
      if (result.status !== 'following') {
        throw new Error('Expected External Session follow subscription');
      }

      let disposalSettled = false;
      const disposal = Promise.resolve(result.subscription.dispose()).then(
        () => {
          disposalSettled = true;
          return null;
        },
        (error: unknown) => {
          disposalSettled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(5_999);
      expect(disposalSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(disposalSettled).toBe(true);
      const disposalError = await disposal;
      expect(disposalError).toEqual(expect.objectContaining({
        message: 'Daemon follow close transport timed out after 6000ms',
      }));
      expect(closeRequestTimeouts).toEqual([6_000]);

      const followId = controlClientMock.dispatch.mock.calls.find(
        ([request]) =>
          request.operation.kind === 'session.externalSession.follow.open',
      )?.[0].operation.followId;
      expect(followId).toEqual(expect.any(String));
      expect(pollResolvers).toHaveLength(1);
      pollResolvers[0]?.({
        events: [],
        effects: [{
          kind: 'session.externalSession.follow.event',
          effectId: 'follow-close-timeout-effect',
          followId,
          event: {
            kind: 'data',
            items: [{
              id: 'follow-close-timeout-item',
              timestampMs: 13,
              kind: 'agent',
              data: { type: 'text', text: 'still retained after timeout' },
            }],
            fromCursor: 'cursor-1',
            nextCursor: 'cursor-2',
          },
        }],
      });
      await listenerCalled;
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'data',
        nextCursor: 'cursor-2',
      }));

      await port.retire();
      expect(closeFollowIds).toEqual([followId, followId]);
      await expect(result.subscription.dispose()).resolves.toBeUndefined();
      expect(closeAttempts).toBe(2);
      vi.useRealTimers();
      await session.dispose('session_closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries one exact pending follow close during bounded retirement', async () => {
    vi.useFakeTimers();
    try {
      const closeFollowIds: string[] = [];
      const closeRequestTimeouts: Array<number | null | undefined> = [];
      controlClientMock.dispatch.mockImplementation(async (request, options) => {
        switch (request.operation.kind) {
          case 'session.externalSession.follow.open':
            return {
              ok: true,
              result: {
                status: 'following',
                startingCursor: 'cursor-1',
              },
            };
          case 'session.externalSession.follow.close': {
            closeFollowIds.push(request.operation.followId);
            closeRequestTimeouts.push(options?.timeoutMs);
            const timeoutMs = options?.timeoutMs ?? 300_000;
            return await new Promise((_resolve, reject) => {
              setTimeout(() => {
                reject(new Error(
                  `Daemon follow close transport timed out after ${timeoutMs}ms`,
                ));
              }, timeoutMs);
            });
          }
          default:
            throw new Error(
              `Unexpected daemon bridge operation: ${request.operation.kind}`,
            );
        }
      });
      const carrier = tryCreateDaemonAgentRuntimeCarrier({
        [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
      });
      if (!carrier) throw new Error('Expected daemon Agent runtime carrier');
      const port = carrier.externalSessionHostOperations.bindSession(
        'host-session-follow-close-retirement-timeout',
      );
      const result = await port.executeFollow({
        ref: {
          agentId: 'replacement-fixture',
          sourceId: 'default',
          remoteSessionId: 'remote-session-follow-close-retirement-timeout',
        },
        source: { kind: 'codexHome', home: 'user' },
        options: {},
        listener: vi.fn(),
      });
      if (result.status !== 'following') {
        throw new Error('Expected External Session follow subscription');
      }

      let disposalSettled = false;
      const disposal = Promise.resolve(result.subscription.dispose()).then(
        () => {
          disposalSettled = true;
          return null;
        },
        (error: unknown) => {
          disposalSettled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(closeFollowIds).toHaveLength(1);

      let retirementSettled = false;
      const retirement = port.retire().then(() => {
        retirementSettled = true;
      });
      await vi.advanceTimersByTimeAsync(5_999);
      expect(disposalSettled).toBe(false);
      expect(retirementSettled).toBe(false);
      expect(closeFollowIds).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(disposalSettled).toBe(true);
      expect(retirementSettled).toBe(false);
      expect(closeFollowIds).toHaveLength(2);
      expect(closeFollowIds[1]).toBe(closeFollowIds[0]);
      expect(closeRequestTimeouts).toEqual([6_000, 6_000]);
      await expect(disposal).resolves.toEqual(expect.objectContaining({
        message: 'Daemon follow close transport timed out after 6000ms',
      }));

      await vi.advanceTimersByTimeAsync(5_999);
      expect(retirementSettled).toBe(false);
      expect(closeFollowIds).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(retirementSettled).toBe(true);
      await retirement;
      expect(closeFollowIds).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts the complete Agent model descriptor published by the daemon', async () => {
    controlClientMock.dispatch.mockImplementation(async (request) => {
      switch (request.operation.kind) {
        case 'factory.prepare':
          return { ok: true, result: { controls: [] } };
        case 'session.open':
          return { ok: true, result: { methods: [] } };
        case 'effect.complete':
        case 'effect.fail':
        case 'session.dispose':
          return { ok: true, result: null };
        case 'channel.poll':
          return await new Promise((resolve) => {
            pollResolvers.push((result) => resolve({ ok: true, result }));
          });
        default:
          throw new Error(
            `Unexpected daemon bridge operation: ${request.operation.kind}`,
          );
      }
    });
    const bindModels = vi.fn(
      (
        _source: Parameters<
          AgentSessionRuntimeContext['session']['services']['models']['bind']
        >[0],
      ) => ({ dispose() {} }),
    );
    const carrier = tryCreateDaemonAgentRuntimeCarrier({
      [HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    });
    if (!carrier?.runtime.sessions) {
      throw new Error('Expected daemon Agent runtime sessions');
    }
    const runtimeContext = {
      signal: new AbortController().signal,
      session: {
        services: {
          features: { isEnabled: () => false },
          models: { bind: bindModels },
        },
      },
    } as unknown as AgentSessionRuntimeContext;
    const session = await carrier.runtime.sessions.open({
      kind: 'create',
      sessionId: 'host-session-complete-model-descriptor',
      cwd: root,
    }, runtimeContext);
    await vi.waitFor(() => expect(pollResolvers).toHaveLength(1));

    pollResolvers[0]?.({
      events: [],
      effects: [{
        kind: 'session.models.publish',
        effectId: 'complete-model-descriptor-effect',
        snapshot: {
          currentModelId: 'claude-sonnet-4-6',
          models: [{
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            contextWindowTokens: 200_000,
            extendedContextModelId: 'claude-sonnet-4-6[1m]',
            modelOptions: [{
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'high',
              options: [{ value: 'high', name: 'High' }],
            }, {
              id: 'boolean_option',
              name: 'Boolean option',
              type: 'boolean',
              currentValue: false,
              options: [{ value: true, name: 'Enabled' }],
            }, {
              id: 'number_option',
              name: 'Number option',
              type: 'number',
              currentValue: 2,
              options: [{ value: 2, name: 'Two' }],
            }, {
              id: 'nullable_option',
              name: 'Nullable option',
              type: 'select',
              currentValue: null,
              options: [{ value: null, name: 'Automatic' }],
            }],
            capabilities: {
              toolRoundTrips: 'supported',
              reasoningControls: 'supported',
            },
          }],
        },
      }],
    });

    await vi.waitFor(() => {
      expect(bindModels).toHaveBeenCalledTimes(1);
      expect(controlClientMock.dispatch.mock.calls
        .some(([request]) =>
          request.operation.kind === 'effect.complete'
          && request.operation.effectId === 'complete-model-descriptor-effect'))
        .toBe(true);
    });
    expect(controlClientMock.dispatch.mock.calls
      .some(([request]) =>
        request.operation.kind === 'effect.fail'
        && request.operation.effectId === 'complete-model-descriptor-effect'))
      .toBe(false);
    expect(bindModels.mock.calls[0]?.[0].read()).toMatchObject({
      currentModelId: 'claude-sonnet-4-6',
      models: [{
        id: 'claude-sonnet-4-6',
        extendedContextModelId: 'claude-sonnet-4-6[1m]',
        capabilities: {
          toolRoundTrips: 'supported',
          reasoningControls: 'supported',
        },
      }],
    });
    expect(carrier.isCurrent()).toBe(true);

    await session.dispose('runtime_recovery');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

import type {
  VoiceRealtimeConnection,
  VoiceRealtimeTransportEvent,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import type { VoiceRealtimeProtocolAdapter } from '@/voice/runtime/protocol/VoiceRealtimeProtocolAdapter';
import {
  projectCanonicalVoiceTranscriptEvent,
  readCanonicalVoiceTranscriptSnapshot,
} from '@/voice/transcript/voiceConversationTranscript';
import { createRealtimeToolBarrier } from '@/voice/tools/realtimeToolBarrier';
import {
  createVoiceConversationController,
  type VoiceConversationControllerDeps,
} from './VoiceConversationController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function createConnectionFixture(kind: VoiceRealtimeConnection['kind'] = 'sdk_handle') {
  const events: VoiceRealtimeJsonValue[] = [];
  const transportEvents: VoiceRealtimeTransportEvent[] = [];
  let finishControlEvents!: () => void;
  let rejectControlEvents!: (reason: unknown) => void;
  const controlEventsFinished = new Promise<void>((resolve, reject) => {
    finishControlEvents = resolve;
    rejectControlEvents = reject;
  });
  let finishTransportEvents!: () => void;
  const transportEventsFinished = new Promise<void>((resolve) => {
    finishTransportEvents = resolve;
  });
  const connect = vi.fn(async (_signal: AbortSignal) => {});
  const close = vi.fn(async () => {
    finishControlEvents();
    finishTransportEvents();
  });
  const sendControl = vi.fn(async (_event: VoiceRealtimeJsonValue) => {});
  const beginOutputInterruptionCandidate = vi.fn(() => 'ducked' as const);
  const resolveOutputInterruptionCandidate = vi.fn();
  let remoteClosed = false;
  const connection: {
    -readonly [Key in keyof VoiceRealtimeConnection]: VoiceRealtimeConnection[Key];
  } = {
    kind,
    connect,
    close,
    sendControl,
    beginOutputInterruptionCandidate,
    resolveOutputInterruptionCandidate,
    currentProviderSessionId: () => null,
    playbackCursorMs: () => null,
    state: () => remoteClosed || close.mock.calls.length > 0 ? 'closed' : connect.mock.calls.length > 0 ? 'open' : 'idle',
    controlEvents: () => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events.splice(0)) yield event;
        await controlEventsFinished;
      },
    }),
    transportEvents: () => ({
      async *[Symbol.asyncIterator]() {
        for (const event of transportEvents.splice(0)) yield event;
        await transportEventsFinished;
      },
    }),
  };
  return {
    connection,
    connect,
    close,
    sendControl,
    beginOutputInterruptionCandidate,
    resolveOutputInterruptionCandidate,
    events,
    transportEvents,
    finishEvents: () => {
      remoteClosed = true;
      finishControlEvents();
      finishTransportEvents();
    },
    failControlEvents: (reason: unknown) => {
      remoteClosed = true;
      rejectControlEvents(reason);
    },
  };
}

function createAdapter(overrides: Partial<VoiceRealtimeProtocolAdapter> = {}): VoiceRealtimeProtocolAdapter {
  return {
    id: 'fixture_provider',
    turnControls: {
      cancelResponse: 'immediate',
      truncatePlayback: 'played_ms',
      clearInput: true,
      stopSession: true,
      resumption: 'resume',
      replay: 'stable_ids',
      exactMessage: false,
    },
    prepare: async () => ({
      kind: 'prepared',
      session: { config: { session: 'fixture' }, safeMetadata: null },
    }),
    decodeControl: () => [],
    encodeTurnControl: (action) => ({ type: action }),
    ...overrides,
  };
}

function createMachineFixture() {
  const transitions: string[] = [];
  const failureCodes: string[] = [];
  return {
    transitions,
    failureCodes,
    machine: {
      connecting: () => transitions.push('connecting'),
      reconnecting: ({ active }: Readonly<{ active: boolean }>) => transitions.push(active ? 'reconnecting' : 'reconnect-settled'),
      connected: () => transitions.push('connected'),
      ending: () => transitions.push('ending'),
      disconnected: () => transitions.push('disconnected'),
      failed: ({ code }: Readonly<{ code: string }>) => {
        transitions.push('failed');
        failureCodes.push(code);
      },
    },
  };
}

describe('VoiceConversationController', () => {
  it('routes provisional output interruption through only the currently owned connection', async () => {
    const fixture = createConnectionFixture('webrtc');
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => fixture.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });
    expect(controller.beginOutputInterruptionCandidate()).toBe('unsupported');
    await controller.start({ controlSessionId: 'candidate-owner' });

    expect(controller.beginOutputInterruptionCandidate()).toBe('ducked');
    controller.resolveOutputInterruptionCandidate('false_alarm');
    expect(fixture.resolveOutputInterruptionCandidate).toHaveBeenCalledWith('false_alarm');

    await controller.stop();
    expect(controller.beginOutputInterruptionCandidate()).toBe('unsupported');
  });

  it('declines a stale provider selection before acquiring attempt resources', async () => {
    const resources = {
      prepare: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const prepare = vi.fn(async () => ({
      kind: 'prepared' as const,
      session: { config: {}, safeMetadata: null },
    }));
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter({ prepare }),
      machine: machine.machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => false,
      onCanonicalEvent: async () => {},
      resources,
    });

    await expect(controller.start({ controlSessionId: 'stale-selection' })).resolves.toEqual({
      status: 'declined',
      code: 'voice_provider_not_selected',
    });
    expect(resources.prepare).not.toHaveBeenCalled();
    expect(resources.release).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(machine.transitions).toEqual([]);
  });

  it('passes the provider-neutral start request through preparation without interpreting it', async () => {
    const prepare = vi.fn(async () => ({
      kind: 'prepared' as const,
      session: { config: {}, safeMetadata: null },
    }));
    const controller = createVoiceConversationController({
      adapter: createAdapter({ prepare }),
      machine: createMachineFixture().machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await controller.start({
      controlSessionId: 'start-request',
      request: { textOnly: true, initialContext: 'context' },
    });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      request: { textOnly: true, initialContext: 'context' },
    }));
    await controller.stop();
  });

  it('releases attempt resources exactly once for declined starts and connected stops', async () => {
    const declinedPreflight = vi.fn(async () => {});
    const declinedPrepare = vi.fn(async () => {});
    const declinedRelease = vi.fn(async () => {});
    const providerPrepare = vi.fn(async () => ({
      kind: 'prepared' as const,
      session: { config: {}, safeMetadata: null },
    }));
    const declined = createVoiceConversationController({
      adapter: createAdapter({
        preflight: async () => ({ kind: 'declined', code: 'credential_unavailable' }),
        prepare: providerPrepare,
      }),
      machine: createMachineFixture().machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        preflight: declinedPreflight,
        prepare: declinedPrepare,
        release: declinedRelease,
      },
    });
    await declined.start({ controlSessionId: 'declined-resource' });
    expect(declinedPreflight).not.toHaveBeenCalled();
    expect(declinedPrepare).not.toHaveBeenCalled();
    expect(declinedRelease).not.toHaveBeenCalled();
    expect(providerPrepare).not.toHaveBeenCalled();

    const connectedRelease = vi.fn(async () => {});
    const connected = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        prepare: vi.fn(async () => {}),
        release: connectedRelease,
      },
    });
    await connected.start({ controlSessionId: 'connected-resource' });
    await connected.stop();
    await connected.stop();
    expect(connectedRelease).toHaveBeenCalledTimes(1);
  });

  it('settles typed resource preflight declines and releases partial acquisition once', async () => {
    const release = vi.fn(async () => {});
    const machine = createMachineFixture();
    const prepare = vi.fn(async () => ({
      kind: 'prepared' as const,
      session: { config: {}, safeMetadata: null },
    }));
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        preflight: async () => ({ kind: 'ready' }),
        prepare,
      }),
      machine: machine.machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        prepare: vi.fn(async () => ({ kind: 'declined' as const, code: 'mic_permission_denied' })),
        release,
      },
    });

    await expect(controller.start({ controlSessionId: 'mic-denied' })).resolves.toEqual({
      status: 'declined',
      code: 'mic_permission_denied',
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(machine.transitions).toEqual(['connecting', 'disconnected']);
  });

  it('preserves a safe coded resource-preflight failure without exposing its raw message', async () => {
    const machine = createMachineFixture();
    const providerPrepare = vi.fn(async () => ({
      kind: 'prepared' as const,
      session: { config: {}, safeMetadata: null },
    }));
    const createConnection = vi.fn(async () => createConnectionFixture().connection);
    const controller = createVoiceConversationController({
      adapter: createAdapter({ prepare: providerPrepare }),
      machine: machine.machine,
      createConnection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        preflight: async () => {
          throw Object.assign(new Error('sensitive machine path: /private/workspace'), {
            code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
          });
        },
        prepare: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
      },
    });

    await expect(controller.start({ controlSessionId: 'binding-preflight' })).resolves.toEqual({
      status: 'failed',
      code: 'VOICE_AGENT_TARGET_MACHINE_OFFLINE',
    });
    expect(providerPrepare).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
    expect(controller.getOwnedControlSessionId()).toBeNull();
    expect(machine.transitions).toEqual(['connecting', 'failed']);
  });

  it('redacts an unsafe resource-preflight error code to the generic connection failure', async () => {
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        preflight: async () => {
          throw Object.assign(new Error('private failure'), {
            code: 'machine unavailable at /Users/private/repository',
          });
        },
        prepare: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
      },
    });

    await expect(controller.start({ controlSessionId: 'unsafe-code' })).resolves.toEqual({
      status: 'failed',
      code: 'voice_connection_failed',
    });
  });

  it.each([
    'provider preflight',
    'resource prepare',
    'provider prepare',
  ] as const)('normalizes typed %s decline codes at every controller output', async (boundary) => {
    for (const [code, expectedCode] of [
      ['machine unavailable at /Users/private/repository', 'voice_connection_failed'],
      ['VOICE_AGENT_TARGET_MACHINE_OFFLINE', 'VOICE_AGENT_TARGET_MACHINE_OFFLINE'],
    ] as const) {
      const releasePrepared = vi.fn(async () => {});
      const disconnected = vi.fn<VoiceConversationControllerDeps['machine']['disconnected']>();
      const adapter = createAdapter({
        releasePrepared,
        ...(boundary === 'provider preflight'
          ? { preflight: async () => ({ kind: 'declined' as const, code }) }
          : {}),
        ...(boundary === 'provider prepare'
          ? { prepare: async () => ({ kind: 'declined' as const, code }) }
          : {}),
      });
      const resources = boundary === 'resource prepare'
        ? {
            prepare: vi.fn(async () => ({ kind: 'declined' as const, code })),
            release: vi.fn(async () => {}),
          }
        : undefined;
      const controller = createVoiceConversationController({
        adapter,
        machine: {
          connecting: vi.fn(),
          connected: vi.fn(),
          ending: vi.fn(),
          disconnected,
          failed: vi.fn(),
        },
        createConnection: async () => createConnectionFixture().connection,
        isSelectionCurrent: () => true,
        onCanonicalEvent: async () => {},
        resources,
      });

      await expect(controller.start({ controlSessionId: `decline-${boundary}` })).resolves.toEqual({
        status: 'declined',
        code: expectedCode,
      });
      expect(disconnected).toHaveBeenCalledWith({
        controlSessionId: `decline-${boundary}`,
        attemptId: 1,
        code: expectedCode,
      });
      expect(releasePrepared).toHaveBeenCalledWith({
        controlSessionId: `decline-${boundary}`,
        attemptId: 1,
        reason: { code: 'error', detail: expectedCode },
      });
    }
  });

  it('settles prepared, declined, and aborted starts exactly once', async () => {
    const preparedMachine = createMachineFixture();
    const preparedConnection = createConnectionFixture('webrtc');
    const prepared = createVoiceConversationController({
      adapter: createAdapter(),
      machine: preparedMachine.machine,
      createConnection: async () => preparedConnection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });
    await expect(prepared.start({ controlSessionId: 's1' })).resolves.toEqual({ status: 'connected' });
    expect(preparedMachine.transitions).toEqual(['connecting', 'connected']);

    const declinedMachine = createMachineFixture();
    const declined = createVoiceConversationController({
      adapter: createAdapter({
        prepare: async () => ({ kind: 'declined', code: 'needs_setup' }),
      }),
      machine: declinedMachine.machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });
    await expect(declined.start({ controlSessionId: 's2' })).resolves.toEqual({
      status: 'declined',
      code: 'needs_setup',
    });
    expect(declinedMachine.transitions).toEqual(['connecting', 'disconnected']);
    expect(declined.getOwnedControlSessionId()).toBeNull();

    const abortedMachine = createMachineFixture();
    const aborted = createVoiceConversationController({
      adapter: createAdapter({ prepare: async () => ({ kind: 'aborted' }) }),
      machine: abortedMachine.machine,
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });
    await expect(aborted.start({ controlSessionId: 's3' })).resolves.toEqual({ status: 'aborted' });
    expect(abortedMachine.transitions).toEqual(['connecting', 'disconnected']);
    expect(aborted.getOwnedControlSessionId()).toBeNull();
  });

  it('initializes every connected transport with the owned request before publishing connected', async () => {
    const first = createConnectionFixture('webrtc');
    const second = createConnectionFixture('webrtc');
    const machine = createMachineFixture();
    const onConnectionReady = vi.fn(async () => {});
    let connectionIndex = 0;
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      onConnectionReady,
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 1,
    });

    const request = { initialContext: 'workspace context' } as const;
    await expect(controller.start({ controlSessionId: 'context-reconnect', request })).resolves.toEqual({ status: 'connected' });
    expect(onConnectionReady).toHaveBeenNthCalledWith(1, expect.objectContaining({
      controlSessionId: 'context-reconnect', reason: 'initial', request, connection: first.connection,
    }));
    expect(machine.transitions).toEqual(['connecting', 'connected']);

    await expect(controller.requestReconnect()).resolves.toBe(true);
    expect(onConnectionReady).toHaveBeenNthCalledWith(2, expect.objectContaining({
      controlSessionId: 'context-reconnect', reason: 'reconnect', request, connection: second.connection,
    }));
    expect(machine.transitions).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connecting',
      'connected',
      'reconnect-settled',
    ]);
  });

  it.each([
    {
      failure: 'ordinary provider rejection',
      error: new Error('provider_unreachable'),
      expectedCode: 'voice_connection_failed',
    },
    {
      failure: 'transport-originated abort-shaped rejection while the attempt remains live',
      error: Object.assign(new Error('voice_webrtc_ice_failed'), {
        name: 'AbortError',
        code: 'voice_webrtc_ice_failed',
      }),
      expectedCode: 'voice_webrtc_ice_failed',
    },
  ])('keeps $failure controller-visible with its safe code and releases ownership', async ({
    error,
    expectedCode,
  }) => {
    const connection = createConnectionFixture();
    connection.connection.connect = vi.fn(async () => {
      throw error;
    });
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await expect(controller.start({ controlSessionId: 'failed-start' })).resolves.toEqual({
      status: 'failed',
      code: expectedCode,
    });
    expect(controller.getOwnedControlSessionId()).toBeNull();
    expect(machine.transitions).toEqual(['connecting', 'failed']);
  });

  it.each([
    'voice_webrtc_ice_failed',
    'voice_webrtc_data_channel_closed',
    'voice_webrtc_failed',
  ])('preserves %s when the owned WebRTC event queue terminates', async (failureCode) => {
    const connection = createConnectionFixture('webrtc');
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await expect(controller.start({ controlSessionId: 'failed-webrtc-events' }))
      .resolves.toEqual({ status: 'connected' });
    connection.failControlEvents(Object.assign(new Error(failureCode), {
      code: failureCode,
    }));

    await vi.waitFor(() => expect(machine.failureCodes).toEqual([failureCode]));
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledWith({
      code: 'error',
      detail: failureCode,
    });
    expect(controller.getOwnedControlSessionId()).toBeNull();
  });

  it('bounds an initial connection that never becomes ready and releases ownership', async () => {
    const connection = createConnectionFixture('webrtc');
    connection.connection.connect = vi.fn(async (signal: AbortSignal) => await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
    }));
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      connectionReadyTimeoutMs: 10,
    });

    const result = await Promise.race([
      controller.start({ controlSessionId: 'connection-timeout' }),
      new Promise<'still_pending'>((resolve) => setTimeout(() => resolve('still_pending'), 50)),
    ]);

    expect(result).toEqual({ status: 'failed', code: 'voice_connection_timeout' });
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(controller.getOwnedControlSessionId()).toBeNull();
    expect(machine.transitions).toEqual(['connecting', 'failed']);
  });

  it('keeps an explicit stop authoritative when an abort-ignoring connection later times out', async () => {
    const connection = createConnectionFixture('webrtc');
    const connect = vi.fn(async () => await new Promise<void>(() => {}));
    connection.connection.connect = connect;
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      connectionReadyTimeoutMs: 100,
    });

    const starting = controller.start({ controlSessionId: 'stopped-before-timeout' });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    await controller.stop();

    await expect(starting).resolves.toEqual({ status: 'aborted' });
  });

  it('releases provider preparation state when a prepared connection never becomes active', async () => {
    const releasePrepared = vi.fn(async () => {});
    const connection = createConnectionFixture();
    connection.connection.connect = vi.fn(async () => {
      throw new Error('missing_provider_identity');
    });
    const adapter = Object.assign(createAdapter(), { releasePrepared }) as VoiceRealtimeProtocolAdapter;
    const controller = createVoiceConversationController({
      adapter,
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await controller.start({ controlSessionId: 'prepared-but-not-active' });
    expect(releasePrepared).toHaveBeenCalledTimes(1);
    expect(releasePrepared).toHaveBeenCalledWith({
      controlSessionId: 'prepared-but-not-active',
      attemptId: 1,
      reason: { code: 'error' },
    });
  });

  it('releases ownership before publishing a terminal machine settlement', async () => {
    let ownedDuringSettlement: string | null = 'not-settled';
    let controller!: ReturnType<typeof createVoiceConversationController>;
    controller = createVoiceConversationController({
      adapter: createAdapter({ prepare: async () => ({ kind: 'declined', code: 'not_ready' }) }),
      machine: {
        ...createMachineFixture().machine,
        disconnected: () => {
          ownedDuringSettlement = controller.getOwnedControlSessionId();
        },
      },
      createConnection: async () => createConnectionFixture().connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await controller.start({ controlSessionId: 'terminal-ordering' });
    expect(ownedDuringSettlement).toBeNull();
  });

  it('makes stale preparation inert and closes the original connection on stop during connect', async () => {
    const firstPreparation = deferred<Awaited<ReturnType<VoiceRealtimeProtocolAdapter['prepare']>>>();
    const connectGate = deferred<void>();
    const firstConnection = createConnectionFixture('sdk_handle');
    firstConnection.connection.connect = vi.fn(async () => await connectGate.promise);
    const secondConnection = createConnectionFixture('websocket_pcm');
    const machine = createMachineFixture();
    let prepareCount = 0;
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        prepare: async () => {
          prepareCount += 1;
          return prepareCount === 1
            ? await firstPreparation.promise
            : { kind: 'prepared', session: { config: {}, safeMetadata: null } };
        },
      }),
      machine: machine.machine,
      createConnection: async (_session, attempt) => attempt === 1
        ? firstConnection.connection
        : secondConnection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    const staleStart = controller.start({ controlSessionId: 'stale' });
    const liveStart = controller.start({ controlSessionId: 'live' });
    firstPreparation.resolve({ kind: 'prepared', session: { config: {}, safeMetadata: null } });
    await expect(staleStart).resolves.toEqual({ status: 'aborted' });
    await expect(liveStart).resolves.toEqual({ status: 'connected' });
    expect(firstConnection.connect).not.toHaveBeenCalled();

    const connectingController = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => firstConnection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });
    const connecting = connectingController.start({ controlSessionId: 'during-connect' });
    await vi.waitFor(() => expect(firstConnection.connection.connect).toHaveBeenCalled());
    const stopping = connectingController.stop();
    connectGate.resolve();
    await expect(connecting).resolves.toEqual({ status: 'aborted' });
    await stopping;
    expect(firstConnection.close).toHaveBeenCalledTimes(1);
  });

  it('makes stop authoritative during the initial supersede yield before start publishes ownership', async () => {
    const connection = createConnectionFixture();
    const machine = createMachineFixture();
    const createConnection = vi.fn(async () => connection.connection);
    const prepareAttemptResources = vi.fn(async () => {});
    const releasePrepared = vi.fn(async () => {});
    const controller = createVoiceConversationController({
      adapter: createAdapter({ releasePrepared }),
      machine: machine.machine,
      createConnection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: {
        prepare: prepareAttemptResources,
        release: vi.fn(async () => {}),
      },
    });

    const starting = controller.start({ controlSessionId: 'stop-before-owner-publication' });
    const stopping = controller.stop();

    const startResult = await starting;
    await stopping;
    if (controller.getOwnedControlSessionId()) await controller.stop();
    expect(startResult).toEqual({ status: 'aborted' });
    expect(controller.getOwnedControlSessionId()).toBeNull();
    expect(createConnection).not.toHaveBeenCalled();
    expect(connection.connect).not.toHaveBeenCalled();
    expect(prepareAttemptResources).not.toHaveBeenCalled();
    expect(machine.transitions).not.toContain('connected');
    expect(releasePrepared).toHaveBeenCalledTimes(1);
    expect(releasePrepared).toHaveBeenCalledWith({
      controlSessionId: 'stop-before-owner-publication',
      attemptId: 1,
      reason: { code: 'user_stop' },
    });
  });

  it('does not publish stopped A terminal state after same-session replacement B connects', async () => {
    const staleCleanup = deferred<void>();
    const firstConnection = createConnectionFixture('sdk_handle');
    const secondConnection = createConnectionFixture('websocket_pcm');
    const machine = createMachineFixture();
    const preflight = vi.fn(async () => ({ kind: 'ready' as const }));
    const releasePrepared = vi.fn(async () => {
      if (releasePrepared.mock.calls.length === 1) await staleCleanup.promise;
    });
    const createConnection = vi.fn(async (
      _session: unknown,
      attemptId: number,
    ) => attemptId === 1 ? firstConnection.connection : secondConnection.connection);
    const controller = createVoiceConversationController({
      adapter: createAdapter({ preflight, releasePrepared }),
      machine: machine.machine,
      createConnection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await expect(controller.start({ controlSessionId: 'shared-control-session' })).resolves.toEqual({
      status: 'connected',
    });
    let replacementStopSettled = false;
    const replacementStop = controller.stop().then(() => {
      replacementStopSettled = true;
    });
    await vi.waitFor(() => expect(releasePrepared).toHaveBeenCalledTimes(1));
    const liveStart = controller.start({ controlSessionId: 'shared-control-session' });

    await expect(liveStart).resolves.toEqual({ status: 'connected' });
    await Promise.resolve();
    const stoppedBeforeStaleCleanup = replacementStopSettled;
    expect(controller.getOwnedControlSessionId()).toBe('shared-control-session');
    expect(firstConnection.connect).toHaveBeenCalledTimes(1);
    expect(firstConnection.close).toHaveBeenCalledTimes(1);
    expect(secondConnection.connect).toHaveBeenCalledTimes(1);
    expect(secondConnection.close).not.toHaveBeenCalled();
    expect(machine.transitions.at(-1)).toBe('connected');

    staleCleanup.resolve();
    await replacementStop;
    expect(stoppedBeforeStaleCleanup).toBe(false);
    expect(controller.getOwnedControlSessionId()).toBe('shared-control-session');
    expect(machine.transitions.at(-1)).toBe('connected');
    expect(releasePrepared).toHaveBeenCalledWith({
      controlSessionId: 'shared-control-session',
      attemptId: 1,
      reason: { code: 'user_stop' },
    });
    expect(preflight).toHaveBeenCalledTimes(2);

    await controller.stop();
    expect(secondConnection.close).toHaveBeenCalledTimes(1);
  });

  it('does not publish failed A terminal state after same-session replacement B connects', async () => {
    const staleCleanup = deferred<void>();
    const firstConnection = createConnectionFixture('sdk_handle');
    const secondConnection = createConnectionFixture('websocket_pcm');
    const machine = createMachineFixture();
    const releasePrepared = vi.fn(async () => {
      if (releasePrepared.mock.calls.length === 1) await staleCleanup.promise;
    });
    const controller = createVoiceConversationController({
      adapter: createAdapter({ releasePrepared }),
      machine: machine.machine,
      createConnection: async (_session, attemptId) => (
        attemptId === 1 ? firstConnection.connection : secondConnection.connection
      ),
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });

    await expect(controller.start({ controlSessionId: 'shared-control-session' })).resolves.toEqual({
      status: 'connected',
    });
    const staleFailure = controller.fail('provider_connection_failed');
    await vi.waitFor(() => expect(releasePrepared).toHaveBeenCalledTimes(1));
    await expect(controller.start({ controlSessionId: 'shared-control-session' })).resolves.toEqual({
      status: 'connected',
    });

    staleCleanup.resolve();
    await staleFailure;

    expect(controller.getOwnedControlSessionId()).toBe('shared-control-session');
    expect(machine.transitions.at(-1)).toBe('connected');
    expect(secondConnection.close).not.toHaveBeenCalled();

    await controller.stop();
  });

  it('keeps A cancelled when replacement B fails selection before A settles late', async () => {
    const stalePreflight = deferred<void>();
    const connection = createConnectionFixture();
    const machine = createMachineFixture();
    const preflight = vi.fn(async () => {
      await stalePreflight.promise;
      return { kind: 'ready' as const };
    });
    const releasePrepared = vi.fn(async () => {});
    const createConnection = vi.fn(async () => connection.connection);
    let selected = true;
    const controller = createVoiceConversationController({
      adapter: createAdapter({ preflight, releasePrepared }),
      machine: machine.machine,
      createConnection,
      isSelectionCurrent: () => selected,
      onCanonicalEvent: async () => {},
    });

    const staleStart = controller.start({ controlSessionId: 'selection-a' });
    const replacementStop = controller.stop();
    selected = false;
    await expect(controller.start({ controlSessionId: 'selection-b' })).resolves.toEqual({
      status: 'declined',
      code: 'voice_provider_not_selected',
    });
    selected = true;
    stalePreflight.resolve();

    await replacementStop;
    const staleResult = await staleStart;
    if (controller.getOwnedControlSessionId()) await controller.stop();
    expect(staleResult).toEqual({ status: 'aborted' });
    expect(controller.getOwnedControlSessionId()).toBeNull();
    expect(preflight).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
    expect(connection.connect).not.toHaveBeenCalled();
    expect(machine.transitions).not.toContain('connected');
    expect(releasePrepared).toHaveBeenCalledTimes(1);
    expect(releasePrepared).toHaveBeenCalledWith({
      controlSessionId: 'selection-a',
      attemptId: 1,
      reason: { code: 'user_stop' },
    });
  });

  it('fails closed when provider or selected execution machine changes during an await', async () => {
    const preparation = deferred<Awaited<ReturnType<VoiceRealtimeProtocolAdapter['prepare']>>>();
    let selected = true;
    const machine = createMachineFixture();
    const connection = createConnectionFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter({ prepare: async () => await preparation.promise }),
      machine: machine.machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => selected,
      onCanonicalEvent: async () => {},
    });

    const start = controller.start({ controlSessionId: 'selection-change' });
    selected = false;
    preparation.resolve({ kind: 'prepared', session: { config: {}, safeMetadata: null } });
    await expect(start).resolves.toEqual({ status: 'aborted' });
    expect(connection.connect).not.toHaveBeenCalled();
    expect(machine.transitions).toEqual(['connecting', 'disconnected']);
  });

  it('gates turn actions on semantic capability and forwards canonical events', async () => {
    const connection = createConnectionFixture();
    connection.events.push({ type: 'transcript.final', text: 'hello' });
    const canonicalEvents: unknown[] = [];
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        decodeControl: () => [{ type: 'input_speech_started' }],
      }),
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async (event) => { canonicalEvents.push(event); },
    });
    await controller.start({ controlSessionId: 'controls' });
    await vi.waitFor(() => expect(canonicalEvents).toEqual([{ type: 'input_speech_started' }]));

    await expect(controller.performTurnControl('cancel_response')).resolves.toEqual({ status: 'sent' });
    await expect(controller.performTurnControl('send_exact_message')).resolves.toEqual({
      status: 'unavailable',
      code: 'voice_turn_action_unsupported',
    });
    expect(connection.sendControl).toHaveBeenCalledTimes(1);
    expect(connection.sendControl).toHaveBeenCalledWith({ type: 'cancel_response' });
  });

  it('exposes provider-encoded client controls only while the owned connection is open', async () => {
    const connection = createConnectionFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
    });
    await expect(controller.sendClientControl({ type: 'voice.user_text', text: 'before' })).resolves.toEqual({
      status: 'unavailable',
      code: 'voice_connection_not_open',
    });
    await controller.start({ controlSessionId: 'client-control' });
    await expect(controller.sendClientControl({ type: 'voice.user_text', text: 'hello' })).resolves.toEqual({
      status: 'sent',
    });
    expect(controller.getActiveControlSessionId()).toBe('client-control');
    expect(connection.sendControl).toHaveBeenCalledWith({ type: 'voice.user_text', text: 'hello' });
    await controller.stop();
    expect(controller.getActiveControlSessionId()).toBeNull();
  });

  it('makes stop idempotent and prevents stale event side effects after teardown', async () => {
    const connection = createConnectionFixture();
    const machine = createMachineFixture();
    const onCanonicalEvent = vi.fn(async () => {});
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent,
    });
    await controller.start({ controlSessionId: 'stop' });
    await controller.stop();
    await controller.stop();
    connection.events.push({ type: 'late' });
    connection.finishEvents();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(machine.transitions).toEqual(['connecting', 'connected', 'ending', 'disconnected']);
    expect(onCanonicalEvent).not.toHaveBeenCalled();
  });

  it('settles an active externally reported failure once while releasing owned resources', async () => {
    const connection = createConnectionFixture();
    const machine = createMachineFixture();
    const release = vi.fn(async () => {});
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      resources: { prepare: vi.fn(async () => {}), release },
    });
    await controller.start({ controlSessionId: 'external-failure' });

    await controller.fail('mic_permission_revoked');
    await controller.fail('late_duplicate');

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(machine.transitions).toEqual(['connecting', 'connecting', 'connected', 'failed']);
  });

  it('refreshes expired auth once and reconnects with bounded backoff on remote close', async () => {
    const first = createConnectionFixture('webrtc');
    const second = createConnectionFixture('webrtc');
    first.events.push({ type: 'auth.expired' });
    const refreshAuth = vi.fn(async () => true);
    const waits: number[] = [];
    let connectionIndex = 0;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        refreshAuth,
        decodeControl: (event) => (event as { type?: string }).type === 'auth.expired'
          ? [{ type: 'auth_expired' }]
          : [],
      }),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      waitBeforeReconnect: async (attempt) => { waits.push(attempt); },
      maxReconnectAttempts: 2,
    });

    await controller.start({ controlSessionId: 'auth-refresh' });
    await vi.waitFor(() => expect(refreshAuth).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));
    expect(waits).toEqual([1]);
    expect(machine.transitions).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connecting',
      'connected',
      'reconnect-settled',
    ]);

    second.finishEvents();
    await controller.stop();
  });

  it('fails closed instead of refreshing auth more than once in one controller attempt', async () => {
    const first = createConnectionFixture('webrtc');
    const second = createConnectionFixture('webrtc');
    first.events.push({ type: 'auth.expired' });
    second.events.push({ type: 'auth.expired' });
    const refreshAuth = vi.fn(async () => true);
    let connectionIndex = 0;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        refreshAuth,
        decodeControl: (event) => (event as { type?: string }).type === 'auth.expired'
          ? [{ type: 'auth_expired' }]
          : [],
      }),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 2,
    });

    await controller.start({ controlSessionId: 'auth-refresh-budget' });

    await vi.waitFor(() => expect(second.close).toHaveBeenCalledTimes(1));
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(machine.transitions.at(-1)).toBe('failed');
  });

  it('retries transient preparation failures within the reconnect budget', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    let prepareCount = 0;
    let connectionIndex = 0;
    const waits: number[] = [];
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        prepare: async () => {
          prepareCount += 1;
          if (prepareCount === 2) throw new Error('temporary_broker_failure');
          return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
        },
      }),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      waitBeforeReconnect: async (attempt) => { waits.push(attempt); },
      maxReconnectAttempts: 2,
    });

    await controller.start({ controlSessionId: 'prepare-retry' });
    await expect(controller.requestReconnect()).resolves.toBe(true);
    expect(waits).toEqual([1, 2]);
    expect(second.connect).toHaveBeenCalledTimes(1);
    expect(machine.transitions).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connecting',
      'connecting',
      'connected',
      'reconnect-settled',
    ]);
    await controller.stop();
  });

  it('ignores a late provider identity from the detached connection during reconnect', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    first.events.push({ type: 'auth.expired' });
    const lateIdentity = deferred<void>();
    first.connection.transportEvents = () => ({
      async *[Symbol.asyncIterator]() {
        await lateIdentity.promise;
        yield { type: 'session_identity' as const, sessionId: 'stale-provider-session' };
      },
    });
    const reconnectGate = deferred<void>();
    const reconnectStarted = vi.fn();
    const sessionLifecycle = {
      connected: vi.fn(async () => {}),
      ended: vi.fn(async () => {}),
    };
    let connectionIndex = 0;
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        decodeControl: (event) => (event as { type?: string }).type === 'auth.expired'
          ? [{ type: 'auth_expired' }]
          : [],
        refreshAuth: async () => true,
      }),
      machine: createMachineFixture().machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      sessionLifecycle,
      waitBeforeReconnect: async () => {
        reconnectStarted();
        await reconnectGate.promise;
      },
      maxReconnectAttempts: 1,
    });

    await controller.start({ controlSessionId: 'late-identity' });
    await vi.waitFor(() => expect(reconnectStarted).toHaveBeenCalledTimes(1));
    lateIdentity.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionLifecycle.connected).not.toHaveBeenCalled();
    reconnectGate.resolve();
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));
    await controller.stop();
  });

  it('settles reconnect exhaustion once and aborts a pending backoff on stop', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    second.connection.connect = vi.fn(async () => { throw new Error('offline'); });
    let connectionIndex = 0;
    const waitGate = deferred<void>();
    const waitStarted = vi.fn();
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      waitBeforeReconnect: async (_attempt, signal) => {
        waitStarted();
        await Promise.race([
          waitGate.promise,
          new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
        ]);
      },
      maxReconnectAttempts: 1,
    });

    await controller.start({ controlSessionId: 'reconnect-stop' });
    first.finishEvents();
    await vi.waitFor(() => expect(waitStarted).toHaveBeenCalledTimes(1));
    await controller.stop();
    waitGate.resolve();
    expect(second.connect).not.toHaveBeenCalled();
    expect(machine.transitions.at(-1)).toBe('disconnected');
    expect(machine.transitions.filter((entry) => entry === 'disconnected')).toHaveLength(1);
  });

  it('settles disconnected when provider selection changes during reconnect backoff', async () => {
    const first = createConnectionFixture();
    const waitGate = deferred<void>();
    const waitStarted = vi.fn();
    let selected = true;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => first.connection,
      isSelectionCurrent: () => selected,
      onCanonicalEvent: async () => {},
      waitBeforeReconnect: async () => {
        waitStarted();
        await waitGate.promise;
      },
      maxReconnectAttempts: 1,
    });

    await controller.start({ controlSessionId: 'reconnect-selection-change' });
    const reconnecting = controller.requestReconnect();
    await vi.waitFor(() => expect(waitStarted).toHaveBeenCalledTimes(1));
    selected = false;
    waitGate.resolve();
    await expect(reconnecting).resolves.toBe(false);

    expect(machine.transitions.at(-1)).toBe('disconnected');
    expect(machine.transitions.filter((entry) => entry === 'disconnected')).toHaveLength(1);
    expect(controller.getOwnedControlSessionId()).toBeNull();
    expect(machine.transitions).toContain('reconnecting');
    expect(machine.transitions).toContain('reconnect-settled');
  });

  it('forwards WebRTC media events and reconnects only after a terminal ICE failure', async () => {
    const first = createConnectionFixture('webrtc');
    const second = createConnectionFixture('webrtc');
    const remoteTrack = { id: 'remote-track-a' };
    first.transportEvents.push(
      { type: 'webrtc_remote_track', track: remoteTrack, streams: [] },
      { type: 'webrtc_ice_state', state: 'disconnected' },
      { type: 'webrtc_ice_state', state: 'failed' },
    );
    const seenTransportEvents: VoiceRealtimeTransportEvent[] = [];
    let connectionIndex = 0;
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      onTransportEvent: async (event) => { seenTransportEvents.push(event); },
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 1,
    });

    await controller.start({ controlSessionId: 'webrtc-events' });
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));
    expect(seenTransportEvents).toEqual([
      { type: 'webrtc_remote_track', track: remoteTrack, streams: [] },
      { type: 'webrtc_ice_state', state: 'disconnected' },
      { type: 'webrtc_ice_state', state: 'failed' },
    ]);
    await controller.stop();
  });

  it('coordinates canonical transcript projection and the all-results tool barrier', async () => {
    const connection = createConnectionFixture();
    connection.events.push(
      { kind: 'transcript' },
      { kind: 'tools' },
    );
    const transcriptEvent = {
      v: 1 as const,
      type: 'voice.transcript.final' as const,
      epoch: 1,
      sequence: 1,
      revision: 1,
      eventId: 'event-controller-1',
      itemId: 'item-controller-1',
      role: 'user' as const,
      text: 'controller owns projection',
      provenance: 'live' as const,
    };
    const calls = [{
      v: 1 as const,
      responseId: 'response-controller-1',
      callId: 'call-controller-1',
      toolName: 'voice_test',
      order: 0,
      arguments: {},
    }];
    const toolBarrier = {
      run: vi.fn(async () => ({ status: 'submitted' as const, results: [] })),
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    const adapter = createAdapter({
      decodeControl: (event) => (event as { kind?: string }).kind === 'transcript'
        ? [{ type: 'transcript', event: transcriptEvent }]
        : [{
            type: 'tool_calls',
            responseId: 'response-controller-1',
            calls,
          }],
    });
    const projectTranscript = vi.fn<NonNullable<VoiceConversationControllerDeps['projectTranscript']>>(
      ({ event }) => projectCanonicalVoiceTranscriptEvent({
        conversationSessionId: 'controller-canonical-session',
        event,
      }),
    );
    const input = {
      adapter,
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      projectTranscript,
      createToolBarrier: () => toolBarrier,
    };
    const controller = createVoiceConversationController(input);

    await controller.start({ controlSessionId: 'controller-canonical-session' });
    await vi.waitFor(() => expect(toolBarrier.run).toHaveBeenCalledTimes(1));
    expect(toolBarrier.run).toHaveBeenCalledWith({
      responseId: 'response-controller-1',
      calls,
      signal: expect.any(AbortSignal),
    });
    expect(projectTranscript).toHaveBeenCalledWith({
      controlSessionId: 'controller-canonical-session',
      attemptId: 1,
      connectionId: 1,
      event: transcriptEvent,
    });
    expect(readCanonicalVoiceTranscriptSnapshot('controller-canonical-session')).toEqual([
      expect.objectContaining({ itemId: 'item-controller-1', text: 'controller owns projection' }),
    ]);
    await controller.stop();
    expect(toolBarrier.dispose).toHaveBeenCalledTimes(1);
  });

  it('cancels detached response delivery but preserves the attempt tool barrier across reconnect', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    first.events.push({ kind: 'tools' });
    const cancelled = deferred<Readonly<{ status: 'cancelled'; results: readonly [] }>>();
    const firstBarrier = {
      run: vi.fn(async () => await cancelled.promise),
      cancel: vi.fn(() => {
        cancelled.resolve({ status: 'cancelled', results: [] });
      }),
      dispose: vi.fn(),
    };
    const createToolBarrier = vi.fn(() => firstBarrier);
    let connectionIndex = 0;
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        decodeControl: () => [{
          type: 'tool_calls',
          responseId: 'response-before-reconnect',
          calls: [{
            v: 1,
            responseId: 'response-before-reconnect',
            callId: 'call-before-reconnect',
            toolName: 'voice_test',
            order: 0,
            arguments: {},
          }],
        }],
      }),
      machine: createMachineFixture().machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier,
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 1,
    });

    await controller.start({ controlSessionId: 'tool-reconnect' });
    await vi.waitFor(() => expect(firstBarrier.run).toHaveBeenCalledTimes(1));
    first.finishEvents();
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));

    expect(firstBarrier.cancel).toHaveBeenCalledWith('response-before-reconnect');
    expect(firstBarrier.dispose).not.toHaveBeenCalled();
    expect(createToolBarrier).toHaveBeenCalledTimes(1);
    await controller.stop();
    expect(firstBarrier.dispose).toHaveBeenCalledTimes(1);
  });

  it('reconnects and redelivers the same retained tool result without repeating the effect', async () => {
    const first = createConnectionFixture();
    const second = createConnectionFixture();
    first.events.push({ kind: 'tools' });
    const calls = [{
      v: 1 as const,
      responseId: 'response-delivery-retry',
      callId: 'call-delivery-retry',
      toolName: 'sendSessionMessage',
      order: 0,
      arguments: { message: 'continue once' },
    }];
    const executeCall = vi.fn(async () => ({ ok: true }));
    const submitResults = vi.fn()
      .mockRejectedValueOnce(new Error('provider connection lost'))
      .mockResolvedValueOnce(undefined);
    const continueResponse = vi.fn(async () => {});
    const toolBarrier = createRealtimeToolBarrier({
      classifyCall: () => 'mutation',
      authorizeCall: async () => ({ status: 'allowed' }),
      executeCall,
      redactResult: (value) => value,
      submitResults,
      continueResponse,
    });
    let connectionIndex = 0;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter({
        decodeControl: () => [{
          type: 'tool_calls',
          responseId: 'response-delivery-retry',
          calls,
        }],
      }),
      machine: machine.machine,
      createConnection: async () => [first.connection, second.connection][connectionIndex++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      createToolBarrier: () => toolBarrier,
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 1,
    });

    await controller.start({ controlSessionId: 'tool-delivery-retry' });
    await vi.waitFor(() => expect(second.connect).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(submitResults).toHaveBeenCalledTimes(2));

    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(continueResponse).toHaveBeenCalledTimes(1);
    expect(machine.transitions).not.toContain('failed');

    await controller.stop();
  });

  it('binds provider session identity and finalizes provider lifecycle exactly once', async () => {
    const connection = createConnectionFixture('sdk_handle');
    connection.transportEvents.push({ type: 'session_identity', sessionId: 'provider-session-1' });
    const sessionLifecycle = {
      connected: vi.fn(async () => {}),
      ended: vi.fn(async () => {}),
    };
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => connection.connection,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      sessionLifecycle,
    });
    await controller.start({ controlSessionId: 'provider-lifecycle' });
    await vi.waitFor(() => expect(sessionLifecycle.connected).toHaveBeenCalledWith({
      controlSessionId: 'provider-lifecycle',
      attemptId: 1,
      providerSessionId: 'provider-session-1',
    }));
    await controller.stop();
    await controller.stop();
    expect(sessionLifecycle.ended).toHaveBeenCalledTimes(1);
    expect(sessionLifecycle.ended).toHaveBeenCalledWith(expect.objectContaining({
      controlSessionId: 'provider-lifecycle',
      providerSessionId: 'provider-session-1',
      reason: 'user_stop',
    }));
  });

  it('binds connection-established identity before publishing connected to synchronous observers', async () => {
    const connection = createConnectionFixture('sdk_handle');
    const connectionWithIdentity = Object.assign(connection.connection, {
      currentProviderSessionId: () => 'provider-session-synchronous-stop',
    }) as VoiceRealtimeConnection;
    const sessionLifecycle = {
      connected: vi.fn(async () => {}),
      ended: vi.fn(async () => {}),
    };
    let stopping: Promise<void> | null = null;
    let controller!: ReturnType<typeof createVoiceConversationController>;
    controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: {
        ...createMachineFixture().machine,
        connected: () => {
          stopping = controller.stop();
        },
      },
      createConnection: async () => connectionWithIdentity,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      sessionLifecycle,
    });

    await expect(controller.start({ controlSessionId: 'synchronous-stop' })).resolves.toEqual({ status: 'aborted' });
    await stopping;
    expect(sessionLifecycle.connected).toHaveBeenCalledTimes(1);
    expect(sessionLifecycle.ended).toHaveBeenCalledTimes(1);
    expect(sessionLifecycle.ended).toHaveBeenCalledWith(expect.objectContaining({
      providerSessionId: 'provider-session-synchronous-stop',
      reason: 'user_stop',
    }));
  });

  it('fails closed when provider selection changes while session identity is being bound', async () => {
    const connection = createConnectionFixture('sdk_handle');
    const connectionWithIdentity = Object.assign(connection.connection, {
      currentProviderSessionId: () => 'provider-session-selection-change',
    }) as VoiceRealtimeConnection;
    const identityGate = deferred<void>();
    const identityBindingStarted = vi.fn();
    let selected = true;
    const machine = createMachineFixture();
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: machine.machine,
      createConnection: async () => connectionWithIdentity,
      isSelectionCurrent: () => selected,
      onCanonicalEvent: async () => {},
      sessionLifecycle: {
        connected: async () => {
          identityBindingStarted();
          await identityGate.promise;
        },
        ended: async () => {},
      },
    });

    const starting = controller.start({ controlSessionId: 'identity-selection-change' });
    await vi.waitFor(() => expect(identityBindingStarted).toHaveBeenCalledTimes(1));
    selected = false;
    identityGate.resolve();

    await expect(starting).resolves.toEqual({ status: 'aborted' });
    expect(machine.transitions).toEqual(['connecting', 'disconnected']);
    expect(controller.getOwnedControlSessionId()).toBeNull();
  });

  it('finalizes each provider session before reconnecting and again on final teardown', async () => {
    const first = createConnectionFixture('sdk_handle');
    const second = createConnectionFixture('sdk_handle');
    first.transportEvents.push({ type: 'session_identity', sessionId: 'provider-session-a' });
    second.transportEvents.push({ type: 'session_identity', sessionId: 'provider-session-b' });
    let index = 0;
    const sessionLifecycle = {
      connected: vi.fn(async () => {}),
      ended: vi.fn(async () => {}),
    };
    const controller = createVoiceConversationController({
      adapter: createAdapter(),
      machine: createMachineFixture().machine,
      createConnection: async () => [first.connection, second.connection][index++]!,
      isSelectionCurrent: () => true,
      onCanonicalEvent: async () => {},
      sessionLifecycle,
      waitBeforeReconnect: async () => {},
      maxReconnectAttempts: 1,
    });
    await controller.start({ controlSessionId: 'provider-reconnect-lifecycle' });
    await vi.waitFor(() => expect(sessionLifecycle.connected).toHaveBeenCalledTimes(1));
    first.finishEvents();
    await vi.waitFor(() => expect(sessionLifecycle.connected).toHaveBeenCalledTimes(2));
    expect(sessionLifecycle.ended).toHaveBeenCalledTimes(1);
    await controller.stop();
    expect(sessionLifecycle.ended).toHaveBeenCalledTimes(2);
  });
});

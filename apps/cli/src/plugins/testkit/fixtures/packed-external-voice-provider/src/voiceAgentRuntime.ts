import type {
  AgentRuntimeFactory,
  AgentSessionRealtimeConversation,
  AgentSessionRealtimeHandle,
  AgentSessionRealtimeLifecycleEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';

function createRealtimeHandle(onTerminal: () => void): AgentSessionRealtimeHandle {
  const listeners = new Set<(event: AgentSessionRealtimeLifecycleEvent) => void>();
  let terminalEvent: AgentSessionRealtimeLifecycleEvent | null = null;

  const stop: AgentSessionRealtimeHandle['stop'] = async (options) => {
    if (options?.signal?.aborted) return { status: 'aborted' };
    if (terminalEvent) return { status: 'already_stopped' };
    terminalEvent = { kind: 'terminal', reason: 'stopped' };
    onTerminal();
    for (const listener of listeners) {
      listener(terminalEvent);
    }
    listeners.clear();
    return { status: 'stopped' };
  };

  return {
    stop,
    watch(listener) {
      if (terminalEvent) {
        listener(terminalEvent);
        return { dispose() {} };
      }
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    async dispose() {
      await stop();
    },
  };
}

function createRealtimeConversation(): AgentSessionRealtimeConversation {
  let activeHandle: AgentSessionRealtimeHandle | null = null;
  return {
    async inspect() {
      return { status: 'available', transport: 'webrtc' };
    },
    async start(_input, options) {
      if (options?.signal?.aborted) return { status: 'aborted' };
      if (activeHandle) return { status: 'busy' };
      const handle = createRealtimeHandle(() => {
        activeHandle = null;
      });
      activeHandle = handle;
      return {
        status: 'started',
        transport: { kind: 'webrtc', answerSdp: 'packed-answer-sdp' },
        handle,
      };
    },
  };
}

export const createPackedVoiceAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    async open(request) {
      return {
        sessionId: request.sessionId,
        async send() {
          return { status: 'admitted' };
        },
        watch() {
          return { dispose() {} };
        },
        async dispose() {},
        realtimeConversation: createRealtimeConversation(),
      };
    },
  },
});

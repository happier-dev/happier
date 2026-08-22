function createRealtimeHandle(onTerminal) {
  const listeners = new Set();
  let terminalEvent = null;
  const stop = async (options) => {
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
    dispose() {
      return stop();
    },
  };
}

function createRealtimeConversation() {
  let activeHandle = null;
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

export function createPackedVoiceAgentRuntime() {
  return {
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
  };
}

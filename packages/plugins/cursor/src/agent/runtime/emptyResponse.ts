import type {
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';

const EMPTY_RESPONSE_DIAGNOSTIC = Object.freeze({
  code: 'cursor_empty_provider_response',
  severity: 'error' as const,
  message: 'Cursor completed the turn without returning an assistant message.',
});

function isTurnTerminal(event: AgentSessionRuntimeEvent): boolean {
  return event.kind === 'turn-complete'
    || event.kind === 'turn-failed'
    || event.kind === 'turn-cancelled';
}

export function withCursorEmptyResponseFailure(runtime: AgentSessionRuntime): AgentSessionRuntime {
  return {
    send: runtime.send.bind(runtime),
    ...(runtime.cancel ? { cancel: runtime.cancel.bind(runtime) } : {}),
    ...(runtime.updateConfiguration
      ? { updateConfiguration: runtime.updateConfiguration.bind(runtime) }
      : {}),
    ...(runtime.compact ? { compact: runtime.compact.bind(runtime) } : {}),
    watch(listener) {
      let turnStartObserved = false;
      let messageDeltaObserved = false;

      return runtime.watch((event) => {
        if (event.kind === 'turn-start') {
          turnStartObserved = true;
          messageDeltaObserved = false;
        } else if (turnStartObserved && event.kind === 'message-delta') {
          messageDeltaObserved = true;
        }

        const forwardedEvent: AgentSessionRuntimeEvent = event.kind === 'turn-complete'
          && turnStartObserved
          && !messageDeltaObserved
          ? {
              ...event,
              kind: 'turn-failed',
              diagnostic: EMPTY_RESPONSE_DIAGNOSTIC,
            }
          : event;

        if (isTurnTerminal(event)) {
          turnStartObserved = false;
          messageDeltaObserved = false;
        }
        listener(forwardedEvent);
      });
    },
    dispose: runtime.dispose.bind(runtime),
  };
}

import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';
import type { PluginVoiceRealtimeConnection } from '@happier-dev/plugin-sdk/runtime';

import type {
  ElevenLabsConversationHandle,
  ElevenLabsConversationHandleEvent,
} from './createElevenLabsConversationHandle.js';
type ElevenLabsLiveness = Readonly<{
  connected(): void;
  disconnected(): void;
  noteInboundEvent(): void;
  userTurnCommitted(): void;
  modeChanged(mode: string): void;
}>;

function readRecord(value: VoiceRealtimeJsonValue): Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, VoiceRealtimeJsonValue>>
    : {};
}

function readRequiredString(value: VoiceRealtimeJsonValue | undefined, code: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(code);
  return text;
}

export function createElevenLabsSdkConnection(input: Readonly<{
  createSdkHandleConnection: (input: Readonly<{ driver: Readonly<{
    open(input: Readonly<{
      signal: AbortSignal;
      onControl: (event: unknown) => void;
      onTransport: (event: Readonly<{ type: 'session_identity'; sessionId: string }>) => void;
      onRemoteClose: (reason: string) => void;
    }>): Promise<void>;
    sendControl(event: VoiceRealtimeJsonValue): Promise<void>;
    close(): Promise<void>;
  }> }>) => PluginVoiceRealtimeConnection;
  handle: ElevenLabsConversationHandle;
  startConfig: unknown;
  initialMuted?: boolean;
  onSessionIdentity?(conversationId: string): void;
  onSessionEnded?(): Promise<void> | void;
  createLiveness?(onFailure: (reason: string) => void): ElevenLabsLiveness;
}>): PluginVoiceRealtimeConnection {
  let unsubscribe: (() => void) | null = null;
  let activeHandle: ElevenLabsConversationHandle | null = null;
  let endSessionPromise: Promise<void> | null = null;
  let endLifecyclePromise: Promise<void> | null = null;
  let closed = false;
  let liveness: ElevenLabsLiveness | null = null;
  const lifecycleController = new AbortController();

  const endActiveSession = async (): Promise<void> => {
    const handle = activeHandle;
    if (!handle) return;
    endSessionPromise ??= Promise.resolve(handle.endSession()).finally(() => {
      if (activeHandle === handle) activeHandle = null;
    });
    await endSessionPromise;
  };

  const endLifecycle = async (): Promise<void> => {
    endLifecyclePromise ??= Promise.resolve(input.onSessionEnded?.());
    await endLifecyclePromise;
  };

  return input.createSdkHandleConnection({
    driver: {
      async open({ signal, onControl, onTransport, onRemoteClose }): Promise<void> {
        const stopLiveness = (): void => {
          const active = liveness;
          liveness = null;
          active?.disconnected();
        };
        let remoteCloseSignalled = false;
        const signalRemoteClose = (reason: string): void => {
          if (remoteCloseSignalled) return;
          remoteCloseSignalled = true;
          stopLiveness();
          onRemoteClose(reason);
        };
        liveness = input.createLiveness?.(signalRemoteClose) ?? null;
        const onEvent = (event: ElevenLabsConversationHandleEvent): void => {
          switch (event.type) {
            case 'connect':
              liveness?.noteInboundEvent();
              onControl({ type: 'elevenlabs.connect' });
              return;
            case 'disconnect':
              signalRemoteClose(event.reason ?? 'sdk_disconnected');
              return;
            case 'message':
              liveness?.noteInboundEvent();
              if (event.data.role === 'user' || event.data.source === 'user') {
                liveness?.userTurnCommitted();
              }
              onControl(event.data);
              return;
            case 'error':
              signalRemoteClose('sdk_error');
              return;
            case 'status':
              liveness?.noteInboundEvent();
              onControl({ type: 'elevenlabs.status', status: event.data.status });
              return;
            case 'mode':
              liveness?.modeChanged(event.data.mode);
              onControl({ type: 'elevenlabs.mode', mode: event.data.mode });
              return;
            case 'debug':
              return;
          }
        };
        const abortLifecycle = (): void => lifecycleController.abort();
        if (signal.aborted) abortLifecycle();
        else signal.addEventListener('abort', abortLifecycle, { once: true });
        let handle: ElevenLabsConversationHandle;
        try {
          handle = input.handle;
        } finally {
          signal.removeEventListener('abort', abortLifecycle);
        }
        if (signal.aborted || lifecycleController.signal.aborted || closed) {
          throw Object.assign(new Error('voice_connection_aborted'), { name: 'AbortError' });
        }
        activeHandle = handle;
        unsubscribe = handle.subscribe(onEvent);
        const sessionId = await handle.startSession(input.startConfig);
        if (signal.aborted || closed) {
          await endActiveSession();
          // The generic connection owner observes its aborted lifecycle signal
          // and rejects connect. Returning here avoids creating a second late
          // rejection after the abort race has already settled.
          return;
        }
        const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim() === sessionId
          ? sessionId
          : '';
        if (!normalizedSessionId) throw new Error('elevenlabs_missing_conversation_id');
        handle.setMicMuted(input.initialMuted === true);
        input.onSessionIdentity?.(normalizedSessionId);
        onTransport({ type: 'session_identity', sessionId: normalizedSessionId });
        liveness?.connected();
      },
      async sendControl(event): Promise<void> {
        const handle = activeHandle;
        if (!handle) throw new Error('elevenlabs_handle_not_active');
        const record = readRecord(event);
        switch (record.type) {
          case 'voice.user_text':
            handle.sendUserMessage(readRequiredString(record.text, 'elevenlabs_user_text_required'));
            return;
          case 'voice.context_update':
            handle.sendContextualUpdate(readRequiredString(record.text, 'elevenlabs_context_update_required'));
            return;
          case 'voice.input_muted':
            if (typeof record.muted !== 'boolean') {
              throw new Error('elevenlabs_input_mute_unsupported');
            }
            handle.setMicMuted(record.muted);
            return;
          default:
            throw new Error('elevenlabs_control_unsupported');
        }
      },
      async close(): Promise<void> {
        closed = true;
        lifecycleController.abort();
        const activeLiveness = liveness;
        liveness = null;
        activeLiveness?.disconnected();
        const dispose = unsubscribe;
        unsubscribe = null;
        dispose?.();
        const handle = activeHandle;
        try {
          if (handle) await endActiveSession();
        } finally {
          try {
            // Each connection owns one wrapper. Dispose it even when the SDK
            // setup is still pending so callbacks and tool closures stay
            // revoked while a late SDK conversation is ended on settlement.
            handle?.dispose();
          } finally {
            await endLifecycle();
          }
        }
      },
    },
  });
}

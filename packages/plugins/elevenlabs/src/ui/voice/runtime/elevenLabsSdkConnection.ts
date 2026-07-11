import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

import type { RealtimeConnection } from './types.js';
import type {
  ElevenLabsConversationHandle,
  ElevenLabsConversationHandleEvent,
} from './createElevenLabsConversationHandle.js';
import {
  elevenLabsConversationHandleRegistry,
  type ElevenLabsConversationHandleMode,
  type ElevenLabsConversationHandleRegistry,
} from './elevenLabsConversationHandleRegistry.js';

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
  }> }>) => RealtimeConnection;
  handle?: ElevenLabsConversationHandle;
  resolveHandle?: (signal: AbortSignal) => Promise<ElevenLabsConversationHandle>;
  startConfig: unknown;
}>): RealtimeConnection {
  let unsubscribe: (() => void) | null = null;
  let activeHandle: ElevenLabsConversationHandle | null = null;
  let endSessionPromise: Promise<void> | null = null;
  let closed = false;
  const lifecycleController = new AbortController();

  const endActiveSession = async (): Promise<void> => {
    const handle = activeHandle;
    if (!handle) return;
    endSessionPromise ??= Promise.resolve(handle.endSession()).finally(() => {
      if (activeHandle === handle) activeHandle = null;
    });
    await endSessionPromise;
  };

  return input.createSdkHandleConnection({
    driver: {
      async open({ signal, onControl, onTransport, onRemoteClose }): Promise<void> {
        const onEvent = (event: ElevenLabsConversationHandleEvent): void => {
          switch (event.type) {
            case 'connect':
              onControl({ type: 'elevenlabs.connect' });
              return;
            case 'disconnect':
              onRemoteClose(event.reason ?? 'sdk_disconnected');
              return;
            case 'message':
              onControl(event.data);
              return;
            case 'error':
              onRemoteClose('sdk_error');
              return;
            case 'status':
              onControl({ type: 'elevenlabs.status', status: event.data.status });
              return;
            case 'mode':
              onControl({ type: 'elevenlabs.mode', mode: event.data.mode });
              return;
            case 'debug':
              return;
          }
        };
        const abortLifecycle = (): void => lifecycleController.abort();
        if (signal.aborted) abortLifecycle();
        else signal.addEventListener('abort', abortLifecycle, { once: true });
        let handle: ElevenLabsConversationHandle | undefined;
        try {
          handle = input.handle ?? await input.resolveHandle?.(lifecycleController.signal);
        } finally {
          signal.removeEventListener('abort', abortLifecycle);
        }
        if (!handle) throw new Error('elevenlabs_handle_resolver_missing');
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
        onTransport({ type: 'session_identity', sessionId: normalizedSessionId });
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
        const dispose = unsubscribe;
        unsubscribe = null;
        dispose?.();
        const handle = activeHandle;
        if (handle) await endActiveSession();
      },
    },
  });
}

export function createRegisteredElevenLabsSdkConnection(input: Readonly<{
  createSdkHandleConnection: Parameters<typeof createElevenLabsSdkConnection>[0]['createSdkHandleConnection'];
  registry?: ElevenLabsConversationHandleRegistry;
  mode: ElevenLabsConversationHandleMode;
  startConfig: unknown;
  handleReadyTimeoutMs?: number;
}>): RealtimeConnection {
  const registry = input.registry ?? elevenLabsConversationHandleRegistry;
  return createElevenLabsSdkConnection({
    createSdkHandleConnection: input.createSdkHandleConnection,
    startConfig: input.startConfig,
    resolveHandle: async (signal) => registry.current(input.mode) ?? await registry.waitForCurrent(
      input.mode,
      signal,
      input.handleReadyTimeoutMs ?? 10_000,
    ),
  });
}

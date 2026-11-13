import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/plugin-sdk/errors';
import { VoiceRealtimeToolResultV1Schema } from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceOutputFocusState,
  VoiceRealtimeConnection,
  VoiceRealtimeJsonValue,
} from '@happier-dev/plugin-sdk/voice/client';

import type {
  ElevenLabsConversationHandle,
  ElevenLabsConversationHandleEvent,
} from './conversationHandle.js';
function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function readRequiredString(value: unknown, code: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(code);
  return text;
}

function isRecoverableClientToolError(context: unknown): boolean {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
  const record = context as Readonly<Record<string, unknown>>;
  // SDK 1.18.0 reports execution/undefined-tool failures with exactly this
  // context and sends an is_error result itself. Its outer result-transport
  // failure includes toolCallId, and session/media errors have other contexts.
  return Object.keys(record).length === 1
    && typeof record.clientToolName === 'string'
    && record.clientToolName.length > 0
    && record.clientToolName.trim() === record.clientToolName;
}

function readNumericNativeCode(value: unknown): string | undefined {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) ? String(number) : undefined;
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
    setOutputFocusState?(state: VoiceOutputFocusState): void;
    close(): Promise<void>;
  }> }>) => VoiceRealtimeConnection;
  handle: ElevenLabsConversationHandle;
  startConfig: unknown;
  initialMuted?: boolean | (() => boolean);
  duckGain: number;
  onSessionIdentity?(conversationId: string): void;
  onSessionEnded?(): Promise<void> | void;
}>): VoiceRealtimeConnection {
  let unsubscribe: (() => void) | null = null;
  let activeHandle: ElevenLabsConversationHandle | null = null;
  let endSessionPromise: Promise<void> | null = null;
  let endLifecyclePromise: Promise<void> | null = null;
  let closed = false;
  let publishControl: ((event: unknown) => void) | null = null;
  const lifecycleController = new AbortController();
  const duckGain = Math.max(0, Math.min(1, Number.isFinite(input.duckGain) ? input.duckGain : 0));

  const setOutputFocusState = (state: VoiceOutputFocusState): void => {
    input.handle.setOutputVolume(
      state === 'suspended'
        ? 0
        : state === 'ducked'
          ? duckGain
          : 1,
    );
  };

  const endActiveSession = async (): Promise<void> => {
    const handle = activeHandle;
    if (!handle) return;
    endSessionPromise ??= Promise.resolve(handle.endSession()).finally(() => {
      if (activeHandle === handle) activeHandle = null;
    });
    await endSessionPromise;
  };

  const endLifecycle = async (): Promise<void> => {
    endLifecyclePromise ??= Promise.resolve().then(() => input.onSessionEnded?.()).catch((error: unknown) => {
      endLifecyclePromise = null;
      throw error;
    });
    await endLifecyclePromise;
  };

  const reportSendFailure = (toolResult: boolean, error: unknown, phase: string) => {
    const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
    // Pinned LiveKit 2.21.0 PublishDataError carries code 14. Preserve that
    // native identifier without accepting arbitrary vendor text or codes.
    const vendor = readRecord(error);
    const failureCause = { phase, errorClass, errorCode, httpStatus,
      ...(vendor.name === 'PublishDataError' && vendor.code === 14 ? { nativeErrorCode: '14' } : {}) };
    publishControl?.({ type: 'elevenlabs.send_error', toolResult, failureCause });
    return failureCause;
  };

  return input.createSdkHandleConnection({
    driver: {
      async open({ signal, onControl, onTransport }): Promise<void> {
        publishControl = onControl;
        let sessionFailure: Error | null = null;
        const reportSessionFailure = (error: unknown, phase: string, nativeErrorCode?: string): void => {
          if (sessionFailure) return;
          const { errorClass, errorCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
          const failureCause = { errorClass, errorCode, httpStatus, phase,
            ...(nativeErrorCode === undefined ? {} : { nativeErrorCode }) };
          sessionFailure = Object.assign(new Error('voice_service_unavailable'), { code: 'voice_service_unavailable', failureCause });
          onControl({ type: 'elevenlabs.session_error', failureCause });
        };
        const onEvent = (event: ElevenLabsConversationHandleEvent): void => {
          switch (event.type) {
            case 'connect':
              onControl({ type: 'elevenlabs.connect' });
              return;
            case 'disconnect': {
              // SDK 1.18.0's onDisconnect ends the conversation, after LiveKit's
              // own reconnection lifecycle. Reopening it as a transport drop
              // creates an unbounded stream of new provider conversations.
              const details = event.details;
              const context = details && details.reason !== 'user' ? details.context : undefined;
              const contextType = context?.type;
              const phase = `elevenlabs.disconnect${details ? `.${details.reason}` : ''}${
                contextType === 'close' || contextType === 'connection_state_changed'
                  || contextType === 'end_call' || contextType === 'max_duration_exceeded'
                  ? `.${contextType}` : ''}`;
              reportSessionFailure(undefined, phase, readNumericNativeCode(
                details && details.reason !== 'user' ? details.closeCode ?? context?.code ?? context?.reason : undefined,
              ));
              return;
            }
            case 'message':
              // SDK 1.18.0's user onMessage callback comes only from its
              // finished user_transcript handler, never sendUserMessage.
              onControl(event.data.source === 'user'
                ? { type: 'elevenlabs.user_transcript', message: event.data }
                : event.data);
              return;
            case 'agent_response_correction':
              // Forwarded in ElevenLabs' own client-event envelope so the leaf
              // transcript mapper reads the provider wire, not a local shape.
              onControl({
                type: 'agent_response_correction',
                agent_response_correction_event: {
                  original_agent_response: event.data.original_agent_response,
                  corrected_agent_response: event.data.corrected_agent_response,
                  event_id: event.data.event_id,
                },
              });
              return;
            case 'error':
              if (isRecoverableClientToolError(event.context)) return;
              reportSessionFailure(event.context, 'elevenlabs.sdk.error', readNumericNativeCode(readRecord(event.context).code));
              return;
            case 'status':
              onControl({ type: 'elevenlabs.status', status: event.data.status });
              return;
            case 'mode':
              onControl({ type: 'elevenlabs.mode', mode: event.data.mode });
              return;
            case 'debug':
              // SDK 1.18.0 completes clientTools before its asynchronous WebRTC
              // publishData settles. LiveKit reconnects without onDisconnect;
              // this callback is the SDK's delivery-failure signal. Project only
              // content-free exception facts, never its result or vendor text.
              if (readRecord(event.message).type === 'send_message_error') {
                const failure = readRecord(readRecord(event.message).message);
                const toolResult = readRecord(failure.message).type === 'client_tool_result';
                reportSendFailure(toolResult, failure.error, toolResult
                  ? 'elevenlabs.tool_result.publish' : 'elevenlabs.control.publish');
              }
              return;
            case 'tool_call':
              onControl({ type: 'elevenlabs.client_tool_call', call: event.call });
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
        const textOnly = input.startConfig !== null
          && typeof input.startConfig === 'object'
          && !Array.isArray(input.startConfig)
          && (input.startConfig as Readonly<{ textOnly?: unknown }>).textOnly === true;
        // Seed the wrapper before SDK negotiation. Later mute changes update
        // that same attempt-owned desired value and therefore win over this
        // initial value when the provider conversation eventually resolves.
        if (!textOnly) {
          handle.setMicMuted(
            typeof input.initialMuted === 'function'
              ? input.initialMuted()
              : input.initialMuted === true,
          );
        }
        const sessionId = await handle.startSession(input.startConfig);
        if (sessionFailure) throw sessionFailure;
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
        input.onSessionIdentity?.(normalizedSessionId);
        onTransport({ type: 'session_identity', sessionId: normalizedSessionId });
      },
      async sendControl(event): Promise<void> {
        const handle = activeHandle;
        if (!handle) throw new Error('elevenlabs_handle_not_active');
        const record = readRecord(event);
        try {
          switch (record.type) {
            case 'voice.tool_result':
              handle.settleToolResult(VoiceRealtimeToolResultV1Schema.parse(record.result));
              return;
            case 'voice.provider_managed_tools':
              // The installed SDK resumes after its callback promise settles.
              return;
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
        } catch (error) {
          const failureCause = reportSendFailure(record.type === 'voice.tool_result', error, record.type === 'voice.tool_result'
            ? 'elevenlabs.tool_result.settle' : 'elevenlabs.control.send');
          throw Object.assign(new Error('voice_service_unavailable'), { failureCause });
        }
      },
      setOutputFocusState,
      async close(): Promise<void> {
        closed = true;
        publishControl = null;
        lifecycleController.abort();
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

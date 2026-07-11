import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol';

import type {
  ControllerMachinePort,
  CreateConversationController,
  RealtimeConnection,
} from './types.js';
import {
  type createElevenLabsProtocolAdapter,
} from './elevenLabsProtocolAdapter.js';

type AttemptResources = Readonly<{
  prepare: (input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    request: VoiceRealtimeJsonValue;
    signal: AbortSignal;
  }>) => Promise<void>;
  release: (input: Readonly<{
    controlSessionId: string;
    attemptId: number;
    reason: Readonly<{ code: 'user_stop' | 'aborted' | 'remote_close' | 'replaced' | 'error'; detail?: string }>;
  }>) => Promise<void>;
}>;

function readEventRecord(value: VoiceRealtimeJsonValue): Readonly<Record<string, VoiceRealtimeJsonValue>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, VoiceRealtimeJsonValue>>
    : {};
}

export function createRealtimeElevenLabsRuntime(input: Readonly<{
  createConversationController: CreateConversationController;
  protocol: ReturnType<typeof createElevenLabsProtocolAdapter>;
  machine: ControllerMachinePort;
  resources: AttemptResources;
  createConnection: (
    session: Readonly<{ config: VoiceRealtimeJsonValue; safeMetadata: VoiceRealtimeJsonValue }>,
    attemptId: number,
  ) => Promise<RealtimeConnection>;
  isSelectionCurrent: () => boolean;
  onProviderMode: (mode: string, controlSessionId: string) => void;
  onProviderEvent?: (event: VoiceRealtimeJsonValue) => void;
  projectTranscript?: Parameters<CreateConversationController>[0]['projectTranscript'];
}>) {
  const protocol = input.protocol;

  const controller = input.createConversationController({
    adapter: protocol.adapter,
    machine: input.machine,
    resources: input.resources,
    createConnection: input.createConnection,
    isSelectionCurrent: input.isSelectionCurrent,
    projectTranscript: input.projectTranscript,
    onCanonicalEvent: async (event) => {
      if (event.type !== 'provider_event') return;
      input.onProviderEvent?.(event.event);
      const record = readEventRecord(event.event);
      if (record.type === 'elevenlabs.mode' && typeof record.mode === 'string') {
        const controlSessionId = controller.getOwnedControlSessionId();
        if (controlSessionId) input.onProviderMode(record.mode, controlSessionId);
        return;
      }
    },
    sessionLifecycle: {
      connected: async ({ controlSessionId, providerSessionId }) => {
        protocol.handleSessionIdentity({ controlSessionId, conversationId: providerSessionId });
      },
      ended: async () => {
        await protocol.endSession();
      },
    },
  });

  return Object.freeze({
    start(controlSessionId: string, request: Readonly<{
      initialContext?: string;
      requestedTargetSessionId?: string | null;
      retryAfterPaywall?: boolean;
      textOnly?: boolean;
    }> = {}) {
      return controller.start({
        controlSessionId,
        request: {
          ...(request.initialContext ? { initialContext: request.initialContext } : {}),
          ...(request.requestedTargetSessionId ? { requestedTargetSessionId: request.requestedTargetSessionId } : {}),
          retryAfterPaywall: request.retryAfterPaywall === true,
          textOnly: request.textOnly === true,
        },
      });
    },
    stop: controller.stop,
    fail: controller.fail,
    sendText(text: string) {
      return controller.sendClientControl({ type: 'voice.user_text', text });
    },
    sendContextUpdate(text: string) {
      return controller.sendClientControl({ type: 'voice.context_update', text });
    },
    setInputMuted(muted: boolean) {
      return controller.sendClientControl({ type: 'voice.input_muted', muted });
    },
    isStarted: () => controller.getActiveControlSessionId() !== null,
    getControlSessionId: controller.getOwnedControlSessionId,
    requestReconnect: controller.requestReconnect,
  });
}

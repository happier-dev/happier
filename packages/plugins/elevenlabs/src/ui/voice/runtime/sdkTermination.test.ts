import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const network = vi.hoisted(() => ({ terminateDuringStart: false, rooms: [] as Array<{
  name: string;
  emit(event: string, ...args: unknown[]): boolean;
  disconnected: boolean;
  sent: Array<{ message: Record<string, unknown>; reliable: boolean }>;
}> }));

vi.mock('livekit-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('livekit-client')>();
  const { EventEmitter } = await import('node:events');
  // Only the remote Room/network is substituted. Use installed ElevenLabs
  // 1.18.0 startup, callbacks, teardown and reliable data publication.
  class Room extends EventEmitter {
    name = `conv_termination${network.rooms.length + 1}`;
    disconnected = false;
    sent: Array<{ message: Record<string, unknown>; reliable: boolean }> = [];
    localParticipant = {
      audioTrackPublications: new Map(),
      getTrackPublication: () => undefined,
      publishData: async (data: Uint8Array, options: { reliable: boolean }) => {
        this.sent.push({ message: JSON.parse(new TextDecoder().decode(data)), reliable: options.reliable });
        if (network.terminateDuringStart) {
          network.terminateDuringStart = false;
          this.emit(original.RoomEvent.ParticipantDisconnected, { identity: 'agent-early' });
        }
      },
    };
    constructor() { super(); network.rooms.push(this); }
    async connect() { this.emit(original.RoomEvent.Connected); }
    async disconnect() { this.disconnected = true; }
  }
  return { ...original, Room };
});

import { createElevenLabsConversationHandle } from './conversationHandle.js';
import { createElevenLabsSdkConnection } from './sdkConnection.js';
import { createElevenLabsVoiceProviderRuntime } from '../runtime.js';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../protocol/voice/index.js';
import type { CreateVoiceConversationController } from '../../../../../../../apps/ui/sources/voice/runtime/controller/VoiceConversationController.js';
import type { createRealtimeToolBarrier as CreateRealtimeToolBarrier } from '../../../../../../../apps/ui/sources/voice/tools/realtimeToolBarrier.js';

const { createVoiceConversationController } = await import(/* @vite-ignore */ new URL(
  '../../../../../../../apps/ui/sources/voice/runtime/controller/VoiceConversationController.ts', import.meta.url,
).href) as { createVoiceConversationController: CreateVoiceConversationController };
const { createSdkHandleConnection } = await import(/* @vite-ignore */ new URL(
  '../../../../../../../apps/ui/sources/voice/runtime/connection/VoiceRealtimeConnection.ts', import.meta.url,
).href) as { createSdkHandleConnection: Parameters<typeof createElevenLabsSdkConnection>[0]['createSdkHandleConnection'] };
const { createRealtimeToolBarrier } = await import(/* @vite-ignore */ new URL(
  '../../../../../../../apps/ui/sources/voice/tools/realtimeToolBarrier.ts', import.meta.url,
).href) as { createRealtimeToolBarrier: typeof CreateRealtimeToolBarrier };

describe('ElevenLabs SDK terminal session callbacks', () => {
  it.each(['agent', 'transport', 'server', 'early', 'reconnect'] as const)(
    'surfaces %s termination before any turn without automatically starting another conversation', async (termination) => {
      const { RoomEvent, ConnectionState } = await import('livekit-client');
      const runtime = createElevenLabsVoiceProviderRuntime({ loadConversationSdk: () => import('@elevenlabs/client') });
      type Failure = Parameters<Parameters<CreateVoiceConversationController>[0]['machine']['failed']>[0];
      const failures: Failure[] = [];
      const inputs: string[] = [];
      const connections: Array<ReturnType<typeof createElevenLabsSdkConnection>> = [];
      const firstRoom = network.rooms.length;
      const hostedConversation = {
        start: async () => ({ allowed: true as const, token: 'test-network-token', leaseId: 'lease', bindingNonce: 'nonce', expiresAtMs: 1000 }),
        abort: async () => {}, complete: async () => {},
      };
      const controller = createVoiceConversationController({
        adapter: { ...runtime.protocol, id: 'elevenlabs',
          turnControls: { cancelResponse: 'unsupported', truncatePlayback: 'unsupported', clearInput: false,
            stopSession: true, resumption: 'none', exactMessage: true },
          prepare: input => runtime.protocol.prepare({ ...input, platform: 'web',
            providerConfig: ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
            credentials: { phase: 'prepare', mediated: null, raw: null }, providerConversation: null, hostedConversation }) },
        machine: { connecting() {}, connected() {}, ending() {}, disconnected() {}, failed: failure => { failures.push(failure); } },
        createConnection: async session => {
          const connection = createElevenLabsSdkConnection({ createSdkHandleConnection,
            handle: createElevenLabsConversationHandle({ tools: [], loadConversationSdk: () => import('@elevenlabs/client') }),
            startConfig: { ...session.config as Record<string, unknown>, textOnly: true, connectionType: 'webrtc' }, duckGain: 0.18 });
          connections.push(connection);
          return connection;
        },
        isSelectionCurrent: () => true,
        onCanonicalEvent: async () => {},
        projectTranscript: ({ event }) => { inputs.push(event.text); },
        createToolBarrier: () => createRealtimeToolBarrier({
          classifyCall: () => 'read_only', executeCall: async () => { throw new Error('unexpected_tool'); },
          redactResult: value => value, submitResults: async () => {}, continueResponse: async () => {},
        }),
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        network.terminateDuringStart = termination === 'early';
        await expect(controller.start({ controlSessionId: 'terminal-session', request: { textOnly: true } })).resolves.toEqual(
          termination === 'early' ? { status: 'failed', code: 'voice_service_unavailable' } : { status: 'connected' },
        );
        const room = network.rooms[firstRoom]!;
        expect(room.sent.map(item => item.message.type)).toEqual(['conversation_initiation_client_data']);
        expect(room.sent.every(item => item.reliable)).toBe(true);
        expect(inputs).toEqual([]);
        if (termination === 'agent') room.emit(RoomEvent.ParticipantDisconnected, { identity: 'agent-remote' });
        else if (termination === 'transport') room.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Disconnected);
        else if (termination === 'server') room.emit(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify({
          type: 'error', error_event: { message: 'private vendor response', code: 1008, details: 'private details' },
        })));
        else if (termination === 'reconnect') {
          // Exercise the host's existing transport recovery. If the replacement
          // SDK conversation ends during startup, it must settle once too.
          network.terminateDuringStart = true;
          await connections[0]!.close({ code: 'remote_close' });
        }
        await vi.waitFor(() => expect(failures).toHaveLength(1));
        expect(failures[0]).toMatchObject({ code: 'voice_service_unavailable', failureCause: {
          phase: termination === 'agent' || termination === 'early' || termination === 'reconnect' ? 'elevenlabs.disconnect.agent.close'
            : termination === 'transport' ? 'elevenlabs.disconnect.error.connection_state_changed' : 'elevenlabs.sdk.error',
          errorCode: null, httpStatus: null,
          ...(termination === 'server' ? { nativeErrorCode: '1008' } : {}),
        } });
        expect(JSON.stringify(failures)).not.toContain('private');
        expect(controller.getOwnedControlSessionId()).toBeNull();
        expect(connections[0]?.state()).toBe('closed');
        // A terminal SDK callback must not enter the host's fresh-conversation
        // reconnect path, regardless of whether a user turn has arrived.
        const endedRoomCount = firstRoom + (termination === 'reconnect' ? 2 : 1);
        expect(network.rooms).toHaveLength(endedRoomCount);

        await expect(controller.start({ controlSessionId: 'terminal-session', request: { textOnly: true } })).resolves.toEqual({ status: 'connected' });
        const retry = network.rooms[endedRoomCount]!;
        retry.emit(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify({
          type: 'user_transcript', user_transcription_event: { user_transcript: 'a fresh user turn', event_id: 1 },
        })));
        await vi.waitFor(() => expect(inputs).toEqual(['a fresh user turn']));
        room.emit(RoomEvent.ParticipantDisconnected, { identity: 'agent-late' });
        expect(failures).toHaveLength(1);
        expect(controller.getOwnedControlSessionId()).toBe('terminal-session');
        expect(network.rooms).toHaveLength(endedRoomCount + 1);
      } finally {
        network.terminateDuringStart = false;
        await controller.stop();
        await runtime.dispose();
        consoleError.mockRestore();
      }
    },
  );
});

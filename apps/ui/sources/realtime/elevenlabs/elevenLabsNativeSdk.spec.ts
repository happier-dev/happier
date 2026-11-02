import { afterEach, describe, expect, it, vi } from 'vitest';
import { Conversation, WebRTCConnection } from '@elevenlabs/client';
import { ConnectionState, RemoteAudioTrack, RoomEvent } from 'livekit-client';

const { rooms } = vi.hoisted(() => ({
    rooms: [] as Array<{ dispatch: (event: string, ...args: unknown[]) => Promise<void> }>,
}));

// LiveKit's Room is the network/native media boundary; ElevenLabs and LiveKit tracks stay real.
vi.mock('livekit-client', async (importOriginal) => {
    const { EventEmitter } = await import('node:events');
    const actual = await importOriginal<typeof import('livekit-client')>();
    class BoundaryRoom extends EventEmitter {
        name = 'conv_native_sdk';
        localParticipant = {
            audioTrackPublications: new Map(),
            getTrackPublication: () => undefined,
            setMicrophoneEnabled: async () => undefined,
            publishData: async () => undefined,
        };
        constructor() {
            super();
            rooms.push(this);
        }
        async connect() {
            this.emit(actual.RoomEvent.SignalConnected);
            this.emit(actual.RoomEvent.Connected);
        }
        async disconnect() {}
        async dispatch(event: string, ...args: unknown[]) {
            await Promise.all(this.listeners(event).map((listener) => listener(...args)));
        }
    }
    return { ...actual, Room: BoundaryRoom };
});

async function connectWithoutBrowserGlobals() {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('Event', undefined);
    vi.stubGlobal('CloseEvent', undefined);
    const connection = await WebRTCConnection.create({ conversationToken: 'native-test-token' });
    const room = rooms.at(-1);
    if (!room) throw new Error('SDK did not create a LiveKit room');
    return { connection, room };
}

afterEach(() => {
    vi.unstubAllGlobals();
    rooms.length = 0;
});

describe('ElevenLabs native WebRTC SDK', () => {
    it('reports a server error without an error payload and continues receiving valid errors', async () => {
        const onError = vi.fn();
        const conversation = await Conversation.startSession({
            textOnly: true,
            conversationToken: 'native-test-token',
            onError,
        });
        const room = rooms.at(-1);
        if (!room) throw new Error('SDK did not create a LiveKit room');
        const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await room.dispatch(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify({ type: 'error' })));
            expect(onError).toHaveBeenCalledWith('Server error: Unknown error', expect.objectContaining({
                errorType: undefined,
            }));

            await room.dispatch(RoomEvent.DataReceived, new TextEncoder().encode(JSON.stringify({
                type: 'error',
                error_event: { error_type: 'llm_error', message: 'Provider unavailable', code: 1011 },
            })));
            expect(onError).toHaveBeenLastCalledWith('Server error: Provider unavailable', expect.objectContaining({
                errorType: 'llm_error',
                code: 1011,
            }));
        } finally {
            await conversation.endSession();
            logError.mockRestore();
        }
    });

    it('receives an agent audio track without attaching a browser audio element', async () => {
        const { room } = await connectWithoutBrowserGlobals();
        // Hermes receives these OS-owned objects from react-native-webrtc.
        const mediaTrack = { id: 'agent-audio', kind: 'audio' } as MediaStreamTrack;
        const receiver = {} as RTCRtpReceiver;
        const track = new RemoteAudioTrack(mediaTrack, 'TR_agent', receiver);

        await expect(room.dispatch(RoomEvent.TrackSubscribed, track, undefined, { identity: 'agent' }))
            .resolves.toBeUndefined();
        expect(track.attachedElements).toHaveLength(0);
    });

    it.each([
        { event: RoomEvent.ConnectionStateChanged, value: ConnectionState.Disconnected, reason: 'error' },
        { event: RoomEvent.ParticipantDisconnected, value: { identity: 'agent' }, reason: 'agent' },
        { event: RoomEvent.Disconnected, value: undefined, reason: 'agent' },
    ])('reports $event without browser event constructors', async ({ event, value, reason }) => {
        const { connection, room } = await connectWithoutBrowserGlobals();
        const onDisconnect = vi.fn();
        connection.onDisconnect(onDisconnect);

        await expect(room.dispatch(event, value)).resolves.toBeUndefined();
        expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({ reason }));
    });
});

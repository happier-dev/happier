import { vi } from 'vitest';

export class TestVoiceWebRtcDataChannel extends EventTarget {
    readyState: RTCDataChannelState = 'connecting';
    readonly sent: string[] = [];

    send(value: string): void {
        this.sent.push(value);
    }

    open(): void {
        this.readyState = 'open';
        this.dispatchEvent(new Event('open'));
    }

    message(value: unknown): void {
        this.dispatchEvent(new MessageEvent('message', { data: value }));
    }

    close(): void {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.dispatchEvent(new Event('close'));
    }
}

export class TestVoiceWebRtcPeer extends EventTarget {
    readonly channel = new TestVoiceWebRtcDataChannel();
    connectionState: RTCPeerConnectionState = 'new';
    iceConnectionState: RTCIceConnectionState = 'new';
    readonly addTrack = vi.fn();
    readonly createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel);
    readonly createOffer = vi.fn(async () => ({
        type: 'offer' as const,
        sdp: 'v=0\r\na=test-offer\r\n',
    }));
    readonly setLocalDescription = vi.fn(async () => undefined);
    readonly setRemoteDescription = vi.fn(async () => undefined);
    readonly close = vi.fn();
}

export function installVoiceWebRtcBrowserBoundary(): Readonly<{
    peer: TestVoiceWebRtcPeer;
    micStream: MediaStream;
    micTrack: MediaStreamTrack;
    micSession: Readonly<{
        ensureActive(): Promise<void>;
        teardown(): Promise<void>;
        setMuted(muted: boolean): void;
        isMuted(): boolean;
        getStream(): MediaStream;
        getAudioContext(): null;
    }>;
    restore(): void;
}> {
    const peer = new TestVoiceWebRtcPeer();
    const micTrackTarget = new EventTarget();
    const micTrack = Object.assign(micTrackTarget, {
        id: 'test-mic-track',
        kind: 'audio',
        enabled: true,
        muted: false,
        stop: vi.fn(),
    }) as unknown as MediaStreamTrack;
    const micStream = Object.freeze({
        getAudioTracks: () => [micTrack],
        getTracks: () => [micTrack],
    }) as unknown as MediaStream;
    const mediaDevices = Object.assign(new EventTarget(), {
        getUserMedia: vi.fn(async () => micStream),
        enumerateDevices: vi.fn(async () => [{
            deviceId: 'test-mic',
            groupId: 'test',
            kind: 'audioinput' as const,
            label: 'Test microphone',
            toJSON: () => ({}),
        }]),
    }) as unknown as MediaDevices;
    const currentNavigator = globalThis.navigator;
    const language = typeof currentNavigator?.language === 'string'
        ? currentNavigator.language
        : 'en-US';
    const languages = Array.isArray(currentNavigator?.languages)
        ? [...currentNavigator.languages]
        : [language];

    vi.stubGlobal('RTCPeerConnection', vi.fn(() => peer));
    vi.stubGlobal('navigator', Object.freeze({
        mediaDevices,
        language,
        languages: Object.freeze(languages),
    }));
    let muted = false;
    const micSession = Object.freeze({
        ensureActive: vi.fn(async () => undefined),
        teardown: vi.fn(async () => {
            micTrack.stop();
        }),
        setMuted: vi.fn((nextMuted: boolean) => {
            muted = nextMuted;
            micTrack.enabled = !nextMuted;
        }),
        isMuted: () => muted,
        getStream: () => micStream,
        getAudioContext: () => null,
    });

    return Object.freeze({
        peer,
        micStream,
        micTrack,
        micSession,
        restore() {
            vi.unstubAllGlobals();
        },
    });
}

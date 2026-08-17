class StubMediaStreamTrack {
    id = 'vitest-native-track';
    kind = 'audio';
    enabled = true;

    _setVolume(_volume: number): void {}
}

export class MediaStream {
    private readonly tracks: StubMediaStreamTrack[];

    constructor(tracks: StubMediaStreamTrack[] = []) {
        this.tracks = [...tracks];
    }

    getTracks(): StubMediaStreamTrack[] {
        return [...this.tracks];
    }

    getAudioTracks(): StubMediaStreamTrack[] {
        return this.tracks.filter((track) => track.kind === 'audio');
    }

    release(): void {}
}

export { StubMediaStreamTrack as MediaStreamTrack };

export class RTCPeerConnection extends EventTarget {}

export const mediaDevices = Object.freeze({
    async getUserMedia(): Promise<MediaStream> {
        return new MediaStream([new StubMediaStreamTrack()]);
    },
});

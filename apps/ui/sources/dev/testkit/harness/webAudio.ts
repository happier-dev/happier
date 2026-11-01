/** Browser AudioContext boundary; callers retain the real decoding/playback orchestration. */
export function createWebAudioBoundary() {
    const decodedBytes: ArrayBuffer[] = [];
    const sources: AudioSource[] = [];
    let finishAutomatically = true;

    class AudioSource {
        buffer: unknown = null;
        onended: (() => void) | null = null;
        started = false;
        disconnected = false;
        connect() {}
        disconnect() { this.disconnected = true; }
        start() {
            this.started = true;
            if (finishAutomatically) queueMicrotask(() => this.finish());
        }
        stop() { this.finish(); }
        finish() { this.onended?.(); }
    }

    class AudioContext {
        destination = {};
        async resume() {}
        async decodeAudioData(bytes: ArrayBuffer) {
            decodedBytes.push(bytes);
            return { duration: 1 };
        }
        createBufferSource() {
            const source = new AudioSource();
            sources.push(source);
            return source;
        }
    }

    return {
        AudioContext,
        decodedBytes,
        sources,
        holdPlayback() { finishAutomatically = false; },
    };
}

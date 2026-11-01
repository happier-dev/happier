type KokoroWorkerRequest =
    | { id: string; type: 'stream'; text: string; voiceId: string | null }
    | { id: string; type: 'cancel' };

type KokoroWorkerResponse =
    | { id: string; type: 'stream_chunk'; wavBytes: ArrayBuffer; sentenceText: string }
    | { id: string; type: 'stream_end' }
    | { id: string; type: 'error'; message: string };

/** Browser Worker transport for the real Kokoro streaming client. */
export function createKokoroWorkerBoundary() {
    const messages: KokoroWorkerRequest[] = [];
    let worker: Worker | undefined;

    class Worker {
        onmessage: ((event: { data: KokoroWorkerResponse }) => void) | null = null;
        onerror: ((event: { message: string }) => void) | null = null;
        constructor() { worker = this; }
        postMessage(message: KokoroWorkerRequest) { messages.push(message); }
        terminate() {}
    }

    return {
        Worker,
        messages,
        emit(data: KokoroWorkerResponse) {
            if (!worker) throw new Error('Expected Kokoro worker');
            worker.onmessage?.({ data });
        },
    };
}

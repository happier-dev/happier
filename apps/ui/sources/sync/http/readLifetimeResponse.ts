/**
 * Expo streams and React Native's global Response are different implementations:
 * the latter stringifies a ReadableStream body. Keep the stream here and use the
 * platform Response only for conversions that require its Blob/FormData types.
 */
export function createReadLifetimeResponse(source: Response, body: ReadableStream<Uint8Array>): Response {
    return new ReadLifetimeResponse(source, body);
}

export async function bufferReadLifetimeResponse(source: Response): Promise<Response> {
    const bytes = new Uint8Array(await source.arrayBuffer());
    return createReadLifetimeResponse(source, new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    }));
}

type BodyState = { stream: ReadableStream<Uint8Array>; used: boolean };

function trackBody(body: ReadableStream<Uint8Array>): BodyState {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const state: BodyState = {
        used: false,
        stream: new ReadableStream<Uint8Array>({
            async pull(controller) {
                state.used = true;
                reader ??= body.getReader();
                try {
                    const chunk = await reader.read();
                    if (chunk.done) {
                        reader.releaseLock();
                        controller.close();
                    } else controller.enqueue(chunk.value);
                } catch (error) { controller.error(error); }
            },
            cancel(reason) {
                state.used = true;
                return reader ? reader.cancel(reason) : body.cancel(reason);
            },
        // Do not pre-read: bodyUsed changes when a consumer actually reads.
        }, { highWaterMark: 0 }),
    };
    return state;
}

class ReadLifetimeResponse implements Response {
    readonly headers: Headers;
    readonly ok: boolean;
    readonly redirected: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly type: ResponseType;
    readonly url: string;
    private state: BodyState;

    constructor(source: Response, body: ReadableStream<Uint8Array>) {
        this.headers = new Headers(source.headers);
        this.ok = source.ok;
        this.redirected = source.redirected;
        this.status = source.status;
        this.statusText = source.statusText;
        this.type = source.type;
        this.url = source.url;
        this.state = trackBody(body);
    }

    get body(): ReadableStream<Uint8Array> { return this.state.stream; }
    get bodyUsed(): boolean { return this.state.used; }

    clone(): Response {
        if (this.bodyUsed || this.body.locked) throw new TypeError('Response body is already used');
        const [original, cloned] = this.body.tee();
        this.state = trackBody(original);
        return createReadLifetimeResponse(this, cloned);
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        if (this.bodyUsed || this.body.locked) throw new TypeError('Response body is already used');
        const reader = this.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                chunks.push(chunk.value);
                length += chunk.value.byteLength;
            }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return bytes.buffer;
    }

    async bytes(): Promise<Uint8Array<ArrayBuffer>> { return new Uint8Array(await this.arrayBuffer()); }
    async text(): Promise<string> { return new TextDecoder().decode(await this.arrayBuffer()); }
    async json(): Promise<unknown> { return JSON.parse(await this.text()); }
    async blob(): Promise<Blob> {
        return new Response(await this.arrayBuffer(), { headers: this.headers }).blob();
    }
    async formData(): Promise<FormData> {
        return new Response(await this.arrayBuffer(), { headers: this.headers }).formData();
    }
}

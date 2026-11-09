import { afterAll } from 'vitest';

// Node's Fetch Response requires Blob.stream(). JSDOM's Blob/File/FileReader
// family is coherent, but its Blob omits that SDK method. Keep the DOM family
// intact while allowing a real response body to round-trip through blob().
const blobPrototype = globalThis.Blob?.prototype;
if (typeof globalThis.FileReader === 'function' && blobPrototype && typeof blobPrototype.stream !== 'function') {
    const originalDescriptor = Object.getOwnPropertyDescriptor(blobPrototype, 'stream');
    const originalResponseDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Response');
    const CurrentResponse = globalThis.Response;
    function stream(this: Blob): ReadableStream<Uint8Array> {
        const blob = this;
        const reader = new FileReader();
        let cancelled = false;
        return new ReadableStream<Uint8Array>({
            start(controller) {
                reader.onload = () => {
                    if (cancelled) return;
                    if (reader.result === null || typeof reader.result === 'string') {
                        controller.error(new Error('Blob read did not return bytes'));
                        return;
                    }
                    controller.enqueue(new Uint8Array(reader.result));
                    controller.close();
                };
                reader.onerror = () => { if (!cancelled) controller.error(reader.error); };
                reader.onabort = () => { if (!cancelled) controller.error(new DOMException('Blob read aborted', 'AbortError')); };
                reader.readAsArrayBuffer(blob);
            },
            cancel() { cancelled = true; reader.abort(); },
        });
    }
    Object.defineProperty(blobPrototype, 'stream', { value: stream, configurable: true, writable: true });
    // Fetch captured Node's Blob before JSDOM installed its own. Convert only the
    // DOM BodyInit at this SDK boundary; native Response keeps its own brand and statics.
    const DomResponse = new Proxy(CurrentResponse, {
        construct(target, args, newTarget) {
            const body: unknown = args[0];
            if (!(body instanceof Blob)) return Reflect.construct(target, args, newTarget);
            // These are the public Response constructor arguments; native WebIDL owns admission.
            const init = args[1] as ResponseInit | undefined;
            const headers = new Headers(init?.headers);
            if (body.type && !headers.has('content-type')) headers.set('content-type', body.type);
            return Reflect.construct(target, [body.stream(), { ...init, headers }], newTarget);
        },
    });
    Object.defineProperty(globalThis, 'Response', { value: DomResponse, configurable: true, writable: true });
    afterAll(() => {
        if (globalThis.Response === DomResponse) {
            if (originalResponseDescriptor) Object.defineProperty(globalThis, 'Response', originalResponseDescriptor);
            else Reflect.deleteProperty(globalThis, 'Response');
        }
        if (blobPrototype.stream === stream) {
            if (originalDescriptor) Object.defineProperty(blobPrototype, 'stream', originalDescriptor);
            else Reflect.deleteProperty(blobPrototype, 'stream');
        }
    });
}

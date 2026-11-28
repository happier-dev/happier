/**
 * The desktop shell's IPC global (`__TAURI_INTERNALS__`) as the desktop HTTP transport
 * (`utils/platform/tauri/transferFetch.ts`) meets it. Only the native boundary is substituted:
 * Request/Response, the Tauri `Channel` and streams stay real.
 */

export type DesktopHostCall = Readonly<{
    command: string;
    args: Record<string, unknown>;
    /** What the renderer passed to `invoke`: an args object, or the raw `desktop_http_fetch` request frame. */
    payload: Record<string, unknown> | Uint8Array;
}>;

/** Decodes a `[u32 LE head length][head JSON][body bytes]` frame, the shape of both directions. */
function decodeDesktopHttpFrame(frame: Uint8Array): Readonly<{ head: Record<string, unknown>; body: Uint8Array }> {
    const headLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headLength))) as Record<string, unknown>;
    return { head, body: frame.subarray(4 + headLength) };
}

/** The args a host reads from a raw request frame: `requestId` plus the request with its body bytes. */
function readDesktopHostArgs(payload: Record<string, unknown> | Uint8Array): Record<string, unknown> {
    if (!(payload instanceof Uint8Array)) return payload;
    const { head: { requestId, ...request }, body } = decodeDesktopHttpFrame(payload);
    return { requestId, clientConfig: { ...request, data: body.byteLength === 0 ? null : body } };
}

/** The host's answer to `desktop_http_fetch`: `[u32 LE head length][head JSON][body]`. */
export function desktopHttpFrame(head: Readonly<Record<string, unknown>>, body: string | Uint8Array = ''): ArrayBuffer {
    const encodedHead = new TextEncoder().encode(JSON.stringify(head));
    const encodedBody = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const frame = new Uint8Array(4 + encodedHead.byteLength + encodedBody.byteLength);
    new DataView(frame.buffer).setUint32(0, encodedHead.byteLength, true);
    frame.set(encodedHead, 4);
    frame.set(encodedBody, 4 + encodedHead.byteLength);
    return frame.buffer;
}

export function createDesktopHostInternals(answer: (call: DesktopHostCall) => unknown) {
    const calls: DesktopHostCall[] = [];
    const callbacks = new Map<number, (message: unknown) => void>();
    let nextCallbackId = 1;
    return {
        calls,
        /** Delivers one channel envelope (`{ index, message }`) as the host would. */
        deliver: (callbackId: number, message: unknown) => callbacks.get(callbackId)?.(message),
        internals: {
            transformCallback: (callback: (message: unknown) => void) => {
                const id = nextCallbackId++;
                callbacks.set(id, callback);
                return id;
            },
            unregisterCallback: (id: number) => { callbacks.delete(id); },
            invoke: async (command: string, payload: Record<string, unknown> | Uint8Array = {}) => {
                const call = { command, args: readDesktopHostArgs(payload), payload };
                calls.push(call);
                return await answer(call);
            },
        },
    };
}

type ClientConfig = Readonly<{
    method: string;
    url: string;
    headers: [string, string][];
    data: Uint8Array | null;
    maxRedirections?: number;
}>;

/** Answers `desktop_http_fetch` by performing the request with `fetchImpl`, as both shells do natively. */
export async function answerDesktopHttpFetch(call: DesktopHostCall, fetchImpl: typeof fetch = globalThis.fetch): Promise<ArrayBuffer> {
    if (call.command !== 'desktop_http_fetch') throw new Error(`Unexpected desktop IPC: ${call.command}`);
    const config = call.args.clientConfig as ClientConfig;
    const response = await fetchImpl(config.url, {
        method: config.method,
        headers: config.headers,
        ...(config.data ? { body: Uint8Array.from(config.data) } : {}),
        redirect: config.maxRedirections === 0 ? 'manual' : 'follow',
    });
    return desktopHttpFrame({
        status: response.status,
        statusText: response.statusText,
        url: response.url || config.url,
        headers: [...response.headers.entries()],
        streamed: false,
    }, new Uint8Array(await response.arrayBuffer()));
}

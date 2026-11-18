/**
 * The desktop shell's IPC global (`__TAURI_INTERNALS__`) as the desktop HTTP transport
 * (`utils/platform/tauri/transferFetch.ts`) meets it. Only the native boundary is substituted:
 * Request/Response, the Tauri `Channel` and streams stay real.
 */

export type DesktopHostCall = Readonly<{ command: string; args: Record<string, unknown> }>;

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
            invoke: async (command: string, args: Record<string, unknown> = {}) => {
                const call = { command, args };
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
    data: number[] | null;
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

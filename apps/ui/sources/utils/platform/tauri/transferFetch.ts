import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

import { invokeDesktopHost, isDesktopHost } from '../desktopHost';

function normalizeRequestUrl(input: RequestInfo | URL): string | null {
    if (input instanceof URL) {
        return input.toString();
    }

    if (typeof input === 'string') {
        const value = input.trim();
        return value ? value : null;
    }

    if (typeof Request !== 'undefined' && input instanceof Request) {
        const value = input.url.trim();
        return value ? value : null;
    }

    return null;
}

export function shouldUseTauriRuntimeFetch(input: RequestInfo | URL): boolean {
    const rawUrl = normalizeRequestUrl(input);
    if (!rawUrl) {
        return false;
    }

    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        return true;
    }

    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Desktop HTTP transport. Both shells implement these commands: Tauri in
 * `src-tauri/src/desktop_http.rs`, Electron in `apps/desktop/src/main/commands/httpTransport.ts`.
 * A request is one `fetch` invoke whose answer carries status, headers and, for a body the server
 * declared small, the body. Any other body streams through `readBody` into a channel.
 */
export const DESKTOP_HTTP_COMMANDS = {
    fetch: 'desktop_http_fetch',
    readBody: 'desktop_http_read_body',
    cancel: 'desktop_http_cancel',
} as const;

const REQUEST_CANCELLED = 'Request cancelled';
// https://fetch.spec.whatwg.org/#null-body-status
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
/** Last byte of a body channel message: 0 = a data chunk follows it, 1 = the body ended. */
const CHUNK_END = 1;

type DesktopHttpHead = Readonly<{
    status: number;
    statusText: string;
    url: string;
    headers: [string, string][];
    streamed: boolean;
}>;

let nextDesktopRequestId = 1;

function readFrameBytes(value: unknown): Uint8Array {
    if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
        return new Uint8Array(value as ArrayBuffer);
    }
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('desktop_http_fetch answered without a response frame');
}

/** Decodes the host frame `[u32 LE head length][head JSON][body bytes]`. */
function decodeFetchFrame(value: unknown): Readonly<{ head: DesktopHttpHead; body: Uint8Array }> {
    const frame = readFrameBytes(value);
    const headLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + headLength))) as DesktopHttpHead;
    return { head, body: frame.subarray(4 + headLength) };
}

/** The request as the browser would send it: init headers win, Request adds its own defaults. */
async function describeRequest(input: RequestInfo | URL, init: RequestInit | undefined) {
    const headers = new Headers(init?.headers);
    const request = new Request(input, init);
    const body = await request.arrayBuffer();
    for (const [name, value] of request.headers) {
        if (!headers.has(name)) headers.set(name, value);
    }
    return {
        method: request.method,
        url: request.url,
        headers: Array.from(headers.entries()),
        data: body.byteLength === 0 ? null : Array.from(new Uint8Array(body)),
        // The host reads redirect control from here, not from RequestInit.redirect.
        ...(init?.redirect === 'manual' ? { maxRedirections: 0 } : {}),
    };
}

function streamHostBody(requestId: number, signal: AbortSignal | null | undefined, cancelHost: () => void): ReadableStream<Uint8Array> {
    let finished = false;
    let stopAbortWatch = () => {};
    const finish = () => {
        finished = true;
        stopAbortWatch();
    };
    return new ReadableStream<Uint8Array>({
        start: async (controller) => {
            const onAbort = () => {
                if (finished) return;
                finish();
                cancelHost();
                controller.error(new Error(REQUEST_CANCELLED));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            stopAbortWatch = () => signal?.removeEventListener('abort', onAbort);
            const { Channel } = await import('@tauri-apps/api/core');
            const channel = new Channel<ArrayBuffer | number[]>((message) => {
                if (finished) return;
                const bytes = new Uint8Array(message);
                if (bytes[bytes.byteLength - 1] === CHUNK_END) {
                    finish();
                    controller.close();
                    return;
                }
                controller.enqueue(bytes.slice(0, -1));
            });
            invokeDesktopHost<null>(DESKTOP_HTTP_COMMANDS.readBody, { requestId, channel }).catch((error: unknown) => {
                if (finished) return;
                finish();
                controller.error(error);
            });
        },
        cancel: () => {
            if (finished) return;
            finish();
            cancelHost();
        },
    });
}

async function desktopHttpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const signal = init?.signal;
    if (signal?.aborted) throw new Error(REQUEST_CANCELLED);
    const clientConfig = await describeRequest(input, init);
    if (signal?.aborted) throw new Error(REQUEST_CANCELLED);

    const requestId = nextDesktopRequestId++;
    const cancelHost = () => {
        void invokeDesktopHost<null>(DESKTOP_HTTP_COMMANDS.cancel, { requestId }).catch(() => {});
    };
    signal?.addEventListener('abort', cancelHost, { once: true });
    let decoded: ReturnType<typeof decodeFetchFrame>;
    try {
        decoded = decodeFetchFrame(await invokeDesktopHost<unknown>(DESKTOP_HTTP_COMMANDS.fetch, { requestId, clientConfig }));
    } catch (error) {
        if (signal?.aborted) throw new Error(REQUEST_CANCELLED);
        throw error;
    } finally {
        signal?.removeEventListener('abort', cancelHost);
    }
    const { head, body } = decoded;
    // An abort can race the host's answer; a held body is then released, not returned.
    if (signal?.aborted) {
        if (head.streamed) cancelHost();
        throw new Error(REQUEST_CANCELLED);
    }

    const responseBody = NULL_BODY_STATUSES.has(head.status) ? null
        : head.streamed ? streamHostBody(requestId, signal, cancelHost)
        : body;
    const response = new Response(responseBody as BodyInit | null, { status: head.status, statusText: head.statusText });
    // url and headers are read-only on a constructed Response.
    Object.defineProperty(response, 'url', { value: head.url });
    Object.defineProperty(response, 'headers', { value: new Headers(head.headers) });
    return response;
}

export async function resolveTauriRuntimeFetch(input: RequestInfo | URL): Promise<RuntimeFetch | null> {
    return shouldUseTauriRuntimeFetch(input) && isDesktopHost() ? desktopHttpFetch : null;
}

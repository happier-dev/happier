import type { CommandArgs, CommandContext, CommandHandler } from './types';

/**
 * Host side of the desktop HTTP transport.
 *
 * Every `http(s)` request the app makes on desktop goes through
 * `apps/ui/sources/utils/platform/tauri/transferFetch.ts`; the Tauri target implements the same
 * commands in `apps/ui/src-tauri/src/desktop_http.rs`. Requests run in the main process, which is
 * what exempts them from the renderer's same-origin rules, as Rust does for Tauri.
 *
 *   `desktop_http_fetch`     -> performs the request and answers one frame:
 *                               `[u32 LE head length][head JSON][body]`. A body the server declared
 *                               no larger than {@link INLINE_BODY_LIMIT} is in the frame; any other
 *                               body is held and the head says `streamed: true`.
 *   `desktop_http_read_body` -> streams a held body into a channel: chunks end with a 0 byte, `[1]`
 *                               ends the body.
 *   `desktop_http_cancel`    -> ends a request in whichever phase it is.
 */

export const DESKTOP_HTTP_COMMANDS = {
    fetch: 'desktop_http_fetch',
    readBody: 'desktop_http_read_body',
    cancel: 'desktop_http_cancel',
} as const;

/** Same split as the Tauri host (`desktop_http.rs`): larger or undeclared bodies stream. */
export const INLINE_BODY_LIMIT = 1024 * 1024;

// https://fetch.spec.whatwg.org/#null-body-status
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
const REQUEST_CANCELLED = 'Request cancelled';
const CHUNK_MORE = 0;
const CHUNK_END = 1;

/** Tauri's own wire form for a `Channel`, produced by its `__TAURI_TO_IPC_KEY__` serializer. */
export const CHANNEL_ARG_PREFIX = '__CHANNEL__:';

/**
 * Reads the callback id out of a `Channel` argument.
 *
 * Tauri serializes a channel to `__CHANNEL__:<id>` through a method on the class prototype. Across
 * Electron's context-isolation boundary a prototype method is not reachable, so a channel arrives
 * as its own enumerable data — `{ id }` — instead. Both are the same value in different clothes,
 * and this is the single place that knows a channel is expected, so both are read here.
 */
export function parseChannelId(value: unknown): number | null {
    if (typeof value === 'string') {
        if (!value.startsWith(CHANNEL_ARG_PREFIX)) return null;
        const id = Number.parseInt(value.slice(CHANNEL_ARG_PREFIX.length), 10);
        return Number.isInteger(id) ? id : null;
    }
    if (value && typeof value === 'object') {
        const id = (value as { id?: unknown }).id;
        return typeof id === 'number' && Number.isInteger(id) ? id : null;
    }
    return null;
}

type ClientConfig = Readonly<{
    method: string;
    url: string;
    headers: readonly (readonly [string, string])[];
    data: readonly number[] | null;
    maxRedirections?: number;
}>;

export function parseClientConfig(value: unknown): ClientConfig | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method : '';
    const url = typeof record.url === 'string' ? record.url : '';
    if (!method || !url) return null;

    const headers = Array.isArray(record.headers)
        ? record.headers.flatMap((entry): [string, string][] =>
            Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
                ? [[entry[0], entry[1]]]
                : [])
        : [];

    const data = Array.isArray(record.data) ? record.data.filter((byte): byte is number => typeof byte === 'number') : null;

    return {
        method,
        url,
        headers,
        data,
        ...(typeof record.maxRedirections === 'number' ? { maxRedirections: record.maxRedirections } : {}),
    };
}

function encodeFrame(head: Readonly<Record<string, unknown>>, body: Uint8Array): Uint8Array {
    const encodedHead = Buffer.from(JSON.stringify(head), 'utf8');
    const frame = new Uint8Array(4 + encodedHead.byteLength + body.byteLength);
    new DataView(frame.buffer).setUint32(0, encodedHead.byteLength, true);
    frame.set(encodedHead, 4);
    frame.set(body, 4 + encodedHead.byteLength);
    return frame;
}

function bodyIsInline(method: string, status: number, contentLength: string | null): boolean {
    if (method.toUpperCase() === 'HEAD' || NULL_BODY_STATUSES.has(status)) return true;
    if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false;
    return Number(contentLength) <= INLINE_BODY_LIMIT;
}

type InFlight = {
    controller: AbortController;
    pendingBody: ReadableStream<Uint8Array> | null;
};

export class HttpTransportState {
    private readonly requests = new Map<string, InFlight>();

    private static key(context: CommandContext, requestId: number): string {
        return `${context.sender.id}:${requestId}`;
    }

    async fetch(requestId: number, config: ClientConfig, context: CommandContext): Promise<Uint8Array> {
        const key = HttpTransportState.key(context, requestId);
        const entry: InFlight = { controller: new AbortController(), pendingBody: null };
        this.requests.set(key, entry);
        try {
            const body = config.data && config.data.length > 0 ? new Uint8Array(config.data) : null;
            const response = await fetch(config.url, {
                method: config.method,
                headers: config.headers.map((header) => [header[0], header[1]]),
                ...(body ? { body } : {}),
                signal: entry.controller.signal,
                redirect: config.maxRedirections === 0 ? 'manual' : 'follow',
            });
            const streamed = response.body !== null
                && !bodyIsInline(config.method, response.status, response.headers.get('content-length'));
            const head = {
                status: response.status,
                statusText: response.statusText,
                url: response.url || config.url,
                headers: [...response.headers.entries()],
                streamed,
            };
            if (streamed) {
                entry.pendingBody = response.body;
                return encodeFrame(head, new Uint8Array());
            }
            const frame = encodeFrame(head, new Uint8Array(await response.arrayBuffer()));
            this.requests.delete(key);
            return frame;
        } catch (error) {
            this.requests.delete(key);
            if (entry.controller.signal.aborted) throw new Error(REQUEST_CANCELLED);
            throw error;
        }
    }

    async readBody(requestId: number, channelId: number, context: CommandContext): Promise<null> {
        const key = HttpTransportState.key(context, requestId);
        const entry = this.requests.get(key);
        const body = entry?.pendingBody ?? null;
        if (!entry || body === null) {
            this.requests.delete(key);
            throw new Error(`${DESKTOP_HTTP_COMMANDS.readBody}: no streamed body for request ${requestId}`);
        }
        entry.pendingBody = null;

        let index = 0;
        const send = (message: Uint8Array) => {
            context.sendCallback(channelId, { index, message });
            index += 1;
        };
        try {
            const reader = body.getReader();
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                const message = new Uint8Array(chunk.value.byteLength + 1);
                message.set(chunk.value);
                message[chunk.value.byteLength] = CHUNK_MORE;
                send(message);
            }
            send(Uint8Array.of(CHUNK_END));
            context.sendCallback(channelId, { index, end: true });
            return null;
        } catch (error) {
            if (entry.controller.signal.aborted) throw new Error(REQUEST_CANCELLED);
            throw error;
        } finally {
            this.requests.delete(key);
        }
    }

    cancel(requestId: number, context: CommandContext): null {
        const key = HttpTransportState.key(context, requestId);
        this.requests.get(key)?.controller.abort();
        this.requests.delete(key);
        return null;
    }

    /** Requests between their fetch and the end of their body. */
    get inFlightCount(): number {
        return this.requests.size;
    }
}

function readRequestId(args: CommandArgs): number {
    const requestId = args.requestId;
    if (typeof requestId !== 'number' || !Number.isInteger(requestId)) {
        throw new Error('desktop_http commands require a numeric requestId');
    }
    return requestId;
}

export function registerHttpTransportCommands(
    registry: Map<string, CommandHandler>,
    state: HttpTransportState,
): void {
    registry.set(DESKTOP_HTTP_COMMANDS.fetch, (args, context) => {
        const config = parseClientConfig(args.clientConfig);
        if (config === null) {
            throw new Error(`${DESKTOP_HTTP_COMMANDS.fetch} requires a clientConfig with a method and url`);
        }
        return state.fetch(readRequestId(args), config, context);
    });

    registry.set(DESKTOP_HTTP_COMMANDS.readBody, (args, context) => {
        const channelId = parseChannelId(args.channel);
        if (channelId === null) {
            throw new Error(`${DESKTOP_HTTP_COMMANDS.readBody} requires a serialized channel`);
        }
        return state.readBody(readRequestId(args), channelId, context);
    });

    registry.set(DESKTOP_HTTP_COMMANDS.cancel, (args, context) => state.cancel(readRequestId(args), context));
}

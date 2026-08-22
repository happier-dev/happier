import type { CommandArgs, CommandContext, CommandHandler } from './types';

/**
 * Host side of `@tauri-apps/plugin-http`.
 *
 * Every `http(s)` request the app makes on desktop is routed through this plugin by
 * `apps/ui/sources/utils/platform/tauri/transferFetch.ts`, so the app cannot reach a server without
 * it. Requests are performed from the main process, which is what makes them exempt from the
 * renderer's same-origin rules — the same reason the Tauri target performs them in Rust.
 *
 * The protocol is fixed by the plugin's JS half:
 *   `fetch`           -> stores the request, returns a request id
 *   `fetch_send`      -> performs it, returns status/headers and a response id
 *   `fetch_read_body` -> streams the body into a channel; a message whose last byte is 1 ends it
 *   `fetch_cancel`    -> aborts an in-flight request
 */

export const HTTP_PLUGIN_COMMANDS = {
    fetch: 'plugin:http|fetch',
    fetchSend: 'plugin:http|fetch_send',
    fetchReadBody: 'plugin:http|fetch_read_body',
    fetchCancel: 'plugin:http|fetch_cancel',
} as const;

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
    connectTimeout?: number;
}>;

/** Origin and path of an http-plugin request, with query and credentials stripped. */
export function describeRequestTarget(args: CommandArgs): string | null {
    const url = (args.clientConfig as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return null;
    }
}

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
        ...(typeof record.connectTimeout === 'number' ? { connectTimeout: record.connectTimeout } : {}),
    };
}

type PendingRequest = Readonly<{
    config: ClientConfig;
    controller: AbortController;
}>;

/**
 * Sends one channel message wrapped in the ordering envelope the plugin's `Channel` expects.
 * Ordering is the channel's correctness contract: it queues anything that arrives out of sequence.
 */
function sendChannelMessage(
    context: CommandContext,
    channelId: number,
    index: number,
    message: number[] | { end: true },
): void {
    const envelope = Array.isArray(message) ? { index, message } : { index, end: true };
    context.sendCallback(channelId, envelope);
}

export class HttpPluginState {
    private nextId = 1;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly bodies = new Map<number, Readonly<{ body: ReadableStream<Uint8Array> | null; controller: AbortController }>>();

    private allocateId(): number {
        const id = this.nextId;
        this.nextId += 1;
        return id;
    }

    createRequest(config: ClientConfig): number {
        const rid = this.allocateId();
        this.pending.set(rid, { config, controller: new AbortController() });
        return rid;
    }

    async send(rid: number): Promise<{
        status: number;
        statusText: string;
        url: string;
        headers: [string, string][];
        rid: number;
    }> {
        const request = this.pending.get(rid);
        if (!request) {
            throw new Error(`plugin:http|fetch_send: unknown request ${rid}`);
        }
        this.pending.delete(rid);

        const { config, controller } = request;
        const body = config.data && config.data.length > 0 ? new Uint8Array(config.data) : null;

        const response = await fetch(config.url, {
            method: config.method,
            headers: config.headers.map((entry) => [entry[0], entry[1]]),
            ...(body ? { body } : {}),
            signal: controller.signal,
            redirect: config.maxRedirections === 0 ? 'manual' : 'follow',
        });

        const responseRid = this.allocateId();
        this.bodies.set(responseRid, { body: response.body, controller });

        return {
            status: response.status,
            statusText: response.statusText,
            url: response.url || config.url,
            headers: [...response.headers.entries()].map(([name, value]) => [name, value]),
            rid: responseRid,
        };
    }

    /**
     * Streams a response body into the renderer channel. Data chunks carry a trailing `0`; a final
     * message of `[1]` is the plugin's end-of-stream signal, after which the callback is released.
     */
    async readBody(rid: number, channelId: number, context: CommandContext): Promise<null> {
        const entry = this.bodies.get(rid);
        if (!entry) {
            throw new Error(`plugin:http|fetch_read_body: unknown response ${rid}`);
        }
        this.bodies.delete(rid);

        let index = 0;
        if (entry.body !== null) {
            const reader = entry.body.getReader();
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                sendChannelMessage(context, channelId, index, [...chunk.value, 0]);
                index += 1;
            }
        }
        sendChannelMessage(context, channelId, index, [1]);
        sendChannelMessage(context, channelId, index + 1, { end: true });
        return null;
    }

    cancel(rid: number): null {
        this.pending.get(rid)?.controller.abort();
        this.pending.delete(rid);
        this.bodies.get(rid)?.controller.abort();
        this.bodies.delete(rid);
        return null;
    }
}

function readRid(args: CommandArgs): number {
    const rid = args.rid;
    if (typeof rid !== 'number' || !Number.isInteger(rid)) {
        throw new Error('plugin:http command requires a numeric rid');
    }
    return rid;
}

export function registerHttpPluginCommands(
    registry: Map<string, CommandHandler>,
    state: HttpPluginState,
): void {
    registry.set(HTTP_PLUGIN_COMMANDS.fetch, (args) => {
        const config = parseClientConfig(args.clientConfig);
        if (config === null) {
            throw new Error('plugin:http|fetch requires a clientConfig with a method and url');
        }
        return state.createRequest(config);
    });

    registry.set(HTTP_PLUGIN_COMMANDS.fetchSend, (args) => state.send(readRid(args)));

    registry.set(HTTP_PLUGIN_COMMANDS.fetchReadBody, (args, context: CommandContext) => {
        const channelId = parseChannelId(args.streamChannel);
        if (channelId === null) {
            throw new Error('plugin:http|fetch_read_body requires a serialized stream channel');
        }
        return state.readBody(readRid(args), channelId, context);
    });

    registry.set(HTTP_PLUGIN_COMMANDS.fetchCancel, (args) => state.cancel(readRid(args)));
}

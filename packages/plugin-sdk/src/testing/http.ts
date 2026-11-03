/** @moduleRealm daemon */
import { PluginError } from '../errors.js';
import { mergeAbortSignals } from '../abortSignals.js';
import type { HttpRequest, HttpResponse, HttpService, PreparedHttpRead } from '../services/io.js';

/** HTTP transport boundary only; production host policy admission remains real in host tests. */
export function createPluginHttpFixture(
    boundary: Readonly<{
        request(
            input: HttpRequest,
            options?: Parameters<HttpService['request']>[1],
        ): Promise<Omit<HttpResponse, 'finalUrl'> & { readonly finalUrl?: string }>;
        openWebSocket?: HttpService['openWebSocket'];
        requestStream?: HttpService['requestStream'];
    }>,
): HttpService {
    const send: HttpService['request'] = async (input, options) => {
        const response = await boundary.request(input, options);
        return { ...response, finalUrl: response.finalUrl ?? input.url };
    };
    return Object.freeze({
        request: send,
        requestStream: boundary.requestStream ?? (async () => {
            throw new PluginError({ code: 'plugin_fetch_adapter_unavailable', message: 'This HTTP fixture has no streaming boundary' });
        }),
        async prepareRead(input, options) {
            options?.signal?.throwIfAborted();
            const { intent, method = 'GET', ...transportInput } = input;
            if (!((intent === 'get' && method === 'GET') || (intent === 'graphqlQuery' && method === 'POST'))
                || 'credentialBinding' in input || input.redirect === 'follow') {
                throw new PluginError({ code: 'plugin_fetch_prepared_read_invalid', message: 'Only an exact GET or declared read-only GraphQL query can be prepared' });
            }
            const admitted = Object.freeze({
                ...transportInput,
                method,
                ...(input.headers === undefined ? {} : { headers: Object.freeze({ ...input.headers }) }),
                ...(input.body === undefined ? {} : { body: input.body.slice() }),
            });
            let consumed = false;
            const lifetime = new AbortController();
            return Object.freeze({
                async request({ signal }) {
                    if (consumed) throw new PluginError({ code: 'plugin_fetch_prepared_read_consumed', message: 'A prepared read can be requested only once' });
                    consumed = true;
                    const owner = mergeAbortSignals([lifetime.signal, signal]);
                    try {
                        owner.signal.throwIfAborted();
                        return await new Promise<HttpResponse>((resolve, reject) => {
                            const onAbort = () => reject(owner.signal.reason);
                            owner.signal.addEventListener('abort', onAbort, { once: true });
                            Promise.resolve().then(() => {
                                owner.signal.throwIfAborted();
                                return send(admitted, { signal: owner.signal });
                            }).then(resolve, reject).finally(() => owner.signal.removeEventListener('abort', onAbort));
                        });
                    } finally {
                        owner.dispose();
                        lifetime.abort();
                    }
                },
                async dispose() { lifetime.abort(); },
            } satisfies PreparedHttpRead);
        },
        openWebSocket: boundary.openWebSocket ?? (async () => {
            throw new PluginError({ code: 'plugin_websocket_permission_denied', message: 'This HTTP fixture has no WebSocket boundary' });
        }),
    } satisfies HttpService);
}

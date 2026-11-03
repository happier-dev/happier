import { describe, expect, it, vi } from 'vitest';
import { createPluginHttpFixture } from './http.js';

describe('public HTTP fixture prepared reads', () => {
    it('snapshots without sending, transfers cancellation to the request owner and consumes once like the host', async () => {
        const request = vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() }));
        const http = createPluginHttpFixture({ request });
        const invocation = new AbortController();
        const headers = { accept: 'application/json' };
        const body = new TextEncoder().encode('query { viewer { login } }');
        const read = await http.prepareRead({ intent: 'graphqlQuery', method: 'POST',
            url: 'https://example.test/graphql', redirect: 'error', headers, body }, { signal: invocation.signal });
        expect(request).not.toHaveBeenCalled();
        headers.accept = 'changed';
        body.fill(0);
        invocation.abort();
        await expect(read.request({ signal: new AbortController().signal })).resolves.toMatchObject({
            status: 200, finalUrl: 'https://example.test/graphql',
        });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'POST', headers: { accept: 'application/json' },
            body: new TextEncoder().encode('query { viewer { login } }'),
        }), expect.anything());
        await expect(read.request({ signal: new AbortController().signal })).rejects.toMatchObject({ code: 'plugin_fetch_prepared_read_consumed' });
        await read.dispose();
    });

    it('disposes an executing read by aborting its transport, and refuses an unused disposed handle', async () => {
        let transportSignal: AbortSignal | undefined;
        let enter!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const http = createPluginHttpFixture({ request: async (_input, options) => {
            transportSignal = options?.signal;
            enter();
            return new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }));
        } });
        const input = { intent: 'get', url: 'https://example.test/read', redirect: 'error' } as const;
        const read = await http.prepareRead(input);
        const result = read.request({ signal: new AbortController().signal }).catch(error => ({ error }));
        await entered;
        await read.dispose();
        expect(transportSignal?.aborted).toBe(true);
        await expect(result).resolves.toMatchObject({ error: { name: 'AbortError' } });
        const unused = await http.prepareRead(input);
        await unused.dispose();
        await expect(unused.request({ signal: new AbortController().signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});

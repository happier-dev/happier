import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod/mini';
import type { KvItem } from '@/sync/api/account/apiKv';

/** External opaque KV HTTP facts; Account codecs, CAS and tab reconciliation stay real. */
export function createAccountKvHttpFixture(options: Readonly<{ rows?: Map<string, KvItem> }> = {}) {
    const rows = options.rows ?? new Map<string, KvItem>();
    const requests: Array<{ method: string | undefined; path: string }> = [];
    const mutationsSchema = z.strictObject({ mutations: z.array(z.strictObject({
        key: z.string(), value: z.nullable(z.string()), version: z.number().check(z.int()),
    })) });
    const bulkSchema = z.strictObject({ keys: z.array(z.string()) });
    const handleFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response | null> => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname !== '/v1/kv' && !url.pathname.startsWith('/v1/kv/')) return null;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        requests.push({ method, path: url.pathname });
        const json = (value: unknown, status = 200) => Response.json(value, { status });
        if (method === 'GET') {
            if (url.pathname === '/v1/kv') {
                const prefix = url.searchParams.get('prefix') ?? '';
                return json({ items: [...rows.values()].filter(row => row.key.startsWith(prefix)) });
            }
            const row = rows.get(decodeURIComponent(url.pathname.slice('/v1/kv/'.length)));
            return json(row ?? { error: 'not_found' }, row ? 200 : 404);
        }
        const parsed: unknown = JSON.parse(await new Response(init?.body ?? (input instanceof Request ? input.body : null)).text());
        if (url.pathname === '/v1/kv/bulk') {
            const { keys } = bulkSchema.parse(parsed);
            return json({ values: keys.flatMap(key => rows.has(key) ? [rows.get(key)] : []) });
        }
        const { mutations } = mutationsSchema.parse(parsed);
        const errors = mutations.flatMap(mutation => {
            const row = rows.get(mutation.key);
            return mutation.version === (row?.version ?? -1) ? [] : [{ key: mutation.key,
                error: 'version-mismatch', version: row?.version ?? -1, value: row?.value ?? null }];
        });
        if (errors.length) return json({ success: false, errors }, 409);
        return json({ success: true, results: mutations.map(mutation => {
            const version = (rows.get(mutation.key)?.version ?? -1) + 1;
            if (mutation.value === null) rows.delete(mutation.key);
            else rows.set(mutation.key, { key: mutation.key, value: mutation.value, version });
            return { key: mutation.key, version };
        }) });
    };
    return {
        reset: () => { rows.clear(); requests.length = 0; },
        read: (key: string) => rows.get(key),
        readRequests: () => [...requests],
        handleFetch,
        handle: async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
            const url = new URL(request.url ?? '/', 'http://fixture.test');
            if (url.pathname !== '/v1/kv' && !url.pathname.startsWith('/v1/kv/')) return false;
            let body = '';
            for await (const chunk of request) body += String(chunk);
            const result = await handleFetch(url, { method: request.method, ...(body ? { body } : {}) });
            if (!result) return false;
            response.statusCode = result.status;
            response.setHeader('Content-Type', 'application/json');
            response.end(await result.text());
            return true;
        },
    };
}

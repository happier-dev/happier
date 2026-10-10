import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { KvItem } from '@/sync/api/account/apiKv';

/** External opaque KV HTTP facts; Account codecs, CAS and tab reconciliation stay real. */
export function createAccountKvHttpFixture() {
    const rows = new Map<string, KvItem>();
    const mutationsSchema = z.object({ mutations: z.array(z.object({
        key: z.string(), value: z.string().nullable(), version: z.number().int(),
    }).strict()) }).strict();
    const bulkSchema = z.object({ keys: z.array(z.string()) }).strict();
    return {
        reset: () => rows.clear(),
        read: (key: string) => rows.get(key),
        handle: async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
            const url = new URL(request.url ?? '/', 'http://fixture.test');
            if (url.pathname !== '/v1/kv' && !url.pathname.startsWith('/v1/kv/')) return false;
            const json = (value: unknown, status = 200) => {
                response.statusCode = status;
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify(value));
            };
            if (request.method === 'GET') {
                if (url.pathname === '/v1/kv') {
                    const prefix = url.searchParams.get('prefix') ?? '';
                    json({ items: [...rows.values()].filter(row => row.key.startsWith(prefix)) });
                } else {
                    const row = rows.get(decodeURIComponent(url.pathname.slice('/v1/kv/'.length)));
                    json(row ?? { error: 'not_found' }, row ? 200 : 404);
                }
                return true;
            }
            let body = '';
            for await (const chunk of request) body += String(chunk);
            const parsed: unknown = JSON.parse(body);
            if (url.pathname === '/v1/kv/bulk') {
                const { keys } = bulkSchema.parse(parsed);
                json({ values: keys.flatMap(key => rows.has(key) ? [rows.get(key)] : []) });
                return true;
            }
            const { mutations } = mutationsSchema.parse(parsed);
            const errors = mutations.flatMap(mutation => {
                const row = rows.get(mutation.key);
                return mutation.version === (row?.version ?? -1) ? [] : [{ key: mutation.key,
                    error: 'version-mismatch', version: row?.version ?? -1, value: row?.value ?? null }];
            });
            if (errors.length) json({ success: false, errors }, 409);
            else json({ success: true, results: mutations.map(mutation => {
                const version = (rows.get(mutation.key)?.version ?? -1) + 1;
                if (mutation.value === null) rows.delete(mutation.key);
                else rows.set(mutation.key, { key: mutation.key, value: mutation.value, version });
                return { key: mutation.key, version };
            }) });
            return true;
        },
    };
}

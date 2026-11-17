import { describe, expect, it } from 'vitest';
import { createApiProjectAccountRowsTransport } from './apiProjectAccountRows';

describe('Project row authoring metadata negotiation', () => {
    it('binds exact reads to the requested key and preserves deleted and absent results', async () => {
        const key = { kind: 'project-organization' as const, serverId: 'home', projectKey: 'selected' };
        const bodies: unknown[] = [];
        let response: unknown = { status: 'absent' };
        const transport = createApiProjectAccountRowsTransport({ request: async (path, init, options) => {
            expect(path).toBe('/v1/account/project-rows/read');
            expect(options?.recoveryRead).toBe('unbounded');
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json(response);
        } });
        expect(await transport.read(key)).toEqual({ status: 'absent' });
        response = { status: 'deleted', revision: 3 };
        expect(await transport.read(key)).toEqual(response);
        response = { status: 'present', row: { key: { ...key, projectKey: 'other' }, revision: 1,
            content: { t: 'plain', v: { key: { ...key, projectKey: 'other' }, value: {} } } } };
        await expect(transport.read(key)).rejects.toThrow();
        expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ key, includeAuthoringSession: true })));
    });
    it('requests ids explicitly, falls back once on a legacy schema refusal, and remembers that server for later demand', async () => {
        const bodies: unknown[] = [];
        const transport = createApiProjectAccountRowsTransport({ request: async (_path, init) => {
            const body: unknown = JSON.parse(String(init?.body));
            bodies.push(body);
            if (body && typeof body === 'object' && 'includeAuthoringSession' in body) {
                return Response.json({ error: 'invalid-params' }, { status: 400 });
            }
            return Response.json({ status: 'listed', coverage: 'complete', rows: [] });
        } });
        expect(await transport.list()).toMatchObject({ status: 'listed', rows: [] });
        expect(await transport.list()).toMatchObject({ status: 'listed', rows: [] });
        // Navigation excludes demanded defaults (Plan F U2); an older server lists its default census.
        expect(bodies).toEqual([{ kinds: ['workspace-ref', 'relationship-graph', 'project-organization', 'services-organization'],
            includeAuthoringSession: true }, {}, {}]);
    });

    it('propagates unrelated refusals without downgrading to an unrestricted read', async () => {
        let reads = 0;
        const transport = createApiProjectAccountRowsTransport({ request: async () => {
            reads++;
            return Response.json({ error: 'forbidden' }, { status: 403 });
        } });
        await expect(transport.list()).rejects.toThrow();
        expect(reads).toBe(1);
    });
});

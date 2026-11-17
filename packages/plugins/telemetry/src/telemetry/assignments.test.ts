import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createOtlpRequestHandler } from '../otlp/receiver.js';
import { createTelemetryAssignments } from './assignments.js';
import type { TelemetryContext } from './assignments.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
    })));
});

async function listen(handler: RequestListener) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    return `http://127.0.0.1:${address.port}`;
}

describe('collector token assignments', () => {
    it('authenticates by hash, rotates on replacement, and removes only withdrawn assignments', async () => {
        const assignments = createTelemetryAssignments();
        const admitted: TelemetryContext[] = [];
        const url = await listen((request, response) => {
            const result = assignments.admit(request);
            if (result.accepted) admitted.push(result.context);
            response.statusCode = result.accepted ? 200 : result.status;
            response.end();
        });
        assignments.replace([
            { environmentId: 'A', tokenHash: digest(tokenA) },
            { environmentId: 'B', tokenHash: digest(tokenB) },
            { environmentId: 'pending', tokenHash: null },
        ]);
        const send = (token: string) => fetch(url, { headers: { authorization: `Bearer ${token}` } });
        expect((await send(tokenA)).status).toBe(200);
        expect((await send(tokenB)).status).toBe(200);
        expect(admitted).toEqual([
            { environmentId: 'A', partition: 'environment:A' },
            { environmentId: 'B', partition: 'environment:B' },
        ]);
        // Deploy settle replaces A's hash; a setup-time rotation has not touched this snapshot.
        assignments.replace([{ environmentId: 'A', tokenHash: digest('new-A') }]);
        expect((await send(tokenA)).status).toBe(401);
        expect((await send(tokenB)).status).toBe(401);
        expect((await send('new-A')).status).toBe(200);
        expect((await fetch(url)).status).toBe(401);
        expect((await fetch(url, { headers: { authorization: `Basic ${tokenA}` } })).status).toBe(401);
        expect((await send(`${'new-A'} extra`)).status).toBe(401);
    });

    it('uses the shared HTTP receiver and token partition despite forged resource attributes', async () => {
        const assignments = createTelemetryAssignments();
        assignments.replace([{ environmentId: 'A', tokenHash: digest(tokenA) }]);
        const contexts: TelemetryContext[] = [];
        const handler = createOtlpRequestHandler<TelemetryContext>({
            context: { environmentId: 'unused', partition: 'unused' },
            admit: request => assignments.admit(request),
            normalizeStatement: () => { throw new Error('No SQL in transport fixture'); },
            onBatch: (_batch, context) => { contexts.push(context); return { accepted: true }; },
        });
        const url = await listen((request, response) => { void handler(request, response); });
        const body = JSON.stringify({ resourceSpans: [{
            resource: { attributes: [
                { key: 'service.name', value: { stringValue: 'environment:B' } },
                { key: 'environment.id', value: { stringValue: 'B' } },
            ] },
            scopeSpans: [{ spans: [{
                traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef',
                name: 'request', kind: 2, startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000010000000',
            }] }],
        }] });
        const send = (token?: string) => fetch(`${url}/v1/traces`, {
            method: 'POST', body, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        });
        expect((await send(tokenA)).status).toBe(200);
        expect(contexts).toEqual([{ environmentId: 'A', partition: 'environment:A' }]);
        expect((await send()).status).toBe(401);
        expect((await send(tokenB)).status).toBe(401);
        // A sender that has transmitted only headers must receive its refusal without
        // sending the promised body; awaiting the body first would never settle here.
        const headersOnly = await new Promise<number | undefined>((resolve, reject) => {
            const request = httpRequest(`${url}/v1/traces`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000000' },
            }, response => { response.resume(); resolve(response.statusCode); request.destroy(); });
            request.once('error', reject);
            request.flushHeaders();
        });
        expect(headersOnly).toBe(401);
        expect(contexts).toHaveLength(1);
    });
});

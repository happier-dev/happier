import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { createRunnerManagedProviderConsumerAccess } from './runnerManagedProviderConsumerAccess';

describe('runner shared Provider consumer access', () => {
    it('cancels one consumer stream without closing another consumer of the same gateway', async () => {
        const streams: ServerResponse[] = [];
        const requests: IncomingHttpHeaders[] = [];
        const upstream = createServer((request, response) => {
            requests.push(request.headers);
            response.writeHead(200, { 'content-type': 'text/plain' });
            streams.push(response);
            response.write('started');
        });
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
        const address = upstream.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback gateway');
        const lifetime = new AbortController();
        const createConsumer = () => createRunnerManagedProviderConsumerAccess({
            signal: lifetime.signal,
            credentialTransport: { id: 'bearer', protocols: ['anthropic'], uses: ['runtime'], destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' } },
            // This is the authenticated private RPC response boundary. The HTTP
            // application, credential substitution and socket lifetime are real.
            readAccess: async () => ({ endpointUrl: `http://127.0.0.1:${address.port}/v1`, headers: { authorization: 'Bearer daemon-consumer' } }),
            materialize: async ({ endpointUrl, credentialPlaceholder }) => ({ v: 1, kind: 'spawnEnv', env: [
                { name: 'URL', value: endpointUrl, source: 'provider' },
                { name: 'TOKEN', value: credentialPlaceholder, source: 'provider' },
            ] }),
        });
        const consumers = await Promise.all([createConsumer(), createConsumer()]);
        const firstRequest = new AbortController();
        const open = async (index: number, signal?: typeof firstRequest.signal) => {
            const consumer = consumers[index]!;
            const publicEnvironment = Object.fromEntries(consumer.materialization.env.flatMap((entry) => entry.value === null ? [] : [[entry.name, entry.value]]));
            const environment = consumer.transformLaunchEnvironment(publicEnvironment);
            const response = await fetch(`${environment.URL}/messages`, { headers: { authorization: `Bearer ${environment.TOKEN}`,
                'x-api-key': 'caller-other-credential', 'x-happier-machine-local-capability': 'caller-transport-capability' }, ...(signal ? { signal } : {}) });
            const reader = response.body!.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toBe('started');
            return reader;
        };
        try {
            const first = await open(0, firstRequest.signal);
            const second = await open(1);
            for (const headers of requests) {
                expect(headers.authorization).toBe('Bearer daemon-consumer');
                expect(headers['x-api-key']).toBeUndefined();
                expect(headers['x-happier-machine-local-capability']).toBeUndefined();
            }
            firstRequest.abort();
            await vi.waitFor(() => expect(streams[0]?.destroyed).toBe(true));
            expect(streams[1]?.destroyed).toBe(false);
            await consumers[0]!.cleanup();
            streams[1]!.write('still-alive');
            expect(new TextDecoder().decode((await second.read()).value)).toBe('still-alive');
            streams[1]!.end();
            expect((await second.read()).done).toBe(true);
            await first.cancel().catch(() => undefined);
            await second.cancel();
        } finally {
            lifetime.abort();
            await Promise.all(consumers.map((consumer) => consumer.cleanup()));
            for (const response of streams) response.destroy();
            await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
        }
    });
});

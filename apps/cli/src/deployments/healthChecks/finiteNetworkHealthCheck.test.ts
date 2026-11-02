import { Resolver } from 'node:dns/promises';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthCheckResultV1Schema } from '@happier-dev/deployment-protocol/v1';
import { readDnsHealthCheckV1, readTcpHealthCheckV1 } from './finiteNetworkHealthCheck';

const basis = { observer: { machineId: 'observer', installationId: 'installation' }, vantage: 'sameMachine' as const };
const context = () => ({ signal: new AbortController().signal, now: () => 1000 });

describe('finite TCP and DNS saved checks', () => {
    afterEach(() => vi.restoreAllMocks());

    it('connects only the selected TCP endpoint and reports a refused connection without exposing the endpoint', async () => {
        const server = createServer(socket => socket.end());
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP listener required');
        const check = { ...basis, host: '127.0.0.1', port: address.port };
        try {
            const result = HealthCheckResultV1Schema.parse(await readTcpHealthCheckV1(check, context()));
            expect(result.status).toBe('up');
            expect(JSON.stringify(result)).not.toContain(check.host);
            expect(result.evidence.items[0]?.text).toContain('not from outside');
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
        expect((await readTcpHealthCheckV1(check, context())).status).toBe('down');
    });

    it('resolves the exact DNS record and distinguishes expected-answer mismatch, absence and unavailable resolver', async () => {
        const resolve = vi.spyOn(Resolver.prototype, 'resolve');
        resolve.mockResolvedValue(['192.0.2.1']);
        const check = { ...basis, hostname: 'private.example.test', recordType: 'A' as const, expectedAnswer: '192.0.2.1' };
        const result = HealthCheckResultV1Schema.parse(await readDnsHealthCheckV1(check, context()));
        expect(result.status).toBe('up');
        expect(resolve).toHaveBeenCalledWith(check.hostname, 'A');
        expect(JSON.stringify(result)).not.toContain(check.hostname);
        expect(JSON.stringify(result)).not.toContain(check.expectedAnswer);
        resolve.mockResolvedValue(['192.0.2.2']);
        expect((await readDnsHealthCheckV1(check, context())).status).toBe('down');
        resolve.mockRejectedValue(Object.assign(new Error('private native error'), { code: 'ENODATA' }));
        expect((await readDnsHealthCheckV1(check, context())).status).toBe('down');
        resolve.mockRejectedValue(Object.assign(new Error('private native error'), { code: 'ESERVFAIL' }));
        expect((await readDnsHealthCheckV1(check, context())).status).toBe('unknown');
    });

    it('cancels the native resolver and keeps cancellation unavailable rather than opening an outage', async () => {
        const abort = new AbortController();
        const cancel = vi.spyOn(Resolver.prototype, 'cancel');
        vi.spyOn(Resolver.prototype, 'resolve').mockImplementation(() => new Promise((_resolve, reject) => {
            abort.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' })), { once: true });
        }));
        const pending = readDnsHealthCheckV1({ ...basis, hostname: 'private.example.test', recordType: 'A' },
            { ...context(), signal: abort.signal });
        abort.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancel).toHaveBeenCalledOnce();
    });
});

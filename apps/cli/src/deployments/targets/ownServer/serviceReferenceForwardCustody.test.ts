import { createServer } from 'node:net';
import { getEventListeners, once } from 'node:events';
import { expect, it } from 'vitest';
import { createServiceReferenceForwardCustody } from './serviceReferenceForwardCustody';

it('retains a host-local collector bridge through the same consuming service lifetime', async () => {
    const bridge = createServer();
    bridge.listen(0, '127.0.0.1');
    await once(bridge, 'listening');
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('TCP listener required');
    const host = new AbortController();
    const consumer = new AbortController();
    const custody = createServiceReferenceForwardCustody({ signal: host.signal,
        async acquire() { throw new Error('Local collector must not acquire a peer transport'); } });
    try {
        custody.adopt({ host: '127.0.0.1', port: address.port, observedPath: 'direct',
            close: () => new Promise<void>((resolve, reject) => bridge.close(error => error ? reject(error) : resolve())) });
        custody.retain([consumer.signal]);
        await custody.release();
        expect(bridge.listening).toBe(true);
        const closed = once(bridge, 'close');
        consumer.abort();
        await closed;
        expect(bridge.listening).toBe(false);
    } finally { host.abort(); if (bridge.listening) await new Promise<void>(resolve => bridge.close(() => resolve())); }
});

it('keeps the acquired listener after launch release until every consuming service retires', async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP listener required');
    const host = new AbortController();
    let acquisitions = 0;
    const custody = createServiceReferenceForwardCustody({ signal: host.signal, async acquire() {
        acquisitions++;
        return { host: '127.0.0.1', port: address.port, observedPath: 'direct',
            close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
    } });
    const admission = { kind: 'iroh', machineId: 'source', scheme: 'postgres', serviceExport: {
        exportKey: 'database', installationId: 'installed', deploymentId: 'deployed', generation: 'current',
        service: { kind: 'deployment', machineId: 'source', environmentId: 'data', environmentInstanceId: 'data-instance',
            composeService: 'db', serviceId: 'data-instance/db' }, destination: { host: '127.0.0.1', port: 5432 },
    } } as const;
    const one = new AbortController();
    const two = new AbortController();
    const failures: (string | null)[] = [];
    try {
        await custody.acquire(admission);
        await custody.acquire(admission);
        expect(acquisitions).toBe(1);
        custody.retain([one.signal, two.signal], failure => failures.push(failure?.errorCode ?? null));
        custody.reportFailure(admission, { ok: false, errorCode: 'private_service_destination_unreachable', error: 'private_service_destination_unreachable' });
        custody.reportFailure({ ...admission, machineId: 'other-source' }, null);
        expect(failures.at(-1)).toBe('private_service_destination_unreachable');
        await custody.release();
        expect(server.listening).toBe(true);
        one.abort();
        expect(server.listening).toBe(true);
        const closed = once(server, 'close');
        two.abort();
        await closed;
        expect(server.listening).toBe(false);
        expect(getEventListeners(host.signal, 'abort')).toEqual([]);
        expect(getEventListeners(one.signal, 'abort')).toEqual([]);
        expect(getEventListeners(two.signal, 'abort')).toEqual([]);
    } finally { host.abort(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
});

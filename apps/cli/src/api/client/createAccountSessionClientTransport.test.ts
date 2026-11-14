import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The network socket is the system boundary: everything above it stays real.
const created = vi.hoisted(() => [] as FakeServerSocket[]);
class FakeServerSocket extends EventEmitter {
    connected = false;
    active = false;
    connectCalls = 0;
    disconnectCalls = 0;
    connect() { this.connectCalls += 1; this.active = true; return this; }
    disconnect() { this.disconnectCalls += 1; this.active = false; if (this.connected) { this.connected = false; this.emit('disconnect', 'io client disconnect'); } return this; }
    close() { return this.disconnect(); }
    onAny(listener: (event: string, ...args: unknown[]) => void) {
        const emit = this.emit.bind(this);
        this.emit = (event: string | symbol, ...args: unknown[]) => {
            if (typeof event === 'string' && event !== 'connect' && event !== 'disconnect') listener(event, ...args);
            return emit(event, ...args);
        };
        return this;
    }
    serverConnects() { this.connected = true; this.emit('connect'); }
}
vi.mock('@/api/session/sockets', () => ({
    createUserScopedSocket: () => { const socket = new FakeServerSocket(); created.push(socket); return socket; },
}));

const { createAccountSessionClientTransport } = await import('./createAccountSessionClientTransport');
const { shareAccountUpdatesInThisProcess } = await import('@/api/session/sharedAccountUpdatesSocket');

describe('createAccountSessionClientTransport Account updates', () => {
    afterEach(() => { created.length = 0; });

    it('keeps one socket per Session client outside a session host', () => {
        createAccountSessionClientTransport('token-0').createAccountUpdatesSocket!();
        createAccountSessionClientTransport('token-0').createAccountUpdatesSocket!();
        expect(created).toHaveLength(2);
    });

    it('shares one Account update connection across the Sessions of a session host and fans updates out to attached Sessions', async () => {
        shareAccountUpdatesInThisProcess();
        const views = [0, 1, 2].map(() => createAccountSessionClientTransport('token-1').createAccountUpdatesSocket!());
        const received = views.map(() => [] as unknown[]);
        views.forEach((view, index) => view.on('update', (update: unknown) => { received[index]!.push(update); }));
        views[0]!.connect();
        views[1]!.connect();
        expect(created).toHaveLength(1);
        const server = created[0]!;
        expect(server.connectCalls).toBe(1);
        const connects = views.map(() => 0);
        views.forEach((view, index) => view.on('connect', () => { connects[index]! += 1; }));
        server.serverConnects();
        expect(connects).toEqual([1, 1, 0]);
        server.emit('update', { body: { t: 'account-change' } });
        // Delivery follows demand: an unattached Session receives nothing.
        expect(received.map(list => list.length)).toEqual([1, 1, 0]);
        // A later attach joins the open connection without another connect.
        views[2]!.connect();
        await Promise.resolve();
        expect(connects[2]).toBe(1);
        expect(server.connectCalls).toBe(1);
        expect(views.map(view => view.connected)).toEqual([true, true, true]);
        // One Session releasing its demand leaves the shared connection open.
        views[0]!.disconnect();
        expect(server.disconnectCalls).toBe(0);
        expect(views[0]!.connected).toBe(false);
        server.emit('update', { body: { t: 'account-change' } });
        expect(received.map(list => list.length)).toEqual([1, 2, 1]);
        views[1]!.close();
        views[2]!.close();
        expect(server.disconnectCalls).toBe(1);
        // A different credential is a different Account stream.
        createAccountSessionClientTransport('token-2').createAccountUpdatesSocket!();
        expect(created).toHaveLength(2);
    });
});

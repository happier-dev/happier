import { expect, it } from 'vitest';

import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { shareAccountUpdatesInThisProcess } from '@/api/session/sharedAccountUpdatesSocket';
import { createAccountSessionClientTransport } from './createAccountSessionClientTransport';
import { runWithServerHttpBaseUrl } from './serverHttpBaseUrl';

it('keeps standalone Session clients on independent Account connections', async () => {
    const home = await createRequesterCurrentnessSocketHarness();
    const open = runWithServerHttpBaseUrl(home.serverUrl,
        () => createAccountSessionClientTransport('standalone').createAccountUpdatesSocket!);
    const first = open();
    const second = open();
    try {
        first.connect();
        second.connect();
        await expect.poll(() => home.server.sockets.sockets.size).toBe(2);
        first.disconnect();
        await expect.poll(() => home.server.sockets.sockets.size).toBe(1);
        expect(second.connected).toBe(true);
    } finally {
        first.close();
        second.close();
        await home.close();
    }
});

it('restores the shared Account stream after a transport drop without a Session reconnect', async () => {
    const home = await createRequesterCurrentnessSocketHarness();
    shareAccountUpdatesInThisProcess();
    const open = runWithServerHttpBaseUrl(home.serverUrl,
        () => createAccountSessionClientTransport('account-reconnect').createAccountUpdatesSocket!);
    const first = open();
    const second = open();
    const released = open();
    const otherCredential = runWithServerHttpBaseUrl(home.serverUrl,
        () => createAccountSessionClientTransport('other-account').createAccountUpdatesSocket!());
    const received = [first, second, released].map(view => {
        const updates: unknown[] = [];
        view.on('update', (update: unknown) => { updates.push(update); });
        return updates;
    });
    try {
        first.connect();
        second.connect();
        otherCredential.connect();
        await expect.poll(() => [...home.server.sockets.sockets.values()].map(socket => socket.handshake.auth.token).sort())
            .toEqual(['account-reconnect', 'other-account']);
        otherCredential.close();
        let lateConnect = false;
        released.on('connect', () => { lateConnect = true; });
        released.connect();
        await expect.poll(() => lateConnect).toBe(true);
        await expect.poll(() => home.server.sockets.sockets.size).toBe(1);
        home.server.emit('update', { body: { t: 'update-account', id: 'account' } });
        await expect.poll(() => received.map(updates => updates.length)).toEqual([1, 1, 1]);
        released.disconnect();
        const original = [...home.server.sockets.sockets.values()][0]!;
        original.conn.close();
        await expect.poll(() => [...home.server.sockets.sockets.keys()].filter(id => id !== original.id)).toHaveLength(1);
        await expect.poll(() => first.connected && second.connected).toBe(true);
        home.server.emit('update', { body: { t: 'update-account', id: 'account' } });
        await expect.poll(() => received.map(updates => updates.length)).toEqual([2, 2, 1]);
        first.disconnect();
        second.disconnect();
        await expect.poll(() => home.server.sockets.sockets.size).toBe(0);
    } finally {
        first.close();
        second.close();
        released.close();
        otherCredential.close();
        await home.close();
    }
});

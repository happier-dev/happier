import { Duplex, PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';

import { currentSessionHolderScope, registerSessionMcpRelayAcceptor, SessionHolderChild } from './sessionHolder';
it('routes held relays to their own registration and refuses unresolved registrations', async () => {
    // The native holder channel is the transport boundary; use the real frame decoder and registry.
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    outgoing.resume();
    const channel = Duplex.from({ readable: incoming, writable: outgoing });
    const child = new SessionHolderChild('/unused-fixture.sock');
    child.attachSocket(channel, () => undefined);
    const served: string[] = [];
    const scope = currentSessionHolderScope();
    const unregisterParent = registerSessionMcpRelayAcceptor(scope, relay => { served.push('parent'); relay.stdin.end(); }, 'a'.repeat(64));
    const unregisterRun = registerSessionMcpRelayAcceptor(scope, relay => { served.push('run'); relay.stdin.end(); }, 'b'.repeat(64));
    let sequence = 0;
    const relay = async (registrationId?: unknown) => {
        const options = Buffer.from(JSON.stringify(registrationId === undefined ? {} : { registrationId }));
        const frame = Buffer.alloc(17 + options.length);
        frame.write('M');
        frame.writeUInt32BE(12 + options.length, 1);
        frame.writeBigUInt64BE(BigInt(++sequence), 5);
        frame.writeUInt32BE(sequence, 13);
        options.copy(frame, 17);
        incoming.write(frame);
        await setImmediate();
    };
    try {
        await relay('b'.repeat(64));
        expect(served).toEqual(['run']);
        await relay('c'.repeat(64));
        await relay();
        await relay(null);
        expect(served).toEqual(['run']);
        const unregisterDuplicate = registerSessionMcpRelayAcceptor(scope, relay => { served.push('duplicate'); relay.stdin.end(); }, 'b'.repeat(64));
        try { await relay('b'.repeat(64)); expect(served).toEqual(['run']); }
        finally { unregisterDuplicate(); }
        unregisterParent();
        await relay();
        expect(served).toEqual(['run', 'run']);
        await relay(null);
        expect(served).toEqual(['run', 'run']);
    } finally {
        unregisterParent();
        unregisterRun();
        child.detach();
        incoming.destroy();
        outgoing.destroy();
    }
});

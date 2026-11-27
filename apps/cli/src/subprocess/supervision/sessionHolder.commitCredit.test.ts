import { Duplex, PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';

import { SessionHolderChild } from './sessionHolder';
import { getHolderReplayRange, type HolderReplayRange } from './sessionHolderReplayPosition';

it('preserves exited stdout for a late transcript consumer and credits only committed bytes', async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const channel = Duplex.from({ readable: incoming, writable: outgoing });
    const child = new SessionHolderChild('/unused-credit-fixture.sock', 'primary');
    const acknowledged: number[] = [];
    const stdout: HolderReplayRange[] = [];
    outgoing.on('data', (bytes: Buffer) => {
        for (let offset = 0; offset < bytes.length;) {
            const length = bytes.readUInt32BE(offset + 1);
            if (String.fromCharCode(bytes[offset]!) === 'a') {
                acknowledged.push(Number(bytes.readBigUInt64BE(offset + 5)));
            }
            offset += length + 5;
        }
    });
    const send = (kind: string, body: string, sequence?: number) => {
        const payload = Buffer.from(body);
        const header = Buffer.alloc(sequence === undefined ? 5 : 13);
        header.write(kind);
        header.writeUInt32BE(header.length - 5 + payload.length, 1);
        if (sequence !== undefined) header.writeBigUInt64BE(BigInt(sequence), 5);
        incoming.write(Buffer.concat([header, payload]));
    };

    try {
        child.enableTranscriptCommitCredit();
        child.attachSocket(channel, () => undefined);
        send('H', JSON.stringify({ protocol: 1, holderPid: 1, agentPid: 2, replayFrom: 41 }));
        send('o', 'first\nsecond\npar', 41);
        send('o', 'tial\n', 42);
        send('x', JSON.stringify({ code: 42, signal: null }), 43);
        send('z', '', 44);
        await setImmediate();
        child.stdout.on('data', (bytes: Buffer) => {
            const range = getHolderReplayRange(bytes);
            if (range) stdout.push(range);
        });
        await setImmediate();
        expect(stdout).toHaveLength(2);
        expect(acknowledged).toEqual([]);

        const { holderInstanceId } = stdout[0]!;
        const accept = (startSequence: number, startOffset: number, endSequence: number, endOffset: number) => {
            child.acceptTranscriptRange({
                holderInstanceId,
                start: { sequence: startSequence, byteOffset: startOffset },
                end: { sequence: endSequence, byteOffset: endOffset },
            });
        };
        accept(41, 6, 41, 13);
        accept(41, 0, 41, 6);
        await setImmediate();
        expect(acknowledged).toEqual([]);

        accept(41, 13, 42, 5);
        await setImmediate();
        expect(acknowledged).toEqual([42]);

        expect(child.exitCode).toBe(42);
        expect(channel.writable).toBe(true);
        expect(acknowledged).toEqual([42]);

        child.acceptTranscriptExit();
        await setImmediate();
        expect(acknowledged).toEqual([42, 44]);
    } finally {
        child.detach();
        incoming.destroy();
        outgoing.destroy();
    }
});

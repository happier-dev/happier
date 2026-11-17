import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { openNativeDockerStream } from './nativeDockerStream';

describe('borrowed native Docker stream', () => {
    it.each(['close', 'abort'] as const)('preserves binary duplex traffic and settles its process on %s without releasing the generation', async stop => {
        const controller = new AbortController();
        const cwd = await realpath(tmpdir());
        let releases = 0;
        const args = ['exec', '--interactive', 'selected-container', 'protocol'];
        // The real supervised OS boundary substitutes a small protocol peer for Docker.
        const script = `process.stdout.write(JSON.stringify({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(1),marker:process.env.NATIVE_STREAM_TEST})+'\\n');process.stdin.on('data',bytes=>process.stdout.write(bytes));`;
        const borrowed = await openNativeDockerStream({ command: process.execPath, args: [], cwd,
            env: { NATIVE_STREAM_TEST: 'retained-launch' }, release() { releases++; } },
        ['-e', script, '--'], args, controller.signal);
        try {
            const [ready] = await once(borrowed.stream, 'data');
            const peer = JSON.parse(Buffer.from(ready).toString('utf8')) as { pid: number; cwd: string; args: string[]; marker: string };
            expect(peer).toMatchObject({ cwd, args, marker: 'retained-launch' });
            const payload = Buffer.from([0, 255, 195, 40, 128, 10, 13, 0]);
            const received = once(borrowed.stream, 'data');
            borrowed.stream.write(payload);
            expect(Buffer.from((await received)[0])).toEqual(payload);
            if (stop === 'abort') controller.abort();
            await borrowed.close();
            await borrowed.close();
            expect(borrowed.stream.destroyed).toBe(true);
            expect(() => process.kill(peer.pid, 0)).toThrow();
            expect(releases).toBe(0);
        } finally { await borrowed.close(); }
    });

    it('does not spawn or release retained generation custody after cancellation', async () => {
        const controller = new AbortController();
        controller.abort();
        let releases = 0;
        await expect(openNativeDockerStream({ command: 'must-not-spawn', args: [], env: {},
            release() { releases++; } }, [], [], controller.signal)).rejects.toThrow();
        expect(releases).toBe(0);
    });
});

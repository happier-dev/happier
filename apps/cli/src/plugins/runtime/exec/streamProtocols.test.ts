import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { ExecProcessHandleV1 } from '@happier-dev/plugin-sdk';

import { PluginExecClientError } from './errors';
import { createFramedBytesProcessClient } from './framedBytes';
import { createJsonStreamProcessClient } from './jsonStream';

function createInMemoryProcess(writes: Array<string | Uint8Array>): ExecProcessHandleV1 {
    return {
        pid: 1,
        exit: new Promise(() => undefined),
        async writeStdin(input) {
            writes.push(input);
        },
        kill: () => undefined,
        dispose: async () => undefined,
    };
}

describe('A.13p.1 stream protocol clients', () => {
    it('rejects invalid JSON stream records with a typed protocol error', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });

        stdout.end('not-json\n');

        await expect(protocol.client.closed).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('rejects inbound JSON stream records that exceed maxFrameBytes', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            maxFrameBytes: 8,
            write: async (input) => {
                writes.push(input);
            },
        });

        stdout.end('{"tooLarge":true}\n');

        await expect(protocol.client.closed).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });

    it('rejects non-serializable JSON stream writes with a typed protocol error', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });
        const record: Record<string, unknown> = {};
        record.self = record;

        await expect(protocol.client.writeRecord(record)).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
        expect(writes).toEqual([]);
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

    it('rejects JSON stream writes after a clean close without writing stdin', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });

        stdout.end();

        await expect(protocol.client.closed).resolves.toBeUndefined();
        await expect(protocol.client.writeRecord({ afterClose: true })).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_DISPOSED',
        });
        expect(writes).toEqual([]);
    });

    it('rejects JSON stream writes with an already-aborted signal without writing stdin', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });

        await expect(
            protocol.client.writeRecord({ aborted: true }, { signal: AbortSignal.abort() }),
        ).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_ABORTED',
        });
        expect(writes).toEqual([]);
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

    it('delivers split and batched framed-bytes frames without altering payload bytes', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createFramedBytesProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });
        const frames: number[][] = [];
        protocol.client.subscribe((frame) => {
            frames.push([...frame]);
        });

        stdout.write(Buffer.from([0, 0]));
        stdout.write(Buffer.from([0, 3, 0, 255]));
        stdout.write(Buffer.from([13, 0, 0, 0, 0]));

        await expect.poll(() => frames).toEqual([
            [0, 255, 13],
            [],
        ]);
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

    it('rejects outbound framed-bytes frames that exceed maxFrameBytes before writing stdin', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createFramedBytesProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            maxFrameBytes: 2,
            write: async (input) => {
                writes.push(input);
            },
        });

        await expect(protocol.client.writeFrame(Uint8Array.from([1, 2, 3]))).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
        expect(writes).toEqual([]);
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

    it('rejects framed-bytes writes after a clean close without writing stdin', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createFramedBytesProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });

        stdout.end();

        await expect(protocol.client.closed).resolves.toBeUndefined();
        await expect(protocol.client.writeFrame(Uint8Array.from([1]))).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_DISPOSED',
        });
        expect(writes).toEqual([]);
    });

    it('rejects framed-bytes writes with an already-aborted signal without writing stdin', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createFramedBytesProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });

        await expect(
            protocol.client.writeFrame(Uint8Array.from([1, 2, 3]), { signal: AbortSignal.abort() }),
        ).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_ABORTED',
        });
        expect(writes).toEqual([]);
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

    it('rejects framed-bytes streams that end with a partial frame', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createFramedBytesProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            write: async (input) => {
                writes.push(input);
            },
        });

        stdout.end(Buffer.from([0, 0, 0, 4, 1, 2]));

        await expect(protocol.client.closed).rejects.toMatchObject({
            code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
        });
    });
});

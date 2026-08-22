import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { ExecProcessHandleV1 } from './privateContract';

import {
    PluginExecClientError,
    createPluginExecClientExitError,
} from './errors';
import { createFramedBytesProcessClient } from './framedBytes';
import { createJsonStreamProcessClient } from './jsonStream';
import { encodeContentLengthFrame } from './contentLengthFraming';

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
    it('reports callback queue facts from real JSON stream delivery', async () => {
        const stdout = new PassThrough();
        const samples: Array<{
            family: 'plugin-protocol-callbacks';
            queuedItems: number;
            queuedBytes: number;
            backpressured: boolean;
        }> = [];
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let delivered!: () => void;
        const delivery = new Promise<void>((resolve) => {
            delivered = resolve;
        });
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess([]),
            stdout,
            write: async () => undefined,
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-protocol-callbacks') samples.push(sample);
            },
        });
        protocol.client.subscribe(async () => {
            await blocked;
            delivered();
        });
        const encoded = JSON.stringify({ measured: true });

        stdout.write(`${encoded}\n`);

        await expect.poll(() => samples).toEqual([{
            family: 'plugin-protocol-callbacks',
            queuedItems: 1,
            queuedBytes: Buffer.byteLength(encoded),
            backpressured: false,
        }]);
        release();
        await delivery;
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

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

    it('classifies non-serializable JSON stream writes as rejected before write', async () => {
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

        await expect(protocol.client.writeRecord(record)).resolves.toMatchObject({
            kind: 'rejected_before_write',
            error: {
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
            },
        });
        expect(writes).toEqual([]);
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

    it('classifies JSON stream writes after a clean close as rejected before write', async () => {
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
        await expect(protocol.client.writeRecord({ afterClose: true })).resolves.toMatchObject({
            kind: 'rejected_before_write',
            error: {
                code: 'PLUGIN_EXEC_CLIENT_DISPOSED',
            },
        });
        expect(writes).toEqual([]);
    });

    it('keeps clean JSON-stream EOF authoritative after process exit zero', async () => {
        const stdout = new PassThrough();
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess([]),
            stdout,
            write: async () => undefined,
        });

        stdout.end();
        await expect(protocol.client.closed).resolves.toBeUndefined();
        protocol.settleExit(createPluginExecClientExitError({ exitCode: 0, signal: null }));

        await expect(protocol.client.writeRecord({ afterExit: true })).resolves.toMatchObject({
            kind: 'rejected_before_write',
            error: { code: 'PLUGIN_EXEC_CLIENT_DISPOSED' },
        });
    });

    it('retains a later nonzero JSON-stream exit for calls made after terminal settlement', async () => {
        const stdout = new PassThrough();
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess([]),
            stdout,
            write: async () => undefined,
        });

        stdout.end();
        await expect(protocol.client.closed).resolves.toBeUndefined();
        protocol.settleExit(createPluginExecClientExitError({ exitCode: 23, signal: null }, 'nested failure'));

        await expect(protocol.client.writeRecord({ afterExit: true })).resolves.toMatchObject({
            kind: 'rejected_before_write',
            error: {
                code: 'PLUGIN_EXEC_CLIENT_EXITED',
                message: expect.stringMatching(/exit code 23.*nested failure/u),
            },
        });
    });

    it('installs explicit JSON-stream disposal after clean EOF for later calls', async () => {
        const stdout = new PassThrough();
        const explicitDisposal = new PluginExecClientError(
            'PLUGIN_TEST_EXPLICIT_DISPOSAL',
            'explicit test disposal',
        );
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess([]),
            stdout,
            write: async () => undefined,
        });

        stdout.end();
        await expect(protocol.client.closed).resolves.toBeUndefined();
        protocol.dispose(explicitDisposal);

        await expect(protocol.client.writeRecord({ afterDispose: true })).resolves.toEqual({
            kind: 'rejected_before_write',
            error: explicitDisposal,
        });
    });

    it('classifies already-aborted JSON stream writes as rejected before write', async () => {
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
        ).resolves.toMatchObject({
            kind: 'rejected_before_write',
            error: {
                code: 'PLUGIN_EXEC_CLIENT_ABORTED',
            },
        });
        expect(writes).toEqual([]);
        protocol.dispose(new PluginExecClientError('PLUGIN_EXEC_CLIENT_DISPOSED', 'disposed'));
    });

    it('classifies a rejected process write as write attempted', async () => {
        const stdout = new PassThrough();
        const writeFailure = new Error('process writer result is unknowable');
        const protocol = createJsonStreamProcessClient({
            process: createInMemoryProcess([]),
            stdout,
            write: async () => {
                throw writeFailure;
            },
        });

        await expect(protocol.client.writeRecord({ attempted: true })).resolves.toEqual({
            kind: 'write_may_have_occurred',
            error: writeFailure,
        });
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

    it('reads and writes fragmented content-length byte frames', async () => {
        const stdout = new PassThrough();
        const writes: Array<string | Uint8Array> = [];
        const protocol = createFramedBytesProcessClient({
            process: createInMemoryProcess(writes),
            stdout,
            framing: 'contentLength',
            maxFrameBytes: 4,
            write: async (input) => {
                writes.push(input);
            },
        });
        const frames: number[][] = [];
        protocol.client.subscribe((frame) => {
            frames.push([...frame]);
        });
        const encoded = encodeContentLengthFrame(new Uint8Array([0, 255, 2, 3]));

        stdout.write(encoded.subarray(0, 8));
        stdout.write(encoded.subarray(8));
        await expect.poll(() => frames).toEqual([[0, 255, 2, 3]]);
        await protocol.client.writeFrame(new Uint8Array([4]));
        expect(Buffer.from(writes[0] as Uint8Array).toString('ascii')).toMatch(/^Content-Length: 1\r\n\r\n/u);
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

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { attachJsonlLineReader } from './attachJsonlLineReader';

async function flushStreamEvents(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('attachJsonlLineReader', () => {
    it('emits only LF-terminated records and reports trailing partial text separately', async () => {
        const stream = new PassThrough();
        const lines: string[] = [];
        const partials: string[] = [];

        attachJsonlLineReader(stream, (line) => lines.push(line), {
            onTrailingPartialLine: (partialLine) => partials.push(partialLine),
        });

        stream.write(Buffer.from('{"a":1}\n{"b":"x\u2028y"}'));
        stream.end(Buffer.from('\n{"c":3}\r\npartial'));
        await flushStreamEvents();

        expect(lines).toEqual(['{"a":1}', '{"b":"x\u2028y"}', '{"c":3}']);
        expect(partials).toEqual(['partial']);
    });

    it('keeps bare CR and unicode separators inside line payloads', async () => {
        const stream = new PassThrough();
        const lines: string[] = [];

        attachJsonlLineReader(stream, (line) => lines.push(line));

        stream.end('a\rb\u2028c\u2029d\n');
        await flushStreamEvents();

        expect(lines).toEqual(['a\rb\u2028c\u2029d']);
    });

    it('detaches idempotently without destroying or ending the stream', async () => {
        const stream = new PassThrough();
        const lines: string[] = [];
        const detach = attachJsonlLineReader(stream, (line) => lines.push(line));

        stream.write('first\n');
        await flushStreamEvents();

        detach();
        detach();
        stream.write('ignored\n');
        await flushStreamEvents();

        expect(lines).toEqual(['first']);
        expect(stream.destroyed).toBe(false);
        stream.end();
    });

    it('reports trailing partial text when detached', async () => {
        const stream = new PassThrough();
        const partials: string[] = [];
        const detach = attachJsonlLineReader(stream, () => undefined, {
            onTrailingPartialLine: (partialLine) => partials.push(partialLine),
        });

        stream.write('partial');
        await flushStreamEvents();
        detach();

        expect(partials).toEqual(['partial']);
        stream.end();
    });

    it('flushes decoder state when detached before reporting a trailing partial', async () => {
        const stream = new PassThrough();
        const partials: string[] = [];
        const detach = attachJsonlLineReader(stream, () => undefined, {
            onTrailingPartialLine: (partialLine) => partials.push(partialLine),
        });

        stream.write(Buffer.from([0xe2, 0x82]));
        await flushStreamEvents();
        detach();

        expect(partials).toEqual(['\uFFFD']);
        stream.end();
    });

    it('detaches and reports callback failures before later records are emitted', async () => {
        const stream = new PassThrough();
        const lines: string[] = [];
        const errors: unknown[] = [];

        attachJsonlLineReader(stream, (line) => {
            lines.push(line);
            throw new Error('line failed');
        }, {
            onError: (error) => errors.push(error),
        });

        stream.write('first\nsecond\n');
        stream.write('third\n');
        await flushStreamEvents();

        expect(lines).toEqual(['first']);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
        expect((errors[0] as Error).message).toBe('line failed');
        stream.end();
    });

    it('detaches and reports stream errors', async () => {
        const stream = new PassThrough();
        const lines: string[] = [];
        const errors: unknown[] = [];

        attachJsonlLineReader(stream, (line) => lines.push(line), {
            onError: (error) => errors.push(error),
        });

        stream.write('before\n');
        stream.emit('error', new Error('stream failed'));
        stream.write('after\n');
        await flushStreamEvents();

        expect(lines).toEqual(['before']);
        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('stream failed');
        stream.end();
    });
});

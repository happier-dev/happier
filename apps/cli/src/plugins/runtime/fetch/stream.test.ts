import { describe, expect, it } from 'vitest';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { wrapPluginHttpStream } from './stream';

describe('HTTP body lifetime with retained redaction custody', () => {
    it.each([false, true])('preserves binary stream bytes while redacting split credentials (echo=%s)', async echo => {
        const secret = new TextEncoder().encode('sëcret');
        const prefix = new Uint8Array([0xff, 0x00, 0xc3, 0x28, 0xef, 0xbb, 0xbf]);
        const suffix = new Uint8Array([0x80, 0xfe, 0xe2, 0x82]);
        const bytes = new Uint8Array([...prefix, ...(echo ? secret : []), ...suffix]);
        const lease = createProviderRedactionLease({ values: ['sëcret'] });
        const response = wrapPluginHttpStream({ status: 200, finalUrl: 'https://logs.example/read',
            headers: { 'content-type': 'application/octet-stream' },
            chunks: { async *[Symbol.asyncIterator]() {
                for (const byte of bytes) yield new Uint8Array([byte]);
            } }, async dispose() {},
        }, { sanitizer: lease.createStreamingSanitizer(), onDispose: lease.close });
        const received: number[] = [];
        for await (const chunk of response.chunks) received.push(...chunk);
        expect(received).toEqual([...prefix, ...(echo ? new TextEncoder().encode('[REDACTED]') : []), ...suffix]);
        expect(lease.isActive()).toBe(false);
    });

    it('redacts a credential split across byte and UTF-8 boundaries', async () => {
        const lease = createProviderRedactionLease({ values: ['sëcret'] });
        const bytes = new TextEncoder().encode('visible sëcret tail');
        const response = wrapPluginHttpStream({ status: 200, finalUrl: 'https://logs.example/read', headers: {},
            chunks: { async *[Symbol.asyncIterator]() { yield bytes.slice(0, 10); yield bytes.slice(10, 13); yield bytes.slice(13); } },
            async dispose() {},
        }, { sanitizer: lease.createStreamingSanitizer(), onDispose: lease.close });
        let visible = '';
        for await (const chunk of response.chunks) visible += new TextDecoder().decode(chunk);
        expect(visible).toBe('visible [REDACTED] tail');
        expect(lease.isActive()).toBe(false);
    });

    it.each(['end', 'dispose'] as const)('settles iteration after normal %s retires the lease', async end => {
        const lease = createProviderRedactionLease({ values: ['long-sensitive-sentinel'] });
        const response = wrapPluginHttpStream({ status: 200, finalUrl: 'https://logs.example/read', headers: {},
            chunks: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode('tail'); } },
            async dispose() {},
        }, {
            sanitizer: lease.createStreamingSanitizer(),
            onDispose: lease.close,
        });
        const iterator = response.chunks[Symbol.asyncIterator]();
        if (end === 'end') expect(new TextDecoder().decode((await iterator.next()).value)).toBe('tail');
        else await response.dispose();
        expect(lease.isActive()).toBe(false);
        expect(await iterator.next()).toEqual({ done: true, value: undefined });
        await response.dispose();
    });

    it('preserves local cancellation when body cleanup also fails', async () => {
        const cancellation = new AbortController();
        const response = wrapPluginHttpStream({ status: 200, finalUrl: 'https://logs.example/read', headers: {},
            chunks: { async *[Symbol.asyncIterator]() { yield new Uint8Array([1]); } },
            async dispose() { throw new Error('Cleanup failure'); },
        }, { signal: cancellation.signal });
        cancellation.abort();
        await expect(response.chunks[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'AbortError' });
    });

    it.each(['reject', 'complete'] as const)('settles a pending %s read after explicit disposal retires its redaction custody', async settlement => {
        const lease = createProviderRedactionLease({ values: ['sensitive-sentinel'] });
        let rejectRead!: (error: Error) => void;
        let completeRead!: (value: IteratorResult<Uint8Array>) => void;
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        const response = wrapPluginHttpStream({ status: 200, finalUrl: 'https://logs.example/read', headers: {},
            chunks: { [Symbol.asyncIterator]: () => ({
                next: () => new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
                    completeRead = resolve;
                    rejectRead = reject;
                    started();
                }),
            }) },
            async dispose() {
                if (settlement === 'reject') rejectRead(Object.assign(new Error('Body closed'), { name: 'AbortError' }));
                else completeRead({ done: true, value: undefined });
            },
        }, {
            sanitizer: lease.createStreamingSanitizer(),
            onDispose: lease.close,
        });
        const pending = response.chunks[Symbol.asyncIterator]().next();
        await reading;
        const settled = expect(pending).resolves.toEqual({ done: true, value: undefined });
        await response.dispose();
        await settled;
        expect(lease.isActive()).toBe(false);
    });
});

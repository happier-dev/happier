import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { prepareKokoroWebRuntime } from './kokoroWebStreams.mjs';

test('vendored Kokoro decompresses its phonemizer data without stream async iteration', async () => {
    const require = createRequire(import.meta.url);
    const installedRuntime = path.join(path.dirname(require.resolve('kokoro-js')), 'kokoro.web.js');
    const original = fs.readFileSync(installedRuntime, 'utf8');
    const source = prepareKokoroWebRuntime(original);
    const streamOffset = source.indexOf('.pipeThrough(new DecompressionStream("gzip"))');
    assert.notEqual(streamOffset, -1, 'expected the installed Kokoro phonemizer bootstrap');
    const start = source.lastIndexOf('(async()=>{', streamOffset);
    const end = source.indexOf('})()', streamOffset) + 4;
    assert.ok(start >= 0 && end > start);
    // Execute the dependency's actual gzip bootstrap, including its embedded data, rather than
    // importing its unrelated model/WebAssembly runtime. Xg is its captured base64 decoder.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const decompress = new AsyncFunction('Xg', `let a,n; await ${source.slice(start, end)}; return a;`);
    const originalEnd = original.indexOf('})()', streamOffset) + 4;
    const upstream = new AsyncFunction('Xg', `let a,n; await ${original.slice(start, originalEnd)}; return a;`);
    const expected = await upstream(atob);
    assert.ok(expected.byteLength > 0);

    // Safari exposes stream readers even on runtimes without the optional async iterator.
    const descriptor = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
    try {
        Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { configurable: true, value: undefined });
        const actual = await decompress(atob);
        assert.deepEqual(new Uint8Array(actual), new Uint8Array(expected));
    } finally {
        if (descriptor) Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, descriptor);
        else delete ReadableStream.prototype[Symbol.asyncIterator];
    }
});

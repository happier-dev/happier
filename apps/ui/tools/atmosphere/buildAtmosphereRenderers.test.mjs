import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

import { buildAtmosphereRenderers } from './buildAtmosphereRenderers.mjs';
import { atmosphereRipple, createAtmosphereTransition } from '../../../../packages/brand/atmosphere.mjs';

test('both emitted platform engines preserve the independent lab RGBA matrix', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-U4-renderers-'));
    try {
        const built = await buildAtmosphereRenderers({ outputDirectory: directory });
        const fixture = JSON.parse(await readFile(new URL('../../../../packages/brand/fixtures/atmosphere-parity.json', import.meta.url), 'utf8'));
        const replies = [];
        const worker = { postMessage: (message) => replies.push(message), performance, AbortController };
        worker.self = worker;
        runInNewContext(await readFile(built.workerFile, 'utf8'), worker);
        const native = { performance };
        runInNewContext((await readFile(built.nativeFile, 'utf8')).replace('export function', 'function'), native);
        const core = native.createAtmosphereWorkletCore();
        const require = createRequire(new URL('../../package.json', import.meta.url));
        const transformed = require('@babel/core').transformSync(await readFile(built.nativeFile, 'utf8'), {
            filename: built.nativeFile, configFile: false, babelrc: false,
            plugins: [require.resolve('react-native-worklets/plugin')],
        }).code;
        const workletHost = { performance };
        workletHost.global = workletHost;
        runInNewContext(transformed.replace(/^export /gm, '') + '\nglobalThis.factory = createAtmosphereWorkletCore;', workletHost);
        assert.deepEqual(Object.keys(workletHost.factory.__closure), [], 'native factory has no inaccessible host imports');
        const unpacked = runInNewContext(`(${workletHost.factory.__initData.code})`, { performance });
        const workletCore = unpacked();
        for (const reference of fixture.cases) {
            const source = fixture.inputs[reference.input];
            const pixels = { rgba: new Uint8ClampedArray(Buffer.from(source.rgba, 'base64')), w: source.w, h: source.h };
            const { effect, dark, page, mute, strength, ...rest } = reference.job;
            const job = { ...rest, source: pixels, look: effect, theme: dark ? 'dark' : 'light', page,
                params: { ...rest.params, mute, strength } };
            await worker.onmessage({ data: { id: reference.id, job } });
            const reply = replies.pop();
            assert.equal(reply.ok, true, reply.error);
            assert.equal(createHash('sha256').update(reply.result.rgba).digest('hex'), reference.sha256, `web ${reference.id}`);
            const result = core.renderBackdrop(job);
            assert.equal(createHash('sha256').update(result.rgba).digest('hex'), reference.sha256, `native ${reference.id}`);
            assert.equal(createHash('sha256').update(workletCore.renderBackdrop(job).rgba).digest('hex'), reference.sha256, `serialized worklet ${reference.id}`);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the serialized native core paints the same ripple and resettle pixels as web', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-FX4-core-'));
    try {
        const built = await buildAtmosphereRenderers({ outputDirectory: directory, web: false });
        const require = createRequire(new URL('../../package.json', import.meta.url));
        const transformed = require('@babel/core').transformSync(await readFile(built.nativeFile, 'utf8'), {
            filename: built.nativeFile, configFile: false, babelrc: false,
            plugins: [require.resolve('react-native-worklets/plugin')],
        }).code;
        const host = { performance }; host.global = host;
        runInNewContext(transformed.replace(/^export /gm, '') + '\nglobalThis.factory = createAtmosphereWorkletCore;', host);
        assert.deepEqual(Object.keys(host.factory.__closure), []);
        const core = runInNewContext(`(${host.factory.__initData.code})`, { performance })();
        assert.equal(typeof core.atmosphereRipple, 'function', 'native must paint the ring, not substitute the reduced path');
        assert.equal(typeof core.createAtmosphereTransition, 'function', 'native must paint blue-noise resettle');
        const w = 32, h = 24;
        const before = new Uint8ClampedArray(w * h * 4).fill(40);
        const after = new Uint8ClampedArray(w * h * 4).fill(190);
        for (const kind of ['resettle', 'crossfade']) {
            const input = { from: { rgba: before, w, h }, to: { rgba: after, w, h }, page: [245, 245, 245], theme: 'light', dpr: 2 };
            const web = createAtmosphereTransition(kind, input);
            const native = core.createAtmosphereTransition(kind, input);
            for (const t of [0, 0.3, 0.55, 0.8, 1]) assert.deepEqual(Array.from(native.frame(t)), Array.from(web.frame(t)));
        }
        for (const theme of ['light', 'dark']) for (const t of [0, 0.25, 0.5, 1]) {
            const input = { w, h, theme, page: [245, 245, 245], dpr: 2, x: 12, y: 6, glyphs: { cw: 3, ch: 5, chars: '0123456789', masks: new Uint8Array(150).fill(255) } };
            assert.deepEqual(Array.from(core.atmosphereRipple(t, input).rgba), Array.from(atmosphereRipple(t, input).rgba));
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

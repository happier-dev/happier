// @happier-test-preparation source
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { brotliDecompressSync } from 'node:zlib';
import { test } from 'node:test';
import { createArtifactAssetResponse } from './metroArtifactAssetResponse.cjs';

const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliRequire = createRequire(expoRequire.resolve('@expo/cli/package.json'));
const { compression } = cliRequire('./build/src/start/server/metro/dev-server/compression.js');
const body = Buffer.from('const message = "Packaged plugin source";\n'.repeat(4096));

async function serve(run) {
    const artifactResponse = createArtifactAssetResponse((req, res) => {
        if (req.url.includes('missing')) {
            res.statusCode = 404;
            res.end('Asset not found');
            return;
        }
        res.setHeader('Content-Type', req.url.startsWith('/assets/') ? false : 'application/javascript');
        res.end(body);
    }, ['bundle', 'map']);
    const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        compression(req, res, () => artifactResponse(req, res));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

async function request(origin, path, encoding = 'br') {
    const { get } = await import('node:http');
    return await new Promise((resolve, reject) => {
        get(origin + path, { headers: { 'Accept-Encoding': encoding } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

test('compresses exact packaged source assets once and preserves decoded bytes', async () => {
    await serve(async origin => {
        for (const path of ['/assets/?unstable_path=./plugin/entry.cjs.bundle', '/assets/plugin/entry.mjs.bundle',
            '/assets/?unstable_path=./grammar/javascript.json.bundle', '/assets/?unstable_path=./plugin/entry.cjs.bundle.map']) {
            const result = await request(origin, path);
            assert.equal(result.status, 200);
            assert.equal(result.headers['content-encoding'], 'br');
            assert.deepEqual(brotliDecompressSync(result.bytes), body);
            assert.equal(result.headers['cache-control'], 'no-store');
            assert.match(result.headers['content-type'], path.includes('.json.bundle') || path.endsWith('.map') ? /application\/json/ : /application\/javascript/);
            const identity = await request(origin, path, 'identity');
            assert.equal(identity.headers['content-encoding'], undefined);
            assert.deepEqual(identity.bytes, body);
        }
    });
});

test('serves web dev bundles directly and preserves other Metro responses', async () => {
    await serve(async origin => {
        const bundle = await request(origin, '/index.bundle?platform=web&dev=true&hot=false');
        assert.equal(bundle.status, 200);
        assert.equal(bundle.headers['content-encoding'], undefined);
        assert.deepEqual(bundle.bytes, body);
        assert.match(bundle.headers['cache-control'], /\bno-store\b/);
        for (const path of ['/index.bundle?platform=android&dev=true', '/index.bundle?platform=web&dev=false',
            '/index.map?platform=web&dev=true']) {
            const compressed = await request(origin, path);
            assert.equal(compressed.headers['content-encoding'], 'br', path);
            assert.deepEqual(brotliDecompressSync(compressed.bytes), body);
        }
        const ordinary = await request(origin, '/assets/?unstable_path=./logo.png');
        assert.equal(ordinary.headers['content-encoding'], undefined);
        assert.equal(ordinary.headers['content-type'], 'false');
        assert.deepEqual(ordinary.bytes, body);
        const missing = await request(origin, '/assets/?unstable_path=./missing.bundle');
        assert.equal(missing.status, 404);
        assert.equal(missing.headers['content-encoding'], undefined);
        assert.equal(missing.bytes.toString(), 'Asset not found');
    });
});

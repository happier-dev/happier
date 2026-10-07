import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { buildPasswordKdfWorker } from './buildPasswordKdfWorker.mjs';

test('UI postinstall builds its real password worker before Protocol dist exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-cold-password-worker-'));
    const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const repoRoot = resolve(uiDir, '../..');
    const fixtureUi = join(directory, 'apps/ui');
    const require = createRequire(join(uiDir, 'package.json'));
    try {
        await mkdir(join(fixtureUi, 'tools/password'), { recursive: true });
        await mkdir(join(fixtureUi, 'sources/auth/password'), { recursive: true });
        await mkdir(join(directory, 'node_modules/@happier-dev'), { recursive: true });
        // Execute current producer bytes against an actual source-only checkout
        // boundary, without moving any shared workspace dist or dependencies.
        await cp(join(uiDir, 'tools/password/buildPasswordKdfWorker.mjs'), join(fixtureUi, 'tools/password/buildPasswordKdfWorker.mjs'));
        await cp(join(uiDir, 'sources/auth/password/passwordKdf.worker.ts'), join(fixtureUi, 'sources/auth/password/passwordKdf.worker.ts'));
        const protocolDir = join(directory, 'packages/protocol');
        await mkdir(protocolDir, { recursive: true });
        await cp(join(repoRoot, 'packages/protocol/package.json'), join(protocolDir, 'package.json'));
        await cp(join(repoRoot, 'packages/protocol/src'), join(protocolDir, 'src'), { recursive: true });
        await symlink(protocolDir, join(directory, 'node_modules/@happier-dev/protocol'), 'junction');
        for (const name of ['esbuild', 'zod', 'base64-js', '@noble/hashes', 'libsodium-wrappers-sumo', 'libsodium-sumo']) {
            let packageDir = dirname(require.resolve(name === '@noble/hashes' ? '@noble/hashes/sha2' : name));
            while (JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8').catch(() => '{}')).name !== name) {
                const parent = dirname(packageDir);
                assert.notEqual(parent, packageDir, `package boundary for ${name}`);
                packageDir = parent;
            }
            const target = join(directory, 'node_modules', name);
            await mkdir(dirname(target), { recursive: true });
            await symlink(packageDir, target, 'junction');
        }
        await writeFile(join(fixtureUi, 'package.json'), '{"type":"module"}');
        const producer = await import(pathToFileURL(join(fixtureUi, 'tools/password/buildPasswordKdfWorker.mjs')).href);
        const { outputFile, bytes } = await producer.buildPasswordKdfWorker();
        assert.ok(bytes > 0);
        const replies = [];
        const context = { crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array,
            postMessage: message => replies.push(structuredClone(message)) };
        context.self = context;
        runInNewContext(await readFile(outputFile, 'utf8'), context);
        await context.onmessage({ data: {
            password: new TextEncoder().encode('a sufficiently long password'),
            kdf: { algorithm: 'argon2id13', salt: 'AAAAAAAAAAAAAAAAAAAAAA',
                opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32 },
        } });
        assert.equal(replies[0].ok, true);
        assert.equal(replies[0].key.byteLength, 32);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('emitted password worker executes without Node or external script loading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-password-worker-'));
    try {
        const { outputFile } = await buildPasswordKdfWorker({
            outputFile: join(directory, 'happier-password-kdf-worker.js'),
        });
        const replies = [];
        // Genuine worker globals only: no require, process, fetch or importScripts.
        const context = {
            crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array,
            postMessage: (message) => replies.push(structuredClone(message)),
        };
        context.self = context;
        runInNewContext(await readFile(outputFile, 'utf8'), context);
        await context.onmessage({ data: {
            password: new TextEncoder().encode('a sufficiently long password'),
            kdf: {
                algorithm: 'argon2id13', salt: 'AAAAAAAAAAAAAAAAAAAAAA',
                opsLimit: 3, memLimitBytes: 67108864, outputBytes: 32,
            },
        } });
        assert.equal(replies.length, 1);
        assert.equal(replies[0].ok, true);
        assert.equal(replies[0].key.byteLength, 32);
        assert.ok(replies[0].key.some((byte) => byte !== 0));
        await context.onmessage({ data: {} });
        assert.equal(replies[1].ok, false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

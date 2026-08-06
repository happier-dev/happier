import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pruneServerPrismaArtifactsForTarget } from './buildServerBinaryArtifactPayload.js';

const PRISMA_NODE_ENGINE_FILE_NAMES = [
    'libquery_engine-debian-openssl-3.0.x.so.node',
    'libquery_engine-linux-arm64-openssl-3.0.x.so.node',
    'libquery_engine-darwin.dylib.node',
    'libquery_engine-darwin-arm64.dylib.node',
    'query_engine-windows.dll.node',
];

const PRISMA_RUNTIME_FILE_NAMES = [
    // Providers actually reachable via ServerDbProvider ('sqlite' | 'mysql') plus the always-generated
    // 'postgres' default client -- these must survive pruning.
    'query_engine_bg.postgresql.wasm-base64.js',
    'query_engine_bg.postgresql.wasm-base64.mjs',
    'query_engine_bg.mysql.wasm-base64.js',
    'query_engine_bg.mysql.wasm-base64.mjs',
    'query_engine_bg.sqlite.wasm-base64.js',
    'query_engine_bg.sqlite.wasm-base64.mjs',
    // Providers never reachable through resolveRequestedServerDbProviders/BuildDbProvider -- must be pruned.
    'query_engine_bg.cockroachdb.wasm-base64.js',
    'query_engine_bg.cockroachdb.wasm-base64.mjs',
    'query_engine_bg.sqlserver.wasm-base64.js',
    'query_engine_bg.sqlserver.wasm-base64.mjs',
    // Sourcemaps -- never needed at runtime, must be pruned regardless of provider.
    'binary.js.map',
    'binary.mjs.map',
    'index-browser.js.map',
];

const tempDirs: string[] = [];

async function createTempPayloadDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'build-server-binary-artifact-payload-prisma-prune-'));
    tempDirs.push(dir);
    return dir;
}

async function writeFixtureFile(path: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'fixture', 'utf8');
}

async function buildFakePrismaClientDirTree(payloadDir: string, relativeDir: string): Promise<string> {
    const dirPath = join(payloadDir, relativeDir);
    for (const fileName of PRISMA_NODE_ENGINE_FILE_NAMES) {
        await writeFixtureFile(join(dirPath, fileName));
    }
    return dirPath;
}

async function buildFakePrismaClientRuntimeDirTree(payloadDir: string): Promise<string> {
    const dirPath = join(payloadDir, 'node_modules', '@prisma', 'client', 'runtime');
    for (const fileName of PRISMA_RUNTIME_FILE_NAMES) {
        await writeFixtureFile(join(dirPath, fileName));
    }
    // A file that is neither a per-provider engine file nor a sourcemap must survive untouched.
    await writeFixtureFile(join(dirPath, 'index.js'));
    return dirPath;
}

describe('pruneServerPrismaArtifactsForTarget', () => {
    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map(async (dir) => {
            await rm(dir, { recursive: true, force: true });
        }));
    });

    it('keeps only the linux-arm64 engine file in each generated provider client directory', async () => {
        const payloadDir = await createTempPayloadDir();
        const sqliteClientDir = await buildFakePrismaClientDirTree(payloadDir, join('generated', 'sqlite-client'));
        const mysqlClientDir = await buildFakePrismaClientDirTree(payloadDir, join('generated', 'mysql-client'));
        const dotPrismaClientDir = await buildFakePrismaClientDirTree(payloadDir, join('node_modules', '.prisma', 'client'));

        await pruneServerPrismaArtifactsForTarget({
            payloadDir,
            target: { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
        });

        for (const dir of [sqliteClientDir, mysqlClientDir, dotPrismaClientDir]) {
            const remaining = await readdir(dir);
            expect(remaining).toEqual(['libquery_engine-linux-arm64-openssl-3.0.x.so.node']);
        }
    });

    it('keeps only the darwin-arm64 engine file for a darwin-arm64 target', async () => {
        const payloadDir = await createTempPayloadDir();
        const sqliteClientDir = await buildFakePrismaClientDirTree(payloadDir, join('generated', 'sqlite-client'));

        await pruneServerPrismaArtifactsForTarget({
            payloadDir,
            target: { bunTarget: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64', exeExt: '' },
        });

        const remaining = await readdir(sqliteClientDir);
        expect(remaining).toEqual(['libquery_engine-darwin-arm64.dylib.node']);
    });

    it('prunes cockroachdb/sqlserver runtime WASM engines and all sourcemaps from @prisma/client/runtime, keeping reachable providers and unrelated files', async () => {
        const payloadDir = await createTempPayloadDir();
        const runtimeDir = await buildFakePrismaClientRuntimeDirTree(payloadDir);

        await pruneServerPrismaArtifactsForTarget({
            payloadDir,
            target: { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
        });

        const remaining = await readdir(runtimeDir);
        expect(remaining.sort()).toEqual([
            'index.js',
            'query_engine_bg.mysql.wasm-base64.js',
            'query_engine_bg.mysql.wasm-base64.mjs',
            'query_engine_bg.postgresql.wasm-base64.js',
            'query_engine_bg.postgresql.wasm-base64.mjs',
            'query_engine_bg.sqlite.wasm-base64.js',
            'query_engine_bg.sqlite.wasm-base64.mjs',
        ].sort());
    });

    it('is a no-op when the expected Prisma directories are absent', async () => {
        const payloadDir = await createTempPayloadDir();

        await expect(pruneServerPrismaArtifactsForTarget({
            payloadDir,
            target: { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
        })).resolves.toBeUndefined();
    });

    it('rejects instead of silently skipping pruning when an expected Prisma directory path is actually a file', async () => {
        const payloadDir = await createTempPayloadDir();
        const dotPrismaClientPath = join(payloadDir, 'node_modules', '.prisma', 'client');
        await mkdir(join(dotPrismaClientPath, '..'), { recursive: true });
        // A file where a directory is expected (e.g. from a corrupted staging step) must surface as an
        // error, not be silently treated as "directory has no files to prune".
        await writeFile(dotPrismaClientPath, 'not a directory', 'utf8');

        await expect(pruneServerPrismaArtifactsForTarget({
            payloadDir,
            target: { bunTarget: 'bun-linux-arm64', os: 'linux', arch: 'arm64', exeExt: '' },
        })).rejects.toThrow();
    });
});

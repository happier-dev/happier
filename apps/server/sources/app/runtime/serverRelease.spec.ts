import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { readServerGuestCliIdentity } from './serverRelease';
import fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { registerServerGuestCliPayloadRoutes } from './serverGuestCliPayload';
import { createScpReadyPayloadArchive } from '../../../../../packages/cli-common/src/systemTasks/kinds/createScpReadyPayloadArchive';

it('exports only opted-in producer archives and keeps release builds unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-guest-cli-export-'));
    try {
        const archivePath = join(root, 'linux-x64.tar.gz');
        const bytes = Buffer.from('retained producer archive');
        await writeFile(archivePath, bytes);
        const target = { os: 'linux', arch: 'x64' };
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const env = { HAPPIER_DEV_GUEST_CLI_EXPORT: '1',
            HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: JSON.stringify({ root, identity: 'producer', archives: [{ target, sha256, archivePath }] }) };
        expect(readServerGuestCliIdentity(env)).toMatchObject({ payloads: [{ target, sha256,
            url: '/v1/runtime/guest-cli/payloads/linux/x64' }] });
        expect(readServerGuestCliIdentity({ ...env, HAPPIER_DEV_GUEST_CLI_EXPORT: undefined })).not.toHaveProperty('payloads');
        expect(readServerGuestCliIdentity({ ...env, HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA: undefined })).not.toHaveProperty('payloads');
        const outfile = join(root, 'release.mjs');
        await build({ entryPoints: [fileURLToPath(new URL('./serverRelease.ts', import.meta.url))], outfile,
            bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'], define: {
                __HAPPIER_GUEST_CLI_SOURCE__: JSON.stringify('public-release'),
                __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__: 'false',
            } });
        const runtime = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
        expect(runtime.readServerGuestCliIdentity(env)).not.toHaveProperty('payloads');
        const routeFile = join(root, 'release-route.mjs');
        await build({ entryPoints: [fileURLToPath(new URL('./serverGuestCliPayload.ts', import.meta.url))], outfile: routeFile,
            bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'],
            define: { __HAPPIER_DEV_GUEST_CLI_EXPORT_AVAILABLE__: 'false' } });
        const routeRuntime = await import(/* @vite-ignore */ pathToFileURL(routeFile).href);
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        try {
            routeRuntime.registerServerGuestCliPayloadRoutes(app);
            expect(app.hasRoute({ method: 'GET', url: '/v1/runtime/guest-cli/payloads/:os/:arch' })).toBe(false);
            expect(routeRuntime.readServerGuestCliPayloads(env)).toEqual([]);
        } finally { await app.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('serves the exact canonical archive advertised by a source Home and refuses undeclared targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-guest-cli-http-'));
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    const priorFlag = process.env.HAPPIER_DEV_GUEST_CLI_EXPORT;
    const priorMetadata = process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA;
    let archive: Awaited<ReturnType<typeof createScpReadyPayloadArchive>> | undefined;
    try {
        const payloadRoot = join(root, 'guest-payload');
        await mkdir(payloadRoot);
        await writeFile(join(payloadRoot, 'happier'), 'native guest executable');
        archive = await createScpReadyPayloadArchive(payloadRoot);
        const archivePath = join(archive.archiveStageRoot, archive.archiveFileName);
        const bytes = await readFile(archivePath);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        process.env.HAPPIER_DEV_GUEST_CLI_EXPORT = '1';
        process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA = JSON.stringify({ root: payloadRoot, identity: 'producer',
            archives: [{ target: { os: 'linux', arch: 'x64' }, sha256, archivePath }] });
        registerServerGuestCliPayloadRoutes(app);
        const descriptor = readServerGuestCliIdentity().payloads![0];
        const response = await app.inject({ method: 'GET', url: descriptor.url });
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload).toEqual(bytes);
        expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(descriptor.sha256);
        expect((await app.inject('/v1/runtime/guest-cli/payloads/linux/arm64')).statusCode).toBe(404);
        expect((await app.inject('/v1/runtime/guest-cli/payloads/../../package.json')).statusCode).toBe(404);
        delete process.env.HAPPIER_DEV_GUEST_CLI_EXPORT;
        expect((await app.inject(descriptor.url)).statusCode).toBe(404);
        expect(readServerGuestCliIdentity()).not.toHaveProperty('payloads');
    } finally {
        if (priorFlag === undefined) delete process.env.HAPPIER_DEV_GUEST_CLI_EXPORT;
        else process.env.HAPPIER_DEV_GUEST_CLI_EXPORT = priorFlag;
        if (priorMetadata === undefined) delete process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA;
        else process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_METADATA = priorMetadata;
        await app.close();
        await archive?.cleanup();
        await rm(root, { recursive: true, force: true });
    }
});

it('publishes the build-selected guest CLI source and explicit development line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-guest-cli-identity-'));
    try {
        for (const [source, channel] of [['home-payload', 'publicdev'], ['public-release', 'stable'], ['public-release', 'preview'], ['public-release', 'publicdev']]) {
            const outfile = join(root, `${source}-${channel}.mjs`);
            await build({
                entryPoints: [fileURLToPath(new URL('./serverRelease.ts', import.meta.url))],
                outfile, bundle: true, platform: 'node', format: 'esm', conditions: ['happier-source'],
                define: { __HAPPIER_GUEST_CLI_SOURCE__: JSON.stringify(source), __HAPPIER_GUEST_CLI_CHANNEL__: JSON.stringify(channel) },
            });
            const runtime = await import(/* @vite-ignore */ pathToFileURL(outfile).href);
            expect(runtime.readServerGuestCliIdentity()).toEqual({ source, line: '0.3', channel });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

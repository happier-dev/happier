import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { ingestPluginManifestV2 } from '@happier-dev/protocol';

import {
    cleanupStagedNpmArtifactCandidate,
    stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { webSocketTargetOrigin } from '../runtime/fetch/webSocket';
import { executeContributedAction } from '../runtime/invocation/actions/executeContributedAction';
import { createAuthoredAdmittedPluginRuntimeFixture } from '../testkit/admittedRuntime';
import { packLocalPlugin } from './pack';

const fixtureRoot = fileURLToPath(new URL(
    '../testkit/fixtures/packed-external-websocket-client',
    import.meta.url,
));

// The archive owns its executable entry; no ignored, pre-built dist is needed.
const PUBLIC_WEBSOCKET_MODULE = `export function activate(api) {
    api.actions.register('connect', async (input, context) => {
        const socket = await context.services.http.openWebSocket({
            url: input.url, protocols: ['fixture-v1'], allowInsecureWs: true,
        }, { signal: context.signal });
        try {
            await socket.send({ kind: 'text', text: input.message }, { signal: context.signal });
            const message = await socket.receive({ signal: context.signal });
            if (message.kind !== 'text') throw new Error('Expected fixture greeting');
            return { url: socket.url, protocol: socket.protocol, text: message.text };
        } finally {
            socket.close();
            await socket.closed;
        }
    });
}`;

async function createFixtureGateway(): Promise<Readonly<{
    url: string;
    received: Promise<string>;
    close(): Promise<void>;
}>> {
    let resolveReceived!: (message: string) => void;
    const received = new Promise<string>((resolve) => { resolveReceived = resolve; });
    const server = createServer();
    const gateway = new WebSocketServer({
        server,
        handleProtocols(protocols) {
            return protocols.has('fixture-v1') ? 'fixture-v1' : false;
        },
    });
    gateway.on('connection', (socket) => {
        socket.send('fixture-welcome');
        socket.once('message', (message) => {
            const text = Array.isArray(message)
                ? Buffer.concat(message).toString('utf8')
                : message instanceof ArrayBuffer
                    ? Buffer.from(message).toString('utf8')
                    : message.toString('utf8');
            resolveReceived(text);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return Object.freeze({
        url: `ws://127.0.0.1:${address.port}/fixture`,
        received,
        async close() {
            await new Promise<void>((resolve, reject) => {
                gateway.close((error) => (error ? reject(error) : resolve()));
            });
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    });
}

describe('packed external WebSocket client contract', () => {
    it('packs, stages, and reaches the host only through public HttpService.openWebSocket', async () => {
        const manifest = JSON.parse(await readFile(
            join(fixtureRoot, '.happier-plugin', 'plugin.json'),
            'utf8',
        ));
        expect(ingestPluginManifestV2(manifest)).toMatchObject({ ok: true });
        expect(manifest.hostAccess.required).toEqual([{
            id: 'gateway',
            capability: 'network.client',
            reason: 'Maintain the declared gateway connection',
            scope: {
                targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
                transports: ['websocket'],
            },
        }]);

        const parent = await mkdtemp(join(tmpdir(), 'happier-packed-websocket-public-contract-'));
        const archivePath = join(parent, 'packed-websocket.tgz');
        const installRoot = join(parent, 'installed');
        const gateway = await createFixtureGateway();
        let staged: Awaited<ReturnType<typeof stageDownloadedNpmArtifactCandidate>> | null = null;
        let runtime: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | null = null;
        try {
            const sourceRoot = join(parent, 'source');
            const origin = webSocketTargetOrigin(new URL(gateway.url));
            const sourceManifest = {
                ...manifest,
                hostAccess: {
                    ...manifest.hostAccess,
                    required: [{
                        ...manifest.hostAccess.required[0],
                        scope: {
                            targets: [{ kind: 'fixedOrigin', origin }],
                            transports: ['websocket'], privateNetwork: true,
                        },
                    }],
                },
            };
            await mkdir(join(sourceRoot, '.happier-plugin'), { recursive: true });
            await mkdir(join(sourceRoot, 'dist'));
            await writeFile(join(sourceRoot, 'package.json'), await readFile(join(fixtureRoot, 'package.json')));
            await writeFile(join(sourceRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(sourceManifest));
            await writeFile(join(sourceRoot, 'dist', 'daemon.js'), PUBLIC_WEBSOCKET_MODULE);
            const packed = await packLocalPlugin({ locator: sourceRoot, outPath: archivePath });
            expect(
                packed,
                packed.ok ? '' : packed.diagnostics.map((entry) => entry.message).join('\n'),
            ).toMatchObject({ ok: true, pluginId: 'acme.packed-websocket' });
            if (!packed.ok) return;

            const archiveBytes = await readFile(archivePath);
            await mkdir(installRoot);
            staged = await stageDownloadedNpmArtifactCandidate({
                candidate: {
                    source: {
                        kind: 'npm',
                        registryOrigin: 'https://packed-websocket.invalid',
                        packageName: 'happier-plugin-acme-packed-websocket',
                        version: '1.0.0',
                        integrity: sriSha512(archiveBytes),
                        tarballUrl: pathToFileURL(archivePath).href,
                    },
                    artifactPath: archivePath,
                    byteLength: archiveBytes.byteLength,
                    archiveDigestSha256: `sha256:${createHash('sha256').update(archiveBytes).digest('hex')}`,
                    registrySignature: { status: 'absent' },
                    provenance: { status: 'absent' },
                },
                stagingParentPath: installRoot,
            });
            expect(staged.ok).toBe(true);
            if (!staged.ok) return;

            runtime = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
                manifest: JSON.parse(await readFile(join(staged.candidate.rootPath, '.happier-plugin', 'plugin.json'), 'utf8')),
                files: {
                    'package.json': await readFile(join(staged.candidate.rootPath, 'package.json'), 'utf8'),
                    'dist/daemon.js': await readFile(join(staged.candidate.rootPath, 'dist/daemon.js'), 'utf8'),
                },
            }] });
            const result = await executeContributedAction({
                runtimeRegistry: runtime.registry,
                actionId: 'acme.packed-websocket/connect',
                input: { url: gateway.url, message: 'packed-client-ready' },
                context: { surface: 'cli', signal: new AbortController().signal },
            });

            expect(result).toEqual({
                matched: true,
                result: { ok: true, result: {
                url: gateway.url,
                protocol: 'fixture-v1',
                text: 'fixture-welcome',
                } },
            });
            await expect(gateway.received).resolves.toBe('packed-client-ready');
        } finally {
            try {
                await runtime?.dispose();
            } finally {
                try {
                    await gateway.close();
                } finally {
                    try {
                        if (staged?.ok) await cleanupStagedNpmArtifactCandidate(staged.candidate);
                    } finally {
                        await rm(parent, { recursive: true, force: true });
                    }
                }
            }
        }
    });
});

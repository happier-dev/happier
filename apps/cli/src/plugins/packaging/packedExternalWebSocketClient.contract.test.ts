import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { ingestPluginManifestV2, PluginHostAccessRequestV2Schema } from '@happier-dev/protocol';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

import {
    cleanupStagedNpmArtifactCandidate,
    stageDownloadedNpmArtifactCandidate,
} from '../distribution/npm/stage';
import { sriSha512 } from '../distribution/testkit/npmTarball';
import { createGlobalFetchRuntime } from '../runtime/fetch/globalFetchRuntime';
import { createStablePluginHttpHost } from '../runtime/fetch/service';
import { webSocketTargetOrigin } from '../runtime/fetch/webSocket';
import { createLoggerAndEventsAvailablePluginInvocationServiceBinding } from '../runtime/invocation/services/factory';
import { packLocalPlugin } from './pack';

const fixtureRoot = fileURLToPath(new URL(
    '../testkit/fixtures/packed-external-websocket-client',
    import.meta.url,
));

type PackedWebSocketAction = (
    input: Readonly<{ url: string; message: string }>,
    context: Readonly<{
        signal: AbortSignal;
        services: Readonly<{ http: Pick<HttpService, 'openWebSocket'> }>;
    }>,
) => Promise<Readonly<{ url: string; protocol: string; text: string }>>;

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
        try {
            const packed = await packLocalPlugin({ locator: fixtureRoot, outPath: archivePath });
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

            let action: PackedWebSocketAction | null = null;
            const module = await import(pathToFileURL(join(
                staged.candidate.rootPath,
                'dist/daemon.js',
            )).href) as Readonly<{
                activate(api: Readonly<{ actions: Readonly<{
                    register(id: string, handler: PackedWebSocketAction): void;
                }> }>): void;
            }>;
            module.activate({
                actions: {
                    register(id, handler) {
                        expect(id).toBe('connect');
                        action = handler;
                    },
                },
            });
            expect(action).not.toBeNull();

            const origin = webSocketTargetOrigin(new URL(gateway.url));
            const host = createStablePluginHttpHost({ adapter: createGlobalFetchRuntime() });
            const service = host.bind(Object.freeze({
                plugin: Object.freeze({ id: 'acme.packed-websocket', version: '1.0.0' }),
                contribution: Object.freeze({ id: 'connect', qualifiedId: 'acme.packed-websocket/actions/connect' }),
                generation: 'packed-websocket-generation',
                correlationId: 'packed-websocket-correlation',
                surface: 'cli' as const,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            }), createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                'packed-websocket-generation',
                'packed-websocket-binding',
                [{
                    required: true,
                    request: PluginHostAccessRequestV2Schema.parse({
                        id: 'gateway',
                        capability: 'network.client',
                        reason: 'Maintain the declared gateway connection',
                        scope: {
                            targets: [{ kind: 'fixedOrigin', origin }],
                            transports: ['websocket'],
                            privateNetwork: true,
                        },
                    }),
                }],
            ));
            const result = await action!({ url: gateway.url, message: 'packed-client-ready' }, {
                signal: new AbortController().signal,
                services: Object.freeze({ http: service }),
            });

            expect(result).toEqual({
                url: gateway.url,
                protocol: 'fixture-v1',
                text: 'fixture-welcome',
            });
            await expect(gateway.received).resolves.toBe('packed-client-ready');
        } finally {
            await gateway.close();
            if (staged?.ok) await cleanupStagedNpmArtifactCandidate(staged.candidate);
            await rm(parent, { recursive: true, force: true });
        }
    });
});

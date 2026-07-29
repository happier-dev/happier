import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KOKORO_DEFAULT_TTS_PACK_ID } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

function sha256Hex(input: Buffer | string): string {
    return createHash('sha256').update(input).digest('hex');
}

type ServedPack = Readonly<{
    version: string;
    declaredModelBytes: Buffer;
    servedModelBytes?: Buffer;
}>;

describe('voiceInferenceWorker install integrity', () => {
    const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_MODEL_PACK_MANIFESTS'] as const;
    let envScope = createEnvKeyScope(envKeys);
    const tempDirs: string[] = [];
    const servers: Server[] = [];

    async function createHomeDir(): Promise<string> {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-voice-inference-install-integrity-'));
        tempDirs.push(homeDir);
        return homeDir;
    }

    async function importWorkerModuleForHome(homeDir: string) {
        process.env.HAPPIER_HOME_DIR = homeDir;
        vi.resetModules();
        const configurationModule = await import('@/configuration');
        configurationModule.reloadConfiguration();
        const workerModule = await import('./voiceInferenceWorker');
        const pathsModule = await import('./voiceInferencePaths');
        return {
            workerModule,
            paths: pathsModule.resolveVoiceInferencePaths(),
        };
    }

    afterEach(async () => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
        while (servers.length > 0) {
            const server = servers.pop();
            if (!server) {
                continue;
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            }).catch(() => undefined);
        }
        await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    });

    async function startPackServer(params: Readonly<{
        packId: string;
        currentPack: () => ServedPack;
    }>): Promise<number> {
        const server = createServer();
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                const pack = params.currentPack();
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId: params.packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: pack.version,
                        voices: [{ id: 'af_bella', title: 'Bella' }],
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(pack.declaredModelBytes),
                                sizeBytes: pack.declaredModelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    const modelBytes = pack.servedModelBytes ?? pack.declaredModelBytes;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        return address.port;
    }

    it('persists the installed manifest content hash instead of the manifest URL', async () => {
        const packId = KOKORO_DEFAULT_TTS_PACK_ID;
        const servedPack: ServedPack = {
            version: '2026-04-17',
            declaredModelBytes: Buffer.from('model-v1'),
        };
        const port = await startPackServer({
            packId,
            currentPack: () => servedPack,
        });
        const homeDir = await createHomeDir();
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${port}/manifest.json`,
        });

        const { workerModule, paths } = await importWorkerModuleForHome(homeDir);
        const worker = await workerModule.startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('unused'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'unused.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const packManifestPath = join(paths.packsRootDir, packId, 'pack.json');
        const installedManifestBytes = await readFile(packManifestPath);
        const installsState = JSON.parse(await readFile(paths.installsStateFilePath, 'utf8'));
        expect(installsState.modelsById[packId]).toMatchObject({
            version: '2026-04-17',
            manifestHash: sha256Hex(installedManifestBytes),
        });

        await worker.stop();
    });

    it('keeps the previous installed pack on disk when a reinstall fails verification', async () => {
        const packId = KOKORO_DEFAULT_TTS_PACK_ID;
        let servedPack: ServedPack = {
            version: '2026-04-17',
            declaredModelBytes: Buffer.from('model-v1'),
        };
        const port = await startPackServer({
            packId,
            currentPack: () => servedPack,
        });
        const homeDir = await createHomeDir();
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${port}/manifest.json`,
        });

        const { workerModule, paths } = await importWorkerModuleForHome(homeDir);
        const worker = await workerModule.startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('unused'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'unused.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const packDir = join(paths.packsRootDir, packId);
        const originalManifestBytes = await readFile(join(packDir, 'pack.json'));
        const originalModelBytes = await readFile(join(packDir, 'model.onnx'));
        const originalManifestHash = sha256Hex(originalManifestBytes);

        servedPack = {
            version: '2026-04-18',
            declaredModelBytes: Buffer.from('model-v2'),
            // Keep the same byte length so the installer fails with a hash mismatch (not size mismatch).
            servedModelBytes: Buffer.from('model-v3'),
        };

        await expect(worker.installModel({ packId })).rejects.toThrow('model_pack_sha256_mismatch');

        expect(await readFile(join(packDir, 'pack.json'))).toEqual(originalManifestBytes);
        expect(await readFile(join(packDir, 'model.onnx'))).toEqual(originalModelBytes);

        const installsState = JSON.parse(await readFile(paths.installsStateFilePath, 'utf8'));
        expect(installsState.modelsById[packId]).toMatchObject({
            version: '2026-04-17',
            manifestHash: originalManifestHash,
            lastError: 'model_pack_sha256_mismatch',
        });

        await expect(worker.getModelsStatus([packId])).resolves.toEqual([
            expect.objectContaining({
                packId,
                version: '2026-04-17',
                installState: 'installed',
                lastError: 'model_pack_sha256_mismatch',
            }),
        ]);

        await worker.removeModel(packId);
        await expect(worker.getModelsStatus([packId])).resolves.toEqual([
            expect.objectContaining({
                packId,
                installState: 'not_installed',
                lastError: null,
            }),
        ]);

        await worker.stop();
    });
});

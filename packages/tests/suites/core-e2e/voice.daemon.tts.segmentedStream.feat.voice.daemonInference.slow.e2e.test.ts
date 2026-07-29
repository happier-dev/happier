import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceStatusResponseSchema,
    DaemonVoiceInferenceTtsStreamAckResponseSchema,
    DaemonVoiceInferenceTtsStreamNextResponseSchema,
    DaemonVoiceInferenceTtsStreamStartResponseSchema,
    DaemonVoiceInferenceTtsStreamStatusResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

function sha256Hex(value: Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

async function createFakeVoiceInferenceRuntimeModule(filePath: string): Promise<void> {
    await writeFile(
        filePath,
        [
            'export const voiceInferenceRuntimeEngine = {',
            '    warmModel: async () => {},',
            '    synthesizeTts: async (input) => {',
            "        const voice = input.voiceId ?? 'none';",
            "        const speed = input.speed ?? 'none';",
            "        return { bytes: Buffer.from(`tts:${input.text}:${voice}:${speed}`), output: input.output, name: 'segment.wav' };",
            '    },',
            "    transcribeAudio: async () => ({ text: 'unused', language: 'en' }),",
            '};',
            '',
        ].join('\n'),
        'utf8',
    );
}

async function startManifestServer(params: Readonly<{
    packId: string;
    modelBytes: Uint8Array;
}>): Promise<Readonly<{ server: Server; manifestUrl: string }>> {
    const server = createServer((request, response) => {
        const address = server.address();
        if (!address || typeof address === 'string') {
            response.statusCode = 500;
            response.end('missing-address');
            return;
        }

        if (request.url === '/manifest.json') {
            response.statusCode = 200;
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({
                packId: params.packId,
                kind: 'tts_sherpa',
                model: 'kokoro',
                version: '2026-06-29',
                files: [
                    {
                        path: 'model.onnx',
                        url: `http://127.0.0.1:${address.port}/model.onnx`,
                        sha256: sha256Hex(params.modelBytes),
                        sizeBytes: params.modelBytes.byteLength,
                    },
                ],
            }));
            return;
        }

        if (request.url === '/model.onnx') {
            response.statusCode = 200;
            response.setHeader('content-length', String(params.modelBytes.byteLength));
            response.end(Buffer.from(params.modelBytes));
            return;
        }

        response.statusCode = 404;
        response.end('not-found');
    });

    await new Promise<void>((resolveStart, rejectStart) => {
        server.listen(0, '127.0.0.1', () => resolveStart());
        server.once('error', rejectStart);
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('voice_inference_manifest_server_address_missing');
    }

    return {
        server,
        manifestUrl: `http://127.0.0.1:${(address as AddressInfo).port}/manifest.json`,
    };
}

describe('core e2e: daemon segmented TTS stream', () => {
    let server: StartedServer | null = null;
    let daemon: StartedDaemon | null = null;
    let manifestServer: Server | null = null;

    afterAll(async () => {
        await daemon?.stop().catch(() => {});
        await server?.stop().catch(() => {});
        await new Promise<void>((resolveStop) => manifestServer?.close(() => resolveStop()) ?? resolveStop());
    });

    it('delivers daemon TTS segments over RPC and gates completion on playback ack', async () => {
        const testDir = run.testDir('voice-daemon-tts-segmented-stream');
        const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        const runtimeModulePath = resolve(join(testDir, 'voice-inference-runtime-override.mjs'));
        const ttsPackId = 'kokoro-82m-v1.0-onnx-q8-wasm';

        await mkdir(daemonHomeDir, { recursive: true });
        await createFakeVoiceInferenceRuntimeModule(runtimeModulePath);

        const manifest = await startManifestServer({
            packId: ttsPackId,
            modelBytes: Buffer.from('fake-tts-model'),
        });
        manifestServer = manifest.server;

        server = await startServerLight({ testDir, dbProvider: 'sqlite' });
        const auth = await createTestAuth(server.baseUrl);
        const machineKey = Uint8Array.from(randomBytes(32));
        const seeded = await seedCliDataKeyAuthForServer({
            cliHome: daemonHomeDir,
            serverUrl: server.baseUrl,
            token: auth.token,
            machineKey,
        });

        const daemonEnv: NodeJS.ProcessEnv = {
            ...process.env,
            CI: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: server.baseUrl,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
                [ttsPackId]: manifest.manifestUrl,
            }),
            HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE: pathToFileURL(runtimeModulePath).href,
        };

        await ensureCliSharedDepsBuilt({ testDir, env: daemonEnv }, { skipSourceFreshnessCheck: true });
        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: daemonHomeDir,
            env: daemonEnv,
        });

        const ui = createUserScopedSocketCollector(server.baseUrl, auth.token);
        ui.connect();

        try {
            await waitFor(() => ui.isConnected(), {
                timeoutMs: 20_000,
                context: 'user-scoped socket for daemon segmented TTS core e2e',
            });
            const machineRpc = createDataKeyRpcClient(ui, machineKey);

            await waitFor(async () => {
                const raw = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`, {}, 30_000);
                const parsed = DaemonVoiceInferenceStatusResponseSchema.parse(
                    unwrapDataKeyRpcResult(raw, 'daemon voice inference status'),
                );
                return parsed.ok === true;
            }, {
                timeoutMs: 60_000,
                context: 'daemon voice inference status ready',
            });

            const install = DaemonVoiceInferenceModelsInstallResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL}`,
                        { packId: ttsPackId },
                        120_000,
                    ),
                    'daemon voice inference TTS model install',
                ),
            );
            expect(install.ok).toBe(true);
            if (install.ok !== true) {
                throw new Error('daemon voice inference TTS model install failed');
            }
            expect(install.model.packId).toBe(ttsPackId);
            expect(install.model.installState).toBe('installed');

            const started = DaemonVoiceInferenceTtsStreamStartResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START}`,
                        {
                            requestId: 'tts-stream-e2e',
                            text: 'First sentence. Second sentence.',
                            packId: ttsPackId,
                            voiceId: 'af_heart',
                            speed: 1,
                            output: { codec: 'wav', mimeType: 'audio/wav' },
                            prefetchDepth: 1,
                        },
                        30_000,
                    ),
                    'daemon segmented TTS stream start',
                ),
            );
            expect(started).toMatchObject({
                ok: true,
                requestId: 'tts-stream-e2e',
                segmentCount: 2,
                output: { codec: 'wav', mimeType: 'audio/wav' },
            });
            if (started.ok !== true) {
                throw new Error('daemon segmented TTS stream start failed');
            }

            const first = DaemonVoiceInferenceTtsStreamNextResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT}`,
                        { streamId: started.streamId, generation: started.generation },
                        30_000,
                    ),
                    'daemon segmented TTS first next',
                ),
            );
            expect(first.ok).toBe(true);
            if (first.ok !== true || first.event.type !== 'segment') {
                throw new Error('daemon segmented TTS first segment missing');
            }
            expect(first.event.segmentIndex).toBe(0);
            expect(first.event.text).toBe('First sentence.');
            expect(first.event.isLastSegment).toBe(false);
            expect(Buffer.from(first.event.audio.contentBase64, 'base64').toString('utf8')).toBe('tts:First sentence.:af_heart:1');

            const statusBeforeAck = DaemonVoiceInferenceTtsStreamStatusResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS}`,
                        { streamId: started.streamId, generation: started.generation },
                        30_000,
                    ),
                    'daemon segmented TTS status before ack',
                ),
            );
            expect(statusBeforeAck).toMatchObject({
                ok: true,
                state: 'open',
                deliveredSegmentCount: 1,
                ackedSegmentCount: 0,
                outstandingSegmentCount: 1,
            });

            const firstAck = DaemonVoiceInferenceTtsStreamAckResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK}`,
                        {
                            streamId: started.streamId,
                            generation: started.generation,
                            segmentId: first.event.segmentId,
                            segmentIndex: first.event.segmentIndex,
                        },
                        30_000,
                    ),
                    'daemon segmented TTS first ack',
                ),
            );
            expect(firstAck).toMatchObject({ ok: true, ackedSegmentIndex: 0, complete: false });

            const second = DaemonVoiceInferenceTtsStreamNextResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT}`,
                        { streamId: started.streamId, generation: started.generation },
                        30_000,
                    ),
                    'daemon segmented TTS second next',
                ),
            );
            expect(second.ok).toBe(true);
            if (second.ok !== true || second.event.type !== 'segment') {
                throw new Error('daemon segmented TTS second segment missing');
            }
            expect(second.event.segmentIndex).toBe(1);
            expect(second.event.text).toBe('Second sentence.');
            expect(second.event.isLastSegment).toBe(true);
            expect(Buffer.from(second.event.audio.contentBase64, 'base64').toString('utf8')).toBe('tts:Second sentence.:af_heart:1');

            const finalAck = DaemonVoiceInferenceTtsStreamAckResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK}`,
                        {
                            streamId: started.streamId,
                            generation: started.generation,
                            segmentId: second.event.segmentId,
                            segmentIndex: second.event.segmentIndex,
                        },
                        30_000,
                    ),
                    'daemon segmented TTS final ack',
                ),
            );
            expect(finalAck).toMatchObject({ ok: true, ackedSegmentIndex: 1, complete: true });

            const closedStatus = DaemonVoiceInferenceTtsStreamStatusResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS}`,
                        { streamId: started.streamId, generation: started.generation },
                        30_000,
                    ),
                    'daemon segmented TTS closed status',
                ),
            );
            expect(closedStatus).toMatchObject({ ok: false, errorCode: 'stream_not_found' });
        } finally {
            ui.close();
        }
    }, 420_000);
});

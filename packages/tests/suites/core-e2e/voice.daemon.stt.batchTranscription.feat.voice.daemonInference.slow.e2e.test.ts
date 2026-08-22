import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceStatusResponseSchema,
    DaemonVoiceInferenceSttTranscribeResponseSchema,
    DaemonVoiceInferenceSttUploadFinalizeResponseSchema,
    DaemonVoiceInferenceSttUploadInitResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { createSession, fetchAllMessages } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { fetchJson } from '../../src/testkit/http';
import { readVoiceFixture } from '../../src/testkit/voice/voiceFixture';

import { createEncryptedTransferChunkEnvelope } from '../../../../apps/cli/src/machines/transfer/transferChunkEncryption';

const run = createRunDirs({ runLabel: 'core' });

function sha256Hex(value: Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

async function createFakeVoiceInferenceRuntimeModule(params: Readonly<{
    filePath: string;
    expectedText: string;
}>): Promise<void> {
    await writeFile(
        params.filePath,
        [
            "import { readFile } from 'node:fs/promises';",
            '',
            `const expectedText = ${JSON.stringify(params.expectedText)};`,
            '',
            'export const voiceInferenceRuntimeEngine = {',
            '    warmModel: async () => {},',
            "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
            '    transcribeAudio: async (input) => {',
            '        const bytes = await readFile(input.filePath);',
            '        return {',
            "            text: `${expectedText}:${bytes.byteLength}:${input.inputMimeType}`,",
            "            language: input.language ?? 'en',",
            '        };',
            '    },',
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
    const requiredFiles = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'] as const;
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
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: requiredFiles.map((path) => (
                    {
                        path,
                        url: `http://127.0.0.1:${address.port}/${path}`,
                        sha256: sha256Hex(params.modelBytes),
                        sizeBytes: params.modelBytes.byteLength,
                    }
                )),
            }));
            return;
        }

        if (requiredFiles.some((path) => request.url === `/${path}`)) {
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

describe('core e2e: daemon STT batch transcription', () => {
    let server: StartedServer | null = null;
    let daemon: StartedDaemon | null = null;
    let manifestServer: Server | null = null;

    afterAll(async () => {
        await daemon?.stop().catch(() => {});
        await server?.stop().catch(() => {});
        await new Promise<void>((resolveStop) => manifestServer?.close(() => resolveStop()) ?? resolveStop());
    });

    it('transcribes uploaded audio through daemon STT and leaves transcript ownership with the canonical UI commit path', async () => {
        const testDir = run.testDir('voice-daemon-stt-batch-transcription');
        const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        const runtimeModulePath = resolve(join(testDir, 'voice-inference-runtime-override.mjs'));
        const sttPackId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const { bytes: wavBytes } = await readVoiceFixture('short-command-16k');
        const expectedTranscriptionText = 'hello daemon stt';

        await mkdir(daemonHomeDir, { recursive: true });
        await createFakeVoiceInferenceRuntimeModule({
            filePath: runtimeModulePath,
            expectedText: expectedTranscriptionText,
        });

        const manifest = await startManifestServer({
            packId: sttPackId,
            modelBytes: Buffer.from('fake-stt-model'),
        });
        manifestServer = manifest.server;

        server = await startServerLight({ testDir, dbProvider: 'sqlite' });
        const auth = await createTestAuth(server.baseUrl);
        const seeded = await seedCliAuthForTestAccount({
            cliHome: daemonHomeDir,
            serverUrl: server.baseUrl,
            auth,
            mode: 'dataKey',
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
                [sttPackId]: manifest.manifestUrl,
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
                context: 'user-scoped socket for daemon STT core e2e',
            });

            const machineRpc = createDataKeyRpcClient(ui, auth.accountMachineKey);

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
                        {
                            packId: sttPackId,
                        },
                        120_000,
                    ),
                    'daemon voice inference model install',
                ),
            );
            expect(install).toMatchObject({ ok: true });
            if (install.ok !== true) {
                throw new Error('daemon voice inference model install failed');
            }
            expect(install.model.packId).toBe(sttPackId);
            expect(install.model.installState).toBe('installed');

            const uploadInit = DaemonVoiceInferenceSttUploadInitResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT}`,
                        {
                            requestId: 'stt-upload-1',
                            sizeBytes: wavBytes.byteLength,
                            inputMimeType: 'audio/wav',
                        },
                        30_000,
                    ),
                    'daemon STT upload init',
                ),
            );
            expect(uploadInit.success).toBe(true);
            if (uploadInit.success !== true) {
                throw new Error('daemon STT upload init failed');
            }

            let chunkIndex = 0;
            for (let offset = 0; offset < wavBytes.byteLength; offset += uploadInit.chunkSizeBytes) {
                const chunkBytes = wavBytes.subarray(offset, Math.min(offset + uploadInit.chunkSizeBytes, wavBytes.byteLength));
                const encryptedChunk = createEncryptedTransferChunkEnvelope({
                    transferId: uploadInit.uploadId,
                    sequence: chunkIndex,
                    payload: chunkBytes,
                    recipientPublicKeyBase64: uploadInit.recipientPublicKeyBase64,
                });
                const uploadChunk = unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK}`,
                        {
                            uploadId: uploadInit.uploadId,
                            index: chunkIndex,
                            payloadBase64: encryptedChunk.payloadBase64,
                            encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
                        },
                        30_000,
                    ),
                    `daemon STT upload chunk ${chunkIndex}`,
                ) as { success?: boolean; error?: string };
                expect(uploadChunk.success).toBe(true);
                chunkIndex += 1;
            }

            const uploadFinalize = DaemonVoiceInferenceSttUploadFinalizeResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE}`,
                        {
                            uploadId: uploadInit.uploadId,
                        },
                        30_000,
                    ),
                    'daemon STT upload finalize',
                ),
            );
            expect(uploadFinalize.success).toBe(true);
            if (uploadFinalize.success !== true) {
                throw new Error('daemon STT upload finalize failed');
            }
            expect(uploadFinalize.sizeBytes).toBe(wavBytes.byteLength);

            const transcription = DaemonVoiceInferenceSttTranscribeResponseSchema.parse(
                unwrapDataKeyRpcResult(
                    await machineRpc.call(
                        `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE}`,
                        {
                            requestId: 'stt-request-1',
                            uploadId: uploadInit.uploadId,
                            packId: sttPackId,
                            language: 'en',
                            normalization: {
                                inputTransport: 'upload_transfer',
                                strategy: 'daemon_decode',
                                systemFfmpegAllowed: false,
                            },
                        },
                        30_000,
                    ),
                    'daemon STT transcribe',
                ),
            );
            if (transcription.ok !== true) {
                const statusAfterFailure = DaemonVoiceInferenceStatusResponseSchema.parse(
                    unwrapDataKeyRpcResult(
                        await machineRpc.call(
                            `${seeded.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`,
                            {},
                            30_000,
                        ),
                        'daemon voice inference status after STT failure',
                    ),
                );
                throw new Error(
                    `daemon STT transcribe failed: ${JSON.stringify({ transcription, statusAfterFailure })}`,
                );
            }
            expect(transcription).toMatchObject({ ok: true });
            expect(transcription.modelPackId).toBe(sttPackId);
            expect(transcription.language).toBe('en');
            expect(transcription.text).toBe(`${expectedTranscriptionText}:${wavBytes.byteLength}:audio/wav`);

            const startedServer = server;
            if (!startedServer) {
                throw new Error('server did not start');
            }

            const { sessionId } = await createSession(startedServer.baseUrl, auth.token);
            const baselineMessages = await fetchAllMessages(startedServer.baseUrl, auth.token, sessionId);
            expect(baselineMessages).toHaveLength(0);

            const afterTranscribeMessages = await fetchAllMessages(startedServer.baseUrl, auth.token, sessionId);
            expect(afterTranscribeMessages).toHaveLength(0);

            const localId = `voice-daemon-stt-${randomUUID()}`;
            const commitSecret = Uint8Array.from(randomBytes(32));
            const ciphertext = encryptLegacyBase64({
                role: 'user',
                content: { type: 'text', text: transcription.text },
                localId,
                meta: { source: 'ui', sentFrom: 'voice-daemon-stt-e2e' },
            }, commitSecret);
            const commit = await fetchJson<any>(`${startedServer.baseUrl}/v2/sessions/${sessionId}/messages`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${auth.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ ciphertext, localId }),
                timeoutMs: 30_000,
            });
            expect(commit.status).toBe(200);
            expect(commit.data?.didWrite).toBe(true);
            expect(commit.data?.message?.localId).toBe(localId);

            await waitFor(async () => {
                const rows = await fetchAllMessages(startedServer.baseUrl, auth.token, sessionId);
                return rows.filter((row) => row.localId === localId).length === 1;
            }, {
                timeoutMs: 20_000,
                context: 'voice daemon STT canonical transcript commit',
            });

            const finalMessages = await fetchAllMessages(startedServer.baseUrl, auth.token, sessionId);
            expect(finalMessages.filter((row) => row.localId === localId)).toHaveLength(1);
            expect(finalMessages).toHaveLength(1);
        } finally {
            ui.close();
        }
    }, 420_000);
});

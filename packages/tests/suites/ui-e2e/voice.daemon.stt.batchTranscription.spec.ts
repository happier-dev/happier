import { test, expect, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    DaemonVoiceInferenceModelsInstallResponseSchema,
    DaemonVoiceInferenceStatusResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { ensureCliSharedDepsBuilt } from '../../src/testkit/process/cliDist';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import {
    installAuthBootstrapStorageSnapshot,
    type AuthBootstrapStorageSnapshot,
} from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import {
    dismissSetupWizardIfVisible,
    gotoDomContentLoadedWithPathFallback,
    normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { seedDismissedPendingSetupIntent } from '../../src/testkit/uiE2e/pendingSetupIntent';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function sha256Hex(value: Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

function createMonoPcm16WavBuffer(sampleCount = 8, sampleRate = 16_000): Buffer {
    const dataSize = sampleCount * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        buffer.writeInt16LE(index * 128, 44 + (index * 2));
    }
    return buffer;
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
            "            text: `${expectedText}:${bytes.byteLength}:${input.inputMimeType}` ,",
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

async function installDaemonSttModel(params: Readonly<{
    serverBaseUrl: string;
    authToken: string;
    machineKey: Uint8Array;
    machineId: string;
    packId: string;
}>): Promise<void> {
    const socket = createUserScopedSocketCollector(params.serverBaseUrl, params.authToken);
    socket.connect();
    const machineRpc = createDataKeyRpcClient(socket, params.machineKey);

    try {
        await waitFor(async () => {
            const raw = await machineRpc.call(`${params.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`, {}, 30_000);
            const parsed = DaemonVoiceInferenceStatusResponseSchema.parse(
                unwrapDataKeyRpcResult(raw, 'daemon voice inference status'),
            );
            return parsed.ok === true;
        }, {
            timeoutMs: 60_000,
            context: 'ui e2e daemon voice inference status ready',
        });

        const install = DaemonVoiceInferenceModelsInstallResponseSchema.parse(
            unwrapDataKeyRpcResult(
	                await machineRpc.call(
	                    `${params.machineId}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL}`,
	                    {
	                        packId: params.packId,
	                    },
	                    120_000,
	                ),
	                'ui e2e daemon voice inference model install',
            ),
        );

        expect(install.ok).toBe(true);
        if (install.ok !== true) {
            throw new Error('daemon voice inference model install failed');
        }
        expect(install.model.packId).toBe(params.packId);
        expect(install.model.installState).toBe('installed');
    } finally {
        socket.disconnect();
    }
}

async function configureVoiceDaemonSttSettings(params: Readonly<{
    page: Page;
    packId: string;
    machineId: string;
    voiceHomeDirectory: string;
}>): Promise<Record<string, unknown>> {
    return await params.page.evaluate(({ packId, machineId, voiceHomeDirectory }) => {
        const settingsKey = 'mmkv.default\\settings';
        const pendingSettingsKey = 'mmkv.default\\pending-settings';

        const parseRecord = (raw: string | null): Record<string, unknown> => {
            if (!raw) return {};
            try {
                const parsed = JSON.parse(raw) as unknown;
                return typeof parsed === 'object' && parsed ? parsed as Record<string, unknown> : {};
            } catch {
                return {};
            }
        };

        const persistedEnvelope = parseRecord(window.localStorage.getItem(settingsKey));
        const persistedSettings = typeof persistedEnvelope.settings === 'object' && persistedEnvelope.settings
            ? persistedEnvelope.settings as Record<string, unknown>
            : {};
        const pendingSettings = parseRecord(window.localStorage.getItem(pendingSettingsKey));
        const existingVoice = typeof persistedSettings.voice === 'object' && persistedSettings.voice
            ? persistedSettings.voice as Record<string, unknown>
            : {};
        const existingProviders = typeof existingVoice.providers === 'object' && existingVoice.providers
            ? existingVoice.providers as Record<string, unknown>
            : {};
        const existingLocalConversationEnvelope = typeof existingProviders.local_conversation === 'object'
            && existingProviders.local_conversation
            ? existingProviders.local_conversation as Record<string, unknown>
            : {};
        const existingLocalConversation = typeof existingLocalConversationEnvelope.config === 'object'
            && existingLocalConversationEnvelope.config
            ? existingLocalConversationEnvelope.config as Record<string, unknown>
            : {};
        const existingAgent = typeof existingLocalConversation.agent === 'object' && existingLocalConversation.agent
            ? existingLocalConversation.agent as Record<string, unknown>
            : {};
        const {
            machineTargetMode: _legacyMachineTargetMode,
            machineTargetId: _legacyMachineTargetId,
            autoTargetMachineId: _legacyAutoTargetMachineId,
            ...canonicalExistingAgent
        } = existingAgent;
        const existingExecutionMachine = typeof existingVoice.executionMachine === 'object'
            && existingVoice.executionMachine
            ? existingVoice.executionMachine as Record<string, unknown>
            : {};
        const { adapters: _legacyAdapters, ...canonicalExistingVoice } = existingVoice;
        const featureToggles = {
            ...(typeof persistedSettings.featureToggles === 'object' && persistedSettings.featureToggles
                ? persistedSettings.featureToggles as Record<string, unknown>
                : {}),
            voice: true,
            'execution.runs': true,
            'voice.agent': true,
            'voice.daemonInference': true,
        };
        const voice = {
            ...canonicalExistingVoice,
            providerId: 'local_conversation',
            assistantLanguage: 'en',
            executionMachine: {
                ...existingExecutionMachine,
                mode: 'fixed',
                machineId,
                autoMachineId: null,
            },
            providers: {
                ...existingProviders,
                local_conversation: {
                    schemaVersion: 1,
                    config: {
                        ...existingLocalConversation,
                        conversationMode: 'agent',
                        networkTimeoutMs: 15_000,
                        agent: {
                            ...canonicalExistingAgent,
                            backend: 'daemon',
                        },
                        stt: {
                            provider: 'local_neural',
                            openaiCompat: {
                                baseUrl: null,
                                insecureLocalOriginConsent: null,
                                insecureLocalConsentMachineId: null,
                                apiKey: null,
                                model: 'whisper-1',
                            },
                            localNeural: {
                                assetId: packId,
                                language: 'en',
                                execution: 'daemon',
                            },
                            providers: {},
                        },
                    },
                },
            },
        };

        persistedEnvelope.settings = {
            ...persistedSettings,
            experiments: true,
            featureToggles,
            recentMachinePaths: [{ machineId, path: voiceHomeDirectory }],
            voice,
        };

        window.localStorage.setItem(settingsKey, JSON.stringify(persistedEnvelope));
        window.localStorage.setItem(
            pendingSettingsKey,
            JSON.stringify({
                ...pendingSettings,
                experiments: true,
                featureToggles,
                recentMachinePaths: [{ machineId, path: voiceHomeDirectory }],
                voice,
            }),
        );
        return voice;
    }, {
        packId: params.packId,
        machineId: params.machineId,
        voiceHomeDirectory: params.voiceHomeDirectory,
    });
}

const EXPECTED_TRANSCRIPTION_PREFIX = 'hello daemon stt';

function buildServerScopedUiUrl(uiBaseUrl: string, serverBaseUrl: string, path: string): string {
    const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
    url.searchParams.set('server', serverBaseUrl);
    return url.toString();
}

function buildVoiceQaUiUrl(params: Readonly<{
    uiBaseUrl: string;
    sessionId: string;
    packId?: string;
    machineId?: string;
    basePath?: string;
}>): string {
    const url = new URL('/dev/voice-qa', params.uiBaseUrl.endsWith('/') ? params.uiBaseUrl : `${params.uiBaseUrl}/`);
    url.searchParams.set('happier_hmr', '0');
    url.searchParams.set('voiceQaSessionId', params.sessionId);
    if (params.packId) {
        url.searchParams.set('voiceQaRecordedAudioDaemonSttPackId', params.packId);
    }
    if (params.machineId) {
        url.searchParams.set('voiceQaRecordedAudioDaemonMachineId', params.machineId);
    }
    if (params.basePath) {
        url.searchParams.set('voiceQaRecordedAudioDaemonBasePath', params.basePath);
    }
    return url.toString();
}

test.describe('ui e2e: daemon STT batch transcription', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('voice-daemon-stt-batch-transcription-suite');
    const daemonHomeDir = resolve(join(suiteDir, 'daemon-home'));
    const voiceHomeDirectory = resolve(join(daemonHomeDir, 'voice-agent'));
    const runtimeModulePath = resolve(join(suiteDir, 'voice-inference-runtime-override.mjs'));
    const recordedAudioPath = resolve(join(suiteDir, 'recording.wav'));
    const sttPackId = 'sherpa-onnx-stt-en-v1';
    const storageScope = `e2e-voice-daemon-stt-${run.runId}`;

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let daemon: StartedDaemon | null = null;
    let manifestServer: Server | null = null;
    let uiBaseUrl: string | null = null;
    let authBootstrapSnapshot: AuthBootstrapStorageSnapshot | null = null;
    let seededMachineId: string | null = null;

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        const wavBytes = createMonoPcm16WavBuffer();
        await mkdir(daemonHomeDir, { recursive: true });
        await mkdir(voiceHomeDirectory, { recursive: true });
        await writeFile(recordedAudioPath, wavBytes);
        await createFakeVoiceInferenceRuntimeModule({
            filePath: runtimeModulePath,
            expectedText: EXPECTED_TRANSCRIPTION_PREFIX,
        });

        const manifest = await startManifestServer({
            packId: sttPackId,
            modelBytes: Buffer.from('fake-stt-model'),
        });
        manifestServer = manifest.server;

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_FEATURE_VOICE__ENABLED: 'true',
                HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: 'false',
            },
        });
        const auth = await createTestAuth(server.baseUrl);
        const machineKey = Uint8Array.from(randomBytes(32));
        const seeded = await seedCliDataKeyAuthForServer({
            cliHome: daemonHomeDir,
            serverUrl: server.baseUrl,
            token: auth.token,
            machineKey,
        });
        authBootstrapSnapshot = buildAuthBootstrapStorageSnapshot({
            serverUrl: server.baseUrl,
            credentials: {
                token: auth.token,
                encryption: {
                    publicKey: Buffer.from(seeded.publicKey).toString('base64'),
                    machineKey: Buffer.from(machineKey).toString('base64'),
                },
            },
            storageScope,
        });
        seededMachineId = seeded.machineId;
        const daemonEnv: NodeJS.ProcessEnv = {
            ...process.env,
            CI: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_E2E_DAEMON_STARTUP_PHASE_TIMEOUT_MS: '20000',
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: server.baseUrl,
            HAPPIER_WEBAPP_URL: server.baseUrl,
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            HAPPIER_MODEL_PACK_MANIFESTS: JSON.stringify({
                [sttPackId]: manifest.manifestUrl,
            }),
            HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE: pathToFileURL(runtimeModulePath).href,
        };
        await ensureCliSharedDepsBuilt({ testDir: suiteDir, env: daemonEnv }, { skipSourceFreshnessCheck: true });
        daemon = await startTestDaemon({
            testDir: suiteDir,
            happyHomeDir: daemonHomeDir,
            env: daemonEnv,
        });
        await installDaemonSttModel({
            serverBaseUrl: server.baseUrl,
            authToken: auth.token,
            machineKey,
            machineId: seeded.machineId,
            packId: sttPackId,
        });

        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
        };
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        ui = await startUiWeb({
            testDir: suiteDir,
            env: uiWebEnv,
        });
        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await ui?.stop().catch(() => {});
        await daemon?.stop().catch(() => {});
        await server?.stop().catch(() => {});
        await new Promise<void>((resolveStop) => manifestServer?.close(() => resolveStop()) ?? resolveStop());
    });

    test('transcribes recorded audio through daemon STT from the voice QA route', async ({ page }) => {
        test.setTimeout(360_000);
        if (!uiBaseUrl || !authBootstrapSnapshot || !server || !seededMachineId) {
            throw new Error('missing UI e2e daemon STT fixtures');
        }
        const qaTargetSessionId = 'voice-daemon-stt-qa-session';

        await page.setViewportSize({ width: 1440, height: 900 });
        await installAuthBootstrapStorageSnapshot(page, authBootstrapSnapshot);
        await seedDismissedPendingSetupIntent(page, storageScope);
        await gotoDomContentLoadedWithPathFallback(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
            '/',
            120_000,
        );
        await dismissSetupWizardIfVisible({ page });
        const seededVoice = await configureVoiceDaemonSttSettings({
            page,
            packId: sttPackId,
            machineId: seededMachineId,
            voiceHomeDirectory,
        });
        expect(seededVoice).not.toHaveProperty('adapters');
        expect(seededVoice).toMatchObject({
            executionMachine: {
                mode: 'fixed',
                machineId: seededMachineId,
                autoMachineId: null,
            },
            providers: {
                local_conversation: {
                    schemaVersion: 1,
                    config: {
                        conversationMode: 'agent',
                        agent: { backend: 'daemon' },
                        stt: {
                            provider: 'local_neural',
                            localNeural: { assetId: sttPackId, execution: 'daemon' },
                        },
                    },
                },
            },
        });
        expect(JSON.stringify(seededVoice)).not.toMatch(
            /machineTargetMode|machineTargetId|autoTargetMachineId/,
        );

        await gotoDomContentLoadedWithPathFallback(
            page,
            buildVoiceQaUiUrl({
                uiBaseUrl,
                sessionId: qaTargetSessionId,
                packId: sttPackId,
                machineId: seededMachineId,
                basePath: voiceHomeDirectory,
            }),
            '/dev/voice-qa',
            120_000,
        );

        await expect.poll(async () => {
            let pathname = '';
            try {
                pathname = new URL(page.url()).pathname;
            } catch {
                pathname = '';
            }
            return {
                pathname,
                sessionIdInput: await page.getByTestId('voiceQa.sessionIdInput').count(),
                recordedAudioUriInput: await page.getByTestId('voiceQa.recordedAudio.uriInput').count(),
                recordedAudioDaemonPackIdInput: await page.getByTestId('voiceQa.recordedAudio.daemonPackIdInput').count(),
                recordedAudioDaemonMachineIdInput: await page.getByTestId('voiceQa.recordedAudio.daemonMachineIdInput').count(),
                recordedAudioDaemonBasePathInput: await page.getByTestId('voiceQa.recordedAudio.daemonBasePathInput').count(),
                recordedAudioTranscribe: await page.getByTestId('voiceQa.recordedAudio.transcribe').count(),
                createAccount: await page.getByTestId('welcome-create-account').count(),
            };
        }, {
            timeout: 120_000,
        }).toEqual({
            pathname: '/dev/voice-qa',
            sessionIdInput: 1,
            recordedAudioUriInput: 1,
            recordedAudioDaemonPackIdInput: 1,
            recordedAudioDaemonMachineIdInput: 1,
            recordedAudioDaemonBasePathInput: 1,
            recordedAudioTranscribe: 1,
            createAccount: 0,
        });

        await expect(page.getByTestId('voiceQa.recordedAudio.status')).toHaveCount(1, { timeout: 30_000 });
        await expect(page.getByTestId('voiceQa.recordedAudio.result')).toHaveCount(1, { timeout: 30_000 });
        await expect(page.getByTestId('voiceQa.sessionIdInput')).toHaveValue(qaTargetSessionId);
        await expect(page.getByTestId('voiceQa.recordedAudio.daemonPackIdInput')).toHaveValue(sttPackId);
        await expect(page.getByTestId('voiceQa.recordedAudio.daemonMachineIdInput')).toHaveValue(seededMachineId);
        await expect(page.getByTestId('voiceQa.recordedAudio.daemonBasePathInput')).toHaveValue(voiceHomeDirectory);
        await page.getByTestId('voiceQa.recordedAudio.fileInput').setInputFiles(recordedAudioPath);
        await expect(page.getByTestId('voiceQa.recordedAudio.selectedFile')).toContainText('recording.wav');
        await page.getByTestId('voiceQa.recordedAudio.transcribe').click();

        await expect(page.getByTestId('voiceQa.recordedAudio.status')).toContainText('success', { timeout: 180_000 });
        await expect(page.getByTestId('voiceQa.recordedAudio.result')).toHaveText(
            new RegExp(`^${EXPECTED_TRANSCRIPTION_PREFIX}:\\d+:audio/wav$`),
            { timeout: 180_000 },
        );
    });

    test('surfaces machine_unreachable when daemon STT is requested while the daemon is offline', async ({ page }) => {
        test.setTimeout(360_000);
        if (!uiBaseUrl || !authBootstrapSnapshot || !server || !seededMachineId) {
            throw new Error('missing UI e2e daemon STT fixtures');
        }
        const qaTargetSessionId = 'voice-daemon-stt-qa-session-daemon-offline';

        await daemon?.stop().catch(() => {});
        daemon = null;

        await page.setViewportSize({ width: 1440, height: 900 });
        await installAuthBootstrapStorageSnapshot(page, authBootstrapSnapshot);
        await seedDismissedPendingSetupIntent(page, storageScope);
        await gotoDomContentLoadedWithPathFallback(
            page,
            buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/?happier_hmr=0'),
            '/',
            120_000,
        );
        await dismissSetupWizardIfVisible({ page });

        await gotoDomContentLoadedWithPathFallback(
            page,
            buildVoiceQaUiUrl({
                uiBaseUrl,
                sessionId: qaTargetSessionId,
                packId: sttPackId,
                machineId: seededMachineId,
                basePath: voiceHomeDirectory,
            }),
            '/dev/voice-qa',
            120_000,
        );

        await expect(page.getByTestId('voiceQa.recordedAudio.status')).toHaveCount(1, { timeout: 30_000 });
        await expect(page.getByTestId('voiceQa.recordedAudio.result')).toHaveCount(1, { timeout: 30_000 });

        await page.getByTestId('voiceQa.recordedAudio.fileInput').setInputFiles(recordedAudioPath);
        await page.getByTestId('voiceQa.recordedAudio.transcribe').click();

        await expect(page.getByTestId('voiceQa.recordedAudio.status')).toContainText('error', { timeout: 60_000 });
        // Avoid pinning the full message copy; the stable signal is the daemon RPC error code text.
        await expect(page.getByTestId('voiceQa.recordedAudio.result')).toContainText('RPC method not available', { timeout: 60_000 });
    });
});

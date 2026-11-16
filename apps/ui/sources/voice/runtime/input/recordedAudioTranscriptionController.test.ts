import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createHash } from 'node:crypto';
const { createMachineFixture } = await import("@/dev/testkit");
const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
const { storage } = await import("@/sync/domains/state/storage");
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
const { createTransferRecipientKeyPair } = await import("@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption");
import { DaemonVoiceSpeechTranscribeUploadInitResponseSchema, DaemonVoiceSpeechTranscribeUploadChunkResponseSchema,
    DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema, DaemonVoiceSpeechTranscribeResponseSchema,
} from '@happier-dev/protocol/daemon/voiceSpeech';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

const { createPluginUiExecutableModuleHost } = await import("@/components/plugins/reactNative/executableModuleHost");
const { EMPTY_PLUGIN_UI_PROJECTION } = await import("@/sync/domains/plugins/ui/projection");
import type { PluginUiProjectionModel } from "@/sync/domains/plugins/ui/projection";
const { createProjectedExternalVoiceProviderDerivedScopeFactory, withdrawProjectedExternalVoiceProviders } = await import("@/voice/registry/projectedExternalVoiceProviderActivation");

const machineRpc = vi.fn();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios ?? spec.default ?? spec.web },
    });
});



vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('expo-file-system', () => ({ File: class {
    open() { return { size: 4, offset: 0, readBytes: () => new Uint8Array([1, 2, 3, 4]), close() {} }; }
} }));
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
const initialSettings = storage.getState().settings;
const initialMachines = storage.getState().machines;
const initialLists = storage.getState().machineListByServerId;
function selectMachine(machineId: string) {
    storage.getState().applySettingsLocal({ voice: { ...storage.getState().settings.voice, executionMachine: {
        ...storage.getState().settings.voice.executionMachine, mode: 'fixed', machineId,
    } } });
}
beforeEach(async () => {
    network.resetRequests();
    await network.addHome('https://recorded-speech.example.test', 'artifact-account');
    account = await createPlainArtifactHomeFixture('https://recorded-speech.example.test', {
        serverFeatures: FeaturesResponseSchema.parse({ ...{ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } } }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
        handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
    });
    network.setRpcResponder(async request => await machineRpc(request));
    const machines = ['machine-selected', 'machine-attempt', 'machine-other'].map(id => createMachineFixture({ id, activeAt: Date.now() }));
    await publishMachineInventoryForTest({ serverId: account.home.id, accountId: 'artifact-account' }, machines);
    selectMachine('machine-selected');
    const recipient = createTransferRecipientKeyPair();
    machineRpc.mockReset();
    machineRpc.mockImplementation(async (request: { method: string; payload: { requestId?: string } }) => {
        if (request.method === 'daemon.voice.speech.transcribe.upload.init') {
            // A selection change after admission must not split any upload phase.
            selectMachine('machine-other');
            return DaemonVoiceSpeechTranscribeUploadInitResponseSchema.parse({
                success: true, uploadId: 'recorded-upload', chunkSizeBytes: 1024,
                recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
            });
        }
        if (request.method === 'daemon.voice.speech.transcribe.upload.chunk') return DaemonVoiceSpeechTranscribeUploadChunkResponseSchema.parse({ success: true });
        if (request.method === 'daemon.voice.speech.transcribe.upload.finalize') return DaemonVoiceSpeechTranscribeUploadFinalizeResponseSchema.parse({
            success: true, uploadId: 'recorded-upload', sizeBytes: 4,
            sha256: createHash('sha256').update(new Uint8Array([1, 2, 3, 4])).digest('hex'),
        });
        if (request.method === 'daemon.voice.speech.transcribe') return DaemonVoiceSpeechTranscribeResponseSchema.parse({
            ok: true, requestId: request.payload.requestId, text: 'recognized speech',
        });
        throw new Error('unexpected speech RPC: ' + request.method);
    });
});
afterEach(async () => {
    await account?.dispose();
    storage.setState({ settings: initialSettings, machines: initialMachines, machineListByServerId: initialLists });
});

function createExternalSpeechProjection(input: Readonly<{
    generation: number;
    pluginId: string;
    title: string;
    roles?: Array<'dictation_stt' | 'conversation_stt' | 'conversation_tts'>;
}>): PluginUiProjectionModel {
    const declaration = VoiceProviderContributionSchema.parse({
        id: 'stt',
        title: input.title,
        kind: 'speech',
        roles: input.roles ?? ['dictation_stt', 'conversation_stt'],
        platforms: ['web'],
        settings: {
            schemaVersion: 1,
            fields: [{
                id: 'model',
                title: 'Model',
                schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'synthetic-stt-v1',
                presentation: { control: 'text' },
            }, ...(input.roles?.includes('conversation_tts') ? [{
                id: 'voiceName', title: 'Voice', schema: { type: 'string', minLength: 1, maxLength: 256 },
                default: 'fixture-voice', presentation: { control: 'text' },
            }, {
                id: 'format', title: 'Format', schema: { type: 'string', enum: ['wav', 'mp3'] },
                default: 'wav', presentation: { control: 'select', options: [
                    { value: 'wav', title: 'WAV' }, { value: 'mp3', title: 'MP3' },
                ] },
            }] : [])],
        },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const providerId = `${input.pluginId}/${declaration.id}`;
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: input.generation,
        voiceProvidersById: Object.freeze({
            [providerId]: Object.freeze({
                id: providerId,
                pluginId: input.pluginId,
                occurrenceId: `${input.pluginId}-occurrence-${input.generation}`,
                generation: input.generation,
                contributionKey: providerId,
                definition: declaration,
            }),
        }),
    });
}

describe('recordedAudioTranscriptionController', () => {
    it('resolves the current projected external STT contribution for every invocation', async () => {
        const pluginId = 'acme.live-speech';
        const providerId = `${pluginId}/stt`;
        const executableHost = createPluginUiExecutableModuleHost();
        onTestFinished(async () => {
            await withdrawProjectedExternalVoiceProviders(executableHost);
        });
        const { createRecordedAudioTranscriptionController } = await import('./recordedAudioTranscriptionController');
        const controller = createRecordedAudioTranscriptionController();
        const request = {
            uri: 'file:///rec.wav',
            settings: {
                voice: {
                    providerId: 'local_direct',
                    assistantLanguage: 'en',
                    providers: {
                        local_direct: {
                            schemaVersion: 1,
                            config: {
                                stt: { provider: providerId },
                                networkTimeoutMs: 15_000,
                            },
                        },
                        [providerId]: {
                            schemaVersion: 1,
                            config: { model: 'synthetic-stt-v1' },
                        },
                    },
                },
            },
        } as const;

        createProjectedExternalVoiceProviderDerivedScopeFactory({
            projection: createExternalSpeechProjection({ generation: 1, pluginId, title: 'Runtime A' }),
            hostPlatform: 'web',
            executableHost,
        });
        await expect(controller.transcribe(request)).resolves.toBe('recognized speech');

        createProjectedExternalVoiceProviderDerivedScopeFactory({
            projection: createExternalSpeechProjection({ generation: 2, pluginId, title: 'Runtime B', roles: ['conversation_tts'] }),
            hostPlatform: 'web',
            executableHost,
        });
        await expect(controller.transcribe(request)).rejects.toMatchObject({ code: 'provider_unavailable' });

        await withdrawProjectedExternalVoiceProviders(executableHost);
        await expect(controller.transcribe(request)).rejects.toMatchObject({
            code: 'provider_unavailable',
        });
        expect(machineRpc.mock.calls.filter(([request]) => request.method === 'daemon.voice.speech.transcribe')).toHaveLength(1);
    });

    it('uploads registered-speech recorded audio to the machine the attempt captured', async () => {
        // The local-neural path already pins the attempt's daemon. The registered
        // speech path dropped it, so a mid-attempt auto-selection change split
        // the multi-phase upload across two daemons.
        const pluginId = 'acme.live-speech';
        const providerId = `${pluginId}/stt`;
        const executableHost = createPluginUiExecutableModuleHost();
        onTestFinished(async () => {
            await withdrawProjectedExternalVoiceProviders(executableHost);
        });
        createProjectedExternalVoiceProviderDerivedScopeFactory({
            projection: createExternalSpeechProjection({ generation: 1, pluginId, title: 'Runtime A' }),
            hostPlatform: 'web',
            executableHost,
        });

        const { createRecordedAudioTranscriptionController } = await import('./recordedAudioTranscriptionController');
        const controller = createRecordedAudioTranscriptionController();
        await expect(controller.transcribe({
            uri: 'file:///rec.wav',
            executionMachineId: 'machine-attempt',
            settings: {
                voice: {
                    providerId: 'local_direct',
                    assistantLanguage: 'en',
                    providers: {
                        local_direct: {
                            schemaVersion: 1,
                            config: {
                                stt: { provider: providerId },
                                networkTimeoutMs: 15_000,
                            },
                        },
                        [providerId]: {
                            schemaVersion: 1,
                            config: { model: 'synthetic-stt-v1' },
                        },
                    },
                },
            },
        })).resolves.toBe('recognized speech');

        expect(machineRpc.mock.calls.map(([request]) => request.targetId)).toEqual([
            'machine-attempt', 'machine-attempt', 'machine-attempt', 'machine-attempt',
        ]);
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.voice.speech.transcribe.upload.init',
            payload: expect.objectContaining({ target: { pluginId, localId: 'stt' } }),
        }));
    });
});

afterAll(() => network.dispose());

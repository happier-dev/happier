import { MachineLiveStreamRelayCapsV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const network = await installSessionOpsNetworkBoundary();
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { createMachineFixture } = await import("@/dev/testkit");
const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
const { storage } = await import("@/sync/domains/state/storage");
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
const { getActiveServerSnapshot } = await import("@/sync/domains/server/serverRuntime");
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
import { VOICE_RUNTIME_WARM_DEFAULTS } from '@happier-dev/protocol/voice/runtimeConfig';
import { DaemonVoiceInferenceModelStatusSchema, DaemonVoiceInferenceModelsStatusResponseSchema, DaemonVoiceInferenceModelsWarmResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
const { captureDaemonVoiceModelCatalogObservation } = await import('@/voice/settings/panels/modelCatalog/daemonVoiceModelCatalogObservation');

const machineRpcWithServerScopeMock = vi.fn();






const initialSettings = storage.getState().settings;
const initialMachines = storage.getState().machines;
const initialLists = storage.getState().machineListByServerId;
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;

describe('warmDaemonVoiceInferenceOnVoiceHomeAttach', () => {
    beforeEach(async () => {
        network.resetRequests();
    await network.addHome('https://warm-voice.example.test', 'artifact-account');
    account = await createPlainArtifactHomeFixture('https://warm-voice.example.test', {
        serverFeatures: FeaturesResponseSchema.parse({ ...{ features: { voice: { enabled: true }, execution: { runs: { enabled: true } } } }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
        handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init),
    });
    network.setRpcResponder(async request => await machineRpcWithServerScopeMock(request));
    const machine = createMachineFixture({ id: 'machine-selected', activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [account.home.id]: [machine] } });
        storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
            voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
        }, voice: { ...storage.getState().settings.voice, executionMachine: {
            ...storage.getState().settings.voice.executionMachine, mode: 'fixed', machineId: machine.id,
        } } });
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: {
            status: 'ready', features: FeaturesResponseSchema.parse({ ...{
                features: { voice: { enabled: true }, execution: { runs: { enabled: true } } },
            }, features: { ...{ voice: { enabled: true }, execution: { runs: { enabled: true } } }, machines: {
      enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } },
    } }, capabilities: { machines: { liveStream: { serverRouted: {
      caps: MachineLiveStreamRelayCapsV1Schema.parse({}), disabledReason: null,
    } } } } }),
        } });
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, models: [] });
    });
    afterEach(async () => {
        await account?.dispose();
        storage.setState({ settings: initialSettings, machines: initialMachines, machineListByServerId: initialLists });
        resetServerFeaturesClientForTests();
    });

    it('warms local Voice models on the selected daemon without spawning an unrelated agent session', async () => {
        const { warmDaemonVoiceInferenceOnVoiceHomeAttach } = await import(
            './warmDaemonVoiceInferenceOnVoiceHomeAttach'
        );

        await expect(
            warmDaemonVoiceInferenceOnVoiceHomeAttach({
                settings: {
                    voice: {
                        providerId: 'local_conversation',
                        providers: {
                            local_conversation: {
                                schemaVersion: 1,
                                config: {
                                    stt: {
                                        provider: 'local_neural',
                                        localNeural: {
                                            execution: 'daemon',
                                            assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                sessionId: 'synthetic-qa-session',
            }),
        ).resolves.toBeUndefined();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            targetId: 'machine-selected',
            serverUrl: account.home.serverUrl,
            method: 'daemon.voiceInference.models.warm',
            payload: {
                packIds: ['sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'],
            },
            timeoutMs: expect.any(Number),
        }));
        const warmRequest = network.requests.find(request => request.method === 'daemon.voiceInference.models.warm');
        expect(warmRequest?.timeoutMs).toBeGreaterThan(30_000);
        expect(warmRequest?.timeoutMs).toBeLessThanOrEqual(VOICE_RUNTIME_WARM_DEFAULTS.warmRequestTimeoutMs);
    });

    it('rejects a structured daemon warm failure instead of treating it as a successful warm', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: false,
            errorCode: 'model_not_installed',
            error: 'daemon_voice_inference_model_not_installed',
            retryable: false,
        });
        const { warmDaemonVoiceInferenceOnVoiceHomeAttach } = await import(
            './warmDaemonVoiceInferenceOnVoiceHomeAttach'
        );

        await expect(
            warmDaemonVoiceInferenceOnVoiceHomeAttach({
                settings: {
                    voice: {
                        providerId: 'local_conversation',
                        providers: {
                            local_conversation: {
                                schemaVersion: 1,
                                config: {
                                    stt: {
                                        provider: 'local_neural',
                                        localNeural: {
                                            execution: 'daemon',
                                            assetId: 'stt-pack-missing',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                sessionId: 'voice-home-session',
            }),
        ).rejects.toMatchObject({
            code: 'model_not_installed',
            message: 'daemon_voice_inference_model_not_installed',
        });
    });

    it.each([false, true])('publishes returned warm models without another probe or stale read overwrite (pending=%s)', async (pendingRead) => {
        const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const cold = DaemonVoiceInferenceModelStatusSchema.parse({
            packId, kind: 'stt_sherpa', model: 'zipformer_transducer', version: null,
            executionSupport: ['daemon'], runtimeFamily: 'sherpa_zipformer_streaming',
            runtimeSupported: true, installState: 'installed', progress: null,
            lastError: null, updatedAtMs: 0, runtimeState: 'evicted',
        });
        const observation = captureDaemonVoiceModelCatalogObservation('machine-selected');
        observation.publish({ statuses: [cold], errorCode: null, loading: false, stale: false });
        const warmed = DaemonVoiceInferenceModelStatusSchema.parse({ ...cold, runtimeState: 'ready', loadedArtifactBytes: 1024 });
        const { createDeferred } = await import('@/dev/testkit');
        const oldRead = createDeferred<unknown>();
        machineRpcWithServerScopeMock.mockImplementation(async request => request.method === 'daemon.voiceInference.models.status'
            ? await oldRead.promise
            : DaemonVoiceInferenceModelsWarmResponseSchema.parse({ ok: true, models: [warmed] }));
        const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
        const reading = pendingRead ? observation.read({ client: new DaemonVoiceInferenceClient(), packIds: [packId] }) : null;
        if (pendingRead) {
            await network.waitForRpcRequest(request => request.method === 'daemon.voiceInference.models.status');
            expect(network.requests.some(request => request.method === 'daemon.voiceInference.models.status')).toBe(true);
        }
        const { warmDaemonVoiceInferenceOnVoiceHomeAttach } = await import('./warmDaemonVoiceInferenceOnVoiceHomeAttach');
        await warmDaemonVoiceInferenceOnVoiceHomeAttach({ settings: { voice: {
            providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1, config: {
                stt: { provider: 'local_neural', localNeural: { execution: 'daemon', assetId: packId } },
            } } },
        } }, sessionId: 'voice-home-session' });
        expect(observation.getSnapshot()).toMatchObject({ statuses: [warmed], errorCode: null, loading: false });
        oldRead.resolve(DaemonVoiceInferenceModelsStatusResponseSchema.parse({ ok: true, models: [cold] }));
        if (reading) await expect(reading).resolves.toBeNull();
        expect(observation.getSnapshot()).toMatchObject({ statuses: [warmed], errorCode: null, loading: false });
        expect(network.requests.map(request => request.method)).toEqual([
            ...(pendingRead ? ['daemon.voiceInference.models.status'] : []), 'daemon.voiceInference.models.warm',
        ]);
    });
});

afterAll(() => network.dispose());

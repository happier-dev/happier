import { describe, expect, it } from 'vitest';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import type {
    DaemonVoiceInferenceModelStatus,
    FeaturesResponse,
    MachineLiveStreamRelayDisabledReason,
    ModelPackKind,
    PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';
import { getDefaultModelPackId, listModelPackCatalogEntries } from '@happier-dev/protocol';

import { resolveVoiceProviderAvailability } from './resolveVoiceProviderAvailability';
import {
    projectVoiceDaemonExecutionMachineReadinessFact,
    projectVoiceDaemonRuntimeReadinessFact,
    resolveVoiceDaemonDirectRouteAvailability,
    resolveVoiceDaemonHeavyAudioReadiness,
    resolveVoiceDaemonModelAvailabilityFromCatalogState,
    resolveVoiceProviderLocalAvailability,
} from './voiceProviderLocalAvailability';

const relayCaps = {
    maxBitrateBps: 96_000,
    maxFramesPerSecond: 50,
    maxFrameBytes: 16_384,
    maxDurationMs: 60_000,
    maxTotalBytes: 4_000_000,
    maxConcurrentStreamsPerAccount: 2,
    maxConcurrentStreamsPerSocket: 1,
    maxConcurrentStreamsPerMachine: 1,
};

function createFeatures(input: Readonly<{
    serverRoutedEnabled: boolean;
    caps: typeof relayCaps | null;
    disabledReason: MachineLiveStreamRelayDisabledReason | null;
    directRpcEnabled?: boolean;
    directTunnelEnabled?: boolean;
    directTunnelAllowedPorts?: readonly number[];
}>): FeaturesResponse {
    const base = createRootLayoutFeaturesResponse();
    return createRootLayoutFeaturesResponse({
        features: {
            machines: {
                enabled: true,
                rpc: {
                    enabled: true,
                    directPeer: { enabled: input.directRpcEnabled ?? false },
                },
                tunnel: {
                    enabled: true,
                    directPeer: { enabled: input.directTunnelEnabled ?? false },
                    serverRouted: { enabled: false },
                },
                liveStream: {
                    enabled: true,
                    directPeer: { enabled: false },
                    serverRouted: { enabled: input.serverRoutedEnabled },
                },
            },
        },
        capabilities: {
            machines: {
                ...base.capabilities.machines,
                liveStream: {
                    serverRouted: {
                        caps: input.caps,
                        disabledReason: input.disabledReason,
                    },
                },
                tunnel: {
                    ...base.capabilities.machines.tunnel,
                    directPeer: {
                        ...base.capabilities.machines.tunnel.directPeer,
                        allowedPorts: [...(input.directTunnelAllowedPorts ?? [])],
                    },
                },
            },
        },
    });
}

const directEndpoint = {
    v: 1,
    routeKind: 'loopback_direct',
    url: 'http://127.0.0.1:39001/peer-mediation/v1/probe',
    endpointFingerprint: 'fingerprint-1',
    expiresAt: Date.now() + 60_000,
} satisfies PeerLoopbackEndpointCandidateV1;

function modelStatus(
    kind: ModelPackKind,
    overrides: Partial<DaemonVoiceInferenceModelStatus> = {},
): DaemonVoiceInferenceModelStatus {
    const packId = getDefaultModelPackId(kind) ?? listModelPackCatalogEntries(kind)[0]!.packId;
    const entry = listModelPackCatalogEntries(kind).find((candidate) => candidate.packId === packId);
    return {
        packId,
        pluginIdentity: null,
        kind,
        model: entry?.model ?? packId,
        version: null,
        executionSupport: ['daemon'],
        runtimeFamily: entry?.runtimeFamily ?? null,
        runtimeSupported: true,
        installState: 'installed',
        runtimeState: 'ready',
        progress: null,
        lastError: null,
        updatedAtMs: 0,
        ...overrides,
    };
}

describe('resolveVoiceProviderLocalAvailability', () => {
    it.each([
        ['unavailable', 'daemon_unreachable'],
        ['relay_disabled', 'daemon_relay_disabled'],
        ['relay_capped', 'daemon_relay_capped'],
    ] as const)(
        'projects selected-machine heavy-audio route %s as typed unavailable readiness',
        (route, code) => {
            expect(resolveVoiceDaemonHeavyAudioReadiness({
                role: 'dictation_stt',
                providerId: 'local_neural',
                executionMachineId: 'machine-online',
                daemon: {
                    featureEnabled: true,
                    route,
                    modelState: 'ready',
                    runtimeState: 'available',
                    pcmCapture: 'available',
                },
            })).toMatchObject({
                status: 'unavailable',
                code,
                recoveryAction: 'switch_provider',
            });
        },
    );

    it.each(['direct', 'relay'] as const)(
        'keeps selected-machine heavy-audio route %s passively viable',
        (route) => {
            expect(resolveVoiceDaemonHeavyAudioReadiness({
                role: 'conversation_stt',
                providerId: 'local_conversation',
                executionMachineId: 'machine-online',
                daemon: {
                    featureEnabled: true,
                    route,
                    modelState: 'ready',
                    runtimeState: 'available',
                    pcmCapture: 'available',
                },
            })).toBeNull();
        },
    );

    it.each([
        'unavailable',
        'relay_disabled',
        'relay_capped',
    ] as const)(
        'keeps an available daemon runtime ready when the independent route state is %s',
        (route) => {
            const daemon = {
                featureEnabled: true,
                route,
                modelState: 'ready',
                runtimeState: 'available',
                pcmCapture: 'available',
            } as const;
            expect(projectVoiceDaemonRuntimeReadinessFact(daemon)).toBe('ready');
            expect(projectVoiceDaemonExecutionMachineReadinessFact(
                daemon,
                'machine-online',
            )).toBe('missing');
        },
    );

    it.each(['direct', 'relay'] as const)(
        'projects a selected daemon machine ready when its speech route is %s',
        (route) => {
            expect(projectVoiceDaemonExecutionMachineReadinessFact({
                featureEnabled: true,
                route,
                modelState: 'ready',
                runtimeState: 'available',
                pcmCapture: 'available',
            }, 'machine-online')).toBe('ready');
        },
    );

    it.each([
        ['available', 'available'],
        ['unavailable', 'unavailable'],
        ['unknown', 'unknown'],
    ] as const)(
        'preserves the passive native Device STT recognition fact when it is %s',
        (nativeDeviceSpeechRecognition, expected) => {
            expect(resolveVoiceProviderLocalAvailability({
                platformOs: 'ios',
                daemonFeatureEnabled: false,
                serverFeatures: null,
                nativeDeviceSpeechRecognition,
            }).nativeDevice).toEqual({
                requested: true,
                speechRecognition: expected,
            });
        },
    );

    it('maps disabled server-routed live-stream relay to daemon relay-disabled while browser Local remains selectable', () => {
        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: true,
            serverFeatures: createFeatures({
                serverRoutedEnabled: false,
                caps: null,
                disabledReason: 'server_routed_live_stream_disabled',
            }),
            browserSpeechCapability: { support: 'cloud_only', onDevice: 'unsupported' },
        });

        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: localAvailability,
        });

        expect(localAvailability.daemon?.route).toBe('relay_disabled');
        expect(availability.off.enabled).toBe(true);
        expect(availability.happier.enabled).toBe(true);
        expect(availability.byo.enabled).toBe(true);
        expect(availability.local).toMatchObject({ enabled: true, runnable: true, reason: null });
        expect(availability.local.paths.browserSpeech).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'cloud_only',
            reason: 'browser_speech_cloud_only',
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: false,
            runnable: false,
            reason: 'daemon_relay_disabled',
        });
    });

    it('maps missing relay caps to daemon relay-disabled even when the server-routed feature bit is enabled', () => {
        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: true,
            serverFeatures: createFeatures({
                serverRoutedEnabled: true,
                caps: null,
                disabledReason: 'relay_caps_missing',
            }),
            browserSpeechCapability: { support: 'unavailable', onDevice: 'unsupported' },
        });

        expect(localAvailability.daemon?.route).toBe('relay_disabled');
        expect(resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: localAvailability,
        }).local.paths.daemon.reason).toBe('daemon_relay_disabled');
    });

    it('maps cap_exceeded to a capped daemon route and reason', () => {
        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: true,
            serverFeatures: createFeatures({
                serverRoutedEnabled: true,
                caps: null,
                disabledReason: 'cap_exceeded',
            }),
            browserSpeechCapability: { support: 'unavailable', onDevice: 'unsupported' },
        });

        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: localAvailability,
        });

        expect(localAvailability.daemon?.route).toBe('relay_capped');
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: false,
            runnable: false,
            reason: 'daemon_relay_capped',
        });
    });

    it('maps enabled relay with valid caps to daemon relay availability', () => {
        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: true,
            serverFeatures: createFeatures({
                serverRoutedEnabled: true,
                caps: relayCaps,
                disabledReason: null,
            }),
            daemonModelState: 'ready',
            browserSpeechCapability: { support: 'unavailable', onDevice: 'unsupported' },
        });

        expect(localAvailability.daemon).toMatchObject({
            featureEnabled: true,
            route: 'relay',
            modelState: 'ready',
        });
    });

    it('prefers a passive direct daemon route over relay-disabled server policy when machine-RPC prerequisites are present', () => {
        const serverFeatures = createFeatures({
            serverRoutedEnabled: false,
            caps: null,
            disabledReason: 'server_routed_live_stream_disabled',
            directRpcEnabled: true,
            directTunnelEnabled: true,
            directTunnelAllowedPorts: [3005],
        });
        const directRoute = resolveVoiceDaemonDirectRouteAvailability({
            serverFeatures,
            endpoint: directEndpoint,
            credentials: { token: 'token-1', secret: 'secret-1' },
        });

        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: true,
            serverFeatures,
            daemonDirectRouteAvailability: directRoute,
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
            daemonPcmCapture: 'available',
            browserSpeechCapability: { support: 'unavailable', onDevice: 'unsupported' },
        });

        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: localAvailability,
        });

        expect(directRoute).toBe('available');
        expect(localAvailability.daemon).toMatchObject({
            route: 'direct',
            modelState: 'ready',
            runtimeState: 'available',
            pcmCapture: 'available',
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
    });

    it('fails closed before capture when tunnel direct is enabled but STT machine-RPC direct and relay are disabled', () => {
        const serverFeatures = createFeatures({
            serverRoutedEnabled: false,
            caps: null,
            disabledReason: 'server_routed_live_stream_disabled',
            directRpcEnabled: false,
            directTunnelEnabled: true,
            directTunnelAllowedPorts: [3005],
        });
        const directRoute = resolveVoiceDaemonDirectRouteAvailability({
            serverFeatures,
            endpoint: directEndpoint,
            credentials: { token: 'token-1', secret: 'secret-1' },
        });

        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: true,
            serverFeatures,
            daemonDirectRouteAvailability: directRoute,
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
            daemonPcmCapture: 'available',
            browserSpeechCapability: { support: 'unavailable', onDevice: 'unsupported' },
        });

        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: localAvailability,
        });

        expect(directRoute).toBe('unavailable');
        expect(localAvailability.daemon?.route).toBe('relay_disabled');
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: false,
            runnable: false,
            reason: 'daemon_relay_disabled',
        });
    });

    it.each([
        {
            label: 'credentials are missing',
            credentials: null,
            endpoint: directEndpoint,
        },
        {
            label: 'data-key credentials have no intersecting proof capability',
            credentials: {
                token: 'data-key-token',
                encryption: {
                    publicKey: 'public-key',
                    machineKey: 'machine-key',
                },
            },
            endpoint: directEndpoint,
        },
        {
            label: 'the daemon endpoint is missing',
            credentials: { token: 'token-1', secret: 'secret-1' },
            endpoint: null,
        },
    ])('keeps passive machine-RPC direct unavailable when $label', ({ credentials, endpoint }) => {
        expect(resolveVoiceDaemonDirectRouteAvailability({
            serverFeatures: createFeatures({
                serverRoutedEnabled: false,
                caps: null,
                disabledReason: 'server_routed_live_stream_disabled',
                directRpcEnabled: true,
            }),
            credentials,
            endpoint,
        })).toBe('unavailable');
    });

    it('defaults passive web settings availability to unknown until the Web Speech probe resolves', () => {
        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: false,
            serverFeatures: null,
        });

        expect(localAvailability.browserSpeech).toEqual({
            support: 'unknown',
            onDevice: 'unknown',
        });
        expect(resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: localAvailability,
        }).local.paths.browserSpeech).toMatchObject({
            selectable: false,
            runnable: false,
            readiness: 'unknown',
            reason: 'browser_speech_on_device_unknown',
        });
    });

    it('derives ready daemon model availability from the shared catalog status snapshot', () => {
        const modelAvailability = resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: null,
            statuses: [
                modelStatus('stt_sherpa'),
                modelStatus('tts_sherpa', { runtimeState: 'cold' }),
            ],
            selectedSttPackId: null,
            selectedTtsPackId: null,
        });

        const localAvailability = resolveVoiceProviderLocalAvailability({
            platformOs: 'web',
            daemonFeatureEnabled: true,
            serverFeatures: createFeatures({
                serverRoutedEnabled: true,
                caps: relayCaps,
                disabledReason: null,
            }),
            browserSpeechCapability: { support: 'unavailable', onDevice: 'unsupported' },
            daemonModelState: modelAvailability.modelState,
            daemonRuntimeState: modelAvailability.runtimeState,
        });

        expect(modelAvailability).toEqual({ modelState: 'ready', runtimeState: 'available' });
        expect(resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'web',
            local: localAvailability,
        }).local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
    });

    it('derives missing, installing, and error daemon model availability from selected catalog rows', () => {
        const missing = resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: null,
            statuses: [
                modelStatus('stt_sherpa', { installState: 'not_installed', runtimeState: undefined }),
                modelStatus('tts_sherpa'),
            ],
            selectedSttPackId: null,
            selectedTtsPackId: null,
        });
        const installing = resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: null,
            statuses: [
                modelStatus('stt_sherpa', { installState: 'installing', runtimeState: undefined }),
                modelStatus('tts_sherpa'),
            ],
            selectedSttPackId: null,
            selectedTtsPackId: null,
        });
        const errored = resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: null,
            statuses: [
                modelStatus('stt_sherpa', { installState: 'error', runtimeState: undefined }),
                modelStatus('tts_sherpa'),
            ],
            selectedSttPackId: null,
            selectedTtsPackId: null,
        });

        expect(missing.modelState).toBe('missing');
        expect(missing.runtimeState).toBe('available');
        expect(installing.modelState).toBe('installing');
        expect(installing.runtimeState).toBe('available');
        expect(errored.modelState).toBe('error');
        expect(errored.runtimeState).toBe('available');
    });

    it('does not let an unselected Local Neural TTS pack block selected daemon STT readiness', () => {
        expect(resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: null,
            statuses: [
                modelStatus('stt_sherpa'),
                modelStatus('tts_sherpa', { installState: 'not_installed', runtimeState: undefined }),
            ],
            selectedSttPackId: null,
            selectedTtsPackId: null,
            requireStt: true,
            requireTts: false,
        })).toEqual({
            modelState: 'ready',
            runtimeState: 'available',
        });
    });

    it('derives daemon runtime-unavailable without treating it as a model install error', () => {
        expect(resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: 'runtime_unavailable',
            statuses: [],
            selectedSttPackId: null,
            selectedTtsPackId: null,
        })).toEqual({
            modelState: 'unknown',
            runtimeState: 'unavailable',
        });
    });

    it('treats an unsupported selected runtime family as daemon runtime-unavailable', () => {
        expect(resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: 'unsupported_runtime_family',
            statuses: [],
            selectedSttPackId: null,
            selectedTtsPackId: null,
        })).toEqual({
            modelState: 'unknown',
            runtimeState: 'unavailable',
        });
    });

    it.each([
        {
            label: 'daemon explicitly rejects the selected family',
            statusOverrides: { runtimeSupported: false },
        },
        {
            label: 'older daemon omits support projection fields',
            statusOverrides: { runtimeFamily: undefined, runtimeSupported: undefined },
        },
        {
            label: 'daemon projects a family that does not match the selected pack',
            statusOverrides: { runtimeFamily: 'sherpa_parakeet_offline' as const, runtimeSupported: true },
        },
    ])('fails selected installed model readiness closed when $label', ({ statusOverrides }) => {
        expect(resolveVoiceDaemonModelAvailabilityFromCatalogState({
            loading: false,
            errorCode: null,
            statuses: [
                modelStatus('stt_sherpa', statusOverrides),
                modelStatus('tts_sherpa'),
            ],
            selectedSttPackId: null,
            selectedTtsPackId: null,
        })).toEqual({
            modelState: 'ready',
            runtimeState: 'unavailable',
        });
    });
});

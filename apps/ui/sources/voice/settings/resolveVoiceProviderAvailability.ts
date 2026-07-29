import { Platform } from 'react-native';

import type { DeviceSpeechRecognitionAvailability } from '@/voice/input/deviceSpeechRecognitionAvailability';

export type VoiceProviderModeId = 'off' | 'happier' | 'byo' | 'local';

export type VoiceProviderUnavailableReason =
    | 'feature_disabled'
    | 'hosted_unavailable'
    | 'server_unsupported'
    | 'browser_speech_unavailable'
    | 'browser_speech_unsupported'
    | 'browser_speech_cloud_only'
    | 'browser_speech_on_device_downloadable'
    | 'browser_speech_on_device_downloading'
    | 'browser_speech_on_device_permission_policy_blocked'
    | 'browser_speech_on_device_unknown'
    | 'daemon_unreachable'
    | 'daemon_relay_disabled'
    | 'daemon_relay_capped'
    | 'daemon_runtime_unavailable'
    | 'daemon_streaming_stt_pcm_capture_unavailable'
    | 'models_missing'
    | 'models_installing'
    | 'models_error'
    | 'models_unknown'
    | 'native_device_unavailable_on_web'
    | 'native_device_speech_recognition_unavailable'
    | 'native_device_speech_recognition_unknown'
    | 'unknown_provider';

export type VoiceProviderReadiness =
    | 'ready'
    | 'cloud_only'
    | 'installable'
    | 'installing'
    | 'partial'
    | 'error'
    | 'unavailable'
    | 'unknown';

export type VoiceLocalExecutionPathId = 'browserSpeech' | 'daemon' | 'nativeDevice';
export type VoiceBrowserSpeechPrivacy = 'on_device' | 'cloud_or_remote' | 'unknown';
export type VoiceBrowserSpeechSupport = 'available' | 'cloud_only' | 'unavailable' | 'unknown';
export type VoiceBrowserSpeechOnDeviceAvailability =
    | 'available'
    | 'downloadable'
    | 'downloading'
    | 'unavailable'
    | 'permission_policy_blocked'
    | 'unsupported'
    | 'unknown';

export type VoiceBrowserSpeechCapability = Readonly<{
    support: VoiceBrowserSpeechSupport;
    onDevice?: VoiceBrowserSpeechOnDeviceAvailability;
}>;

export type VoiceLocalExecutionPathAvailability = Readonly<{
    pathId: VoiceLocalExecutionPathId;
    selectable: boolean;
    runnable: boolean;
    readiness: VoiceProviderReadiness;
    reason: VoiceProviderUnavailableReason | null;
    privacy?: VoiceBrowserSpeechPrivacy;
    onDevice?: VoiceBrowserSpeechOnDeviceAvailability;
}>;

export type VoiceLocalExecutionAvailability = Readonly<Record<VoiceLocalExecutionPathId, VoiceLocalExecutionPathAvailability>>;

export type VoiceProviderModeAvailability = Readonly<{
    modeId: VoiceProviderModeId;
    enabled: boolean;
    runnable: boolean;
    reason: VoiceProviderUnavailableReason | null;
    paths?: VoiceLocalExecutionAvailability;
}>;

export type VoiceLocalProviderModeAvailability = VoiceProviderModeAvailability & Readonly<{
    modeId: 'local';
    paths: VoiceLocalExecutionAvailability;
}>;

export type VoiceProviderAvailability = Readonly<{
    off: VoiceProviderModeAvailability;
    happier: VoiceProviderModeAvailability;
    byo: VoiceProviderModeAvailability;
    local: VoiceLocalProviderModeAvailability;
}>;

export type VoiceDaemonRouteAvailability = 'direct' | 'relay' | 'relay_disabled' | 'relay_capped' | 'unavailable';
export type VoiceDaemonModelAvailability = 'ready' | 'missing' | 'installing' | 'error' | 'unknown';
export type VoiceDaemonRuntimeAvailability = 'available' | 'unavailable' | 'unknown';
export type VoiceDaemonPcmCaptureAvailability = 'available' | 'unavailable' | 'unknown';

export type ResolveVoiceProviderAvailabilityInput = Readonly<{
    happierVoiceSupported: boolean;
    platformOs?: string;
    local?: Readonly<{
        browserSpeech?: VoiceBrowserSpeechCapability;
        daemon?: Readonly<{
            featureEnabled: boolean;
            route: VoiceDaemonRouteAvailability;
            modelState: VoiceDaemonModelAvailability;
            runtimeState?: VoiceDaemonRuntimeAvailability;
            pcmCapture?: VoiceDaemonPcmCaptureAvailability;
        }>;
        nativeDevice?: Readonly<{
            requested: boolean;
            speechRecognition?: DeviceSpeechRecognitionAvailability;
        }>;
    }>;
}>;

function createDefaultLocalInput(platformOs: string): Required<NonNullable<ResolveVoiceProviderAvailabilityInput['local']>> {
    return {
        browserSpeech: platformOs === 'web'
            ? { support: 'unknown', onDevice: 'unknown' }
            : { support: 'unavailable' },
        daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown', runtimeState: 'unknown' },
        nativeDevice: {
            requested: platformOs !== 'web',
            speechRecognition: 'unknown',
        },
    };
}

function createMode(params: Readonly<{
    modeId: VoiceProviderModeId;
    enabled: boolean;
    runnable?: boolean;
    reason?: VoiceProviderUnavailableReason | null;
    paths?: VoiceLocalExecutionAvailability;
}>): VoiceProviderModeAvailability {
    return {
        modeId: params.modeId,
        enabled: params.enabled,
        runnable: params.runnable ?? params.enabled,
        reason: params.reason ?? null,
        ...(params.paths ? { paths: params.paths } : {}),
    };
}

function createLocalMode(params: Readonly<{
    enabled: boolean;
    runnable: boolean;
    reason: VoiceProviderUnavailableReason | null;
    paths: VoiceLocalExecutionAvailability;
}>): VoiceLocalProviderModeAvailability {
    return {
        modeId: 'local',
        enabled: params.enabled,
        runnable: params.runnable,
        reason: params.reason,
        paths: params.paths,
    };
}

function unavailablePath(
    pathId: VoiceLocalExecutionPathId,
    reason: VoiceProviderUnavailableReason,
    readiness: VoiceProviderReadiness = 'unavailable',
): VoiceLocalExecutionPathAvailability {
    return {
        pathId,
        selectable: false,
        runnable: false,
        readiness,
        reason,
    };
}

function resolveBrowserSpeechPath(
    platformOs: string,
    capability: VoiceBrowserSpeechCapability,
): VoiceLocalExecutionPathAvailability {
    if (platformOs !== 'web') {
        return unavailablePath('browserSpeech', 'browser_speech_unavailable');
    }
    const support = capability.support;
    const onDevice = capability.onDevice;
    if (support === 'available') {
        return {
            pathId: 'browserSpeech',
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
            privacy: 'on_device',
            onDevice: onDevice ?? 'available',
        };
    }
    if (support === 'cloud_only') {
        const fallback = {
            pathId: 'browserSpeech' as const,
            selectable: true,
            runnable: true,
            privacy: 'cloud_or_remote' as const,
            onDevice: onDevice ?? 'unavailable',
        };
        if (onDevice === 'downloadable') {
            return {
                ...fallback,
                readiness: 'installable',
                reason: 'browser_speech_on_device_downloadable',
            };
        }
        if (onDevice === 'downloading') {
            return {
                ...fallback,
                readiness: 'installing',
                reason: 'browser_speech_on_device_downloading',
            };
        }
        if (onDevice === 'permission_policy_blocked') {
            return {
                ...fallback,
                readiness: 'cloud_only',
                reason: 'browser_speech_on_device_permission_policy_blocked',
            };
        }
        if (onDevice === 'unknown') {
            return {
                ...fallback,
                readiness: 'cloud_only',
                reason: 'browser_speech_on_device_unknown',
            };
        }
        return {
            ...fallback,
            readiness: 'cloud_only',
            reason: 'browser_speech_cloud_only',
        };
    }
    if (support === 'unknown') {
        return {
            ...unavailablePath('browserSpeech', 'browser_speech_on_device_unknown', 'unknown'),
            privacy: 'unknown',
            onDevice: onDevice ?? 'unknown',
        };
    }
    if (onDevice === 'unsupported') {
        return unavailablePath('browserSpeech', 'browser_speech_unsupported');
    }
    return unavailablePath('browserSpeech', 'browser_speech_unavailable');
}

function resolveDaemonPath(
    daemon: Required<NonNullable<ResolveVoiceProviderAvailabilityInput['local']>>['daemon'],
    platformOs: string,
): VoiceLocalExecutionPathAvailability {
    if (!daemon.featureEnabled) {
        return unavailablePath('daemon', 'feature_disabled');
    }
    if (daemon.route === 'relay_capped') {
        return unavailablePath('daemon', 'daemon_relay_capped');
    }
    if (daemon.route === 'relay_disabled') {
        return unavailablePath('daemon', 'daemon_relay_disabled');
    }
    if (daemon.route === 'unavailable') {
        return unavailablePath('daemon', 'daemon_unreachable');
    }

    if (daemon.runtimeState === 'unavailable') {
        return {
            pathId: 'daemon',
            selectable: true,
            runnable: false,
            readiness: 'error',
            reason: 'daemon_runtime_unavailable',
        };
    }

    if (daemon.modelState === 'ready') {
        const pcmCapture = daemon.pcmCapture ?? (platformOs === 'web' ? 'available' : 'unavailable');
        if (pcmCapture !== 'available') {
            return {
                pathId: 'daemon',
                selectable: true,
                runnable: false,
                readiness: 'partial',
                reason: 'daemon_streaming_stt_pcm_capture_unavailable',
            };
        }
        return {
            pathId: 'daemon',
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        };
    }
    if (daemon.modelState === 'missing') {
        return {
            pathId: 'daemon',
            selectable: true,
            runnable: false,
            readiness: 'installable',
            reason: 'models_missing',
        };
    }
    if (daemon.modelState === 'installing') {
        return {
            pathId: 'daemon',
            selectable: true,
            runnable: false,
            readiness: 'installing',
            reason: 'models_installing',
        };
    }
    if (daemon.modelState === 'error') {
        return {
            pathId: 'daemon',
            selectable: true,
            runnable: false,
            readiness: 'error',
            reason: 'models_error',
        };
    }
    return {
        pathId: 'daemon',
        selectable: true,
        runnable: false,
        readiness: 'unknown',
        reason: 'models_unknown',
    };
}

function resolveNativeDevicePath(
    platformOs: string,
    nativeDevice: Required<NonNullable<ResolveVoiceProviderAvailabilityInput['local']>>['nativeDevice'],
): VoiceLocalExecutionPathAvailability {
    if (platformOs === 'web') {
        return unavailablePath('nativeDevice', 'native_device_unavailable_on_web');
    }
    if (!nativeDevice.requested) {
        return unavailablePath('nativeDevice', 'unknown_provider', 'unknown');
    }
    if (nativeDevice.speechRecognition === 'unavailable') {
        return unavailablePath('nativeDevice', 'native_device_speech_recognition_unavailable');
    }
    if (nativeDevice.speechRecognition !== 'available') {
        return unavailablePath('nativeDevice', 'native_device_speech_recognition_unknown', 'unknown');
    }
    return {
        pathId: 'nativeDevice',
        selectable: true,
        runnable: true,
        readiness: 'ready',
        reason: null,
    };
}

function chooseLocalReason(paths: readonly VoiceLocalExecutionPathAvailability[]): VoiceProviderUnavailableReason | null {
    const firstRunnable = paths.find((path) => path.runnable);
    if (firstRunnable) {
        return null;
    }
    const firstSelectable = paths.find((path) => path.selectable);
    if (firstSelectable) {
        return firstSelectable.reason;
    }
    return paths.find((path) => path.reason !== null)?.reason ?? 'unknown_provider';
}

export function resolveVoiceProviderAvailability(input: ResolveVoiceProviderAvailabilityInput): VoiceProviderAvailability {
    const params = input;
    const platformOs = params.platformOs ?? Platform.OS;
    const defaultLocalInput = createDefaultLocalInput(platformOs);
    const localInput = {
        browserSpeech: params.local?.browserSpeech ?? defaultLocalInput.browserSpeech,
        daemon: params.local?.daemon ?? defaultLocalInput.daemon,
        nativeDevice: params.local?.nativeDevice ?? defaultLocalInput.nativeDevice,
    };
    const localPaths: VoiceLocalExecutionAvailability = {
        browserSpeech: resolveBrowserSpeechPath(platformOs, localInput.browserSpeech),
        daemon: resolveDaemonPath(localInput.daemon, platformOs),
        nativeDevice: resolveNativeDevicePath(platformOs, localInput.nativeDevice),
    };
    const localPathList = Object.values(localPaths);
    const localEnabled = localPathList.some((path) => path.selectable);
    const localRunnable = localPathList.some((path) => path.runnable);

    return {
        off: createMode({ modeId: 'off', enabled: true }),
        happier: input.happierVoiceSupported
            ? createMode({ modeId: 'happier', enabled: true })
            : createMode({
                modeId: 'happier',
                enabled: false,
                runnable: false,
                reason: 'server_unsupported',
            }),
        byo: createMode({ modeId: 'byo', enabled: true }),
        local: createLocalMode({
            enabled: localEnabled,
            runnable: localRunnable,
            reason: chooseLocalReason(localPathList),
            paths: localPaths,
        }),
    };
}

import * as React from 'react';
import { Platform } from 'react-native';

import {
    DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
    MachineLiveStreamRelayDisabledReasonSchema,
    MachineTunnelCapabilitiesSchema,
    PeerLoopbackEndpointCandidateV1Schema,
    getDefaultModelPackId,
    getModelPackCatalogEntry,
    readMachineLiveStreamRelayCaps,
    readServerEnabledBit,
    resolveCanonicalModelPackId,
} from '@happier-dev/protocol';
import type {
    DaemonVoiceInferenceModelStatus,
    FeaturesResponse,
    MachineLiveStreamRelayDisabledReason,
    MachineTunnelCapabilities,
    ModelPackKind,
} from '@happier-dev/protocol';

import { useFeatureLocalPolicySettings } from '@/hooks/server/useFeatureLocalPolicySettings';
import { getCachedReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { resolveLocalFeaturePolicyEnabled } from '@/sync/domains/features/featureLocalPolicy';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readEndpointFromMachineState } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { storage } from '@/sync/domains/state/storage';
import {
    readDeviceSpeechRecognitionAvailability,
    type DeviceSpeechRecognitionAvailability,
} from '@/voice/input/deviceSpeechRecognitionAvailability';
import { resolveDaemonSpeechPcmCaptureAvailability } from '@/voice/runtime/daemonInference/resolveDaemonSpeechPcmCaptureAvailability';

import type {
    ResolveVoiceProviderAvailabilityInput,
    VoiceBrowserSpeechCapability,
    VoiceBrowserSpeechOnDeviceAvailability,
    VoiceBrowserSpeechSupport,
    VoiceDaemonModelAvailability,
    VoiceDaemonPcmCaptureAvailability,
    VoiceDaemonRouteAvailability,
    VoiceDaemonRuntimeAvailability,
    VoiceProviderUnavailableReason,
} from './resolveVoiceProviderAvailability';
import { getDefaultBrowserWebSpeechCapability, useBrowserWebSpeechCapability } from './browserWebSpeechCapability';

export type VoiceProviderLocalAvailability = NonNullable<ResolveVoiceProviderAvailabilityInput['local']>;
export type VoiceDaemonRouteDiagnosticReason = Extract<
    VoiceProviderUnavailableReason,
    'daemon_relay_disabled' | 'daemon_relay_capped'
>;
export type VoiceDaemonModelCatalogErrorCode =
    | 'feature_disabled'
    | 'machine_unreachable'
    | 'runtime_unavailable'
    | 'unsupported_runtime_family'
    | 'request_timeout'
    | 'internal_error'
    | null;

export type VoiceDaemonModelCatalogAvailability = Readonly<{
    modelState: VoiceDaemonModelAvailability;
    runtimeState: VoiceDaemonRuntimeAvailability;
}>;

type ServerFeaturesForRelay = Pick<FeaturesResponse, 'capabilities' | 'features'> | null | undefined;
export type VoiceDaemonDirectRouteAvailability = 'available' | 'unavailable';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

function readRecordValue(record: Record<string, unknown>, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function normalizeId(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function normalizeDaemonHttpPort(value: unknown): number | null {
    const port = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
            ? Number(value)
            : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return null;
    }
    return port;
}

function readMachineRecordFromState(input: Readonly<{
    state: unknown;
    serverId: string;
    machineId: string;
}>): Record<string, unknown> | null {
    const state = isRecord(input.state) ? input.state : null;
    const machineListByServerId = isRecord(state?.machineListByServerId) ? state.machineListByServerId : null;
    const scopedMachines = machineListByServerId?.[input.serverId];
    if (Array.isArray(scopedMachines)) {
        for (const candidate of scopedMachines) {
            if (!isRecord(candidate)) continue;
            if (String(readRecordValue(candidate, 'id') ?? '') === input.machineId) {
                return candidate;
            }
        }
    }

    const machines = isRecord(state?.machines) ? state.machines : null;
    const fallbackMachine = machines?.[input.machineId];
    return isRecord(fallbackMachine) ? fallbackMachine : null;
}

export function readVoiceDaemonHttpPortFromState(input: Readonly<{
    state: unknown;
    serverId: string;
    machineId: string;
}>): number | null {
    const machine = readMachineRecordFromState(input);
    const daemonState = isRecord(machine?.daemonState) ? machine.daemonState : null;
    return normalizeDaemonHttpPort(daemonState ? readRecordValue(daemonState, 'httpPort') : null);
}

function readTunnelCapabilities(serverFeatures: ServerFeaturesForRelay): MachineTunnelCapabilities {
    const featuresRecord = isRecord(serverFeatures) ? serverFeatures : null;
    const capabilities = isRecord(featuresRecord?.capabilities) ? featuresRecord.capabilities : null;
    const machines = isRecord(capabilities?.machines) ? capabilities.machines : null;
    const tunnel = isRecord(machines?.tunnel) ? machines.tunnel : null;
    const parsed = MachineTunnelCapabilitiesSchema.safeParse(tunnel);
    return parsed.success ? parsed.data : DEFAULT_MACHINE_TUNNEL_CAPABILITIES;
}

export function readVoiceProviderRelayDisabledReason(
    features: Pick<FeaturesResponse, 'capabilities'> | null | undefined,
): MachineLiveStreamRelayDisabledReason | null {
    const capabilities = features && isRecord(features.capabilities) ? features.capabilities : null;
    const machines = capabilities && isRecord(capabilities.machines) ? capabilities.machines : null;
    const liveStream = machines && isRecord(machines.liveStream) ? machines.liveStream : null;
    const serverRouted = liveStream && isRecord(liveStream.serverRouted) ? liveStream.serverRouted : null;
    const disabledReason = serverRouted?.disabledReason;
    if (disabledReason == null) {
        return null;
    }
    const parsed = MachineLiveStreamRelayDisabledReasonSchema.safeParse(disabledReason);
    return parsed.success ? parsed.data : null;
}

export function resolveVoiceDaemonRouteAvailabilityFromServerFeatures(
    features: ServerFeaturesForRelay,
    directRouteAvailability: VoiceDaemonDirectRouteAvailability = 'unavailable',
): VoiceDaemonRouteAvailability {
    if (directRouteAvailability === 'available') {
        return 'direct';
    }

    const disabledReason = readVoiceProviderRelayDisabledReason(features);
    if (disabledReason === 'cap_exceeded') {
        return 'relay_capped';
    }

    const relayEnabled = features
        ? readServerEnabledBit(features, 'machines.liveStream.serverRouted') === true
        : false;
    if (!relayEnabled) {
        return 'relay_disabled';
    }

    return readMachineLiveStreamRelayCaps(features) ? 'relay' : 'relay_disabled';
}

export function resolveVoiceDaemonDirectRouteAvailability(input: Readonly<{
    serverFeatures: ServerFeaturesForRelay;
    serverId: string | null | undefined;
    machineId: string | null | undefined;
    endpoint: unknown;
    daemonHttpPort: unknown;
}>): VoiceDaemonDirectRouteAvailability {
    const serverId = normalizeId(input.serverId);
    const machineId = normalizeId(input.machineId);
    if (!serverId || !machineId) {
        return 'unavailable';
    }
    if (!input.serverFeatures || readServerEnabledBit(input.serverFeatures, 'machines.tunnel.directPeer') !== true) {
        return 'unavailable';
    }

    const port = normalizeDaemonHttpPort(input.daemonHttpPort);
    if (!port) {
        return 'unavailable';
    }
    const caps = readTunnelCapabilities(input.serverFeatures);
    if (!caps.directPeer.allowedPorts.includes(port)) {
        return 'unavailable';
    }

    const parsedEndpoint = PeerLoopbackEndpointCandidateV1Schema.safeParse(input.endpoint);
    return parsedEndpoint.success ? 'available' : 'unavailable';
}

function resolveFixedMachineDirectRouteAvailability(input: Readonly<{
    serverFeatures: ServerFeaturesForRelay;
    daemonMachineId: string | null | undefined;
}>): VoiceDaemonDirectRouteAvailability {
    const machineId = normalizeId(input.daemonMachineId);
    if (!machineId) {
        return 'unavailable';
    }
    const serverId = normalizeId(getActiveServerSnapshot().serverId);
    if (!serverId) {
        return 'unavailable';
    }

    const endpoint = readEndpointFromMachineState({ serverId, machineId });
    const daemonHttpPort = readVoiceDaemonHttpPortFromState({
        state: storage.getState(),
        serverId,
        machineId,
    });
    return resolveVoiceDaemonDirectRouteAvailability({
        serverFeatures: input.serverFeatures,
        serverId,
        machineId,
        endpoint,
        daemonHttpPort,
    });
}

export function resolveVoiceDaemonRouteDiagnosticReason(
    localAvailability: Pick<VoiceProviderLocalAvailability, 'daemon'> | null | undefined,
): VoiceDaemonRouteDiagnosticReason | null {
    const route = localAvailability?.daemon?.route;
    if (route === 'relay_capped') {
        return 'daemon_relay_capped';
    }
    if (route === 'relay_disabled') {
        return 'daemon_relay_disabled';
    }
    return null;
}

function resolveSelectedCatalogPackId(kind: ModelPackKind, selectedPackId: string | null): string | null {
    const trimmed = typeof selectedPackId === 'string' ? selectedPackId.trim() : '';
    if (trimmed.length > 0) {
        return resolveCanonicalModelPackId(trimmed);
    }
    return getDefaultModelPackId(kind);
}

function resolveModelStateForStatus(status: DaemonVoiceInferenceModelStatus | null): VoiceDaemonModelAvailability {
    if (!status || status.installState === 'not_installed') {
        return 'missing';
    }
    if (status.installState === 'installing') {
        return 'installing';
    }
    if (status.installState === 'error') {
        return 'error';
    }
    return 'ready';
}

function isSelectedDaemonRuntimeSupported(status: DaemonVoiceInferenceModelStatus | null): boolean {
    if (!status || status.runtimeSupported !== true || typeof status.runtimeFamily !== 'string') {
        return false;
    }
    const catalogEntry = getModelPackCatalogEntry(status.packId);
    return catalogEntry?.runtimeFamily === status.runtimeFamily;
}

export function resolveVoiceDaemonModelKindAvailabilityFromCatalogState(input: Readonly<{
    loading: boolean;
    errorCode: VoiceDaemonModelCatalogErrorCode;
    statuses: readonly DaemonVoiceInferenceModelStatus[];
    kind: ModelPackKind;
    selectedPackId: string | null;
}>): VoiceDaemonModelCatalogAvailability {
    if (
        input.errorCode === 'runtime_unavailable'
        || input.errorCode === 'unsupported_runtime_family'
    ) {
        return { modelState: 'unknown', runtimeState: 'unavailable' };
    }
    if (input.loading || input.errorCode !== null) {
        return { modelState: 'unknown', runtimeState: 'unknown' };
    }

    const selectedPackId = resolveSelectedCatalogPackId(input.kind, input.selectedPackId);
    if (!selectedPackId) {
        return { modelState: 'unknown', runtimeState: 'unknown' };
    }

    const status = input.statuses.find((candidate) => candidate.packId === selectedPackId) ?? null;
    const modelState = resolveModelStateForStatus(status);
    return {
        modelState,
        runtimeState: !isSelectedDaemonRuntimeSupported(status)
            ? 'unavailable'
            : modelState === 'ready'
                ? 'available'
                : 'unknown',
    };
}

function combineModelStates(states: readonly VoiceDaemonModelAvailability[]): VoiceDaemonModelAvailability {
    if (states.some((state) => state === 'error')) {
        return 'error';
    }
    if (states.some((state) => state === 'installing')) {
        return 'installing';
    }
    if (states.some((state) => state === 'missing')) {
        return 'missing';
    }
    if (states.length > 0 && states.every((state) => state === 'ready')) {
        return 'ready';
    }
    return 'unknown';
}

export function resolveVoiceDaemonModelAvailabilityFromCatalogState(input: Readonly<{
    loading: boolean;
    errorCode: VoiceDaemonModelCatalogErrorCode;
    statuses: readonly DaemonVoiceInferenceModelStatus[];
    selectedSttPackId: string | null;
    selectedTtsPackId: string | null;
}>): VoiceDaemonModelCatalogAvailability {
    if (
        input.errorCode === 'runtime_unavailable'
        || input.errorCode === 'unsupported_runtime_family'
    ) {
        return { modelState: 'unknown', runtimeState: 'unavailable' };
    }
    if (input.loading || input.errorCode !== null) {
        return { modelState: 'unknown', runtimeState: 'unknown' };
    }

    const selectedSttPackId = resolveSelectedCatalogPackId('stt_sherpa', input.selectedSttPackId);
    const selectedTtsPackId = resolveSelectedCatalogPackId('tts_sherpa', input.selectedTtsPackId);
    if (!selectedSttPackId || !selectedTtsPackId) {
        return { modelState: 'unknown', runtimeState: 'unknown' };
    }

    const statusByPackId = new Map(input.statuses.map((status) => [status.packId, status]));
    const selectedStatuses = [
        statusByPackId.get(selectedSttPackId) ?? null,
        statusByPackId.get(selectedTtsPackId) ?? null,
    ] as const;
    const modelState = combineModelStates(selectedStatuses.map(resolveModelStateForStatus));
    const runtimeSupported = selectedStatuses.every(isSelectedDaemonRuntimeSupported);

    return {
        modelState,
        runtimeState: !runtimeSupported
            ? 'unavailable'
            : modelState === 'ready'
                ? 'available'
                : 'unknown',
    };
}

export function resolveVoiceProviderLocalAvailability(input: Readonly<{
    serverFeatures: ServerFeaturesForRelay;
    daemonFeatureEnabled: boolean;
    platformOs?: string;
    browserSpeechCapability?: VoiceBrowserSpeechCapability;
    browserSpeechSupport?: VoiceBrowserSpeechSupport;
    browserSpeechOnDevice?: VoiceBrowserSpeechOnDeviceAvailability;
    daemonModelState?: VoiceDaemonModelAvailability;
    daemonRuntimeState?: VoiceDaemonRuntimeAvailability;
    daemonPcmCapture?: VoiceDaemonPcmCaptureAvailability;
    daemonDirectRouteAvailability?: VoiceDaemonDirectRouteAvailability;
    nativeDeviceRequested?: boolean;
    nativeDeviceSpeechRecognition?: DeviceSpeechRecognitionAvailability;
}>): VoiceProviderLocalAvailability {
    const platformOs = input.platformOs ?? Platform.OS;
    const defaultBrowserSpeechCapability = getDefaultBrowserWebSpeechCapability(platformOs);
    return {
        browserSpeech: input.browserSpeechCapability ?? {
            support: input.browserSpeechSupport ?? defaultBrowserSpeechCapability.support,
            onDevice: input.browserSpeechOnDevice ?? defaultBrowserSpeechCapability.onDevice,
        },
        daemon: {
            featureEnabled: input.daemonFeatureEnabled,
            route: resolveVoiceDaemonRouteAvailabilityFromServerFeatures(
                input.serverFeatures,
                input.daemonDirectRouteAvailability,
            ),
            modelState: input.daemonModelState ?? 'unknown',
            runtimeState: input.daemonRuntimeState ?? 'unknown',
            ...(input.daemonPcmCapture ? { pcmCapture: input.daemonPcmCapture } : {}),
        },
        nativeDevice: {
            requested: input.nativeDeviceRequested ?? platformOs !== 'web',
            speechRecognition: input.nativeDeviceSpeechRecognition ?? 'unknown',
        },
    };
}

function useNativeDeviceSpeechRecognitionAvailability(
    platformOs: string = Platform.OS,
): DeviceSpeechRecognitionAvailability {
    const [availability, setAvailability] = React.useState<DeviceSpeechRecognitionAvailability>('unknown');

    React.useEffect(() => {
        if (platformOs === 'web') {
            setAvailability('unknown');
            return;
        }

        let active = true;
        void import('expo-speech-recognition').then(
            ({ ExpoSpeechRecognitionModule }) => {
                if (!active) return;
                setAvailability(readDeviceSpeechRecognitionAvailability(ExpoSpeechRecognitionModule));
            },
            () => {
                if (!active) return;
                setAvailability('unknown');
            },
        );
        return () => {
            active = false;
        };
    }, [platformOs]);

    return availability;
}

export function useVoiceProviderLocalAvailability(input: Readonly<{
    daemonModelState?: VoiceDaemonModelAvailability;
    daemonRuntimeState?: VoiceDaemonRuntimeAvailability;
    daemonMachineId?: string | null;
}> = {}): VoiceProviderLocalAvailability {
    const localPolicySettings = useFeatureLocalPolicySettings();
    const serverFeatures = getCachedReadyServerFeatures();
    const browserSpeechCapability = useBrowserWebSpeechCapability();
    const nativeDeviceSpeechRecognition = useNativeDeviceSpeechRecognitionAvailability();
    const daemonPcmCapture = resolveDaemonSpeechPcmCaptureAvailability();
    const daemonDirectRouteAvailability = resolveFixedMachineDirectRouteAvailability({
        serverFeatures,
        daemonMachineId: input.daemonMachineId,
    });
    const daemonFeatureEnabled =
        resolveLocalFeaturePolicyEnabled('voice', localPolicySettings)
        && resolveLocalFeaturePolicyEnabled('voice.agent', localPolicySettings)
        && resolveLocalFeaturePolicyEnabled('voice.daemonInference', localPolicySettings);

    return React.useMemo(
        () => resolveVoiceProviderLocalAvailability({
            serverFeatures,
            daemonFeatureEnabled,
            browserSpeechCapability,
            daemonModelState: input.daemonModelState,
            daemonRuntimeState: input.daemonRuntimeState,
            daemonPcmCapture,
            daemonDirectRouteAvailability,
            nativeDeviceSpeechRecognition,
        }),
        [
            browserSpeechCapability,
            daemonDirectRouteAvailability,
            daemonFeatureEnabled,
            daemonPcmCapture,
            input.daemonModelState,
            input.daemonRuntimeState,
            nativeDeviceSpeechRecognition,
            serverFeatures,
        ],
    );
}

import * as React from 'react';
import { Platform } from 'react-native';

import {
    MachineLiveStreamRelayDisabledReasonSchema,
    RPC_METHODS,
    getDefaultModelPackId,
    getModelPackCatalogEntry,
    readMachineLiveStreamRelayCaps,
    readServerEnabledBit,
    resolveCanonicalModelPackId,
    resolveMachineRpcRelayFallbackDecision,
    resolveMachineRpcRoutePolicy,
} from '@happier-dev/protocol';
import type {
    DaemonVoiceInferenceModelStatus,
    FeaturesResponse,
    MachineLiveStreamRelayDisabledReason,
    ModelPackKind,
    VoiceReadinessRole,
} from '@happier-dev/protocol';

import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveMachineRpcDirectRoutePreflight } from '@/sync/domains/machines/peer/mediation/rpc/directRoutePreflight';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import {
    readDeviceSpeechRecognitionAvailability,
    type DeviceSpeechRecognitionAvailability,
} from '@/voice/input/deviceSpeechRecognitionAvailability';
import { resolveDaemonSpeechPcmCaptureAvailability } from '@/voice/runtime/daemonInference/resolveDaemonSpeechPcmCaptureAvailability';
import type { VoiceReadinessFact, VoiceRoleReadiness } from '@/voice/registry/readiness';

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
    'daemon_unreachable' | 'daemon_relay_disabled' | 'daemon_relay_capped'
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

/**
 * Canonical passive projection for daemon heavy-audio prerequisites. Exact
 * feature, machine, and route failures take precedence over catalog facts that
 * may still be loading. This never probes a route, opens media, or starts a
 * provider operation.
 */
export function resolveVoiceDaemonHeavyAudioReadiness(input: Readonly<{
    role: VoiceReadinessRole;
    providerId: string;
    daemon: VoiceProviderLocalAvailability['daemon'] | null | undefined;
    executionMachineId: string | null | undefined;
    executionMachineSelectionKind?: 'resolved' | 'selected_unreachable' | 'none';
}>): VoiceRoleReadiness | null {
    if (!input.daemon) return null;
    if (input.daemon.featureEnabled !== true) {
        return Object.freeze({
            role: input.role,
            providerId: input.providerId,
            status: 'unavailable',
            code: 'server_feature_disabled',
            reasonKey: 'voice.readiness.server_feature_disabled',
            recoveryAction: 'switch_provider',
        });
    }
    if (input.executionMachineSelectionKind === 'selected_unreachable') {
        return Object.freeze({
            role: input.role,
            providerId: input.providerId,
            status: 'incompatible',
            code: 'execution_machine_incompatible',
            reasonKey: 'voice.readiness.execution_machine_incompatible',
            recoveryAction: 'select_execution_machine',
        });
    }
    if (!input.executionMachineId) {
        return Object.freeze({
            role: input.role,
            providerId: input.providerId,
            status: 'needs_setup',
            code: 'execution_machine_missing',
            reasonKey: 'voice.readiness.execution_machine_missing',
            recoveryAction: 'select_execution_machine',
        });
    }
    const code = resolveVoiceDaemonRouteDiagnosticReason({ daemon: input.daemon });
    if (!code) {
        return null;
    }
    return Object.freeze({
        role: input.role,
        providerId: input.providerId,
        status: 'unavailable',
        code,
        reasonKey: `voice.readiness.${code}`,
        recoveryAction: 'switch_provider',
    });
}

/** Canonical passive projection of the daemon inference-runtime fact. */
export function projectVoiceDaemonRuntimeReadinessFact(
    daemon: VoiceProviderLocalAvailability['daemon'] | null | undefined,
): VoiceReadinessFact {
    if (!daemon) return 'unknown';
    if (daemon.runtimeState === 'available') return 'ready';
    if (daemon.runtimeState === 'unavailable') return 'missing';
    return 'unknown';
}

/**
 * Canonical passive projection of whether the selected daemon machine has a
 * policy-authorized speech route. Route failure is an execution-machine fact,
 * not evidence that the daemon's inference runtime is absent.
 */
export function projectVoiceDaemonExecutionMachineReadinessFact(
    daemon: VoiceProviderLocalAvailability['daemon'] | null | undefined,
    executionMachineId: string | null | undefined,
): VoiceReadinessFact {
    if (!executionMachineId) return 'missing';
    if (!daemon) return 'unknown';
    if (
        !daemon.featureEnabled
        || daemon.route === 'unavailable'
        || daemon.route === 'relay_disabled'
        || daemon.route === 'relay_capped'
    ) {
        return 'missing';
    }
    return 'ready';
}

export function projectVoiceDaemonModelReadinessFact(
    daemon: VoiceProviderLocalAvailability['daemon'] | null | undefined,
): VoiceReadinessFact {
    if (daemon?.modelState === 'ready') return 'ready';
    if (daemon?.modelState === 'missing') return 'missing';
    if (daemon?.modelState === 'installing') return 'installing';
    if (daemon?.modelState === 'error') return 'incompatible';
    return 'unknown';
}

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

    const relayDecision = resolveMachineRpcRelayFallbackDecision({
        policy: resolveMachineRpcRoutePolicy(
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
        ),
        deploymentKind: 'shared_server',
        relayEnabled: features
            ? readServerEnabledBit(features, 'machines.liveStream.serverRouted') === true
            : false,
        caps: readMachineLiveStreamRelayCaps(features),
    });
    return relayDecision.ok ? 'relay' : 'relay_disabled';
}

export function resolveVoiceDaemonDirectRouteAvailability(input: Readonly<{
    serverFeatures: FeaturesResponse | null | undefined;
    credentials: AuthCredentials | null | undefined;
    endpoint: unknown;
}>): VoiceDaemonDirectRouteAvailability {
    const preflight = resolveMachineRpcDirectRoutePreflight({
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
        serverFeatures: input.serverFeatures ?? null,
        credentials: input.credentials ?? null,
        endpoint: input.endpoint ?? null,
    });
    return preflight.kind === 'direct_eligible' ? 'available' : 'unavailable';
}

export function resolveVoiceDaemonRouteDiagnosticReason(
    localAvailability: Pick<VoiceProviderLocalAvailability, 'daemon'> | null | undefined,
): VoiceDaemonRouteDiagnosticReason | null {
    const route = localAvailability?.daemon?.route;
    if (route === 'unavailable') {
        return 'daemon_unreachable';
    }
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
            : 'available',
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
    requireStt?: boolean;
    requireTts?: boolean;
}>): VoiceDaemonModelCatalogAvailability {
    const requireStt = input.requireStt ?? true;
    const requireTts = input.requireTts ?? true;
    if (!requireStt && !requireTts) {
        return { modelState: 'ready', runtimeState: 'available' };
    }
    if (
        input.errorCode === 'runtime_unavailable'
        || input.errorCode === 'unsupported_runtime_family'
    ) {
        return { modelState: 'unknown', runtimeState: 'unavailable' };
    }
    if (input.loading || input.errorCode !== null) {
        return { modelState: 'unknown', runtimeState: 'unknown' };
    }

    const selectedSttPackId = requireStt
        ? resolveSelectedCatalogPackId('stt_sherpa', input.selectedSttPackId)
        : null;
    const selectedTtsPackId = requireTts
        ? resolveSelectedCatalogPackId('tts_sherpa', input.selectedTtsPackId)
        : null;
    if ((requireStt && !selectedSttPackId) || (requireTts && !selectedTtsPackId)) {
        return { modelState: 'unknown', runtimeState: 'unknown' };
    }

    const statusByPackId = new Map(input.statuses.map((status) => [status.packId, status]));
    const selectedStatuses = [
        ...(selectedSttPackId ? [statusByPackId.get(selectedSttPackId) ?? null] : []),
        ...(selectedTtsPackId ? [statusByPackId.get(selectedTtsPackId) ?? null] : []),
    ];
    const modelState = combineModelStates(selectedStatuses.map(resolveModelStateForStatus));
    const runtimeSupported = selectedStatuses.every(isSelectedDaemonRuntimeSupported);

    return {
        modelState,
        runtimeState: !runtimeSupported
            ? 'unavailable'
            : 'available',
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
    const activeServer = useActiveServerSnapshot();
    const serverFeaturesSnapshot = useServerFeaturesRuntimeSnapshot();
    const serverFeatures = serverFeaturesSnapshot.status === 'ready'
        ? serverFeaturesSnapshot.features
        : null;
    const daemonMachineId = normalizeId(input.daemonMachineId) ?? '';
    const daemonMachine = useServerScopedMachine(activeServer.serverId, daemonMachineId);
    const { credentials } = useAuth();
    const browserSpeechCapability = useBrowserWebSpeechCapability();
    const nativeDeviceSpeechRecognition = useNativeDeviceSpeechRecognitionAvailability();
    const daemonPcmCapture = resolveDaemonSpeechPcmCaptureAvailability();
    const daemonFeatureEnabled = useFeatureEnabled('voice.daemonInference', {
        scopeKind: 'runtime',
    });
    const daemonDirectRouteAvailability = resolveVoiceDaemonDirectRouteAvailability({
        serverFeatures,
        credentials,
        endpoint: daemonMachine?.daemonState?.peerMediation?.loopback?.endpoint ?? null,
    });

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

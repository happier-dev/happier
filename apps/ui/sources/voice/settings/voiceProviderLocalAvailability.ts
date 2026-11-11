import * as React from 'react';
import { Platform } from 'react-native';

import { MachineLiveStreamRelayDisabledReasonSchema, readMachineLiveStreamRelayCaps } from '@happier-dev/protocol/features/payload/capabilities/machineLiveStreamCapabilities';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getDefaultModelPackId, getModelPackCatalogEntry, resolveCanonicalModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { resolveMachineRpcRelayFallbackDecision, resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import type {
    DaemonVoiceInferenceModelStatus} from '@happier-dev/protocol/daemon/voiceInference';
import type {
    FeaturesResponse} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type {
    MachineLiveStreamRelayDisabledReason} from '@happier-dev/protocol/features/payload/capabilities/machineLiveStreamCapabilities';
import type {
    ModelPackKind} from '@happier-dev/protocol/voice/modelPacks/manifest';
import type {
    VoiceReadinessRole,
} from '@happier-dev/protocol/voice/realtime/capabilities';

import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveFeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import type { FeatureAvailabilityArm } from '@/hooks/server/resolveFeatureAvailabilityArm';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveMachineRpcDirectRoutePreflight } from '@/sync/domains/machines/peer/mediation/rpc/directRoutePreflight';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import {
    readDeviceSpeechRecognitionAvailability,
    type DeviceSpeechRecognitionAvailability,
} from '@/voice/input/deviceSpeechRecognitionAvailability';
import { resolveDaemonSpeechPcmCaptureAvailability } from '@/voice/runtime/daemonInference/resolveDaemonSpeechPcmCaptureAvailability';
import { projectVoiceReadinessRequirement, type VoiceReadinessFact, type VoiceRoleReadiness } from '@/voice/registry/readiness';

import type {
    ResolveVoiceProviderAvailabilityInput,
    VoiceBrowserSpeechCapability,
    VoiceBrowserSpeechOnDeviceAvailability,
    VoiceBrowserSpeechSupport,
    VoiceDaemonModelAvailability,
    VoiceDaemonPcmCaptureAvailability,
    VoiceDaemonRouteAvailability,
    VoiceDaemonRuntimeAvailability,
    VoiceDaemonSpeechAvailability,
    VoiceProviderUnavailableReason,
} from './resolveVoiceProviderAvailability';
import { getDefaultBrowserWebSpeechCapability, useBrowserWebSpeechCapability } from './browserWebSpeechCapability';
import { projectVoiceExecutionMachineReadiness, type VoiceExecutionMachineSelection } from './executionMachine';

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
    executionMachineSelectionKind?: VoiceExecutionMachineSelection['kind'];
}>): VoiceRoleReadiness | null {
    if (!input.daemon) return null;
    if (input.daemon.featureEnabled !== true) {
        return projectVoiceReadinessRequirement(input.role, input.providerId, 'server_feature',
            input.daemon.featureAvailability === 'policy_disabled' ? 'policy_disabled' : 'missing');
    }
    const machineReadiness = projectVoiceReadinessRequirement(input.role, input.providerId, 'execution_machine',
        projectVoiceExecutionMachineReadiness(input.executionMachineSelectionKind, input.executionMachineId));
    if (machineReadiness) return machineReadiness;
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
    daemon: Readonly<{ runtimeState?: VoiceDaemonRuntimeAvailability }> | null | undefined,
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
    daemon: Readonly<{ modelState: VoiceDaemonModelAvailability }> | null | undefined,
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

function normalizeId(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
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
    if (!status) return 'unknown';
    if (status.installState === 'not_installed') {
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
    if (!status) return { modelState: 'unknown', runtimeState: 'unknown' };
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
    const roles = [
        ...(requireStt ? [resolveVoiceDaemonModelKindAvailabilityFromCatalogState({
            ...input, kind: 'stt_sherpa', selectedPackId: input.selectedSttPackId,
        })] : []),
        ...(requireTts ? [resolveVoiceDaemonModelKindAvailabilityFromCatalogState({
            ...input, kind: 'tts_sherpa', selectedPackId: input.selectedTtsPackId,
        })] : []),
    ];
    const modelState = combineModelStates(roles.map(role => role.modelState));
    const runtimeState = roles.some(role => role.runtimeState === 'unavailable')
        ? 'unavailable' : roles.some(role => role.runtimeState === 'unknown') ? 'unknown' : 'available';

    return {
        modelState,
        runtimeState,
    };
}

export function resolveVoiceProviderLocalAvailability(input: Readonly<{
    serverFeatures: ServerFeaturesForRelay;
    daemonFeatureEnabled: boolean;
    daemonFeatureAvailability?: FeatureAvailabilityArm;
    platformOs?: string;
    browserSpeechCapability?: VoiceBrowserSpeechCapability;
    browserSpeechSupport?: VoiceBrowserSpeechSupport;
    browserSpeechOnDevice?: VoiceBrowserSpeechOnDeviceAvailability;
    daemonModelState?: VoiceDaemonModelAvailability;
    daemonRuntimeState?: VoiceDaemonRuntimeAvailability;
    daemonSpeech?: VoiceDaemonSpeechAvailability;
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
            ...(input.daemonFeatureAvailability ? { featureAvailability: input.daemonFeatureAvailability } : {}),
            route: resolveVoiceDaemonRouteAvailabilityFromServerFeatures(
                input.serverFeatures,
                input.daemonDirectRouteAvailability,
            ),
            modelState: input.daemonModelState ?? 'unknown',
            runtimeState: input.daemonRuntimeState ?? 'unknown',
            ...(input.daemonSpeech ? { speech: input.daemonSpeech } : {}),
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
    daemonSpeech?: VoiceDaemonSpeechAvailability;
    daemonMachineId?: string | null;
}> = {}): VoiceProviderLocalAvailability {
    const activeServer = useActiveServerSnapshot();
    const serverFeaturesSnapshot = useServerFeaturesRuntimeSnapshot();
    const serverFeatures = serverFeaturesSnapshot.status === 'ready'
        ? serverFeaturesSnapshot.features
        : null;
    const daemonMachineId = normalizeId(input.daemonMachineId) ?? '';
    const { credentials } = useAuth();
    const browserSpeechCapability = useBrowserWebSpeechCapability();
    const nativeDeviceSpeechRecognition = useNativeDeviceSpeechRecognitionAvailability();
    const daemonPcmCapture = resolveDaemonSpeechPcmCaptureAvailability();
    const daemonFeatureDecision = useFeatureDecision('voice.daemonInference', {
        scopeKind: 'runtime',
    });
    const daemonFeatureEnabled = daemonFeatureDecision?.state === 'enabled';
    const daemonFeatureAvailability = resolveFeatureAvailabilityArm(daemonFeatureDecision);
    // Read the consumed route fact, not the whole Machine. Resource publications
    // stay quiet while preflight still observes endpoint expiry on source changes.
    const daemonDirectRouteAvailability = storage(React.useCallback(state => (
        resolveVoiceDaemonDirectRouteAvailability({
            serverFeatures,
            credentials,
            endpoint: resolveServerScopedMachine(state, activeServer.serverId, daemonMachineId)
                ?.daemonState?.peerMediation?.loopback?.endpoint ?? null,
        })
    ), [activeServer.serverId, daemonMachineId, serverFeatures, credentials]));

    return React.useMemo(
        () => resolveVoiceProviderLocalAvailability({
            serverFeatures,
            daemonFeatureEnabled,
            daemonFeatureAvailability,
            browserSpeechCapability,
            daemonModelState: input.daemonModelState,
            daemonRuntimeState: input.daemonRuntimeState,
            daemonSpeech: input.daemonSpeech,
            daemonPcmCapture,
            daemonDirectRouteAvailability,
            nativeDeviceSpeechRecognition,
        }),
        [
            browserSpeechCapability,
            daemonDirectRouteAvailability,
            daemonFeatureEnabled,
            daemonFeatureAvailability,
            daemonPcmCapture,
            input.daemonModelState,
            input.daemonRuntimeState,
            input.daemonSpeech,
            nativeDeviceSpeechRecognition,
            serverFeatures,
        ],
    );
}

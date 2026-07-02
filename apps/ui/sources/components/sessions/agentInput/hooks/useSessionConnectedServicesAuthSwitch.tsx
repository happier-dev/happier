import * as React from 'react';
import { useRouter } from 'expo-router';

import { readSessionMetadataConnectedServiceBindings, type AgentCore, type ConnectedServiceId } from '@happier-dev/agents';
import type {
    ConnectedServiceBindingSelectionV1,
    ConnectedServiceBindingsV1,
    ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip, AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import {
    resolveConnectedServiceUxDiagnosticPresentation,
    type ConnectedServiceUxDiagnosticPresentation,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { buildConnectedServiceUxDiagnosticAlertButtons } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnosticAlertActions';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    resolveAgentSupportedConnectedServiceIds,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { resolveConnectedServiceDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServicesAuthLabel } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
    setSessionConnectedServiceAuthBinding,
    type SessionConnectedServiceAuthSwitchErrorCode,
    type SessionConnectedServiceAuthSwitchResult as DaemonSessionConnectedServiceAuthSwitchResult,
} from '@/sync/ops/connectedServices/sessionAuthSwitch';
import { useProfile } from '@/sync/store/hooks';
import { t, type TranslationKey } from '@/text';
import {
    createManualAuthSwitchRestartSignal,
    resolveSessionIntentionalRestartState,
    SESSION_INTENTIONAL_RESTART_FAILSAFE_MS,
    type SessionIntentionalRestartSignal,
    type SessionIntentionalRestartState,
} from './sessionIntentionalRestartSignal';
import {
    buildPartialAuthSwitchApplicationStatusBadges,
    resolvePartialAuthSwitchApplicationNotice,
    type PartialAuthSwitchApplicationNotice,
} from './sessionAuthSwitchPartialStatusBadges';

type SessionConnectedServicesAuthSwitchDisabledReason =
    | 'active_turn'
    | 'read_only';

type ConnectedServicesAgentCore = Pick<AgentCore, 'id' | 'connectedServices'> | null;

export type SessionConnectedServicesAuthSwitchResult = Readonly<{
    connectedServicesAuthChip: AgentInputExtraActionChip | null;
    statusBadges: ReadonlyArray<AgentInputStatusBadge>;
    restartState: SessionConnectedServicesAuthSwitchRestartState;
    actionableState: SessionConnectedServicesAuthSwitchActionableState | null;
}>;

export type SessionConnectedServicesAuthSwitchRestartState = SessionIntentionalRestartState;

export type SessionConnectedServicesAuthSwitchActionableState =
    | Readonly<{
        kind: 'provider_state_sharing_required';
        route: '/(app)/settings/connected-services/provider-state-sharing';
      }>
    | Readonly<{
        kind: 'not_group_selection' | 'connected_service_required' | 'profile_action_required';
        route: '/(app)/settings/connected-services';
      }>
    | Readonly<{
        kind: 'reconnect_profile';
        route: '/(app)/settings/connected-services/profile' | '/(app)/settings/connected-services/oauth';
        profileId: string;
      }>
    | Readonly<{
        kind: 'provider_session_state_unavailable_for_resume';
        recovery: 'retry_required';
        diagnostic?: ConnectedServiceUxDiagnosticV1;
      }>;

type ProviderSessionUnavailableDiagnosticActionState = Readonly<{
    diagnostic: ConnectedServiceUxDiagnosticV1;
    serviceId: string;
    binding: ConnectedServicesServiceBinding;
    failureServiceId: string;
}> | null;

type SetBindingForServiceOptions = Readonly<{
    rematerializeServiceId?: ConnectedServiceId;
}>;

function presentAuthSwitchDiagnosticAlert(params: Readonly<{
    presentation: ConnectedServiceUxDiagnosticPresentation;
    retry?: () => void;
    startFreshUnderSelectedAccount?: () => void;
    resumeCurrentAccount?: () => void;
    openConnectedAccounts?: () => void;
    reconnectProfile?: () => void;
    enableStateSharing?: () => void;
    viewLatestFork?: () => void;
    viewNativeFork?: () => void;
    dismiss: () => void;
}>): void {
    Modal.alert(
        t(params.presentation.titleKey),
        translateAuthSwitchDiagnosticBody(params.presentation),
        buildConnectedServiceUxDiagnosticAlertButtons({
            actions: params.presentation.actions,
            handlers: {
                retry: params.retry,
                startFreshUnderSelectedAccount: params.startFreshUnderSelectedAccount,
                resumeCurrentAccount: params.resumeCurrentAccount,
                openConnectedAccounts: params.openConnectedAccounts,
                reconnectProfile: params.reconnectProfile,
                enableStateSharing: params.enableStateSharing,
                viewLatestFork: params.viewLatestFork,
                viewNativeFork: params.viewNativeFork,
                dismiss: params.dismiss,
            },
            translate: t,
        }),
    );
}

function resolveDiagnosticConnectedServiceId(params: Readonly<{
    diagnostic?: ConnectedServiceUxDiagnosticV1 | null;
    fallbackServiceId: string;
}>): ConnectedServiceId | undefined {
    const candidates = [
        params.diagnostic?.serviceId,
        params.fallbackServiceId,
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const parsed = ConnectedServiceIdSchema.safeParse(candidate.trim());
        if (parsed.success) return parsed.data as ConnectedServiceId;
    }
    return undefined;
}

function readDiagnosticProfileId(diagnostic: ConnectedServiceUxDiagnosticV1 | null | undefined): string | null {
    const profileId = diagnostic?.profileId;
    return typeof profileId === 'string' && profileId.trim() ? profileId.trim() : null;
}

function resolveSessionConnectedServiceAuthSwitchErrorMessageKey(
    errorCode: SessionConnectedServiceAuthSwitchErrorCode | undefined,
): TranslationKey {
    switch (errorCode) {
        case 'provider_state_sharing_required':
            return 'connectedServices.authSwitch.errors.providerStateSharingRequired';
        case 'group_generation_conflict':
            return 'connectedServices.authSwitch.errors.groupGenerationConflict';
        case 'not_group_selection':
            return 'connectedServices.authSwitch.errors.notGroupSelection';
        case 'connected_service_required':
            return 'connectedServices.authSwitch.errors.connectedServiceRequired';
        case 'profile_action_required':
            return 'connectedServices.authSwitch.errors.profileActionRequired';
        case 'provider_state_sharing_unavailable':
            return 'connectedServices.authSwitch.errors.providerStateSharingUnavailable';
        case 'profile_disconnected':
            return 'connectedServices.authSwitch.errors.profileDisconnected';
        case 'profile_missing':
            return 'connectedServices.authSwitch.errors.profileMissing';
        case 'group_missing':
            return 'connectedServices.authSwitch.errors.groupMissing';
        case 'metadata_update_failed':
            return 'connectedServices.authSwitch.errors.metadataUpdateFailed';
        case 'restart_failed':
            return 'connectedServices.authSwitch.errors.restartFailed';
        case 'hot_apply_failed':
            return 'connectedServices.authSwitch.errors.hotApplyFailed';
        case 'provider_account_adoption_mismatch':
        case 'post_switch_verification_failed':
            return 'connectedServices.authSwitch.switchFailed';
        case 'agent_mismatch':
            return 'connectedServices.authSwitch.errors.agentMismatch';
        case 'session_not_found':
            return 'connectedServices.authSwitch.errors.sessionNotFound';
        case 'unsupported_service':
            return 'connectedServices.authSwitch.errors.unsupportedService';
        default:
            return 'connectedServices.authSwitch.switchFailed';
    }
}

function resolveSessionConnectedServiceAuthSwitchActionableState(
    result: Readonly<{
        errorCode: SessionConnectedServiceAuthSwitchErrorCode;
        diagnostics?: Readonly<{
            uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
            actionRequired?: Readonly<{
                kind?: string;
                profileId?: string;
            }>;
        }>;
    }>,
): SessionConnectedServicesAuthSwitchActionableState | null {
    switch (result.errorCode) {
        case 'provider_state_sharing_required':
            return {
                kind: 'provider_state_sharing_required',
                route: '/(app)/settings/connected-services/provider-state-sharing',
            };
        case 'not_group_selection':
        case 'connected_service_required':
            return {
                kind: result.errorCode,
                route: '/(app)/settings/connected-services',
            };
        case 'profile_action_required': {
            const actionRequired = result.diagnostics?.actionRequired;
            const profileId = typeof actionRequired?.profileId === 'string' && actionRequired.profileId.trim()
                ? actionRequired.profileId.trim()
                : null;
            if (actionRequired?.kind === 'reconnect_profile' && profileId) {
                return {
                    kind: 'reconnect_profile',
                    route: '/(app)/settings/connected-services/profile',
                    profileId,
                };
            }
            return {
                kind: 'profile_action_required',
                route: '/(app)/settings/connected-services',
            };
        }
        case 'provider_session_state_unavailable_for_resume':
            return {
                kind: 'provider_session_state_unavailable_for_resume',
                recovery: 'retry_required',
                ...(result.diagnostics?.uxDiagnostic ? { diagnostic: result.diagnostics.uxDiagnostic } : {}),
            };
        default:
            return null;
    }
}

function translateAuthSwitchDiagnosticBody(
    presentation: ConnectedServiceUxDiagnosticPresentation,
): string {
    if (!presentation.bodyParams) return t(presentation.bodyKey);
    switch (presentation.bodyKey) {
        case 'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume':
        case 'connectedServices.diagnostics.body.resume_reachability_inputs_missing':
            return t(presentation.bodyKey, presentation.bodyParams);
        default:
            return t(presentation.bodyKey);
    }
}

type SessionConnectedServicesAuthSwitchPendingRestart = Readonly<{
    attemptId: number;
    expectedBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding>>;
    timedOut: boolean;
}>;

type SessionConnectedServicesAuthSwitchRetryState = Readonly<{
    attemptId: number;
    expectedBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding>>;
}>;

const RESTART_TIMEOUT_RECONCILIATION_BUDGET_MS = 30_000;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readBinding(value: unknown): ConnectedServicesServiceBinding | null {
    const raw = readRecord(value);
    if (!raw) return null;
    if (raw.source === 'native') return { source: 'native' };
    if (raw.source !== 'connected') return null;

    const profileId = typeof raw.profileId === 'string' && raw.profileId.trim()
        ? raw.profileId.trim()
        : undefined;
    const groupId = typeof raw.groupId === 'string' && raw.groupId.trim()
        ? raw.groupId.trim()
        : undefined;
    if (raw.selection === 'group' && groupId) {
        return { source: 'connected', selection: 'group', groupId, ...(profileId ? { profileId } : {}) };
    }
    if (profileId) return { source: 'connected', selection: 'profile', profileId };
    return null;
}

function readConnectedServicesBindingsFromMetadata(
    metadata: unknown,
    agentId: string,
): Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> {
    const rawMetadata = readRecord(metadata);
    const connectedServices = readRecord(rawMetadata?.connectedServices);
    const bindings = readRecord(connectedServices?.bindingsByServiceId);
    if (!bindings) {
        if (rawMetadata && Object.prototype.hasOwnProperty.call(rawMetadata, 'connectedServices')) return {};
        return readSessionMetadataConnectedServiceBindings(metadata, agentId);
    }

    const out: Record<string, ConnectedServicesServiceBinding | undefined> = {};
    for (const [serviceId, value] of Object.entries(bindings)) {
        const binding = readBinding(value);
        if (binding) out[serviceId] = binding;
    }
    return out;
}

function areServiceBindingsEqual(
    left: ConnectedServicesServiceBinding | undefined,
    right: ConnectedServicesServiceBinding | undefined,
): boolean {
    const leftSource = left?.source ?? 'native';
    const rightSource = right?.source ?? 'native';
    if (leftSource !== rightSource) return false;
    if (leftSource === 'native') return true;
    if (left?.selection !== right?.selection) return false;
    if (left?.selection === 'group' && right?.selection === 'group') {
        return Boolean(left.groupId) && left.groupId === right.groupId;
    }
    return left?.profileId === right?.profileId
        && left?.groupId === right?.groupId;
}

function areBindingsEqual(
    left: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>,
    right: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>,
): boolean {
    const serviceIds = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const serviceId of serviceIds) {
        if (!areServiceBindingsEqual(left[serviceId], right[serviceId])) return false;
    }
    return true;
}

function arePendingRestartBindingsApplied(
    pendingRestart: Readonly<{
        expectedBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding>>;
    }>,
    metadataBindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>,
): boolean {
    for (const [serviceId, expectedBinding] of Object.entries(pendingRestart.expectedBindingsByServiceId)) {
        if (!areServiceBindingsEqual(metadataBindingsByServiceId[serviceId], expectedBinding)) return false;
    }
    return true;
}

function readErrorTokens(value: unknown): ReadonlyArray<string> {
    const tokens: string[] = [];
    if (typeof value === 'string') tokens.push(value);
    if (value instanceof Error) tokens.push(value.message);
    const raw = readRecord(value);
    if (raw) {
        for (const key of ['code', 'error', 'errorCode', 'message', 'rpcErrorCode']) {
            const token = raw[key];
            if (typeof token === 'string') tokens.push(token);
        }
    }
    return tokens;
}

function isNonTerminalRestartTimeoutError(value: unknown): boolean {
    return readErrorTokens(value).some((token) => token.toLowerCase().includes('timeout'));
}

function buildSessionSwitchPayload(params: Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
}>): ConnectedServiceBindingsV1 {
    const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};
    for (const serviceId of params.supportedServiceIds) {
        const binding = params.bindingsByServiceId[serviceId] ?? { source: 'native' };
        if (binding.source === 'connected' && binding.selection === 'group' && binding.groupId) {
            bindingsByServiceId[serviceId] = {
                source: 'connected',
                selection: 'group',
                groupId: binding.groupId,
                ...(binding.profileId ? { profileId: binding.profileId } : {}),
            };
            continue;
        }
        if (binding.source === 'connected' && binding.profileId) {
            bindingsByServiceId[serviceId] = {
                source: 'connected',
                selection: 'profile',
                profileId: binding.profileId,
            };
            continue;
        }
        bindingsByServiceId[serviceId] = { source: 'native' };
    }
    return { v: 1, bindingsByServiceId };
}

function buildExpectedGroupGenerationByServiceId(params: Readonly<{
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    groupOptionsByServiceId: Readonly<Record<string, ReadonlyArray<{ groupId: string; generation?: number }>>>;
}>): Readonly<Record<string, number>> | undefined {
    const out: Record<string, number> = {};
    for (const [serviceId, binding] of Object.entries(params.bindingsByServiceId)) {
        if (binding?.source !== 'connected' || binding.selection !== 'group' || !binding.groupId) continue;
        const group = params.groupOptionsByServiceId[serviceId]?.find((candidate) => candidate.groupId === binding.groupId);
        if (typeof group?.generation === 'number' && Number.isInteger(group.generation) && group.generation >= 0) {
            out[serviceId] = group.generation;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function resolveSwitchTransition(input: Readonly<{
    current: ConnectedServicesServiceBinding | undefined;
    next: ConnectedServicesServiceBinding;
}>):
    | 'native_to_connected'
    | 'connected_to_native'
    | 'connected_to_connected'
    | 'same_connected_group'
    | null {
    if (areServiceBindingsEqual(input.current, input.next)) return null;
    const currentSource = input.current?.source ?? 'native';
    const nextSource = input.next.source;
    if (currentSource === 'native' && nextSource === 'connected') return 'native_to_connected';
    if (currentSource === 'connected' && nextSource === 'native') return 'connected_to_native';
    if (currentSource === 'connected' && nextSource === 'connected') {
        if (
            input.current?.selection === 'group'
            && input.next.selection === 'group'
            && input.current.groupId
            && input.current.groupId === input.next.groupId
        ) {
            return 'same_connected_group';
        }
        return 'connected_to_connected';
    }
    return null;
}

function agentSupportsSessionAuthSwitchTransition(input: Readonly<{
    agentCore: ConnectedServicesAgentCore;
    agentId: string | null | undefined;
    serviceId: string;
    current: ConnectedServicesServiceBinding | undefined;
    next: ConnectedServicesServiceBinding;
}>): boolean {
    const switchCapability = input.agentCore?.connectedServices?.sessionAuthSwitch;
    if (!switchCapability?.continuityMode) return false;
    const transition = resolveSwitchTransition({
        current: input.current,
        next: input.next,
    });
    if (!transition) return true;
    const supportedTransitions = switchCapability.supportedTransitions;
    if (!supportedTransitions || supportedTransitions.includes(transition)) return true;

    const stateSharingRequired = switchCapability.providerStateSharingRequired;
    if (!stateSharingRequired?.supportedTransitions.includes(transition)) return false;
    const serviceIds = stateSharingRequired.serviceIds;
    if (serviceIds && !serviceIds.includes(input.serviceId as ConnectedServiceId)) return false;
    return true;
}

export function useSessionConnectedServicesAuthSwitch(params: Readonly<{
    sessionId: string;
    agentId: string | null | undefined;
    machineId: string | null | undefined;
    serverId?: string | null;
    agentCore: ConnectedServicesAgentCore;
    sessionMetadata: unknown;
    settings: {
        connectedServicesProfileLabelByKey: Record<string, string | undefined>;
        connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
        connectedServicesProviderStateSharingSettingsV1?: unknown;
    };
    switchingDisabledReason: SessionConnectedServicesAuthSwitchDisabledReason | null;
    sessionActive?: boolean;
    intentionalRestartSignals?: ReadonlyArray<SessionIntentionalRestartSignal>;
}>): SessionConnectedServicesAuthSwitchResult {
    const accountProfile = useProfile();
    const router = useRouter();
    const connectedServicesFeatureEnabled = useFeatureEnabled('connectedServices', {
        scopeKind: 'spawn',
        serverId: params.serverId ?? null,
    });
    const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', {
        scopeKind: 'spawn',
        serverId: params.serverId ?? null,
    });
    const switchAttemptIdRef = React.useRef(0);
    const [pendingRestart, setPendingRestart] = React.useState<SessionConnectedServicesAuthSwitchPendingRestart | null>(null);
    const [restartRetryState, setRestartRetryState] = React.useState<SessionConnectedServicesAuthSwitchRetryState | null>(null);
    const [manualRestartSignal, setManualRestartSignal] = React.useState<SessionIntentionalRestartSignal | null>(null);
    const [restartClockMs, setRestartClockMs] = React.useState(() => Date.now());
    const [partialApplicationNotice, setPartialApplicationNotice] =
        React.useState<PartialAuthSwitchApplicationNotice | null>(null);
    const [actionableState, setActionableState] =
        React.useState<SessionConnectedServicesAuthSwitchActionableState | null>(null);
    const [providerSessionDiagnosticActionState, setProviderSessionDiagnosticActionState] =
        React.useState<ProviderSessionUnavailableDiagnosticActionState>(null);

    const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedServiceId>>(() => (
        resolveAgentSupportedConnectedServiceIds({
            connectedServicesFeatureEnabled,
            agentCore: params.agentCore ?? {},
        })
    ), [connectedServicesFeatureEnabled, params.agentCore]);

    const profileOptionsByServiceId = React.useMemo(() => (
        buildConnectedServiceProfileOptionsByServiceId({
            accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
            agentCore: params.agentCore,
            supportedConnectedServiceIds,
            labelsByKey: params.settings.connectedServicesProfileLabelByKey,
        })
    ), [
        accountProfile,
        params.agentCore,
        params.settings.connectedServicesProfileLabelByKey,
        supportedConnectedServiceIds,
    ]);

    const groupOptionsByServiceId = React.useMemo(() => (
        buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled,
            accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
            supportedConnectedServiceIds,
        })
    ), [accountGroupsFeatureEnabled, accountProfile, supportedConnectedServiceIds]);

    const metadataBindingsByServiceId = React.useMemo(() => (
        readConnectedServicesBindingsFromMetadata(params.sessionMetadata, params.agentId ?? '')
    ), [params.agentId, params.sessionMetadata]);
    const [optimisticBindingsByServiceId, setOptimisticBindingsByServiceId] = React.useState(metadataBindingsByServiceId);
    const lastMetadataBindingsByServiceIdRef = React.useRef(metadataBindingsByServiceId);

    React.useEffect(() => {
        if (areBindingsEqual(lastMetadataBindingsByServiceIdRef.current, metadataBindingsByServiceId)) return;
        lastMetadataBindingsByServiceIdRef.current = metadataBindingsByServiceId;
        setOptimisticBindingsByServiceId((previousBindings) => (
            areBindingsEqual(previousBindings, metadataBindingsByServiceId)
                ? previousBindings
                : metadataBindingsByServiceId
        ));
    }, [metadataBindingsByServiceId]);

    const resolveProfileActionRoute = React.useCallback((serviceId: string, profileId: string) => {
        const profile = profileOptionsByServiceId[serviceId]?.find((option) => option.profileId === profileId);
        return profile?.kind === 'token'
            ? '/(app)/settings/connected-services/profile' as const
            : '/(app)/settings/connected-services/oauth' as const;
    }, [profileOptionsByServiceId]);

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding, options?: SetBindingForServiceOptions) => {
        const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
        const rematerializeServiceId = options?.rematerializeServiceId;
        if (!params.machineId || !agentId) return;
        if (!rematerializeServiceId && areServiceBindingsEqual(optimisticBindingsByServiceId[serviceId], binding)) return;
        if (!agentSupportsSessionAuthSwitchTransition({
            agentCore: params.agentCore,
            agentId: params.agentId,
            serviceId,
            current: optimisticBindingsByServiceId[serviceId],
            next: binding,
        })) return;
        const previousBindings = optimisticBindingsByServiceId;
        const nextBindings = {
            ...optimisticBindingsByServiceId,
            [serviceId]: binding,
        };
        const attemptId = switchAttemptIdRef.current + 1;
        switchAttemptIdRef.current = attemptId;
        const pendingRestartForAttempt = {
            attemptId,
            expectedBindingsByServiceId: {
                [serviceId]: binding,
            },
            timedOut: false,
        } satisfies SessionConnectedServicesAuthSwitchPendingRestart;
        setPendingRestart(null);
        setRestartRetryState(null);
        setManualRestartSignal(null);
        setPartialApplicationNotice(null);
        setActionableState(null);
        setProviderSessionDiagnosticActionState(null);
        setOptimisticBindingsByServiceId(nextBindings);

        const bindings = buildSessionSwitchPayload({
            supportedServiceIds: supportedConnectedServiceIds,
            bindingsByServiceId: nextBindings,
        });
        const expectedGroupGenerationByServiceId = buildExpectedGroupGenerationByServiceId({
            bindingsByServiceId: nextBindings,
            groupOptionsByServiceId,
        });
        void setSessionConnectedServiceAuthBinding({
            sessionId: params.sessionId,
            agentId,
            machineId: params.machineId,
            serverId: params.serverId ?? null,
            bindings,
            ...(rematerializeServiceId ? { rematerializeServiceId } : {}),
            ...(expectedGroupGenerationByServiceId ? { expectedGroupGenerationByServiceId } : {}),
        }).then((result) => {
            if (result.ok) {
                if (switchAttemptIdRef.current === attemptId) {
                    const nowMs = Date.now();
                    setRestartClockMs(nowMs);
                    setManualRestartSignal(result.action === 'restart_requested'
                        ? createManualAuthSwitchRestartSignal({ attemptId, startedAtMs: nowMs })
                        : null);
                    setPendingRestart(result.action === 'restart_requested' ? pendingRestartForAttempt : null);
                    setPartialApplicationNotice(null);
                    setActionableState(null);
                }
                return;
            }
            if (switchAttemptIdRef.current !== attemptId) return;
            setPendingRestart(null);
            setRestartRetryState(null);
            setManualRestartSignal(null);
            setPartialApplicationNotice(resolvePartialAuthSwitchApplicationNotice(result));
            setProviderSessionDiagnosticActionState(null);
            setOptimisticBindingsByServiceId(previousBindings);
            const nextActionableState = resolveSessionConnectedServiceAuthSwitchActionableState(result);
            if (nextActionableState) {
                setActionableState(nextActionableState);
                if (nextActionableState.kind === 'provider_session_state_unavailable_for_resume') {
                    const diagnostic = result.diagnostics?.uxDiagnostic;
                    if (diagnostic) {
                        setProviderSessionDiagnosticActionState({
                            diagnostic,
                            serviceId,
                            binding,
                            failureServiceId: result.serviceId ?? serviceId,
                        });
                        const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);
                        if (diagnosticPresentation) {
                            const failureServiceId = result.serviceId ?? serviceId;
                            const dismiss = () => {
                                setActionableState(null);
                                setProviderSessionDiagnosticActionState(null);
                            };
                            const diagnosticServiceId = resolveDiagnosticConnectedServiceId({
                                diagnostic,
                                fallbackServiceId: failureServiceId,
                            });
                            const diagnosticProfileId = readDiagnosticProfileId(diagnostic);
                            presentAuthSwitchDiagnosticAlert({
                                presentation: diagnosticPresentation,
                                retry: () => setBindingForService(serviceId, binding),
                                startFreshUnderSelectedAccount: diagnosticServiceId
                                    ? () => setBindingForService(serviceId, binding, { rematerializeServiceId: diagnosticServiceId })
                                    : undefined,
                                resumeCurrentAccount: dismiss,
                                openConnectedAccounts: () => router.push('/(app)/settings/connected-services'),
                                reconnectProfile: () => {
                                    if (diagnosticProfileId) {
                                        router.push({
                                            pathname: resolveProfileActionRoute(failureServiceId, diagnosticProfileId),
                                            params: {
                                                serviceId: failureServiceId,
                                                profileId: diagnosticProfileId,
                                            },
                                        });
                                        return;
                                    }
                                    router.push('/(app)/settings/connected-services');
                                },
                                enableStateSharing: () => router.push('/(app)/settings/connected-services/provider-state-sharing'),
                                dismiss,
                            });
                        }
                    }
                    return;
                }
                if ('route' in nextActionableState) {
                    router.push(nextActionableState.route);
                }
                return;
            }
            const diagnostic = result.diagnostics?.uxDiagnostic;
            const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);
            if (diagnosticPresentation) {
                const failureServiceId = result.serviceId ?? serviceId;
                const dismiss = () => {
                    setActionableState(null);
                    setProviderSessionDiagnosticActionState(null);
                };
                const diagnosticServiceId = resolveDiagnosticConnectedServiceId({
                    diagnostic,
                    fallbackServiceId: failureServiceId,
                });
                const diagnosticProfileId = readDiagnosticProfileId(diagnostic);
                presentAuthSwitchDiagnosticAlert({
                    presentation: diagnosticPresentation,
                    retry: () => setBindingForService(serviceId, binding),
                    startFreshUnderSelectedAccount: diagnosticServiceId
                        ? () => setBindingForService(serviceId, binding, { rematerializeServiceId: diagnosticServiceId })
                        : undefined,
                    resumeCurrentAccount: dismiss,
                    openConnectedAccounts: () => router.push('/(app)/settings/connected-services'),
                    reconnectProfile: () => {
                        if (diagnosticProfileId) {
                            router.push({
                                pathname: resolveProfileActionRoute(failureServiceId, diagnosticProfileId),
                                params: {
                                    serviceId: failureServiceId,
                                    profileId: diagnosticProfileId,
                                },
                            });
                            return;
                        }
                        router.push('/(app)/settings/connected-services');
                    },
                    enableStateSharing: () => router.push('/(app)/settings/connected-services/provider-state-sharing'),
                    dismiss,
                });
                return;
            }
            Modal.alert(
                t('common.error'),
                t(resolveSessionConnectedServiceAuthSwitchErrorMessageKey(result.errorCode)),
            );
        }).catch((error) => {
            if (switchAttemptIdRef.current !== attemptId) return;
            if (isNonTerminalRestartTimeoutError(error)) {
                const nowMs = Date.now();
                setRestartClockMs(nowMs);
                setManualRestartSignal(createManualAuthSwitchRestartSignal({ attemptId, startedAtMs: nowMs }));
                setPendingRestart({
                    ...pendingRestartForAttempt,
                    timedOut: true,
                });
                return;
            }
            setPendingRestart(null);
            setRestartRetryState(null);
            setManualRestartSignal(null);
            setPartialApplicationNotice(null);
            setActionableState(null);
            setProviderSessionDiagnosticActionState(null);
            setOptimisticBindingsByServiceId(previousBindings);
            Modal.alert(t('common.error'), t('connectedServices.authSwitch.switchFailed'));
        });
    }, [
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.agentId,
        params.agentCore,
        params.machineId,
        params.serverId,
        params.sessionId,
        resolveProfileActionRoute,
        router,
        supportedConnectedServiceIds,
    ]);

    const resolveOptionAvailability = React.useCallback((optionParams: Readonly<{
        serviceId: string;
        binding: ConnectedServicesServiceBinding;
    }>) => {
        const changesBinding = !areServiceBindingsEqual(optimisticBindingsByServiceId[optionParams.serviceId], optionParams.binding);
        if (!changesBinding) return {};
        if (!params.machineId) return { disabled: true };
        if (!agentSupportsSessionAuthSwitchTransition({
            agentCore: params.agentCore,
            agentId: params.agentId,
            serviceId: optionParams.serviceId,
            current: optimisticBindingsByServiceId[optionParams.serviceId],
            next: optionParams.binding,
        })) return { disabled: true };
        if (params.switchingDisabledReason) return { disabled: true };
        return {};
    }, [
        optimisticBindingsByServiceId,
        params.agentCore,
        params.agentId,
        params.machineId,
        params.switchingDisabledReason,
    ]);

    const popoverContent = React.useCallback(({ requestClose, maxHeight }: AgentInputContentPopoverRenderArgs) => (
        <NewSessionConnectedServicesSelectionContent
            supportedServiceIds={supportedConnectedServiceIds}
            profileOptionsByServiceId={profileOptionsByServiceId}
            groupOptionsByServiceId={groupOptionsByServiceId}
            bindingsByServiceId={optimisticBindingsByServiceId}
            setBindingForService={(serviceId, binding) => {
                requestClose();
                setBindingForService(serviceId, binding);
            }}
            defaultProfileIdByServiceId={params.settings.connectedServicesDefaultProfileByServiceId}
            resolveOptionAvailability={resolveOptionAvailability}
            onOpenSettings={() => {
                requestClose();
                router.push('/(app)/settings/connected-services');
            }}
            maxHeight={maxHeight}
        />
    ), [
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.settings.connectedServicesDefaultProfileByServiceId,
        profileOptionsByServiceId,
        resolveOptionAvailability,
        router,
        setBindingForService,
        supportedConnectedServiceIds,
    ]);

    const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        const label = resolveConnectedServicesAuthLabel({
            supportedServiceIds: supportedConnectedServiceIds,
            bindingsByServiceId: optimisticBindingsByServiceId,
            profileOptionsByServiceId,
            accountGroupOptionsByServiceId: groupOptionsByServiceId,
            accountGroupsEnabled: accountGroupsFeatureEnabled,
            defaultProfileIdByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
            resolveServiceTitle: (serviceId) => resolveConnectedServiceDisplayName(serviceId as ConnectedServiceId, t),
            nativeLabel: t('connectedServices.authChip.nativeLabel'),
            formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
        });

        return createConnectedServicesAuthActionChip({
            label: label.label,
            connectedCount: label.connectedCount,
            authSource: label.connectedCount === 0
                ? 'native'
                : label.connectedCount === supportedConnectedServiceIds.length
                    ? 'connected'
                    : 'mixed',
            popoverContent,
            maxHeightCap: 560,
            maxWidthCap: 560,
            testID: 'session-connected-services-auth-chip',
        });
    }, [
        accountGroupsFeatureEnabled,
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.settings.connectedServicesDefaultProfileByServiceId,
        popoverContent,
        profileOptionsByServiceId,
        supportedConnectedServiceIds,
    ]);

    React.useEffect(() => {
        if (!pendingRestart || params.sessionActive !== true) return;
        if (arePendingRestartBindingsApplied(pendingRestart, metadataBindingsByServiceId)) {
            setPendingRestart(null);
            setRestartRetryState(null);
            setManualRestartSignal(null);
            return;
        }
        if (pendingRestart.timedOut) {
            setPendingRestart(null);
            setManualRestartSignal(null);
            setOptimisticBindingsByServiceId(metadataBindingsByServiceId);
            setRestartRetryState({
                attemptId: pendingRestart.attemptId,
                expectedBindingsByServiceId: pendingRestart.expectedBindingsByServiceId,
            });
        }
    }, [metadataBindingsByServiceId, params.sessionActive, pendingRestart]);

    React.useEffect(() => {
        if (!restartRetryState) return;
        if (arePendingRestartBindingsApplied(restartRetryState, metadataBindingsByServiceId)) {
            setRestartRetryState(null);
            setManualRestartSignal(null);
        }
    }, [metadataBindingsByServiceId, restartRetryState]);

    React.useEffect(() => {
        if (!pendingRestart?.timedOut) return;
        const handle = setTimeout(() => {
            setPendingRestart((current) => {
                if (!current?.timedOut || current.attemptId !== pendingRestart.attemptId) {
                    return current;
                }
                setManualRestartSignal(null);
                setOptimisticBindingsByServiceId(metadataBindingsByServiceId);
                setRestartRetryState({
                    attemptId: current.attemptId,
                    expectedBindingsByServiceId: current.expectedBindingsByServiceId,
                });
                return null;
            });
        }, RESTART_TIMEOUT_RECONCILIATION_BUDGET_MS);
        return () => clearTimeout(handle);
    }, [metadataBindingsByServiceId, pendingRestart]);

    const restartState = React.useMemo(() => resolveSessionIntentionalRestartState({
        signals: [
            manualRestartSignal,
            ...(params.intentionalRestartSignals ?? []),
        ],
        nowMs: restartClockMs,
    }), [manualRestartSignal, params.intentionalRestartSignals, restartClockMs]);

    React.useEffect(() => {
        if (restartState?.status !== 'restarting') return undefined;
        const expiresAtMs = restartState.startedAtMs + SESSION_INTENTIONAL_RESTART_FAILSAFE_MS;
        const delayMs = Math.max(0, expiresAtMs - restartClockMs);
        const handle = setTimeout(() => {
            setRestartClockMs(Date.now());
        }, delayMs);
        return () => clearTimeout(handle);
    }, [restartClockMs, restartState]);

    const statusBadges = React.useMemo<ReadonlyArray<AgentInputStatusBadge>>(() => {
        if (actionableState?.kind === 'provider_session_state_unavailable_for_resume') {
            const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(actionableState.diagnostic);
            const providerDiagnosticActionState = providerSessionDiagnosticActionState;
            const dismiss = () => {
                setActionableState(null);
                setProviderSessionDiagnosticActionState(null);
            };
            const diagnosticServiceId = providerDiagnosticActionState
                ? resolveDiagnosticConnectedServiceId({
                    diagnostic: providerDiagnosticActionState.diagnostic,
                    fallbackServiceId: providerDiagnosticActionState.failureServiceId,
                })
                : undefined;
            const diagnosticProfileId = readDiagnosticProfileId(providerDiagnosticActionState?.diagnostic);
            const label = diagnosticPresentation
                ? t(diagnosticPresentation.statusKey)
                : t('connectedServices.authSwitch.switchFailed');
            return [{
                key: 'connected-services-auth-switch-retry-required',
                label,
                accessibilityLabel: label,
                testID: 'session-connected-services-auth-switch-retry-required',
                tone: 'warning',
                emphasis: 'prominent',
                ...(diagnosticPresentation && providerDiagnosticActionState
                    ? {
                        onPress: () => presentAuthSwitchDiagnosticAlert({
                            presentation: diagnosticPresentation,
                            retry: () => setBindingForService(
                                providerDiagnosticActionState.serviceId,
                                providerDiagnosticActionState.binding,
                            ),
                            startFreshUnderSelectedAccount: diagnosticServiceId
                                ? () => setBindingForService(
                                    providerDiagnosticActionState.serviceId,
                                    providerDiagnosticActionState.binding,
                                    { rematerializeServiceId: diagnosticServiceId },
                                )
                                : undefined,
                            resumeCurrentAccount: dismiss,
                            openConnectedAccounts: () => router.push('/(app)/settings/connected-services'),
                            reconnectProfile: () => {
                                if (diagnosticProfileId) {
                                    router.push({
                                        pathname: resolveProfileActionRoute(
                                            providerDiagnosticActionState.failureServiceId,
                                            diagnosticProfileId,
                                        ),
                                        params: {
                                            serviceId: providerDiagnosticActionState.failureServiceId,
                                            profileId: diagnosticProfileId,
                                        },
                                    });
                                    return;
                                }
                                router.push('/(app)/settings/connected-services');
                            },
                            enableStateSharing: () => router.push('/(app)/settings/connected-services/provider-state-sharing'),
                            dismiss,
                        }),
                    }
                    : {}),
            }];
        }
        return pendingRestart !== null
            ? [{
                key: 'connected-services-auth-switch-restarting',
                label: t('connectedServices.authSwitch.status.restarting'),
                accessibilityLabel: t('connectedServices.authSwitch.status.restarting'),
                testID: 'session-connected-services-auth-switch-restarting-status',
                tone: 'active',
                emphasis: 'prominent',
            }]
            : restartRetryState !== null
                ? [{
                    key: 'connected-services-auth-switch-retry',
                    label: t('connectedServices.authSwitch.status.retry'),
                    accessibilityLabel: t('connectedServices.authSwitch.status.retry'),
                    testID: 'session-connected-services-auth-switch-retry-status',
                    tone: 'warning',
                    emphasis: 'prominent',
                }]
                : buildPartialAuthSwitchApplicationStatusBadges(partialApplicationNotice);
    }, [
        actionableState,
        partialApplicationNotice,
        pendingRestart,
        providerSessionDiagnosticActionState,
        resolveProfileActionRoute,
        restartRetryState,
        router,
        setBindingForService,
    ]);

    return { connectedServicesAuthChip, statusBadges, restartState, actionableState };
}

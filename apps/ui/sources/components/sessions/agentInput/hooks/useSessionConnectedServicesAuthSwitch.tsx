import * as React from 'react';

import { useRouter } from 'expo-router';
import { readSessionMetadataConnectedServiceBindings } from '@happier-dev/agents';
import {
    ConnectedServiceIdSchema,
    type ConnectedServiceId,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';

import type { AgentInputExtraActionChip, AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import {
    NewSessionConnectedServicesSelectionContent,
} from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { resolveConnectedServiceDisplayName, resolveConnectedServiceShortName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServicesAuthLabel } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import {
    resolveConnectedServiceUxDiagnosticPresentation,
    translateConnectedServiceUxDiagnosticBody,
    type ConnectedServiceUxDiagnosticPresentation,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { buildConnectedServiceUxDiagnosticAlertButtons } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnosticAlertActions';
import {
    readConnectedServiceProfileKindFromServices,
    resolveConnectedServiceProfileActionRoute,
} from '@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    setSessionConnectedServiceAuthBinding,
    type SessionConnectedServiceAuthSwitchErrorCode,
    type SessionConnectedServiceAuthSwitchResult as DaemonSessionConnectedServiceAuthSwitchResult,
} from '@/sync/ops/connectedServices/sessionAuthSwitch';
import {
    type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import {
    buildConnectedServiceAccountGroupOptionsByServiceId,
    buildConnectedServiceProfileOptionsByServiceId,
    isConnectedServiceProfileOptionSelectable,
    resolveAgentSupportedConnectedServiceIds,
} from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { useProfile } from '@/sync/store/hooks';
import { t, type TranslationKey } from '@/text';
import {
    createManualAuthSwitchRestartSignal,
    resolveSessionIntentionalRestartState,
    SESSION_INTENTIONAL_RESTART_FAILSAFE_MS,
    type SessionIntentionalRestartSignal,
    type SessionIntentionalRestartState,
} from './sessionIntentionalRestartSignal';

type SessionConnectedServicesAuthSwitchDisabledReason =
    | 'active_turn'
    | 'read_only';

type ConnectedServicesAgentCore = Parameters<typeof resolveAgentSupportedConnectedServiceIds>[0]['agentCore'];

type ConnectedServicesBindingMap = Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;

type PartialAuthSwitchApplicationNotice = Readonly<{
    serviceIds: ReadonlyArray<ConnectedServiceId>;
    /** The service the user switched — the reconcile Retry/Revert re-applies against it. */
    primaryServiceId: string;
    /** Full binding-set that was attempted (used by Retry to re-converge on the target). */
    attemptedBindingsByServiceId: ConnectedServicesBindingMap;
    /** Full binding-set before the switch (used by Revert to re-converge on the previous account). */
    previousBindingsByServiceId: ConnectedServicesBindingMap;
}>;

export type SessionConnectedServicesAuthSwitchResult = Readonly<{
    connectedServicesAuthChip: AgentInputExtraActionChip | null;
    statusBadges: ReadonlyArray<AgentInputStatusBadge>;
    restartState: SessionConnectedServicesAuthSwitchRestartState;
    actionableState: SessionConnectedServicesAuthSwitchActionableState;
}>;

export const CONNECTED_SERVICES_AUTH_SWITCH_RESTART_FAILSAFE_MS = SESSION_INTENTIONAL_RESTART_FAILSAFE_MS;

export type SessionConnectedServicesAuthSwitchRestartState = SessionIntentionalRestartState;

type ConnectedServicesSettingsRoute = '/settings/connected-services';
type ConnectedServicesProviderStateSharingRoute = '/settings/connected-services/provider-state-sharing';
type ConnectedServicesProfileActionRoute = ReturnType<typeof resolveConnectedServiceProfileActionRoute>;

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
        translateConnectedServiceUxDiagnosticBody({
            presentation: params.presentation,
            translate: t,
        }),
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
        if (parsed.success) return parsed.data;
    }
    return undefined;
}

function readDiagnosticProfileId(diagnostic: ConnectedServiceUxDiagnosticV1 | null | undefined): string | null {
    const profileId = diagnostic?.profileId;
    return typeof profileId === 'string' && profileId.trim() ? profileId.trim() : null;
}

export type SessionConnectedServicesAuthSwitchActionableState =
    | Readonly<{
        kind: 'provider_state_sharing_required';
        serviceId: string;
        route: ConnectedServicesProviderStateSharingRoute;
    }>
    | Readonly<{
        kind: 'reconnect_profile';
        serviceId: string;
        profileId: string;
        route: ConnectedServicesProfileActionRoute;
    }>
    | Readonly<{
        kind: 'connected_service_required' | 'not_group_selection' | 'profile_action_required';
        serviceId: string;
        profileId?: string;
        route: ConnectedServicesSettingsRoute;
    }>
    | Readonly<{
        kind: 'provider_session_state_unavailable_for_resume';
        serviceId: string;
        recovery: 'retry_required';
        diagnostic?: ConnectedServiceUxDiagnosticV1;
    }>
    | null;

type ProviderSessionUnavailableDiagnosticActionState = Readonly<{
    diagnostic: ConnectedServiceUxDiagnosticV1;
    serviceId: string;
    binding: ConnectedServicesServiceBinding;
    failureServiceId: string;
}> | null;

type SetBindingForServiceOptions = Readonly<{
    rematerializeServiceId?: ConnectedServiceId;
    /** Skip the "switch session authentication?" confirm — used by reconcile Retry/Revert (the user already chose the action). */
    skipConfirm?: boolean;
    /** Re-apply even when the target equals the current optimistic binding — used by Revert to reconverge a diverged live session. */
    forceReapply?: boolean;
}>;

function resolveSessionConnectedServiceAuthSwitchErrorMessageKey(
    errorCode: SessionConnectedServiceAuthSwitchErrorCode | undefined,
): TranslationKey {
    switch (errorCode) {
        case 'group_generation_conflict':
            return 'connectedServices.authSwitch.errors.groupGenerationConflict';
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

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function resolvePartialAuthSwitchApplicationNotice(
    result: DaemonSessionConnectedServiceAuthSwitchResult | null | undefined,
    reconcile: Readonly<{
        primaryServiceId: string;
        attemptedBindingsByServiceId: ConnectedServicesBindingMap;
        previousBindingsByServiceId: ConnectedServicesBindingMap;
    }>,
): PartialAuthSwitchApplicationNotice | null {
    if (!result || result.ok) return null;
    const serviceResultsByServiceId = result.diagnostics?.serviceResultsByServiceId;
    if (serviceResultsByServiceId) {
        const hasAppliedService = Object.values(serviceResultsByServiceId)
            .some((serviceResult) => serviceResult.status === 'applied');
        const incompleteServiceIds = Object.entries(serviceResultsByServiceId).flatMap(([serviceId, serviceResult]) => {
            if (serviceResult.status === 'applied') return [];
            const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
            return parsed.success ? [parsed.data] : [];
        });
        if (hasAppliedService && incompleteServiceIds.length > 0) {
            return { serviceIds: incompleteServiceIds, ...reconcile };
        }
    }
    return result.diagnostics?.partialState === 'runtime_auth_partially_applied'
        ? { serviceIds: [], ...reconcile }
        : null;
}

function readBinding(value: unknown): ConnectedServicesServiceBinding | null {
    const raw = readRecord(value);
    if (!raw) return null;
    const source = raw.source === 'connected'
        ? 'connected'
        : raw.source === 'native'
            ? 'native'
            : null;
    if (!source) return null;

    const selection = raw.selection === 'group'
        ? 'group'
        : raw.selection === 'profile'
            ? 'profile'
            : undefined;
    const profileId = typeof raw.profileId === 'string' && raw.profileId.trim()
        ? raw.profileId.trim()
        : undefined;
    const groupId = typeof raw.groupId === 'string' && raw.groupId.trim()
        ? raw.groupId.trim()
        : undefined;

    if (source === 'native') return { source: 'native' };
    if (selection === 'group' && groupId) {
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

function buildSessionSwitchPayload(params: Readonly<{
    supportedServiceIds: ReadonlyArray<ConnectedServiceId>;
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
}>): ConnectedServiceBindingsV1 {
    const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV1> = {};

    for (const serviceId of params.supportedServiceIds) {
        const binding = params.bindingsByServiceId[serviceId] ?? { source: 'native' };
        bindingsByServiceId[serviceId] = binding;
    }

    return {
        v: 1,
        bindingsByServiceId,
    };
}

function buildExpectedGroupGenerationByServiceId(params: Readonly<{
    bindingsByServiceId: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>;
    accountGroupOptionsByServiceId: Readonly<Record<string, ReadonlyArray<{ groupId: string; generation?: number }>>>;
}>): Readonly<Record<string, number>> | undefined {
    const out: Record<string, number> = {};
    for (const [serviceId, binding] of Object.entries(params.bindingsByServiceId)) {
        if (binding?.source !== 'connected' || binding.selection !== 'group' || !binding.groupId) continue;
        const group = params.accountGroupOptionsByServiceId[serviceId]?.find((candidate) =>
            candidate.groupId === binding.groupId
        );
        if (typeof group?.generation === 'number' && Number.isInteger(group.generation) && group.generation >= 0) {
            out[serviceId] = group.generation;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function resolveDisabledSubtitle(reason: SessionConnectedServicesAuthSwitchDisabledReason): string {
    return t('connectedServices.authSwitch.readOnlyDisabled');
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
    agentId: string;
    serviceId: string;
    current: ConnectedServicesServiceBinding | undefined;
    next: ConnectedServicesServiceBinding;
}>): boolean {
    const switchCapability = input.agentCore.connectedServices?.sessionAuthSwitch;
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
    agentId: string;
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
    const router = useRouter();
    const accountProfile = useProfile();
    const connectedServicesFeatureEnabled = useFeatureEnabled('connectedServices', {
        scopeKind: 'spawn',
        serverId: params.serverId ?? null,
    });
    const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', {
        scopeKind: 'spawn',
        serverId: params.serverId ?? null,
    });
    const switchAttemptIdRef = React.useRef(0);
    const [manualRestartSignal, setManualRestartSignal] = React.useState<SessionIntentionalRestartSignal | null>(null);
    const [manualRestartExpectedBindingsByServiceId, setManualRestartExpectedBindingsByServiceId] = React.useState<Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> | null>(null);
    const [restartClockMs, setRestartClockMs] = React.useState(() => Date.now());
    const [actionableState, setActionableState] = React.useState<SessionConnectedServicesAuthSwitchActionableState>(null);
    const [providerSessionDiagnosticActionState, setProviderSessionDiagnosticActionState] =
        React.useState<ProviderSessionUnavailableDiagnosticActionState>(null);
    const [metadataUpdatedNoticeVisible, setMetadataUpdatedNoticeVisible] = React.useState(false);
    const [partialApplicationNotice, setPartialApplicationNotice] = React.useState<PartialAuthSwitchApplicationNotice | null>(null);

    const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedServiceId>>(() => {
        return resolveAgentSupportedConnectedServiceIds({
            connectedServicesFeatureEnabled,
            agentCore: params.agentCore,
        });
    }, [connectedServicesFeatureEnabled, params.agentCore]);

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

    const accountGroupOptionsByServiceId = React.useMemo(() => (
        buildConnectedServiceAccountGroupOptionsByServiceId({
            accountGroupsFeatureEnabled,
            accountProfileConnectedServicesV2: accountProfile?.connectedServicesV2 ?? [],
            supportedConnectedServiceIds,
        })
    ), [accountGroupsFeatureEnabled, accountProfile, supportedConnectedServiceIds]);

    const metadataBindingsByServiceId = React.useMemo(() => (
        readConnectedServicesBindingsFromMetadata(params.sessionMetadata, params.agentId)
    ), [params.agentId, params.sessionMetadata]);
    const [optimisticBindingsByServiceId, setOptimisticBindingsByServiceId] = React.useState(metadataBindingsByServiceId);
    const lastMetadataBindingsByServiceIdRef = React.useRef(metadataBindingsByServiceId);

    const labelProfileOptionsByServiceId = React.useMemo(() => {
        const next: Record<string, (typeof profileOptionsByServiceId)[string]> = {};
        for (const [serviceId, options] of Object.entries(profileOptionsByServiceId)) {
            const binding = optimisticBindingsByServiceId[serviceId];
            if (binding?.source !== 'connected' || binding.selection === 'group' || !binding.profileId) {
                next[serviceId] = options;
                continue;
            }
            next[serviceId] = options.map((option) => (
                option.profileId === binding.profileId && !isConnectedServiceProfileOptionSelectable(option)
                    ? { ...option, status: 'connected' as const }
                    : option
            ));
        }
        return next;
    }, [optimisticBindingsByServiceId, profileOptionsByServiceId]);

    const resolveProfileActionRoute = React.useCallback((serviceId: string, profileId: string) => {
        const profile = profileOptionsByServiceId[serviceId]?.find((option) => option.profileId === profileId);
        const profileKind = readConnectedServiceProfileKindFromServices({
            connectedServicesV2: accountProfile?.connectedServicesV2 ?? null,
            serviceId,
            profileId,
        }) ?? profile?.kind;
        return resolveConnectedServiceProfileActionRoute({
            serviceId,
            profileId,
            profileKind,
        });
    }, [accountProfile?.connectedServicesV2, profileOptionsByServiceId]);

    React.useEffect(() => {
        if (areBindingsEqual(lastMetadataBindingsByServiceIdRef.current, metadataBindingsByServiceId)) {
            return;
        }
        lastMetadataBindingsByServiceIdRef.current = metadataBindingsByServiceId;
        setOptimisticBindingsByServiceId((previousBindings) => (
            areBindingsEqual(previousBindings, metadataBindingsByServiceId)
                ? previousBindings
                : metadataBindingsByServiceId
        ));
    }, [metadataBindingsByServiceId]);

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding, options?: SetBindingForServiceOptions) => {
        const machineId = params.machineId;
        const rematerializeServiceId = options?.rematerializeServiceId;
        const forceReapply = options?.forceReapply ?? false;
        if (!machineId) return;
        if (!forceReapply && !rematerializeServiceId && areServiceBindingsEqual(optimisticBindingsByServiceId[serviceId], binding)) return;
        if (!forceReapply && !agentSupportsSessionAuthSwitchTransition({
            agentCore: params.agentCore,
            agentId: params.agentId,
            serviceId,
            current: optimisticBindingsByServiceId[serviceId],
            next: binding,
        })) return;
        void (async () => {
            if (!options?.skipConfirm && params.sessionActive !== false) {
                const confirmed = await Modal.confirm(
                    t('connectedServices.authSwitch.confirmTitle'),
                    t('connectedServices.authSwitch.confirmBody'),
                    { confirmText: t('connectedServices.authSwitch.confirmAction') },
                );
                if (!confirmed) return;
            }

            const previousBindings = optimisticBindingsByServiceId;
            const nextBindings = {
                ...optimisticBindingsByServiceId,
                [serviceId]: binding,
            };
            const attemptId = switchAttemptIdRef.current + 1;
            switchAttemptIdRef.current = attemptId;
            setManualRestartSignal(null);
            setManualRestartExpectedBindingsByServiceId(null);
            setActionableState(null);
            setProviderSessionDiagnosticActionState(null);
            setMetadataUpdatedNoticeVisible(false);
            setPartialApplicationNotice(null);
            setOptimisticBindingsByServiceId(nextBindings);

            const bindings = buildSessionSwitchPayload({
                supportedServiceIds: supportedConnectedServiceIds,
                bindingsByServiceId: nextBindings,
            });
            const expectedGroupGenerationByServiceId = buildExpectedGroupGenerationByServiceId({
                bindingsByServiceId: nextBindings,
                accountGroupOptionsByServiceId,
            });
            const result = await setSessionConnectedServiceAuthBinding({
                sessionId: params.sessionId,
                agentId: params.agentId,
                machineId,
                serverId: params.serverId ?? null,
                bindings,
                ...(rematerializeServiceId ? { rematerializeServiceId } : {}),
                ...(expectedGroupGenerationByServiceId
                    ? { expectedGroupGenerationByServiceId }
                    : {}),
            }).catch(() => null);
            if (result?.ok) {
                if (switchAttemptIdRef.current === attemptId) {
                    const nowMs = Date.now();
                    setRestartClockMs(nowMs);
                    setManualRestartSignal(result.action === 'restart_requested'
                        ? createManualAuthSwitchRestartSignal({ attemptId, startedAtMs: nowMs })
                        : null);
                    setManualRestartExpectedBindingsByServiceId(result.action === 'restart_requested'
                        ? nextBindings
                        : null);
                    setMetadataUpdatedNoticeVisible(result.action === 'metadata_updated');
                }
                return;
            }
            if (switchAttemptIdRef.current !== attemptId) return;
            setManualRestartSignal(null);
            setManualRestartExpectedBindingsByServiceId(null);
            setMetadataUpdatedNoticeVisible(false);
            const partialNotice = resolvePartialAuthSwitchApplicationNotice(result, {
                primaryServiceId: serviceId,
                attemptedBindingsByServiceId: nextBindings,
                previousBindingsByServiceId: previousBindings,
            });
            setPartialApplicationNotice(partialNotice);
            setProviderSessionDiagnosticActionState(null);
            setOptimisticBindingsByServiceId(previousBindings);
            if (result?.errorCode === 'provider_state_sharing_required') {
                const providerStateSharingRoute: ConnectedServicesProviderStateSharingRoute = '/settings/connected-services/provider-state-sharing';
                setActionableState({
                    kind: 'provider_state_sharing_required',
                    serviceId: result.serviceId ?? serviceId,
                    route: providerStateSharingRoute,
                });
                const openSettings = await Modal.confirm(
                    t('connectedServices.providerStateSharing.title'),
                    t('connectedServices.providerStateSharing.stateDisabledSubtitle'),
                    { confirmText: t('modals.openSettings') },
                );
                if (openSettings) {
                    router.push(providerStateSharingRoute);
                }
                return;
            }
            const failureServiceId = result?.serviceId ?? serviceId;
            const actionRequired = result?.diagnostics?.actionRequired;
            if (result?.errorCode === 'profile_action_required' && actionRequired?.kind === 'reconnect_profile' && actionRequired.profileId) {
                const route = resolveProfileActionRoute(failureServiceId, actionRequired.profileId);
                setActionableState({
                    kind: 'reconnect_profile',
                    serviceId: failureServiceId,
                    profileId: actionRequired.profileId,
                    route,
                });
                router.push(route);
                return;
            }
            if (
                result?.errorCode === 'connected_service_required'
                || result?.errorCode === 'not_group_selection'
                || result?.errorCode === 'profile_action_required'
            ) {
                const route: ConnectedServicesSettingsRoute = '/settings/connected-services';
                setActionableState({
                    kind: result.errorCode,
                    serviceId: failureServiceId,
                    ...(actionRequired?.profileId ? { profileId: actionRequired.profileId } : {}),
                    route,
                });
                router.push(route);
                return;
            }
            if (result?.errorCode === 'provider_session_state_unavailable_for_resume') {
                const diagnostic = result.diagnostics?.uxDiagnostic;
                setActionableState({
                    kind: 'provider_session_state_unavailable_for_resume',
                    serviceId: failureServiceId,
                    recovery: 'retry_required',
                    ...(diagnostic ? { diagnostic } : {}),
                });
                if (diagnostic) {
                    setProviderSessionDiagnosticActionState({
                        diagnostic,
                        serviceId,
                        binding,
                        failureServiceId,
                    });
                    const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);
                    if (diagnosticPresentation) {
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
                            openConnectedAccounts: () => router.push('/settings/connected-services'),
                            reconnectProfile: () => {
                                if (diagnosticProfileId) {
                                    router.push(resolveProfileActionRoute(failureServiceId, diagnosticProfileId));
                                    return;
                                }
                                router.push('/settings/connected-services');
                            },
                            enableStateSharing: () => router.push('/settings/connected-services/provider-state-sharing'),
                            dismiss,
                        });
                    }
                }
                return;
            }
            const diagnostic = result?.diagnostics?.uxDiagnostic;
            const diagnosticPresentation = resolveConnectedServiceUxDiagnosticPresentation(diagnostic);
            if (diagnosticPresentation) {
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
                    openConnectedAccounts: () => router.push('/settings/connected-services'),
                    reconnectProfile: () => {
                        if (diagnosticProfileId) {
                            router.push(resolveProfileActionRoute(failureServiceId, diagnosticProfileId));
                            return;
                        }
                        router.push('/settings/connected-services');
                    },
                    enableStateSharing: () => router.push('/settings/connected-services/provider-state-sharing'),
                    dismiss,
                });
                return;
            }
            if (result?.diagnostics?.accountSettingsFreshness?.status === 'failed') {
                Modal.alert(
                    t('common.error'),
                    t('connectedServices.authSwitch.errors.accountSettingsRefreshFailed'),
                );
                return;
            }
            // A partial hot-apply is surfaced by the actionable Retry/Revert status badge
            // (the session-scope mirror of the pool divergence surface). Suppress the generic
            // one-shot error alert so the failure is not double-surfaced and stays recoverable.
            if (partialNotice) return;
            Modal.alert(
                t('common.error'),
                t(resolveSessionConnectedServiceAuthSwitchErrorMessageKey(result?.errorCode)),
            );
        })();
    }, [
        accountGroupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.agentId,
        params.agentCore,
        params.machineId,
        params.serverId,
        params.sessionActive,
        params.sessionId,
        params.settings.connectedServicesProviderStateSharingSettingsV1,
        resolveProfileActionRoute,
        router,
        supportedConnectedServiceIds,
    ]);

    /**
     * Session-scope reconcile for a partial hot-apply — the mirror of the pool-level
     * Retry/Revert divergence surface (PoolDetailView `manualApplyDivergence`). Both
     * actions re-run the canonical {@link setBindingForService} apply path (never a
     * parallel apply): Retry re-converges the running session on the attempted account,
     * Revert re-converges it on the previous account. `forceReapply` is required for
     * Revert because the optimistic binding was already reset to the previous account
     * on the failed attempt, so a plain re-apply would be a no-op while the live session
     * may still be diverged.
     */
    const handlePartialApplicationReconcile = React.useCallback(() => {
        const notice = partialApplicationNotice;
        if (!notice) return;
        const serviceId = notice.primaryServiceId;
        const attemptedBinding = notice.attemptedBindingsByServiceId[serviceId];
        const previousBinding = notice.previousBindingsByServiceId[serviceId] ?? { source: 'native' };
        Modal.alert(
            t('connectedServices.authSwitch.partialApply.title'),
            t('connectedServices.authSwitch.partialApply.body'),
            [
                ...(attemptedBinding ? [{
                    text: t('connectedServices.authSwitch.partialApply.retry'),
                    onPress: () => setBindingForService(serviceId, attemptedBinding, { skipConfirm: true, forceReapply: true }),
                }] : []),
                {
                    text: t('connectedServices.authSwitch.partialApply.revert'),
                    onPress: () => setBindingForService(serviceId, previousBinding, { skipConfirm: true, forceReapply: true }),
                },
                { text: t('common.cancel'), style: 'cancel' as const },
            ],
        );
    }, [partialApplicationNotice, setBindingForService]);

    const resolveOptionAvailability = React.useCallback((optionParams: Readonly<{
        serviceId: string;
        binding: ConnectedServicesServiceBinding;
    }>) => {
        if (
            !params.machineId
            && !areServiceBindingsEqual(optimisticBindingsByServiceId[optionParams.serviceId], optionParams.binding)
        ) {
            return { disabled: true };
        }
        if (
            !agentSupportsSessionAuthSwitchTransition({
                agentCore: params.agentCore,
                agentId: params.agentId,
                serviceId: optionParams.serviceId,
                current: optimisticBindingsByServiceId[optionParams.serviceId],
                next: optionParams.binding,
            })
            && !areServiceBindingsEqual(optimisticBindingsByServiceId[optionParams.serviceId], optionParams.binding)
        ) {
            return { disabled: true };
        }
        if (!params.switchingDisabledReason) return {};
        if (areServiceBindingsEqual(optimisticBindingsByServiceId[optionParams.serviceId], optionParams.binding)) {
            return {};
        }
        if (params.switchingDisabledReason === 'active_turn') {
            return {};
        }
        return {
            disabled: true,
            subtitle: resolveDisabledSubtitle(params.switchingDisabledReason),
        };
    }, [
        optimisticBindingsByServiceId,
        params.agentCore,
        params.agentId,
        params.machineId,
        params.settings.connectedServicesProviderStateSharingSettingsV1,
        params.switchingDisabledReason,
    ]);

    const popoverContent = React.useCallback(({ requestClose, maxHeight }: AgentInputContentPopoverRenderArgs) => (
        <NewSessionConnectedServicesSelectionContent
            supportedServiceIds={supportedConnectedServiceIds}
            profileOptionsByServiceId={profileOptionsByServiceId}
            accountGroupOptionsByServiceId={accountGroupOptionsByServiceId}
            bindingsByServiceId={optimisticBindingsByServiceId}
            setBindingForService={(serviceId, binding) => {
                requestClose();
                setBindingForService(serviceId, binding);
            }}
            defaultProfileIdByServiceId={params.settings.connectedServicesDefaultProfileByServiceId}
            resolveOptionAvailability={resolveOptionAvailability}
            onOpenSettings={(serviceId) => {
                requestClose();
                router.push({
                    pathname: '/settings/connected-services/[serviceId]',
                    params: { serviceId },
                });
            }}
            onReconnectProfile={(serviceId, profileId) => {
                requestClose();
                router.push(resolveProfileActionRoute(serviceId, profileId));
            }}
            maxHeight={maxHeight}
        />
    ), [
        accountGroupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.settings.connectedServicesDefaultProfileByServiceId,
        profileOptionsByServiceId,
        resolveOptionAvailability,
        resolveProfileActionRoute,
        router,
        setBindingForService,
        supportedConnectedServiceIds,
    ]);

    const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        const label = resolveConnectedServicesAuthLabel({
            supportedServiceIds: supportedConnectedServiceIds,
            bindingsByServiceId: optimisticBindingsByServiceId,
            profileOptionsByServiceId: labelProfileOptionsByServiceId,
            accountGroupOptionsByServiceId,
            defaultProfileIdByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
            resolveServiceTitle: (serviceId) => resolveConnectedServiceShortName(serviceId as ConnectedServiceId, t),
            nativeLabel: t('connectedServices.authChip.nativeLabel'),
            formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
        });

        return createConnectedServicesAuthActionChip({
            key: 'session-connected-services-auth',
            testID: 'session-connected-services-auth-chip',
            label: label.label,
            authSource: label.connectedCount > 0 ? 'connected' : 'native',
            connectedCount: label.connectedCount,
            popoverContent,
            maxHeightCap: 560,
            maxWidthCap: 560,
        });
    }, [
        accountGroupOptionsByServiceId,
        labelProfileOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.settings.connectedServicesDefaultProfileByServiceId,
        popoverContent,
        supportedConnectedServiceIds,
    ]);

    React.useEffect(() => {
        if (
            params.sessionActive === true
            && (
                !manualRestartExpectedBindingsByServiceId
                || areBindingsEqual(metadataBindingsByServiceId, manualRestartExpectedBindingsByServiceId)
            )
        ) {
            setManualRestartSignal(null);
            setManualRestartExpectedBindingsByServiceId(null);
            setMetadataUpdatedNoticeVisible(false);
        }
    }, [manualRestartExpectedBindingsByServiceId, metadataBindingsByServiceId, params.sessionActive]);

    const restartState = React.useMemo(() => resolveSessionIntentionalRestartState({
        signals: [
            manualRestartSignal,
            ...(params.intentionalRestartSignals ?? []),
        ],
        nowMs: restartClockMs,
    }), [manualRestartSignal, params.intentionalRestartSignals, restartClockMs]);

    React.useEffect(() => {
        if (restartState?.status !== 'restarting') return undefined;
        const expiresAtMs = restartState.startedAtMs + CONNECTED_SERVICES_AUTH_SWITCH_RESTART_FAILSAFE_MS;
        const delayMs = Math.max(0, expiresAtMs - restartClockMs);
        const timeoutId = setTimeout(() => {
            setRestartClockMs(Date.now());
        }, delayMs);
        return () => clearTimeout(timeoutId);
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
            return [{
                key: 'connected-services-auth-switch-retry-required',
                label: diagnosticPresentation
                    ? t(diagnosticPresentation.statusKey)
                    : t('connectedServices.authSwitch.switchFailed'),
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
                            openConnectedAccounts: () => router.push('/settings/connected-services'),
                            reconnectProfile: () => {
                                if (diagnosticProfileId) {
                                    router.push(resolveProfileActionRoute(
                                        providerDiagnosticActionState.failureServiceId,
                                        diagnosticProfileId,
                                    ));
                                    return;
                                }
                                router.push('/settings/connected-services');
                            },
                            enableStateSharing: () => router.push('/settings/connected-services/provider-state-sharing'),
                            dismiss,
                        }),
                    }
                    : {}),
            }];
        }
        if (partialApplicationNotice) {
            if (partialApplicationNotice.serviceIds.length > 0) {
                return partialApplicationNotice.serviceIds.map((serviceId) => ({
                    key: `connected-services-auth-switch-partial-application-${serviceId}`,
                    label: t('connectedServices.authSwitch.status.partialApplicationForService', {
                        service: resolveConnectedServiceDisplayName(serviceId, t),
                    }),
                    testID: `session-connected-services-auth-switch-partial-application-${serviceId}`,
                    tone: 'warning',
                    emphasis: 'prominent',
                    onPress: handlePartialApplicationReconcile,
                }));
            }
            return [{
                key: 'connected-services-auth-switch-partial-application',
                label: t('connectedServices.authSwitch.status.partialApplication'),
                testID: 'session-connected-services-auth-switch-partial-application',
                tone: 'warning',
                emphasis: 'prominent',
                onPress: handlePartialApplicationReconcile,
            }];
        }
        if (!metadataUpdatedNoticeVisible) return [];
        return [{
            key: 'connected-services-auth-switch-pending-resume',
            label: t('connectedServices.authSwitch.status.appliesOnNextResume'),
            testID: 'session-connected-services-auth-switch-pending-resume',
            tone: 'complete',
            emphasis: 'quiet',
        }];
    }, [
        actionableState,
        handlePartialApplicationReconcile,
        metadataUpdatedNoticeVisible,
        partialApplicationNotice,
        providerSessionDiagnosticActionState,
        resolveProfileActionRoute,
        router,
        setBindingForService,
    ]);

    return { connectedServicesAuthChip, statusBadges, restartState, actionableState };
}

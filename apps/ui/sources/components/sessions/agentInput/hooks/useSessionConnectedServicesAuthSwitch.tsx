import * as React from 'react';
import { useRouter } from 'expo-router';

import type {
    ConnectedAccountServiceKey,
    ConnectedServiceBindingSelectionV1,
    ConnectedServiceBindingsV1,
    ConnectedServiceUxDiagnosticV1,
    PluginProjectedAgentConnectedAccountPurposeV2,
} from '@happier-dev/protocol';
import {
    ConnectedAccountServiceKeySchema,
    parseQualifiedPluginContributionKey,
} from '@happier-dev/protocol';

import type { AgentInputExtraActionChip, AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import {
    resolveConnectedServiceUxDiagnosticPresentation,
    type ConnectedServiceUxDiagnosticPresentation,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { buildConnectedServiceUxDiagnosticAlertButtons } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnosticAlertActions';
import {
    resolveConnectedServiceProfileActionRoute,
} from '@/sync/domains/connectedServices/resolveConnectedServiceProfileActionRoute';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServicesAuthLabel } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import {
    applyProjectedCredentialKindRestrictions,
    buildQualifiedConnectedAccountGroupOptionsByServiceId,
    buildQualifiedConnectedAccountProfileOptionsByServiceId,
    resolveProjectedConnectedAccountServiceKeys,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
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
    rematerializeServiceId?: ConnectedAccountServiceKey;
    /** The user already confirmed this exact Retry/Revert action. */
    skipConfirm?: boolean;
    /**
     * Re-apply even when the target equals the current optimistic binding — used
     * by the partial hot-apply Revert: the optimistic binding was already reset
     * to the previous account on the failed attempt, so a plain re-apply would be
     * a no-op while the live session may still be diverged.
     */
    forceReapply?: boolean;
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
        t(params.presentation.bodyKey),
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
}>): ConnectedAccountServiceKey | undefined {
    const candidates = [
        params.diagnostic?.serviceId,
        params.fallbackServiceId,
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const parsed = ConnectedAccountServiceKeySchema.safeParse(candidate.trim());
        if (parsed.success) return parsed.data;
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

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
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
    supportedServiceIds: ReadonlyArray<ConnectedAccountServiceKey>;
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

export function useSessionConnectedServicesAuthSwitch(params: Readonly<{
    sessionId: string;
    agentId: string | null | undefined;
    machineId: string | null | undefined;
    serverId?: string | null;
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
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
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
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

    const supportedConnectedServiceIds = React.useMemo<ReadonlyArray<ConnectedAccountServiceKey>>(
        () => resolveProjectedConnectedAccountServiceKeys(params.connectedAccounts),
        [params.connectedAccounts],
    );

    const profileOptionsByServiceId = React.useMemo(() => (
        applyProjectedCredentialKindRestrictions({
            optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
            accounts: accountProfile?.connectedAccountsV4 ?? [],
            supportedServiceIds: supportedConnectedServiceIds,
            labelsByKey: params.settings.connectedServicesProfileLabelByKey,
            }),
            connectedAccounts: params.connectedAccounts,
        })
    ), [accountProfile?.connectedAccountsV4, params.connectedAccounts, params.settings.connectedServicesProfileLabelByKey, supportedConnectedServiceIds]);

    const groupOptionsByServiceId = React.useMemo(() => (
        buildQualifiedConnectedAccountGroupOptionsByServiceId({
            groups: accountProfile?.connectedAccountGroupsV4 ?? [],
            supportedServiceIds: supportedConnectedServiceIds,
        })
    ), [accountProfile?.connectedAccountGroupsV4, supportedConnectedServiceIds]);

    const metadataBindingsByServiceId = React.useMemo<Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>>(() => (
        readSessionConnectedServiceBindings({
            metadata: params.sessionMetadata,
            agentId: params.agentId ?? '',
        })?.bindingsByServiceId ?? {}
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

    const resolveProfileActionRoute = React.useCallback(
        (serviceId: string, profileId?: string) => resolveConnectedServiceProfileActionRoute(
            { serviceId, profileId },
            connectedServicesRegistry.entries,
        ),
        [connectedServicesRegistry.entries],
    );

    const setBindingForService = React.useCallback((serviceId: string, binding: ConnectedServicesServiceBinding, options?: SetBindingForServiceOptions) => {
        const agentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
        const machineId = params.machineId;
        const rematerializeServiceId = options?.rematerializeServiceId;
        const forceReapply = options?.forceReapply ?? false;
        if (!machineId || !agentId) return;
        if (!forceReapply && !rematerializeServiceId && areServiceBindingsEqual(optimisticBindingsByServiceId[serviceId], binding)) return;
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
            machineId,
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
            const partialNotice = resolvePartialAuthSwitchApplicationNotice(result, {
                primaryServiceId: serviceId,
                attemptedBindingsByServiceId: nextBindings,
                previousBindingsByServiceId: previousBindings,
            });
            setPartialApplicationNotice(partialNotice);
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
                                        router.push(resolveProfileActionRoute(
                                            failureServiceId,
                                            diagnosticProfileId,
                                        ));
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
                if (nextActionableState.kind === 'reconnect_profile') {
                    router.push(resolveProfileActionRoute(
                        result.serviceId ?? serviceId,
                        nextActionableState.profileId,
                    ));
                } else if ('route' in nextActionableState) {
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
                            router.push(resolveProfileActionRoute(
                                failureServiceId,
                                diagnosticProfileId,
                            ));
                            return;
                        }
                        router.push('/(app)/settings/connected-services');
                    },
                    enableStateSharing: () => router.push('/(app)/settings/connected-services/provider-state-sharing'),
                    dismiss,
                });
                return;
            }
            // A partial hot-apply is surfaced by the actionable Retry/Revert status
            // badge (the session-scope mirror of the pool divergence surface).
            // Suppress the generic one-shot error alert so the failure is not
            // double-surfaced and stays recoverable.
            if (partialNotice) return;
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
        })();
    }, [
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.agentId,
        params.machineId,
        params.serverId,
        params.sessionId,
        params.sessionActive,
        resolveProfileActionRoute,
        router,
        supportedConnectedServiceIds,
    ]);

    /**
     * Session-scope reconcile for a partial hot-apply — the mirror of the pool-level
     * Retry/Revert divergence surface. Both actions re-run the canonical
     * {@link setBindingForService} apply path (never a parallel apply): Retry
     * re-converges the running session on the attempted account, Revert re-converges
     * it on the previous account. `forceReapply` is required because the optimistic
     * bindings were already reset to the previous account on the failed attempt, so
     * a plain re-apply would be a no-op while the live session may still be diverged.
     */
    const handlePartialApplicationReconcile = React.useCallback(() => {
        const notice = partialApplicationNotice;
        if (!notice) return;
        const serviceId = notice.primaryServiceId;
        const attemptedBinding = notice.attemptedBindingsByServiceId[serviceId];
        const previousBinding = notice.previousBindingsByServiceId[serviceId] ?? { source: 'native' as const };
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
        const changesBinding = !areServiceBindingsEqual(optimisticBindingsByServiceId[optionParams.serviceId], optionParams.binding);
        if (!changesBinding) return {};
        if (!params.machineId) return { disabled: true };
        if (params.switchingDisabledReason) return { disabled: true };
        return {};
    }, [
        optimisticBindingsByServiceId,
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
            onOpenSettings={(serviceId) => {
                requestClose();
                router.push(resolveProfileActionRoute(serviceId));
            }}
            maxHeight={maxHeight}
        />
    ), [
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.settings.connectedServicesDefaultProfileByServiceId,
        profileOptionsByServiceId,
        resolveOptionAvailability,
        resolveProfileActionRoute,
        router,
        setBindingForService,
        supportedConnectedServiceIds,
    ]);

    /** Qualified service-title resolver: public applied descriptor title, neutral fallback for unknown services. */
    const resolveServiceTitle = React.useCallback((serviceId: string) => {
        const service = parseQualifiedPluginContributionKey(serviceId);
        return service
            ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServicesRegistry, service, t)
            : t('connectedServices.fallbackName');
    }, [connectedServicesRegistry]);

    const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (supportedConnectedServiceIds.length === 0) return null;
        const label = resolveConnectedServicesAuthLabel({
            supportedServiceIds: supportedConnectedServiceIds,
            bindingsByServiceId: optimisticBindingsByServiceId,
            profileOptionsByServiceId,
            accountGroupOptionsByServiceId: groupOptionsByServiceId,
            accountGroupsEnabled: accountGroupsFeatureEnabled,
            defaultProfileIdByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
            resolveServiceTitle,
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
        resolveServiceTitle,
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
                                    router.push(resolveProfileActionRoute(
                                        providerDiagnosticActionState.failureServiceId,
                                        diagnosticProfileId,
                                    ));
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
                : buildPartialAuthSwitchApplicationStatusBadges(
                    partialApplicationNotice,
                    handlePartialApplicationReconcile,
                    resolveServiceTitle,
                );
    }, [
        actionableState,
        handlePartialApplicationReconcile,
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

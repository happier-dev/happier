import * as React from 'react';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type {
    ConnectedAccountServiceKey,
    ConnectedServiceUxDiagnosticV1,
    PluginProjectedAgentConnectedAccountPurposeV2,
    PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import type {
    SessionTeamCredentialBindingIntentListV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { ConnectedAccountServiceKeySchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    projectAgentConnectedAccountPurposeDefaultsToSessionBindings,
    resolveAgentConnectedAccountPurposeDefaults,
} from '@happier-dev/protocol/account/settings/connected-services';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';

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
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { buildConnectedServicesBindingsPayload } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServicesAuthLabel } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    teamResourceConnectedServiceSelectionKey,
    type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import {
    presentConnectedAccountPurposeTeamResource,
    presentQualifiedConnectedAccountTarget,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
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

function buildPassiveProviderRecoveryDiagnostic(serviceId: ConnectedAccountServiceKey): ConnectedServiceUxDiagnosticV1 {
    return {
        code: 'provider_session_state_unavailable_for_resume',
        failurePhase: 'runtime_auth_recovery',
        source: 'runtime_auth_recovery',
        serviceId,
        retryable: true,
        suggestedActions: ['retry', 'start_fresh_under_selected_account', 'resume_current_account'],
    };
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

export function buildExistingSessionConnectedServiceCredentialBindingIntents(input: Readonly<{
    agentIdentity: PluginContributionIdentityV1;
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    serviceId: string;
    binding: ConnectedServicesServiceBinding | undefined;
    resources: readonly TeamCredentialResourceCatalogEntryV1[];
}>): SessionTeamCredentialBindingIntentListV1 | undefined {
    const declarations = input.connectedAccounts.filter((declaration) => (
        buildQualifiedPluginContributionKey(declaration.service) === input.serviceId
    ));
    if (declarations.length === 0) return undefined;
    const requestedTeamBinding = input.binding?.source === 'team_resource' ? input.binding : null;
    const resource = requestedTeamBinding
        ? input.resources.find((candidate) => (
            candidate.id === requestedTeamBinding.resourceId
            && candidate.connectedServiceSelections.some((selection) => (
                selection.resourceId === requestedTeamBinding.resourceId
                && teamResourceConnectedServiceSelectionKey(selection) === teamResourceConnectedServiceSelectionKey(requestedTeamBinding)
            ))
        ))
        : undefined;
    if (requestedTeamBinding && !resource) return undefined;
    return declarations.map((declaration) => ({
        v: 1,
        slot: {
            kind: 'connected_service_purpose',
            purpose: { consumer: input.agentIdentity, purpose: declaration.purpose },
        },
        ...(resource
            ? {
                resourceId: resource.id,
                expectedResourceRevision: resource.resourceRevision,
                deliveryMode: requestedTeamBinding!.deliveryMode,
            }
            : { resourceId: null }),
    }));
}

function areServiceBindingsEqual(
    left: ConnectedServicesServiceBinding | undefined,
    right: ConnectedServicesServiceBinding | undefined,
): boolean {
    if ((left?.source ?? 'native') !== (right?.source ?? 'native')) return false;
    if ((left?.source ?? 'native') === 'native') return true;
    if (left?.source === 'team_resource' || right?.source === 'team_resource') {
        return left?.source === 'team_resource'
            && right?.source === 'team_resource'
            && left.resourceId === right.resourceId
            && teamResourceConnectedServiceSelectionKey(left) === teamResourceConnectedServiceSelectionKey(right);
    }
    if (left?.source !== 'connected' || right?.source !== 'connected') return false;
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
    agentIdentity?: PluginContributionIdentityV1 | null;
    /** Undefined is unarmed; null is an armed target whose catalog is unavailable. */
    armedAuthoringTarget?: Readonly<{
        agentId: string;
        agentIdentity: PluginContributionIdentityV1;
        connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    }> | null;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialResourceCurrentKeys?: ReadonlySet<string>;
    teamNameById?: Readonly<Record<string, string>>;
    sessionMetadata: unknown;
    settings: {
        connectedServicesProfileLabelByKey: Record<string, string | undefined>;
        connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
        connectedServicesProviderStateSharingSettingsV1?: unknown;
        connectedAccountPurposeBindingsV1?: unknown;
        connectedServicesDefaultAuthByAgentIdV1?: unknown;
    };
    switchingDisabledReason: SessionConnectedServicesAuthSwitchDisabledReason | null;
    sessionActive?: boolean;
    intentionalRestartSignals?: ReadonlyArray<SessionIntentionalRestartSignal>;
    /** Passive Provider runtime failures enter the existing generic recovery owner. */
    passiveProviderRecoveryServiceId?: ConnectedAccountServiceKey | null;
}>): SessionConnectedServicesAuthSwitchResult {
    const accountProfile = useProfile();
    const { present } = useConnectedAccountIdentityPrivacy();
    const router = useRouter();
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const coordinateTeamCredentialSelection = useTeamCredentialSelectionCoordinator(params.serverId);
    const teamCredentialContextRef = React.useRef({
        serverId: params.serverId ?? null,
        resources: params.teamCredentialResources ?? [],
        currentResourceKeys: params.teamCredentialResourceCurrentKeys,
    });
    teamCredentialContextRef.current = {
        serverId: params.serverId ?? null,
        resources: params.teamCredentialResources ?? [],
        currentResourceKeys: params.teamCredentialResourceCurrentKeys,
    };
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
            presentIdentity: present,
            }),
            connectedAccounts: params.connectedAccounts,
        })
    ), [accountProfile?.connectedAccountsV4, params.connectedAccounts, params.settings.connectedServicesProfileLabelByKey, supportedConnectedServiceIds, present]);

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
    // Metadata objects may be recreated by the session projection on each render;
    // publish a passive failure once per binding identity to avoid an effect loop.
    const passiveRecoveryKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        const serviceId = params.passiveProviderRecoveryServiceId ?? null;
        const binding = serviceId ? metadataBindingsByServiceId[serviceId] : undefined;
        if (!serviceId || !binding || binding.source !== 'connected') {
            passiveRecoveryKeyRef.current = null;
            return;
        }
        const recoveryKey = `${serviceId}\0${binding.profileId ?? ''}\0${binding.groupId ?? ''}`;
        if (passiveRecoveryKeyRef.current === recoveryKey) return;
        passiveRecoveryKeyRef.current = recoveryKey;
        const diagnostic = buildPassiveProviderRecoveryDiagnostic(serviceId);
        setActionableState({
            kind: 'provider_session_state_unavailable_for_resume',
            recovery: 'retry_required',
            diagnostic,
        });
        setProviderSessionDiagnosticActionState({
            diagnostic,
            serviceId,
            binding,
            failureServiceId: serviceId,
        });
    }, [metadataBindingsByServiceId, params.passiveProviderRecoveryServiceId]);

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
            let teamVisibilityGrantConsent: Readonly<{ teamId: string }> | undefined;
            if (!options?.skipConfirm && binding.source === 'team_resource') {
                const requestedTeamBinding = binding;
                const startedServerId = teamCredentialContextRef.current.serverId;
                const selectedResource = teamCredentialContextRef.current.resources.find((resource) => (
                    resource.id === requestedTeamBinding.resourceId
                    && resource.connectedServiceSelections.some((selection) => (
                        selection.resourceId === requestedTeamBinding.resourceId
                        && teamResourceConnectedServiceSelectionKey(selection) === teamResourceConnectedServiceSelectionKey(requestedTeamBinding)
                    ))
                ));
                if (!selectedResource) return;
                const outcome = await coordinateTeamCredentialSelection({
                    resource: selectedResource,
                    deliveryMode: requestedTeamBinding.deliveryMode,
                    selection: requestedTeamBinding,
                    isCurrent: () => teamCredentialContextRef.current.serverId === startedServerId
                        && (teamCredentialContextRef.current.currentResourceKeys === undefined
                            || teamCredentialContextRef.current.currentResourceKeys.has(`${selectedResource.teamId}:${requestedTeamBinding.resourceId}`))
                        && teamCredentialContextRef.current.resources.some((resource) => (
                            resource.id === requestedTeamBinding.resourceId
                            && resource.readiness.kind === 'available'
                            && resource.connectedServiceSelections.some((selection) => (
                                selection.resourceId === requestedTeamBinding.resourceId
                                && teamResourceConnectedServiceSelectionKey(selection) === teamResourceConnectedServiceSelectionKey(requestedTeamBinding)
                            ))
                        )),
                });
                if (outcome.kind !== 'continue') return;
                binding = outcome.selection;
                if (selectedResource.sessionUsePolicy === 'team_visibility_required') {
                    const confirmed = await Modal.confirm(
                        t('teams.credentials.usePolicy.title'),
                        t('teams.credentials.usePolicy.visibilityNote'),
                        { confirmText: t('common.continue'), cancelText: t('common.cancel') },
                    );
                    if (!confirmed || (teamCredentialContextRef.current.currentResourceKeys !== undefined
                        && !teamCredentialContextRef.current.currentResourceKeys.has(`${selectedResource.teamId}:${selectedResource.id}`))
                        || !teamCredentialContextRef.current.resources.some((resource) => (
                        resource.id === selectedResource.id
                        && resource.resourceRevision === selectedResource.resourceRevision
                        && resource.readiness.kind === 'available'
                    ))) return;
                    teamVisibilityGrantConsent = { teamId: selectedResource.teamId };
                }
            }
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
        const bindings = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds,
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: groupOptionsByServiceId,
            connectedServicesBindingsByServiceId: nextBindings,
            defaultProfileByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
            accountGroupsFeatureEnabled,
            emitWhenAllNative: true,
        });
        if (!bindings) return;
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

        const expectedGroupGenerationByServiceId = buildExpectedGroupGenerationByServiceId({
            bindingsByServiceId: nextBindings,
            groupOptionsByServiceId,
        });
        const agentIdentity = params.agentIdentity ?? parseQualifiedPluginContributionKey(agentId);
        const teamCredentialBindings = agentIdentity
            ? buildExistingSessionConnectedServiceCredentialBindingIntents({
                agentIdentity,
                connectedAccounts: params.connectedAccounts,
                serviceId,
                binding,
                resources: teamCredentialContextRef.current.resources,
            })
            : undefined;
        const previousTeamCredentialBindings = agentIdentity
            ? buildExistingSessionConnectedServiceCredentialBindingIntents({
                agentIdentity,
                connectedAccounts: params.connectedAccounts,
                serviceId,
                binding: previousBindings[serviceId],
                resources: teamCredentialContextRef.current.resources,
            })
            : undefined;
        if (binding.source === 'team_resource' && !teamCredentialBindings) {
            setOptimisticBindingsByServiceId(previousBindings);
            return;
        }
        void setSessionConnectedServiceAuthBinding({
            sessionId: params.sessionId,
            agentId,
            machineId,
            serverId: params.serverId ?? null,
            bindings,
            ...(rematerializeServiceId ? { rematerializeServiceId } : {}),
            ...(expectedGroupGenerationByServiceId ? { expectedGroupGenerationByServiceId } : {}),
            ...(teamCredentialBindings ? { teamCredentialBindings } : {}),
            ...(previousTeamCredentialBindings ? { previousTeamCredentialBindings } : {}),
            ...(teamVisibilityGrantConsent ? { teamVisibilityGrantConsent } : {}),
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
        coordinateTeamCredentialSelection,
        accountGroupsFeatureEnabled,
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.agentId,
        params.machineId,
        params.serverId,
        params.sessionId,
        params.sessionActive,
        params.settings.connectedServicesDefaultProfileByServiceId,
        profileOptionsByServiceId,
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
            teamCredentialResources={params.teamCredentialResources}
            teamCredentialResourceCurrentKeys={params.teamCredentialResourceCurrentKeys}
            teamNameById={params.teamNameById}
            onRecoverTeamCredentialResource={(resource) => {
                requestClose();
                if (!params.serverId) return;
                router.push(teamCredentialDetailPath({ serverId: params.serverId, teamId: resource.teamId }, resource.id));
            }}
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
        params.teamCredentialResources,
        params.teamCredentialResourceCurrentKeys,
        params.teamNameById,
        params.serverId,
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

    const armedAuthPreview = React.useMemo(() => {
        const target = params.armedAuthoringTarget;
        if (!target) return null;
        const serviceIds = resolveProjectedConnectedAccountServiceKeys(target.connectedAccounts);
        const defaults = resolveAgentConnectedAccountPurposeDefaults({
            settings: params.settings,
            agentId: target.agentId,
            consumer: target.agentIdentity,
            declarations: target.connectedAccounts,
        });
        const bindings = projectAgentConnectedAccountPurposeDefaultsToSessionBindings(defaults)?.bindingsByServiceId ?? {};
        // This describes the requested launch binding, not an effective source
        // runtime. Naming and privacy stay with the qualified-target presenter.
        const actions = serviceIds.map((serviceId) => {
            const binding = bindings[serviceId];
            const serviceTitle = resolveServiceTitle(serviceId);
            let selectionLabel = t('connectedServices.authChip.nativeLabel');
            if (binding?.source === 'connected') {
                const service = parseQualifiedPluginContributionKey(serviceId);
                selectionLabel = service ? presentQualifiedConnectedAccountTarget({
                    target: binding.selection === 'group'
                        ? { kind: 'group', service, groupId: binding.groupId }
                        : { kind: 'account', account: { service, accountId: binding.profileId } },
                    accounts: accountProfile?.connectedAccountsV4 ?? [],
                    groups: accountProfile?.connectedAccountGroupsV4 ?? [],
                    labelsByKey: params.settings.connectedServicesProfileLabelByKey,
                    serviceTitle,
                    presentIdentity: present,
                }).primaryLabel : t('common.unavailable');
            } else if (binding?.source === 'team_resource') {
                const teamResource = defaults.find((entry) => buildQualifiedPluginContributionKey(entry.service) === serviceId
                    && entry.teamResource?.selection.resourceId === binding.resourceId)?.teamResource;
                selectionLabel = teamResource ? presentConnectedAccountPurposeTeamResource({
                    teamResource,
                    teamResources: params.teamCredentialResources ?? [],
                    teamNameById: params.teamNameById,
                    serviceTitle,
                }).primaryLabel : t('common.unavailable');
            }
            return {
                id: serviceId,
                label: `${serviceTitle}: ${selectionLabel}`,
                disabled: true,
            };
        });
        const connectedCount = serviceIds.filter((serviceId) => bindings[serviceId]?.source !== undefined
            && bindings[serviceId]?.source !== 'native').length;
        return {
            actions,
            serviceCount: serviceIds.length,
            connectedCount,
            label: connectedCount === 0 ? t('connectedServices.authChip.nativeLabel') : actions.map((action) => action.label).join(', '),
        };
    }, [accountProfile?.connectedAccountsV4, accountProfile?.connectedAccountGroupsV4, params.armedAuthoringTarget, params.settings, params.teamCredentialResources, params.teamNameById, present, resolveServiceTitle]);

    const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (params.armedAuthoringTarget === null) return null;
        if (armedAuthPreview) {
            if (armedAuthPreview.serviceCount === 0) return null;
            return createConnectedServicesAuthActionChip({
                label: armedAuthPreview.label,
                connectedCount: armedAuthPreview.connectedCount,
                authSource: armedAuthPreview.connectedCount === 0 ? 'native'
                    : armedAuthPreview.connectedCount === armedAuthPreview.serviceCount ? 'connected' : 'mixed',
                popoverContent: () => <ActionListSection actions={armedAuthPreview.actions} />,
                testID: 'session-connected-services-auth-chip',
            });
        }
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
        armedAuthPreview,
        params.armedAuthoringTarget,
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

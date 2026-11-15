import type { TeamCredentialResourceStatusByKey } from '@/sync/domains/teams/teamCredentialResourceStatus';
import * as React from 'react';
import type { PopoverAnchor } from '@/components/ui/popover';
import { presentArmedSessionRouteSource, presentNativeRouteSourceLabel, presentSessionRouteChip, resolveSessionRoutePresentation, type SessionRoutePresentationInput } from '@/providers/session/resolveSessionRoutePresentation';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { useNewSessionEntryRouter as useRouter } from '@/components/sessions/new/navigation/newSessionEntry';

import type {
    ConnectedAccountServiceKey} from '@happier-dev/protocol/connect/connected-service-bindings';
import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    type ConnectedServiceUxDiagnosticV1} from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type {
    PluginProjectedAgentConnectedAccountPurposeV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type {
    PluginContributionIdentityV1,
} from '@happier-dev/protocol/plugins/contribution-identity';
import type {
    SessionTeamCredentialBindingIntentListV1,
    TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import { ConnectedAccountServiceKeySchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';

import type { AgentInputExtraActionChip, AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputContentPopoverRenderArgs } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { createConnectedServicesAuthActionChip } from '@/components/sessions/agentInput/definitions/createConnectedServicesAuthActionChip';
import {
    resolveConnectedServiceUxDiagnosticPresentation,
    type ConnectedServiceUxDiagnosticPresentation,
} from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import { buildConnectedServiceUxDiagnosticAlertButtons } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnosticAlertActions';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { NewSessionConnectedServicesSelectionContent } from '@/components/sessions/new/components/NewSessionConnectedServicesSelectionContent';
import type { SessionRouteSources } from '@/components/sessions/new/components/useSessionRouteSourceSections';
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { buildConnectedServicesBindingsPayload } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import { buildNewSessionTempDataFromSessionConfiguration } from '@/components/sessions/authoring/draft/sessionConfigurationSeed';
import type { ExistingSessionAuthoringSnapshotSession } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { openSessionAuthoringSeed } from '@/sync/ops/actions/openSessionAuthoringSeed';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { resolveConnectedServicesAuthLabel, resolveConnectedServicesAuthWarningTranslationKey } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { buildConnectedAccountPurposeTargetChoices } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { Settings } from '@/sync/domains/settings/settings';
import { teamCredentialDetailPath } from '@/components/settings/teams/teamsRoutes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    teamResourceConnectedServiceSelectionKey,
    type ConnectedServicesServiceBinding,
} from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
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
    type setSessionConnectedServiceAuthBinding,
    type SessionConnectedServiceAuthSwitchErrorCode,
    type SessionConnectedServiceAuthSwitchResult as DaemonSessionConnectedServiceAuthSwitchResult,
} from '@/sync/ops/connectedServices/sessionAuthSwitch';
import { useProfile } from '@/sync/store/hooks';
import { t } from '@/text';
import { presentSessionAuthSwitchFailure } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import {
    createManualAuthSwitchRestartSignal,
    resolveSessionIntentionalRestartState,
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
    routePresentation: ReturnType<typeof resolveSessionRoutePresentation> | null;
    /** The applied account or pool the Agent's own models run through; null for its own sign-in. */
    nativeSourceLabel: string | null;
    /**
     * The source a route or model change armed for the next message continues through (D15), or null
     * when nothing is armed. The send control names it; the send owner applies it.
     */
    armedRouteSourceLabel: string | null;
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
        const leftBinding = left[serviceId];
        const rightBinding = right[serviceId];
        if (!areServiceBindingsEqual(leftBinding, rightBinding)) return false;
        if (leftBinding?.source === 'connected' && leftBinding.selection === 'group'
            && rightBinding?.source === 'connected' && rightBinding.selection === 'group'
            && leftBinding.appliedProfileId !== rightBinding.appliedProfileId) return false;
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
    route?: Omit<SessionRoutePresentationInput, 'native'>;
    /** The session Agent's Gateways and Providers for the "Runs through" popover; omitted, it names none. */
    routeSources?: SessionRouteSources;
    nativeAgentTargetKey?: string | null;
    sessionId: string;
    /** The readable source configuration for a fresh, independently authored Session. */
    sessionConfiguration?: ExistingSessionAuthoringSnapshotSession;
    agentId: string | null | undefined;
    machineId: string | null | undefined;
    serverId?: string | null;
    connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    agentIdentity?: PluginContributionIdentityV1 | null;
    armedContinuationAgent?: Readonly<{
        agentId: string;
        agentIdentity: PluginContributionIdentityV1 | null;
        connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    }> | null;
    /** Undefined is unarmed; null is an armed target whose catalog is unavailable. */
    armedAuthoringTarget?: Readonly<{
        agentId: string;
        agentIdentity: PluginContributionIdentityV1;
        connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    }> | null;
    teamCredentialResources?: readonly TeamCredentialResourceCatalogEntryV1[];
    teamCredentialDisplayNames?: Readonly<Record<string, string | null>>;
    teamCredentialResourceStatusByKey?: TeamCredentialResourceStatusByKey;
    teamNameById?: Readonly<Record<string, string>>;
    sessionMetadata: unknown;
    settings: {
        connectedServicesDefaultProfileByServiceId: Record<string, string | undefined>;
        connectedServicesProviderStateSharingSettingsV1?: unknown;
        connectedServicesDefaultAuthByAgentIdV1?: Settings['connectedServicesDefaultAuthByAgentIdV1'];
        connectedServicesAdditionalDefaultAuthByAgentIdV1?: Settings['connectedServicesAdditionalDefaultAuthByAgentIdV1'];
    };
    switchingDisabledReason: SessionConnectedServicesAuthSwitchDisabledReason | null;
    sessionActive?: boolean;
    intentionalRestartSignals?: ReadonlyArray<SessionIntentionalRestartSignal>;
    intentionalRestartRecoveryEvidenceAtMs?: number | null;
    /** Passive Provider runtime failures enter the existing generic recovery owner. */
    passiveProviderRecoveryServiceId?: ConnectedAccountServiceKey | null;
    applyBinding: typeof setSessionConnectedServiceAuthBinding;
}>): SessionConnectedServicesAuthSwitchResult {
    // Only the connected-account facts auth switching reads; a timestamp-only Account update leaves it still.
    const accountProfile = useProfile(profile => ({
        connectedAccountsV4: profile?.connectedAccountsV4,
        connectedAccountGroupsV4: profile?.connectedAccountGroupsV4,
    }));
    const { present } = useConnectedAccountIdentityPrivacy();
    const armedTarget = params.armedAuthoringTarget === undefined ? params.armedContinuationAgent : params.armedAuthoringTarget;
    const needsConnectedLabels = params.connectedAccounts.length > 0 || Boolean(armedTarget?.connectedAccounts.length);
    const { binding } = useServerCredentialAccountScopeBinding(needsConnectedLabels ? params.serverId : null);
    const armedPurposeCatalog = useConnectedAccountCatalog('purposes', !armedTarget
        ? null
        : params.serverId ? binding?.scope ?? null : undefined);
    const labelsByKey = useConnectedMetadataCatalog(!needsConnectedLabels ? null
        : params.serverId ? binding?.scope ?? null : undefined, selectConnectedMetadataLabels);
    const router = useRouter();
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const coordinateTeamCredentialSelection = useTeamCredentialSelectionCoordinator(params.serverId);
    const teamCredentialContextRef = React.useRef({
        serverId: params.serverId ?? null,
        resources: params.teamCredentialResources ?? [],
        resourceStatusByKey: params.teamCredentialResourceStatusByKey,
    });
    teamCredentialContextRef.current = {
        serverId: params.serverId ?? null,
        resources: params.teamCredentialResources ?? [],
        resourceStatusByKey: params.teamCredentialResourceStatusByKey,
    };
    const accountGroupsFeatureEnabled = useFeatureEnabled('connectedServices.accountGroups', {
        scopeKind: 'spawn',
        serverId: params.serverId ?? null,
    });
    const switchAttemptIdRef = React.useRef(0);
    const [pendingRestart, setPendingRestart] = React.useState<SessionConnectedServicesAuthSwitchPendingRestart | null>(null);
    const [restartRetryState, setRestartRetryState] = React.useState<SessionConnectedServicesAuthSwitchRetryState | null>(null);
    const [manualRestartSignal, setManualRestartSignal] = React.useState<SessionIntentionalRestartSignal | null>(null);
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
            labelsByKey,
            presentIdentity: present,
            }),
            connectedAccounts: params.connectedAccounts,
        })
    ), [accountProfile?.connectedAccountsV4, params.connectedAccounts, labelsByKey, supportedConnectedServiceIds, present]);

    const groupOptionsByServiceId = React.useMemo(() => (
        buildQualifiedConnectedAccountGroupOptionsByServiceId({
            groups: accountProfile?.connectedAccountGroupsV4 ?? [],
            supportedServiceIds: supportedConnectedServiceIds,
            labelsByKey,
        })
    ), [accountProfile?.connectedAccountGroupsV4, labelsByKey, supportedConnectedServiceIds]);

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

    const openConnectSheet = React.useCallback((serviceId: string, accountId?: string | null, anchor?: PopoverAnchor) => {
        const service = parseQualifiedPluginContributionKey(serviceId) ?? undefined;
        return presentConnectSheet({ scope: binding?.scope ?? null, service, intent: 'link', ...(anchor ? { anchor } : {}),
            ...(service && accountId ? { intent: 'reconnect', account: { service, accountId } } : {}) });
    }, [binding]);

    const freshSessionConfiguration = params.sessionConfiguration && readSessionOwnerMetadataView(params.sessionConfiguration)
        ? params.sessionConfiguration
        : null;

    const startFreshUnderSelectedAccount = React.useCallback(async (serviceId: string, selectedBinding: ConnectedServicesServiceBinding) => {
        const lifetime = binding ?? captureActiveServerAccountScopeLifetime();
        const source = freshSessionConfiguration;
        if (!lifetime?.isCurrent() || !source || source.id !== params.sessionId || !params.machineId) return;
        if (params.serverId && !selectActiveServerAccountScopeForServer(lifetime.scope, params.serverId)) return;
        const configuration = buildNewSessionTempDataFromSessionConfiguration({ session: source, machineId: params.machineId });
        if (!configuration.agentTarget) return;
        const bindings = buildConnectedServicesBindingsPayload({
            supportedConnectedServiceIds,
            connectedServiceProfileOptionsByServiceId: profileOptionsByServiceId,
            connectedServiceAccountGroupOptionsByServiceId: groupOptionsByServiceId,
            connectedServicesBindingsByServiceId: { ...metadataBindingsByServiceId, [serviceId]: selectedBinding },
            defaultProfileByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
            accountGroupsFeatureEnabled,
            emitWhenAllNative: true,
        });
        if (!bindings) return;
        const outcome = await openSessionAuthoringSeed({
            seed: { placement: { kind: 'exactTarget', serverId: lifetime.scope.serverId, machineId: params.machineId,
                ...(configuration.directory ? { directory: configuration.directory } : {}) } },
            sourceSession: { serverId: lifetime.scope.serverId, sessionId: source.id },
            connectedServices: bindings,
            accountLifetime: lifetime, scope: lifetime.scope, isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({ draftId }) => router.push({ pathname: '/new',
                params: buildNewSessionLaunchRouteParams({ draftId, targetServerId: lifetime.scope.serverId }) }),
        });
        if (outcome.kind === 'opened') {
            setActionableState(null);
            setProviderSessionDiagnosticActionState(null);
        }
    }, [accountGroupsFeatureEnabled, binding, groupOptionsByServiceId, metadataBindingsByServiceId, params.machineId,
        params.serverId, params.sessionId, freshSessionConfiguration, params.settings.connectedServicesDefaultProfileByServiceId,
        profileOptionsByServiceId, router, supportedConnectedServiceIds]);

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
                        && (teamCredentialContextRef.current.resourceStatusByKey === undefined
                            || (teamCredentialContextRef.current.resourceStatusByKey.get(`${selectedResource.teamId}:${requestedTeamBinding.resourceId}`)?.kind === 'current'))
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
                    if (!confirmed || (teamCredentialContextRef.current.resourceStatusByKey !== undefined
                        && !(teamCredentialContextRef.current.resourceStatusByKey.get(`${selectedResource.teamId}:${selectedResource.id}`)?.kind === 'current'))
                        || !teamCredentialContextRef.current.resources.some((resource) => (
                        resource.id === selectedResource.id
                        && resource.resourceRevision === selectedResource.resourceRevision
                        && resource.readiness.kind === 'available'
                    ))) return;
                    teamVisibilityGrantConsent = { teamId: selectedResource.teamId };
                }
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
        const startedAtMs = Date.now();
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
        const presentFailure = (errorCode: string | undefined, failureServiceId = serviceId) => {
            Modal.alert(t('common.error'), presentSessionAuthSwitchFailure(errorCode),
                buildConnectedServiceUxDiagnosticAlertButtons({
                    actions: [{ kind: CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts, labelKey: 'connectedServices.title' }],
                    handlers: {
                        openConnectedAccounts: () => fireAndForget(openConnectSheet(failureServiceId),
                            { tag: 'SessionAuthSwitch.connect' }),
                        dismiss: () => {},
                    },
                    translate: t,
                }));
        };
        void params.applyBinding({
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
                    setManualRestartSignal(result.action === 'restart_requested'
                        ? createManualAuthSwitchRestartSignal({ attemptId, startedAtMs })
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
                                startFreshUnderSelectedAccount: diagnosticServiceId && freshSessionConfiguration
                                    ? () => startFreshUnderSelectedAccount(serviceId, binding)
                                    : undefined,
                                resumeCurrentAccount: dismiss,
                                openConnectedAccounts: () => {
                                    fireAndForget(openConnectSheet(diagnosticServiceId ?? failureServiceId),
                                        { tag: 'SessionAuthSwitch.connect' });
                                },
                                reconnectProfile: () => {
                                    fireAndForget(openConnectSheet(failureServiceId, diagnosticProfileId),
                                        { tag: 'SessionAuthSwitch.reconnect' });
                                },
                                enableStateSharing: () => router.push('/(app)/settings/connected-services/provider-state-sharing'),
                                dismiss,
                            });
                        }
                    }
                    return;
                }
                if (nextActionableState.kind === 'reconnect_profile') {
                    fireAndForget(openConnectSheet(result.serviceId ?? serviceId, nextActionableState.profileId),
                        { tag: 'SessionAuthSwitch.reconnect' });
                } else if (nextActionableState.kind === 'provider_state_sharing_required') {
                    router.push(nextActionableState.route);
                } else {
                    fireAndForget(openConnectSheet(result.serviceId ?? serviceId), { tag: 'SessionAuthSwitch.connect' });
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
                    startFreshUnderSelectedAccount: diagnosticServiceId && freshSessionConfiguration
                        ? () => startFreshUnderSelectedAccount(serviceId, binding)
                        : undefined,
                    resumeCurrentAccount: dismiss,
                    openConnectedAccounts: () => {
                        fireAndForget(openConnectSheet(diagnosticServiceId ?? failureServiceId),
                            { tag: 'SessionAuthSwitch.connect' });
                    },
                    reconnectProfile: () => {
                        fireAndForget(openConnectSheet(failureServiceId, diagnosticProfileId),
                            { tag: 'SessionAuthSwitch.reconnect' });
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
            presentFailure(result.errorCode, result.serviceId ?? serviceId);
        }).catch((error) => {
            if (switchAttemptIdRef.current !== attemptId) return;
            if (isNonTerminalRestartTimeoutError(error)) {
                setManualRestartSignal(createManualAuthSwitchRestartSignal({ attemptId, startedAtMs }));
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
            presentFailure(readRpcErrorCode(error));
        });
        })();
    }, [
        coordinateTeamCredentialSelection,
        accountGroupsFeatureEnabled,
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.applyBinding,
        params.agentId,
        params.machineId,
        params.serverId,
        params.sessionId,
        freshSessionConfiguration,
        params.sessionActive,
        params.settings.connectedServicesDefaultProfileByServiceId,
        profileOptionsByServiceId,
        openConnectSheet,
        router,
        supportedConnectedServiceIds,
        startFreshUnderSelectedAccount,
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
        if (!params.machineId) return {
            disabled: true, availability: 'available' as const,
            subtitle: t('session.collaboration.readiness.cause.machineMissing'),
        };
        if (params.switchingDisabledReason) return {
            disabled: true, availability: 'available' as const,
            subtitle: t(params.switchingDisabledReason === 'active_turn'
                ? 'connectedServices.authSwitch.activeTurnDisabled'
                : 'connectedServices.authSwitch.readOnlyDisabled'),
        };
        return {};
    }, [
        optimisticBindingsByServiceId,
        params.machineId,
        params.switchingDisabledReason,
    ]);

    const popoverContent = React.useCallback((
        { requestClose, maxHeight }: AgentInputContentPopoverRenderArgs,
        armedNote?: string | null,
        appliedRoute?: ReturnType<typeof resolveSessionRoutePresentation>['applied'],
    ) => (
        <NewSessionConnectedServicesSelectionContent
            armedNote={armedNote}
            routeSources={params.routeSources}
            nativeAgentTargetKey={params.nativeAgentTargetKey ?? undefined}
            appliedRoute={appliedRoute}
            supportedServiceIds={supportedConnectedServiceIds}
            profileOptionsByServiceId={profileOptionsByServiceId}
            groupOptionsByServiceId={groupOptionsByServiceId}
            bindingsByServiceId={optimisticBindingsByServiceId}
            teamCredentialResources={params.teamCredentialResources}
            teamCredentialDisplayNames={params.teamCredentialDisplayNames}
            teamCredentialResourceStatusByKey={params.teamCredentialResourceStatusByKey}
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
            onOpenSettings={(serviceId, anchor) => {
                requestClose();
                fireAndForget(openConnectSheet(serviceId, undefined, anchor).then((result) => {
                    if (result.kind === 'dismissed') return;
                    setBindingForService(buildQualifiedPluginContributionKey(result.account.service), {
                        source: 'connected', selection: 'profile', profileId: result.account.accountId,
                    });
                }), { tag: 'SessionAuthSwitch.connectAndSelect' });
            }}
            maxHeight={maxHeight}
        />
    ), [
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        params.settings.connectedServicesDefaultProfileByServiceId,
        params.teamCredentialResources,
        params.teamCredentialDisplayNames,
        params.teamCredentialResourceStatusByKey,
        params.teamNameById,
        params.serverId,
        params.routeSources,
        params.nativeAgentTargetKey,
        profileOptionsByServiceId,
        resolveOptionAvailability,
        openConnectSheet,
        router,
        setBindingForService,
        freshSessionConfiguration,
        startFreshUnderSelectedAccount,
        supportedConnectedServiceIds,
    ]);

    /** Qualified service-title resolver: public applied descriptor title, neutral fallback for unknown services. */
    const resolveServiceTitle = React.useCallback((serviceId: string) => {
        const service = parseQualifiedPluginContributionKey(serviceId);
        return service
            ? resolveQualifiedConnectedServiceRegistryDisplayName(connectedServicesRegistry, service, t)
            : t('connectedServices.fallbackName');
    }, [connectedServicesRegistry]);

    const appliedNativeRoute = React.useMemo(() => {
        const label = resolveConnectedServicesAuthLabel({
            supportedServiceIds: supportedConnectedServiceIds, bindingsByServiceId: metadataBindingsByServiceId,
            profileOptionsByServiceId, accountGroupOptionsByServiceId: groupOptionsByServiceId,
            accountGroupsEnabled: accountGroupsFeatureEnabled,
            defaultProfileIdByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
            resolveServiceTitle, nativeLabel: t('connectedServices.authChip.nativeLabel'),
            formatConnectedCountLabel: count => t('connectedServices.authChip.connectedCountLabel', { count }),
            teamCredentialResources: params.teamCredentialResources, teamCredentialDisplayNames: params.teamCredentialDisplayNames, teamNameById: params.teamNameById,
        });
        return {
            label: label.label, connectedCount: label.connectedCount,
            authSource: label.connectedCount === 0 ? 'native' as const : label.connectedCount === supportedConnectedServiceIds.length ? 'connected' as const : 'mixed' as const,
        };
    }, [params.settings.connectedServicesDefaultProfileByServiceId, supportedConnectedServiceIds,
        metadataBindingsByServiceId, profileOptionsByServiceId, groupOptionsByServiceId, accountGroupsFeatureEnabled, resolveServiceTitle,
        params.teamCredentialResources, params.teamCredentialDisplayNames, params.teamNameById]);
    const routePresentation = React.useMemo(() => params.route
        ? resolveSessionRoutePresentation({ ...params.route, native: appliedNativeRoute })
        : null, [appliedNativeRoute, params.route]);
    const nativeSourceLabel = supportedConnectedServiceIds.length > 0 ? presentNativeRouteSourceLabel(appliedNativeRoute) : null;
    const armedRouteSourceLabel = routePresentation ? presentArmedSessionRouteSource(routePresentation, appliedNativeRoute) : null;

    const connectedServicesAuthChip = React.useMemo<AgentInputExtraActionChip | null>(() => {
        if (params.armedAuthoringTarget === null) return null;
        const target = armedTarget;
        if (target) {
            const serviceIds = resolveProjectedConnectedAccountServiceKeys(target.connectedAccounts);
            if (serviceIds.length === 0) return null;
            const defaultsReady = Boolean(target.agentIdentity && armedPurposeCatalog.status === 'ready'
                && armedPurposeCatalog.value && !armedPurposeCatalog.stale);
            const unavailableLabel = armedPurposeCatalog.status === 'loading' ? t('common.loading') : t('common.unavailable');
            const defaults = target.agentIdentity && armedPurposeCatalog.value ? resolveAgentConnectedAccountPurposeDefaults({
                    purposeBindings: armedPurposeCatalog.value,
                    settings: defaultsReady ? params.settings : {},
                    agentId: target.agentId,
                    consumer: target.agentIdentity,
                    declarations: target.connectedAccounts,
                }) : [];
            const bindings = projectAgentConnectedAccountPurposeDefaultsToSessionBindings(defaults);
            const teamResourceChoicesByServiceId = Object.fromEntries(defaults.flatMap((selected) => {
                if (!selected.teamResource) return [];
                const serviceId = buildQualifiedPluginContributionKey(selected.service);
                const choice = buildConnectedAccountPurposeTargetChoices({
                    declaration: { purpose: selected.purpose.purpose, service: selected.service, required: true },
                    selectedTarget: null,
                    selectedTeamResource: selected.teamResource,
                    accounts: accountProfile?.connectedAccountsV4 ?? [],
                    groups: accountProfile?.connectedAccountGroupsV4 ?? [],
                    labelsByKey,
                    serviceTitle: resolveServiceTitle(serviceId),
                    presentIdentity: present,
                    resolveAuthentication: getConnectedAccountAuthentication,
                    teamResources: params.teamCredentialResources,
                    teamResourceDisplayNames: params.teamCredentialDisplayNames,
                    teamResourceStatusByKey: params.teamCredentialResourceStatusByKey,
                    teamNameById: params.teamNameById,
                }).find((candidate) => candidate.current);
                return choice ? [[serviceId, choice]] : [];
            }));
            const label = resolveConnectedServicesAuthLabel({
                supportedServiceIds: serviceIds,
                bindingsByServiceId: bindings?.bindingsByServiceId ?? {},
                profileOptionsByServiceId: applyProjectedCredentialKindRestrictions({
                    optionsByServiceId: buildQualifiedConnectedAccountProfileOptionsByServiceId({
                        accounts: accountProfile?.connectedAccountsV4 ?? [],
                        supportedServiceIds: serviceIds,
                        labelsByKey,
                        presentIdentity: present,
                    }),
                    connectedAccounts: target.connectedAccounts,
                }),
                accountGroupOptionsByServiceId: buildQualifiedConnectedAccountGroupOptionsByServiceId({
                    groups: accountProfile?.connectedAccountGroupsV4 ?? [],
                    supportedServiceIds: serviceIds,
                    labelsByKey,
                }),
                accountGroupsEnabled: accountGroupsFeatureEnabled,
                defaultProfileIdByServiceId: params.settings.connectedServicesDefaultProfileByServiceId,
                bindingPresentation: 'requested',
                teamResourceChoicesByServiceId,
                resolveServiceTitle,
                nativeLabel: t('connectedServices.authChip.nativeLabel'),
                formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }),
            });
            const warningKey = resolveConnectedServicesAuthWarningTranslationKey(label.warningCodes[0]);
            const qualifiedLabel = label.connectedCount === 0 ? t('connectedServices.authChip.nativeLabel')
                : serviceIds.map((serviceId) => {
                    const binding = bindings?.bindingsByServiceId[serviceId];
                    const serviceTitle = resolveServiceTitle(serviceId);
                    if (binding?.source === 'connected') {
                        const service = parseQualifiedPluginContributionKey(serviceId);
                        const selectionLabel = service ? presentQualifiedConnectedAccountTarget({
                            target: binding.selection === 'group'
                                ? { kind: 'group', service, groupId: binding.groupId }
                                : { kind: 'account', account: { service, accountId: binding.profileId } },
                            accounts: accountProfile?.connectedAccountsV4 ?? [],
                            groups: accountProfile?.connectedAccountGroupsV4 ?? [],
                            labelsByKey,
                            serviceTitle,
                            presentIdentity: present,
                        }).primaryLabel : t('common.unavailable');
                        return `${serviceTitle}: ${selectionLabel}`;
                    }
                    if (binding?.source === 'team_resource') {
                        return teamResourceChoicesByServiceId[serviceId]?.presentation.accessibilityLabel
                            ?? `${serviceTitle}: ${t('common.unavailable')}`;
                    }
                    return `${serviceTitle}: ${t('connectedServices.authChip.nativeLabel')}`;
                }).join(', ');
            const displayLabel = defaultsReady || (armedPurposeCatalog.value && label.connectedCount > 0)
                ? qualifiedLabel : unavailableLabel;
            return createConnectedServicesAuthActionChip({
                label: displayLabel,
                pending: true,
                connectedCount: label.connectedCount,
                authSource: !defaultsReady ? 'unknown'
                    : label.connectedCount === 0 ? 'native' : label.connectedCount === serviceIds.length ? 'connected' : 'mixed',
                popoverContent: () => <ActionListSection actions={[{
                    id: 'armed-agent-auth-default', label: displayLabel,
                    subtitle: !defaultsReady ? unavailableLabel : warningKey ? t(warningKey) : undefined,
                    disabled: true,
                }]} />,
                agentId: params.agentId,
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
            teamCredentialResources: params.teamCredentialResources, teamCredentialDisplayNames: params.teamCredentialDisplayNames, teamNameById: params.teamNameById,
        });

        const authSource = label.connectedCount === 0
            ? 'native' as const
            : label.connectedCount === supportedConnectedServiceIds.length
                ? 'connected' as const
                : 'mixed' as const;
        // "Runs through …", or "Next via …" while a route or model change is armed for the next message (D15).
        const routeChip = routePresentation
            ? presentSessionRouteChip(routePresentation, { label: label.label, authSource })
            : null;
        const armedSource = routePresentation
            ? presentArmedSessionRouteSource(routePresentation, { label: label.label })
            : null;
        const armedNote = armedSource ? t('connectedServices.authChip.armedNote', { source: armedSource }) : null;
        return createConnectedServicesAuthActionChip({
            label: routeChip?.label ?? label.label,
            pending: routePresentation?.pending != null || pendingRestart !== null || partialApplicationNotice !== null
                || actionableState !== null || providerSessionDiagnosticActionState !== null || label.warningCodes.length > 0
                || supportedConnectedServiceIds.some((serviceId) => !areServiceBindingsEqual(
                    optimisticBindingsByServiceId[serviceId], metadataBindingsByServiceId[serviceId])),
            connectedCount: label.connectedCount,
            authSource,
            popoverContent: (args: AgentInputContentPopoverRenderArgs) => popoverContent(args, armedNote, routePresentation?.applied),
            agentId: params.agentId,
            testID: 'session-connected-services-auth-chip',
        });
    }, [
        armedTarget,
        params.armedAuthoringTarget,
        armedPurposeCatalog.value,
        armedPurposeCatalog.status,
        armedPurposeCatalog.stale,
        params.settings.connectedServicesDefaultAuthByAgentIdV1,
        params.settings.connectedServicesAdditionalDefaultAuthByAgentIdV1,
        labelsByKey,
        params.teamCredentialResources,
        params.teamCredentialDisplayNames,
        params.teamCredentialResourceStatusByKey,
        params.teamNameById,
        // Only these profile members are read: a profile refresh restamps the whole profile.
        accountProfile?.connectedAccountsV4,
        accountProfile?.connectedAccountGroupsV4,
        present,
        accountGroupsFeatureEnabled,
        groupOptionsByServiceId,
        optimisticBindingsByServiceId,
        metadataBindingsByServiceId,
        params.settings.connectedServicesDefaultProfileByServiceId,
        pendingRestart,
        partialApplicationNotice,
        actionableState,
        providerSessionDiagnosticActionState,
        popoverContent,
        profileOptionsByServiceId,
        resolveServiceTitle,
        routePresentation,
        params.agentId,
        supportedConnectedServiceIds,
    ]);

    const restartState = React.useMemo(() => resolveSessionIntentionalRestartState({
        signals: [manualRestartSignal, ...(params.intentionalRestartSignals ?? [])],
        recoveryEvidenceAtMs: params.intentionalRestartRecoveryEvidenceAtMs,
    }), [manualRestartSignal, params.intentionalRestartSignals, params.intentionalRestartRecoveryEvidenceAtMs]);

    React.useEffect(() => {
        if (!pendingRestart) return;
        const failed = restartState?.status === 'failed';
        const recovered = manualRestartSignal !== null && restartState === null;
        if (!failed && !recovered && params.sessionActive !== true) return;
        if (!failed && arePendingRestartBindingsApplied(pendingRestart, metadataBindingsByServiceId)) {
            setPendingRestart(null);
            setRestartRetryState(null);
            setManualRestartSignal(null);
            return;
        }
        if (failed || recovered || pendingRestart.timedOut) {
            setPendingRestart(null);
            setManualRestartSignal(null);
            setOptimisticBindingsByServiceId(metadataBindingsByServiceId);
            setRestartRetryState({
                attemptId: pendingRestart.attemptId,
                expectedBindingsByServiceId: pendingRestart.expectedBindingsByServiceId,
            });
        }
    }, [manualRestartSignal, metadataBindingsByServiceId, params.sessionActive, pendingRestart, restartState]);

    React.useEffect(() => {
        if (!restartRetryState) return;
        if (arePendingRestartBindingsApplied(restartRetryState, metadataBindingsByServiceId)) {
            setRestartRetryState(null);
            setManualRestartSignal(null);
        }
    }, [metadataBindingsByServiceId, restartRetryState]);

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
                            startFreshUnderSelectedAccount: diagnosticServiceId && freshSessionConfiguration
                                ? () => startFreshUnderSelectedAccount(
                                    providerDiagnosticActionState.serviceId,
                                    providerDiagnosticActionState.binding,
                                )
                                : undefined,
                            resumeCurrentAccount: dismiss,
                            openConnectedAccounts: () => {
                                fireAndForget(openConnectSheet(diagnosticServiceId ?? providerDiagnosticActionState.failureServiceId),
                                    { tag: 'SessionAuthSwitch.connect' });
                            },
                            reconnectProfile: () => {
                                fireAndForget(openConnectSheet(providerDiagnosticActionState.failureServiceId, diagnosticProfileId),
                                    { tag: 'SessionAuthSwitch.reconnect' });
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
        openConnectSheet,
        restartRetryState,
        freshSessionConfiguration,
        startFreshUnderSelectedAccount,
        router,
        setBindingForService,
    ]);

    return { routePresentation, nativeSourceLabel, armedRouteSourceLabel, connectedServicesAuthChip, statusBadges, restartState, actionableState };
}

import * as React from 'react';
import { Redirect, useLocalSearchParams, useNavigation } from '@/components/appShell/workspace/destinationRoute';

import type {
    BuiltInLegacyConnectedAccountOperation} from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import type {
    ConnectedAccountPeerOperationTransport} from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type {
    PluginConnectedAccountAuthenticationModeV2} from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import type {
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID } from '@happier-dev/protocol/connect/generatedBuiltInLegacyConnectedAccountCompatibility';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ConnectedAccountActionApprovalNotice } from '../ConnectedAccountActionApprovalNotice';

import {
    useProjectedPluginLocalizedTextResolver,
    useProjectedConnectedServicesRegistry,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { MachineAdministrationTargetSelector, type MachineAdministrationTargetSelectorProps } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { readConnectedAccountBrowserSignInMachineSupport } from '@/sync/domains/connectedServices/connectedAccountBrowserSignInMachineSupport';
import { isMachineAdministrationCandidateSelectable, machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { MachineScopedSection } from '@/components/settings/machines/MachineScopedSection';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useQualifiedConnectedAccountGroups } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { getPreferredLanguage, t } from '@/text';
import {
    readConnectedAccountAddRequest,
    buildConnectedAccountSettingsRoute,
    resolveQualifiedConnectedAccountSettingsRoute,
} from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { resolveConnectedAccountModeTitle } from '../model/resolveConnectedAccountModeTitle';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    useMachineAdministrationTargetSelection,
    type MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import {
    isQualifiedConnectedAccountLegacyOperationSupported,
    type QualifiedConnectedAccountUiPeerTransport,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import {
    resolveQualifiedConnectedAccountLabel,
} from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import {
    runConnectedAccountAuthenticationAction,
    listPendingConnectedAccountAuthenticationActions,
    runConnectedAccountControlCommand,
    type ConnectedAccountAttemptResponse,
    type ConnectedAccountConfigurationTarget,
    type ConnectedAccountDaemonControlResponse,
} from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import {
    useActiveServerAccountScope,
    useProfile,
} from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import {
    captureActiveServerAccountScopeCurrentness,
} from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

import {
    isConnectedServiceCredentialReferencedByGroupError,
    readConnectedServiceSettingsErrorCode,
    readConnectedServiceSettingsErrorDetailsCode,
    readConnectedServiceSettingsErrorRequestId,
    resolveConnectedServiceSettingsErrorMessage,
    resolveConnectedServiceSettingsErrorRecovery,
} from '../connectedServiceSettingsErrors';
import { ConnectedAccountConfigurationForm } from './ConnectedAccountConfigurationForm';
import { ConnectedAccountDeviceForm } from './ConnectedAccountDeviceForm';
import { ConnectedAccountManualForm } from './ConnectedAccountManualForm';
import { ConnectedAccountOAuthForm } from './ConnectedAccountOAuthForm';
import { useConnectedAccountSetupCompletion } from './useConnectedAccountSetupCompletion';
import { useConnectedAccountServiceDescription } from './useConnectedAccountServiceDescription';
import {
    ConnectedAccountServiceContent,
    type ConnectedAccountServiceProfile,
} from './ConnectedAccountServiceContent';
import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { resolveConnectedServiceRegistryEntryDisplayName } from '../model/resolveConnectedServiceDisplayName';
import { ConnectedServiceMark } from '../ConnectedServiceMark';
import { getConnectedAccountAuthentication, getConnectedServiceSetupPresentation, type ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { isAccountDirectConnectedAccountModeV1, listAccountDirectSecretCredentialKeysV1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { resolveAccountDirectSaveTarget } from './accountDirectSaveTarget';
import { randomUUID } from '@/platform/randomUUID';
import { rankConnectedAccountSetupModes, resolveConnectedAccountSetupMode } from '../setup/rankConnectedAccountSetupModes';
import { ConnectedServiceSetupFlowActions, ConnectedServiceSetupFlowBody } from '../setup/ConnectedServiceSetupFlowBody';
import {
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';

type ServiceDescription = Extract<
    ConnectedAccountDaemonControlResponse,
    { status: 'described' }
>;
type ConfigurationDescription = ReturnType<typeof CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get']['parse']>;
type ServiceConfigurationStatus =
    ConfigurationDescription['configuration']['status'];
type ServiceConfigurationStatusByModeId = Readonly<
    Record<string, ServiceConfigurationStatus | undefined>
>;
type PendingIntent =
    | Readonly<{
        kind: 'connect';
        service: QualifiedConnectedAccountRef['service'];
        modeId: string;
    }>
    | Readonly<{
        kind: 'reconnect';
        account: QualifiedConnectedAccountRef;
    }>;

function asStringParam(value: unknown): string {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
    return typeof value === 'string' ? value.trim() : '';
}

function isTerminalAttempt(response: ConnectedAccountAttemptResponse): boolean {
    return response.status === 'connected'
        || response.status === 'cancelled'
        || response.status === 'rejected'
        || response.status === 'unavailable'
        || response.status === 'conflict';
}

function readControlFailureCode(
    response: ConnectedAccountDaemonControlResponse,
    fallback: string,
): string {
    return response.status === 'conflict' || response.status === 'unavailable'
        ? response.code
        : fallback;
}

function readLegacyAuthenticationModeId(
    mapping: Readonly<Partial<Record<'oauth' | 'token', string>>>,
    kind: 'oauth' | 'token',
): string | null {
    return mapping[kind] ?? null;
}

function projectDaemonPeerTransport(
    transport: ConnectedAccountPeerOperationTransport,
): QualifiedConnectedAccountUiPeerTransport {
    return transport.kind === 'v4'
        ? { protocol: 'v4' }
        : {
            protocol: 'legacy',
            peerClass: transport.peerClass === 'exact_v0_2_1'
                ? 'exact-v0.2.1'
                : 'revisioned-v2-v3',
            legacyServiceId: transport.serviceId,
        };
}

function createLinkedAbortController(parentSignal: AbortSignal): Readonly<{
    signal: AbortSignal;
    dispose(): void;
}> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal.aborted) {
        abort();
    } else {
        parentSignal.addEventListener('abort', abort, { once: true });
    }
    return {
        signal: controller.signal,
        dispose(): void {
            parentSignal.removeEventListener('abort', abort);
            controller.abort();
        },
    };
}

type ConnectedAccountServiceControllerProps = Readonly<{
    params: ReturnType<typeof useLocalSearchParams>;
    connectedServicesRegistry:
        ReturnType<typeof useProjectedConnectedServicesRegistry>;
    activeServer: ReturnType<typeof useActiveServerSnapshot>;
    targetSelection: MachineAdministrationTargetSelectionV1;
    onMachineRequirementChange?: (required: boolean, availability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability']) => void;
    localizePluginText: PluginLocalizedTextResolver;
    navigation: unknown;
    /**
     * Host the sign-in in a setup panel (the in-place Connect panel, its modal twin) instead of the
     * service page: the panel shows only the selected way and its Ready action or running flow,
     * and reports the connected account. Device codes require explicit intent.
     */
    panel?: ConnectedAccountSetupPanelIntent;
}>;

/** What a setup panel asks the controller for, and how it hears back. */
export type ConnectedAccountSetupPanelIntent = Readonly<{
    intent: Readonly<{ kind: 'add' }> | Readonly<{ kind: 'reconnect'; accountId: string }>;
    onConnected: (account: QualifiedConnectedAccountRef) => void;
    modeId?: string | null;
    onModeChange?: (modeId: string) => void;
    /** The registered selected mode, not its display kind, decides Machine demand. */
    onMachineRequirementChange?: (required: boolean, availability?: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability']) => void;
    /** Cancel was pressed: the sign-in has already left; the panel steps back or closes. */
    onCancel?: () => void;
}>;

const ConnectedAccountServiceController = React.memo(
    function ConnectedAccountServiceController(
        controllerProps: ConnectedAccountServiceControllerProps,
    ) {
    const {
        params,
        connectedServicesRegistry,
        activeServer,
        targetSelection,
        navigation,
    } = controllerProps;
    const locale = getPreferredLanguage();
    const profile = useProfile();
    const activeServerId = asStringParam(activeServer.serverId);
    const activeServerGeneration = activeServer.generation;
    const nativeSetup = controllerProps.panel !== undefined;
    const route = React.useMemo(
        () => resolveQualifiedConnectedAccountSettingsRoute(
            {
                pluginId: params.pluginId,
                localId: params.localId,
                serviceId: params.serviceId,
                accountId: params.accountId,
                groupId: params.groupId,
                newPool: params.newPool,
                serverId: params.serverId,
                machineId: params.machineId,
            },
            connectedServicesRegistry.entries,
            nativeSetup ? 'nativeSetup' : undefined,
        ),
        [
            connectedServicesRegistry.entries,
            nativeSetup,
            params.localId,
            params.pluginId,
            params.serviceId,
            params.accountId,
            params.groupId,
            params.newPool,
            params.serverId,
            params.machineId,
        ],
    );
    const serverId = activeServerId;
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId,
    });
    const expectedActiveServer = React.useMemo(
        () => serverId === activeServerId
            ? {
                serverId,
                generation: activeServerGeneration,
            }
            : null,
        [activeServerGeneration, activeServerId, serverId],
    );
    const servicePluginId = route?.service.pluginId ?? '';
    const serviceLocalId = route?.service.localId ?? '';
    const service = React.useMemo(
        () => servicePluginId && serviceLocalId
            ? Object.freeze({
                pluginId: servicePluginId,
                localId: serviceLocalId,
            })
            : null,
        [serviceLocalId, servicePluginId],
    );
    const registryEntry = route?.entry ?? null;
    const serviceId = registryEntry?.serviceId ?? '';
    const localizeServiceText = React.useCallback(
        (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => (
            servicePluginId ? controllerProps.localizePluginText(servicePluginId, value) : ''
        ),
        [controllerProps.localizePluginText, servicePluginId],
    );
    const parsedLegacyServiceId = ConnectedServiceIdSchema.safeParse(
        route?.legacyServiceId,
    );
    const legacyServiceId = parsedLegacyServiceId.success
        ? parsedLegacyServiceId.data
        : null;
    const exactRoute = route !== null;

    const [describedOperation, setDescribedOperation] = React.useState<Readonly<{
        description: ServiceDescription; signal: AbortSignal;
    }> | null>(null);
    const [
        serviceConfigurationStatusByModeId,
        setServiceConfigurationStatusByModeId,
    ] = React.useState<ServiceConfigurationStatusByModeId>({});
    const [attempt, setAttempt] = React.useState<ConnectedAccountAttemptResponse | null>(null);
    // Pending replies omit the already issued code. Keep only that display projection for the
    // same attempt; the daemon response remains the lifecycle authority.
    const deviceCodeRef = React.useRef<Extract<ConnectedAccountAttemptResponse, { status: 'awaitingDeviceAuthorization' }> | null>(null);
    const draftDisplayNameRef = React.useRef<string | null>(null);
    const [configuration, setConfiguration] = React.useState<ConfigurationDescription | null>(null);
    const [
        configurationContinuationAttemptId,
        setConfigurationContinuationAttemptId,
    ] = React.useState<string | null>(null);
    const [pendingIntent, setPendingIntent] = React.useState<PendingIntent | null>(null);
    const [activeModeId, setActiveModeId] = React.useState<string | null>(controllerProps.panel?.modeId ?? null);
    const declaredAuthentication = service ? getConnectedAccountAuthentication(service, connectedServicesRegistry) : null;
    const selectedSetupMode = resolveConnectedAccountSetupMode(declaredAuthentication?.modes ?? [], activeModeId);
    const panelIntent = controllerProps.panel?.intent ?? null;
    // Re-entering an Account-direct key edits it through the same Account-direct owner (convert on edit), never the daemon.
    const reconnectedAccount = panelIntent?.kind === 'reconnect' && service
        ? profile.connectedAccountsV4.find(account => account.ref.accountId === panelIntent.accountId
            && account.ref.service.pluginId === service.pluginId && account.ref.service.localId === service.localId) ?? null
        : null;
    const reconnectDirectMode = declaredAuthentication?.modes.find(mode => mode.id === reconnectedAccount?.authenticationModeId
        && isAccountDirectConnectedAccountModeV1(mode)) ?? null;
    const hasAccountDirectSetup = panelIntent?.kind === 'add'
        ? declaredAuthentication?.modes.some(isAccountDirectConnectedAccountModeV1) === true
        : reconnectDirectMode !== null;
    const accountDirectMode = panelIntent?.kind === 'add'
        ? hasAccountDirectSetup && isAccountDirectConnectedAccountModeV1(selectedSetupMode) ? selectedSetupMode : null
        : reconnectDirectMode;
    const accountDirectIdRef = React.useRef<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    // Whether the failure came from loading the sign-in (nothing changed) or from a change: one copy owner reads it.
    const [{ code: errorCode, phase: errorPhase, requestId: errorRequestId, detailsCode: errorDetailsCode }, setError] = React.useState<{
        code: string | null; phase: 'load' | 'change'; requestId?: string; detailsCode?: string;
    }>({ code: null, phase: 'change' });
    const setErrorCode = React.useCallback((code: string | null, phase: 'load' | 'change' = 'change', requestId?: string, detailsCode?: string) => {
        setError(previous => phase === 'load' && code !== null && previous.code !== null && previous.phase === 'change'
            ? previous : { code, phase, requestId, detailsCode });
    }, []);
    const panelRef = React.useRef(controllerProps.panel);
    panelRef.current = controllerProps.panel;
    // A panel starts its sign-in only once it knows no earlier attempt is waiting to be resumed.
    const [noPendingAttempt, setNoPendingAttempt] = React.useState(false);
    const panelStartedRef = React.useRef(false);
    const [retryingDescription, setRetryingDescription] = React.useState(false);
    const [targetPickerOpen, setTargetPickerOpen] = React.useState(false);
    // Advances when the setup flow is cancelled or changes method. An earlier reply
    // belongs to a sign-in the user abandoned: it is not shown, and a live attempt it
    // reports is cancelled.
    const setupAttemptEpochRef = React.useRef(0);
    const flowGenerationRef = React.useRef(0);
    const discoveredScopeRef = React.useRef<string | null>(null);
    const activeControllerRef = React.useRef(true);
    const accountLifetime = React.useMemo(
        () => captureActiveServerAccountScopeCurrentness(),
        [],
    );
    const accountAbortLifetime = React.useMemo(() => ({ controller: new AbortController() }), []);
    const getAccountSignal = React.useCallback(() => accountAbortLifetime.controller.signal, [accountAbortLifetime]);
    const operationAbortControllerRef = React.useRef<AbortController | null>(null);
    const isAccountControllerCurrent = React.useCallback(() => (
        'scope' in accountLifetime
        && activeControllerRef.current
        && !getAccountSignal().aborted
        && accountLifetime.isCurrent()
    ), [accountLifetime, getAccountSignal]);
    const assertCapturedAccountCurrent = React.useCallback(() => {
        if (!accountLifetime.isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    }, [accountLifetime]);
    React.useEffect(() => {
        // A replay renews this mounted view's interest, never a retired Account.
        if (accountAbortLifetime.controller.signal.aborted) accountAbortLifetime.controller = new AbortController();
        const controller = accountAbortLifetime.controller;
        activeControllerRef.current = true;
        const registration = accountLifetime.onRetire(() => {
            activeControllerRef.current = false;
            controller.abort();
            operationAbortControllerRef.current?.abort();
        });
        return () => {
            activeControllerRef.current = false;
            registration.dispose();
            controller.abort();
            operationAbortControllerRef.current?.abort();
        };
    }, [accountAbortLifetime, accountLifetime]);
    const onDescriptionError = React.useCallback((error: unknown) => {
        setErrorCode(readConnectedServiceSettingsErrorCode(error) ?? 'connected_account_service_description_unavailable', 'load',
            readConnectedServiceSettingsErrorRequestId(error));
    }, [setErrorCode]);
    const hasExplicitAuthenticationIntent = activeModeId !== null || panelIntent?.kind === 'reconnect' || Boolean(route?.focus);
    const selectedDescriptionMachineId = hasExplicitAuthenticationIntent
        && targetSelection.selectedTargetServerMatchesActiveAccount
        ? targetSelection.selectedTarget?.machineId : undefined;
    const accountServiceDescription = useConnectedAccountServiceDescription({
        serverId, expectedAccountId: 'scope' in accountLifetime ? accountLifetime.scope.accountId : null,
        service, selectedMachineId: selectedDescriptionMachineId, modeId: activeModeId,
        ...(expectedActiveServer ? { expectedActiveServer } : {}),
        getSignal: getAccountSignal, assertCurrent: assertCapturedAccountCurrent,
        isCurrent: isAccountControllerCurrent, onError: onDescriptionError,
        enabled: exactRoute && accountDirectMode === null,
    });
    const accountDescriptionResponse = accountServiceDescription.current?.result.description;
    const accountDescription = accountDescriptionResponse?.status === 'described' ? accountDescriptionResponse : null;
    const accountAuthenticationModes = accountServiceDescription.current?.result.accountAuthenticationModes;
    const accountModeIds = accountAuthenticationModes?.status === 'available' ? accountAuthenticationModes.modeIds : null;
    const describedAccountId = route?.focus?.kind === 'account' ? route.focus.accountId : null;
    const focusedSavedAccount = describedAccountId === null ? null : accountDescription?.accounts.find(account => account.ref.accountId === describedAccountId
        && account.ref.service.pluginId === servicePluginId && account.ref.service.localId === serviceLocalId)
        ?? profile.connectedAccountsV4.find(account => account.ref.accountId === describedAccountId
            && account.ref.service.pluginId === servicePluginId && account.ref.service.localId === serviceLocalId);
    const focusedModeId = describedAccountId !== null
        ? focusedSavedAccount?.authenticationModeId
        : reconnectedAccount?.authenticationModeId;
    const selectedAuthenticationModeId = configuration?.mode.id ?? activeModeId ?? focusedModeId
        ?? (panelIntent?.kind === 'add' || !controllerProps.panel ? selectedSetupMode?.id ?? null : null);
    const machineRequired = accountDirectMode === null && accountModeIds !== null
        && selectedAuthenticationModeId !== null && !accountModeIds.includes(selectedAuthenticationModeId);
    const hasPortableAuthenticationModes = accountModeIds !== null && accountModeIds.length > 0;
    const selectedModeIsPortable = selectedAuthenticationModeId !== null && accountModeIds?.includes(selectedAuthenticationModeId) === true;
    const browserRequiresMachine = selectedAuthenticationModeId !== null && accountAuthenticationModes?.status === 'available'
        && accountAuthenticationModes.machineRequiredModeIds?.includes(selectedAuthenticationModeId) === true;
    const resolveBrowserMachineAvailability = React.useCallback<NonNullable<MachineAdministrationTargetSelectorProps['resolveCandidateAvailability']>>((candidate) => {
        if (!browserRequiresMachine) return undefined;
        const row = targetSelection.pickerRows.find(value => machineAdministrationTargetsEqual(value.candidate.target, candidate.target));
        const support = readConnectedAccountBrowserSignInMachineSupport(row?.machine);
        if (support === 'custodian_only') return {
            detail: t('connectedServices.errors.browserSignInMachineCustodianRequired'),
            selectable: false,
            hidden: true,
        };
        if (!isMachineAdministrationCandidateSelectable(candidate)) return undefined;
        return support === 'supported' ? undefined : {
            detail: t('sessionInfo.cliVersionOutdated'),
            selectable: false,
        };
    }, [browserRequiresMachine, targetSelection.pickerRows]);
    const browserMachineAvailability = browserRequiresMachine ? resolveBrowserMachineAvailability : undefined;
    const hasOnlineBrowserMachine = browserRequiresMachine && targetSelection.pickerRows.some(row =>
        isMachineAdministrationCandidateSelectable(row.candidate)
        && readConnectedAccountBrowserSignInMachineSupport(row.machine) !== 'custodian_only');
    const hasSupportedBrowserMachine = hasOnlineBrowserMachine && targetSelection.pickerRows.some(row =>
        isMachineAdministrationCandidateSelectable(row.candidate)
        && readConnectedAccountBrowserSignInMachineSupport(row.machine) === 'supported');
    const executionTarget = machineRequired ? targetSelection.resolveExecutionTarget() : null;
    const selectedBrowserMachineSupport = browserRequiresMachine && executionTarget !== null
        ? readConnectedAccountBrowserSignInMachineSupport(executionTarget.machine) : null;
    const selectedBrowserMachineNeedsUpdate = selectedBrowserMachineSupport === 'cli_update_required';
    const machineId = targetSelection.selectedTargetServerMatchesActiveAccount
        && (selectedBrowserMachineSupport === null || selectedBrowserMachineSupport === 'supported')
        && executionTarget?.target.serverIdentityId === targetSelection.selectedTarget?.serverIdentityId
        && executionTarget?.target.machineId === targetSelection.selectedTarget?.machineId
        ? executionTarget?.machine.id ?? '' : '';
    const browserMachineUnavailableCode = !machineId && !attempt && !configuration
        && browserRequiresMachine && accountAuthenticationModes?.status === 'available'
        ? selectedBrowserMachineNeedsUpdate || hasOnlineBrowserMachine && !hasSupportedBrowserMachine
            ? 'cli_update_required' : accountAuthenticationModes.machineUnavailableCode : undefined;
    // A Machine change retires native work, but cannot retire a portable Account attempt.
    const nativeMachineId = machineRequired ? targetSelection.selectedTarget?.machineId : undefined;
    const nativeServerIdentityId = machineRequired ? targetSelection.selectedTarget?.serverIdentityId : undefined;
    const operationAbortLifetime = React.useMemo(() => ({ controller: new AbortController() }),
        [nativeMachineId, nativeServerIdentityId, serverId]);
    const getLifecycleSignal = React.useCallback(() => operationAbortLifetime.controller.signal, [operationAbortLifetime]);
    const description = machineRequired
        ? describedOperation?.signal === getLifecycleSignal() ? describedOperation.description
            : machineId && accountDescription?.operationTransport
                && accountServiceDescription.current?.machineId === machineId ? accountDescription : null
        : accountDescription;
    React.useEffect(() => {
        controllerProps.onMachineRequirementChange?.(machineRequired, browserMachineAvailability);
        controllerProps.panel?.onMachineRequirementChange?.(machineRequired, browserMachineAvailability);
    }, [controllerProps.onMachineRequirementChange, controllerProps.panel?.onMachineRequirementChange, machineRequired, browserMachineAvailability]);
    React.useEffect(() => {
        if (accountDirectMode || !accountServiceDescription.current) return;
        if (accountAuthenticationModes?.status === 'unavailable') {
            setErrorCode(accountAuthenticationModes.code, 'load');
        } else if (accountDescriptionResponse && accountDescriptionResponse.status !== 'described') {
            setErrorCode(readControlFailureCode(accountDescriptionResponse, 'connected_account_service_description_unavailable'), 'load',
                readConnectedServiceSettingsErrorRequestId(accountDescriptionResponse));
        } else {
            setErrorCode(null);
        }
    }, [accountAuthenticationModes, accountDescriptionResponse, accountDirectMode, accountServiceDescription.current, setErrorCode]);
    const isControllerCurrent = React.useCallback(() => (
        isAccountControllerCurrent() && !getLifecycleSignal().aborted
    ), [isAccountControllerCurrent, getLifecycleSignal]);
    const { completed: setupCompleted, complete: completeSetup, reset: resetSetupCompletion } = useConnectedAccountSetupCompletion({
        isCurrent: isControllerCurrent,
        onConnected: account => panelRef.current?.onConnected(account),
    });
    const actionExecution = useMountedActionExecution('scope' in accountLifetime ? accountLifetime.scope : null);
    const executeAction = actionExecution.execute;
    const labelsByKey = useConnectedMetadataCatalog('scope' in accountLifetime ? accountLifetime.scope : null, selectConnectedMetadataLabels);
    const renameAccount = React.useCallback(async (account: QualifiedConnectedAccountRef, label: string): Promise<boolean> => {
        if (!isAccountControllerCurrent() || !('scope' in accountLifetime)) return false;
        try {
            const result = await executeAction('connectedServices.accounts.rename', { account, label }, { signal: getAccountSignal() });
            if (!isAccountControllerCurrent()) return false;
            if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
            return CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.rename'].safeParse(result.result).success;
        } catch (error) {
            if (isAccountControllerCurrent()) await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
            return false;
        }
    }, [accountLifetime, executeAction, isAccountControllerCurrent, getAccountSignal]);
    const accountDirectContext = JSON.stringify([servicePluginId, serviceLocalId, accountDirectMode?.id ?? null]);
    React.useEffect(() => {
        accountDirectIdRef.current = null;
    }, [accountDirectContext]);
    const saveAccountCredential = React.useCallback(async (input: Readonly<{ fields: Readonly<Record<string, string>>; displayName?: string }>): Promise<boolean> => {
        if (!accountDirectMode || !service || !panelIntent || !isAccountControllerCurrent()) return false;
        const draftEpoch = setupAttemptEpochRef.current;
        const target = resolveAccountDirectSaveTarget({ intent: panelIntent, service, modeId: accountDirectMode.id,
            accounts: profile.connectedAccountsV4, newAccountId: () => accountDirectIdRef.current ??= randomUUID() });
        if (target.kind === 'rotate') {
            // A converted account keeps its one Saved Secret record: the new key
            // rotates that record in place through the private-resource writer.
            const secretFieldIds = new Set(listAccountDirectSecretCredentialKeysV1(accountDirectMode).values());
            const entered = Object.entries(input.fields);
            const secret = entered.length === 1 && secretFieldIds.has(entered[0]![0]) ? entered[0]![1] : null;
            if (secret === null || panelIntent.kind !== 'reconnect') { setErrorCode('connected_account_credential_changed'); return false; }
            const account = { service, accountId: panelIntent.accountId };
            setBusy(true);
            try {
                const listed = await executeAction('secrets.list', {}, { signal: getAccountSignal() });
                if (!isAccountControllerCurrent() || draftEpoch !== setupAttemptEpochRef.current) return false;
                if (!listed.ok) throw Object.assign(new Error(listed.error), { code: listed.errorCode });
                const record = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.list'].parse(listed.result).secrets
                    .find(candidate => candidate.secretId === target.resourceId);
                if (!record) throw Object.assign(new Error('connected_account_credential_secret_unavailable'), { code: 'connected_account_credential_secret_unavailable' });
                const rotated = await executeAction('secrets.update', { secretId: record.secretId, value: secret, expectedUpdatedAt: record.updatedAt },
                    { signal: getAccountSignal() });
                if (!isAccountControllerCurrent() || draftEpoch !== setupAttemptEpochRef.current) return false;
                if (!rotated.ok) throw Object.assign(new Error(rotated.error), { code: rotated.errorCode });
                if (input.displayName) await renameAccount(account, input.displayName);
                if (!isAccountControllerCurrent() || draftEpoch !== setupAttemptEpochRef.current) return false;
                setErrorCode(null);
                completeSetup(account);
                return true;
            } catch (error) {
                if (isAccountControllerCurrent() && draftEpoch === setupAttemptEpochRef.current) setErrorCode(readConnectedServiceSettingsErrorCode(error) ?? 'connected_service_request_failed');
                return false;
            } finally { if (isAccountControllerCurrent() && draftEpoch === setupAttemptEpochRef.current) setBusy(false); }
        }
        if (target.kind !== 'save') { setErrorCode('connected_account_credential_changed'); return false; }
        setBusy(true);
        try {
            const result = await executeAction('connectedServices.accounts.credentials.save', {
                account: target.account, modeId: accountDirectMode.id, fields: input.fields,
                ...(target.expectedCredentialRevision ? { expectedCredentialRevision: target.expectedCredentialRevision } : {}),
            }, { signal: getAccountSignal() });
            if (!isAccountControllerCurrent() || draftEpoch !== setupAttemptEpochRef.current) return false;
            if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
            const saved = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.credentials.save'].parse(result.result).account;
            // A personal label is a secondary presentation write. Its existing
            // visible error must not erase an acknowledged credential creation.
            if (input.displayName) await renameAccount(saved, input.displayName);
            if (!isAccountControllerCurrent() || draftEpoch !== setupAttemptEpochRef.current) return false;
            setErrorCode(null);
            completeSetup(saved);
            return true;
        } catch (error) {
            if (isAccountControllerCurrent() && draftEpoch === setupAttemptEpochRef.current) setErrorCode(readConnectedServiceSettingsErrorCode(error) ?? 'connected_service_request_failed');
            return false;
        } finally { if (isAccountControllerCurrent() && draftEpoch === setupAttemptEpochRef.current) setBusy(false); }
    }, [accountDirectMode, getAccountSignal, completeSetup, executeAction, isAccountControllerCurrent, panelIntent, profile.connectedAccountsV4, renameAccount, service]);
    React.useLayoutEffect(() => {
        if (operationAbortLifetime.controller.signal.aborted) operationAbortLifetime.controller = new AbortController();
        const controller = operationAbortLifetime.controller;
        operationAbortControllerRef.current = controller;
        // Account presentation stays mounted; only the exact machine's native work retires.
        setupAttemptEpochRef.current += 1;
        flowGenerationRef.current += 1;
        discoveredScopeRef.current = null;
        deviceCodeRef.current = null;
        draftDisplayNameRef.current = null;
        panelStartedRef.current = false;
        setDescribedOperation(null);
        setServiceConfigurationStatusByModeId({});
        setAttempt(null);
        resetSetupCompletion();
        setConfiguration(null);
        setConfigurationContinuationAttemptId(null);
        setPendingIntent(null);
        setBusy(false);
        setErrorCode(null);
        setNoPendingAttempt(false);
        setRetryingDescription(false);
        return () => controller.abort();
    }, [operationAbortLifetime, resetSetupCompletion]);
    const accountPeer = React.useMemo(() => {
        if (description?.operationTransport) {
            return {
                status: 'ready' as const,
                transport:
                    projectDaemonPeerTransport(description.operationTransport),
                errorCode: null,
            };
        }
        // No transport AND a failed description read is the only way this route
        // learns the peer cannot be resolved at all; without emitting it, the
        // groups hook would report "unsupported" for what is really a failure.
        // The raw daemon code travels as a CODE; the groups hook owns turning it
        // into copy, exactly as this screen's own error row does below.
        return errorCode
            ? {
                status: 'error' as const,
                transport: null,
                errorCode,
            }
            : {
                status: 'loading' as const,
                transport: null,
                errorCode: null,
            };
    }, [description?.operationTransport, errorCode]);
    const groups = useQualifiedConnectedAccountGroups({
        serverId,
        service,
    });
    const focusedAccountId = route?.focus?.kind === 'account' ? route.focus.accountId : null;
    const focusedPool = route?.focus?.kind === 'group';
    const machineAccounts = React.useMemo<
        readonly ConnectedAccountServiceProfile[]
    >(() => {
        const transport = description?.operationTransport;
        if (!description) return [];
        if (!transport) return description.accounts;
        if (transport.kind === 'v4') return description.accounts;
        const compatibility =
            BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
                transport.serviceId
            ];
        if (!compatibility) return [];
        const legacyService = profile.connectedServicesV2.find(
            (candidate) => candidate.serviceId === transport.serviceId,
        );
        return Object.freeze((legacyService?.profiles ?? []).map(
            (legacyProfile) => {
                const kind = legacyProfile.kind === 'oauth'
                    || legacyProfile.kind === 'token'
                    ? legacyProfile.kind
                    : null;
                const authenticationModeId = kind
                    ? readLegacyAuthenticationModeId(
                        compatibility.authenticationModeByCredentialKind,
                        kind,
                    )
                        ?? readLegacyAuthenticationModeId(
                            compatibility
                                .unsupportedAuthenticationModeByCredentialKind,
                            kind,
                        )
                        ?? null
                    : compatibility.defaultAuthenticationModeId;
                return Object.freeze({
                    ref: Object.freeze({
                        service: description.service,
                        accountId: legacyProfile.profileId,
                    }),
                    status: legacyProfile.status,
                    authenticationModeId,
                    revisionSemantics: 'legacy_unfenced' as const,
                    credentialRevision: null,
                    configurationReady: false,
                    configurationRevision: null,
                    displayName: legacyProfile.providerEmail
                        ?? legacyProfile.providerAccountId
                        ?? legacyProfile.profileId,
                    scopes: [] as string[],
                    ...(legacyProfile.expiresAt === undefined
                        ? {}
                        : { expiresAt: legacyProfile.expiresAt }),
                    ...(legacyProfile.lastUsedAt === undefined
                        ? {}
                        : { lastUsedAt: legacyProfile.lastUsedAt }),
                });
            },
        ));
    }, [description, profile.connectedServicesV2]);
    const visibleAccounts = React.useMemo<readonly ConnectedAccountServiceProfile[]>(() => {
        if (!('scope' in accountLifetime) || profile.id !== accountLifetime.scope.accountId) return machineAccounts;
        // Keep native augmentation when available; the Account profile supplies stored detail without a Machine.
        const savedAccounts = profile.connectedAccountsV4.filter(account => (focusedPool || account.ref.accountId === focusedAccountId)
            && account.ref.service.pluginId === servicePluginId && account.ref.service.localId === serviceLocalId
            && !machineAccounts.some(candidate => candidate.ref.accountId === account.ref.accountId));
        return savedAccounts.length === 0 ? machineAccounts : [...machineAccounts, ...savedAccounts];
    }, [accountLifetime, focusedAccountId, focusedPool, machineAccounts, profile.connectedAccountsV4, profile.id, serviceLocalId, servicePluginId]);
    const focusedAccountHasMachineAugmentation = focusedAccountId === null
        || machineAccounts.some(account => account.ref.accountId === focusedAccountId
            && account.ref.service.pluginId === servicePluginId
            && account.ref.service.localId === serviceLocalId);
    const accountDetailAvailable = !controllerProps.panel && (focusedPool && 'scope' in accountLifetime
        || focusedAccountId !== null && visibleAccounts.some(account => account.ref.accountId === focusedAccountId
            && account.ref.service.pluginId === servicePluginId
            && account.ref.service.localId === serviceLocalId));

    const refreshDescription = React.useCallback(async (signal: AbortSignal = getLifecycleSignal()) => {
        if (!machineRequired) return accountServiceDescription.refresh();
        if (
            !isControllerCurrent()
            || signal.aborted
            || !servicePluginId
            || !serviceLocalId
            || !serverId
            || !machineId
            || !exactRoute
            || accountDirectMode !== null
        ) return;
        const requestId = randomUUID();
        const result = await runConnectedAccountControlCommand({
            serverId,
            machineId,
            ...(expectedActiveServer ? { expectedActiveServer } : {}),
            command: {
                operation: 'describeService',
                service: {
                    pluginId: servicePluginId,
                    localId: serviceLocalId,
                },
                requiredOperation: 'account_list',
            },
            signal,
            requestId,
        });
        if (!isControllerCurrent() || signal.aborted) return;
        if (
            result.status !== 'described'
            || result.operationTransport === undefined
        ) {
            setErrorCode(readControlFailureCode(
                result,
                'connected_account_service_description_unavailable',
            ), 'load', requestId);
            return;
        }
        setDescribedOperation({ description: result, signal: getLifecycleSignal() });
        setErrorCode(null);
        return result;
    }, [
        exactRoute, accountDirectMode, machineId, machineRequired, accountServiceDescription.refresh,
        expectedActiveServer, isControllerCurrent, getLifecycleSignal, serverId, serviceLocalId, servicePluginId,
    ]);

    React.useEffect(() => {
        if (!machineRequired || description || !machineId
            || accountServiceDescription.current?.machineId !== selectedDescriptionMachineId) return;
        const request = createLinkedAbortController(getLifecycleSignal());
        void refreshDescription(request.signal).catch(error => {
            if (isControllerCurrent() && !request.signal.aborted) {
                onDescriptionError(error);
            }
        });
        return () => request.dispose();
    }, [accountServiceDescription.current, description, isControllerCurrent, getLifecycleSignal, machineId, machineRequired, onDescriptionError, refreshDescription, selectedDescriptionMachineId]);

    React.useEffect(() => {
        if (!description) return;
        const result = description;
        const request = createLinkedAbortController(getLifecycleSignal());
        const signal = request.signal;
        void Promise.all(
            result.descriptor.authentication.modes
                .filter((mode) => mode.configuration?.scope === 'service')
                .map(async (mode) => {
                    try {
                        const execution = await executeAction('connectedServices.configuration.get',
                            { service: result.service, modeId: mode.id }, { signal });
                        if (!execution.ok) throw Object.assign(new Error(execution.error), { code: execution.errorCode });
                        const configurationResult = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get'].parse(execution.result);
                        const current =
                            configurationResult.target.kind === 'service'
                            && configurationResult.target.service.pluginId
                                === result.service.pluginId
                            && configurationResult.target.service.localId
                                === result.service.localId
                            && configurationResult.target.modeId === mode.id
                            && configurationResult.mode.id === mode.id;
                        return [
                            mode.id,
                            current
                                ? configurationResult.configuration.status
                                : 'configurationRequired',
                        ] as const;
                    } catch (error) {
                        if (signal.aborted) throw error;
                        return [
                            mode.id,
                            'configurationRequired',
                        ] as const;
                    }
                }),
        ).then(entries => {
            if (!isControllerCurrent() || signal.aborted) return;
            setServiceConfigurationStatusByModeId(Object.freeze(Object.fromEntries(entries)));
        }).catch(error => {
            if (isControllerCurrent() && !signal.aborted) onDescriptionError(error);
        });
        return () => request.dispose();
    }, [description, executeAction, isControllerCurrent, getLifecycleSignal, onDescriptionError]);


    /** Cancels an abandoned attempt without showing its reply: its setup flow is gone. */
    const cancelDiscardedAttempt = React.useCallback((attemptIdToCancel: string) => {
        if (!serverId || !('scope' in accountLifetime)) return;
        void runConnectedAccountAuthenticationAction({
            serverId,
            expectedAccountId: accountLifetime.scope.accountId,
            assertCurrent: assertCapturedAccountCurrent,
            ...(expectedActiveServer ? { expectedActiveServer } : {}),
            command: { operation: 'cancel', attemptId: attemptIdToCancel },
        }).catch(() => {
            // The captured Home/machine transport still owns authentication.
            // This release outlives the setup view that just closed.
        });
    }, [accountLifetime, assertCapturedAccountCurrent, expectedActiveServer, serverId]);

    const readConfiguration = React.useCallback(async (
        target: ConnectedAccountConfigurationTarget,
        /** The setup epoch the flow that asks for this read started in (defaults to now). */
        requestEpoch: number = setupAttemptEpochRef.current,
    ): Promise<boolean> => {
        if (!isControllerCurrent() || !serverId || !('scope' in accountLifetime)
            || (target.kind === 'account' && machineRequired && !machineId)) return false;
        const execution = await executeAction('connectedServices.configuration.get', target.kind === 'service'
            ? { service: target.service, modeId: target.modeId }
            : target.kind === 'attempt' ? { target: { kind: 'attempt', attemptId: target.attemptId } }
                : { ...(machineRequired && machineId ? { machineId } : {}), target: { kind: 'account', account: target.account } },
        { signal: getLifecycleSignal() });
        if (!isControllerCurrent()) return false;
        // A form for a setup flow cancelled while it loaded is never shown.
        if (requestEpoch !== setupAttemptEpochRef.current) return false;
        if (!execution.ok) {
            setErrorCode(execution.errorCode ?? 'connected_account_configuration_unavailable', 'load');
            return false;
        }
        const result = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.get'].parse(execution.result);
        setConfiguration(result);
        setActiveModeId(result.mode.id);
        setErrorCode(null);
        return true;
    }, [executeAction, isControllerCurrent, getLifecycleSignal, machineId, machineRequired, serverId]);

    /**
     * The one place an authentication reply is applied. `requestEpoch` is the setup epoch captured
     * when the request was sent: a reply to a request sent before the setup flow was
     * cancelled belongs to the abandoned sign-in, so it is not shown and a live attempt it reports
     * is cancelled. Every caller passes the epoch it captured, so no reply path is unfenced.
     */
    const acceptAttemptResponse = React.useCallback(async (
        response: ConnectedAccountAttemptResponse,
        requestEpoch: number,
        options?: Readonly<{
            /**
             * Set by a lost-reply recovery whose exact read proved the attempt neither
             * advanced nor settled. The outcome of the lost effectful command is still
             * unknown, so the shown uncertainty must survive this response.
             */
            retainUnresolvedError?: boolean;
        }>,
    ) => {
        if (!isControllerCurrent()) return;
        if (requestEpoch !== setupAttemptEpochRef.current) {
            if ('attemptId' in response && response.attemptId) {
                cancelDiscardedAttempt(response.attemptId);
            }
            return;
        }
        if (response.status === 'awaitingDeviceAuthorization') deviceCodeRef.current = response;
        else if (response.status !== 'pending' || deviceCodeRef.current?.attemptId !== response.attemptId) deviceCodeRef.current = null;
        setAttempt(response);
        if (isTerminalAttempt(response)) {
            if (response.status === 'connected' || response.status === 'cancelled') {
                setPendingIntent(null);
            }
            setConfigurationContinuationAttemptId(null);
        }
        if (response.status === 'configurationRequired') {
            setConfigurationContinuationAttemptId(
                response.attemptId ?? null,
            );
            await readConfiguration(response.target, requestEpoch);
            return;
        }
        if (response.status === 'connected') {
            cancelDiscardedAttempt(response.attemptId);
            if (draftDisplayNameRef.current) {
                await renameAccount(response.account, draftDisplayNameRef.current);
            }
            if (!isControllerCurrent()) return;
            draftDisplayNameRef.current = null;
            setAttempt(null);
            setConfiguration(null);
            completeSetup(response.account);
            // The new account joins the Collection; the setup flow closes.
            await refreshDescription();
            return;
        }
        if (
            response.status === 'rejected'
            || response.status === 'unavailable'
            || response.status === 'conflict'
            || response.status === 'reconnectRequired'
            || response.status === 'cleanupPending'
        ) {
            setErrorCode(response.code, 'change', readConnectedServiceSettingsErrorRequestId(response),
                readConnectedServiceSettingsErrorDetailsCode(response) ?? undefined);
        } else if (response.status === 'outcomeUnknown') {
            setErrorCode('connected_account_authentication_outcome_unknown', 'change', readConnectedServiceSettingsErrorRequestId(response),
                readConnectedServiceSettingsErrorDetailsCode(response) ?? undefined);
        } else if (!options?.retainUnresolvedError) {
            setErrorCode(null);
        }
    }, [cancelDiscardedAttempt, completeSetup, isControllerCurrent, readConfiguration, refreshDescription, renameAccount]);

    React.useEffect(() => {
        if (panelIntent?.kind === 'add' && !hasExplicitAuthenticationIntent) return;
        if (!description || !service || !serverId || machineRequired && !machineId || attempt || busy) return;
        const scopeKey = JSON.stringify([serverId, machineRequired ? machineId : null, service.pluginId, service.localId]);
        if (discoveredScopeRef.current === scopeKey) return;
        discoveredScopeRef.current = scopeKey;
        const generation = flowGenerationRef.current;
        const requestEpoch = setupAttemptEpochRef.current;
        const request = createLinkedAbortController(getLifecycleSignal());
        let completed = false;
        void (async () => {
            if (!('scope' in accountLifetime)) return;
            const listed = await listPendingConnectedAccountAuthenticationActions({
                serverId,
                ...(machineRequired && machineId ? { machineId } : {}),
                expectedAccountId: accountLifetime.scope.accountId,
                executeAction,
                assertCurrent: assertCapturedAccountCurrent,
                ...(expectedActiveServer ? { expectedActiveServer } : {}),
                service,
                signal: request.signal,
            });
            if (!isControllerCurrent() || request.signal.aborted || generation !== flowGenerationRef.current) return;
            if (listed.status !== 'pendingAttempts') {
                discoveredScopeRef.current = null;
                setErrorCode(readControlFailureCode(listed, 'connected_account_attempt_discovery_unavailable'), 'load',
                    readConnectedServiceSettingsErrorRequestId(listed));
                return;
            }
            const pending = listed.attempts[0];
            if (!pending) {
                completed = true;
                setNoPendingAttempt(true);
                return;
            }
            const response = await runConnectedAccountAuthenticationAction({
                serverId,
                expectedAccountId: accountLifetime.scope.accountId,
                executeAction,
                assertCurrent: assertCapturedAccountCurrent,
                ...(expectedActiveServer ? { expectedActiveServer } : {}),
                command: pending.kind === 'device'
                    ? { operation: 'resumeDevice', attemptId: pending.attemptId }
                    : { operation: 'read', attemptId: pending.attemptId },
                signal: request.signal,
            });
            if (!isControllerCurrent() || request.signal.aborted || generation !== flowGenerationRef.current) return;
            // Manual forms are host-local. If their owner is gone, the explicit Add
            // intent opens a fresh form; beginning it never submits old credentials.
            if (panelIntent?.kind === 'add' && pending.intent === 'connect' && pending.kind === 'manual'
                && response.status === 'unavailable' && response.code === 'connected_account_attempt_not_found') {
                completed = true;
                setNoPendingAttempt(true);
                return;
            }
            setActiveModeId(pending.modeId);
            // Restored connects retain the same intent as a fresh begin, including after expiry.
            if (pending.intent === 'connect') {
                setPendingIntent({ kind: 'connect', service, modeId: pending.modeId });
            }
            await acceptAttemptResponse(response, requestEpoch);
            completed = true;
        })().catch((error) => {
            if (isControllerCurrent() && !request.signal.aborted && generation === flowGenerationRef.current) {
                discoveredScopeRef.current = null;
                setErrorCode(readConnectedServiceSettingsErrorCode(error) ?? 'connected_account_attempt_discovery_unavailable', 'load',
                    readConnectedServiceSettingsErrorRequestId(error));
            }
        });
        return () => {
            request.dispose();
            if (!completed && discoveredScopeRef.current === scopeKey) {
                discoveredScopeRef.current = null;
            }
        };
    }, [acceptAttemptResponse, accountLifetime, assertCapturedAccountCurrent, attempt, busy, description, executeAction, expectedActiveServer, hasExplicitAuthenticationIntent, isControllerCurrent, getLifecycleSignal, machineId, machineRequired, panelIntent?.kind, serverId, service]);

    const runAuthentication = React.useCallback(async (
        command: Parameters<typeof runConnectedAccountAuthenticationAction>[0]['command'],
    ): Promise<boolean> => {
        if (!('scope' in accountLifetime) || !isControllerCurrent() || !serverId) return false;
        const beginModeId = command.operation === 'beginConnect' ? command.modeId
            : command.operation === 'beginReconnect' ? visibleAccounts.find(account => account.ref.accountId === command.account.accountId
                && account.ref.service.pluginId === command.account.service.pluginId
                && account.ref.service.localId === command.account.service.localId)?.authenticationModeId : null;
        const nativeBegin = beginModeId !== null && beginModeId !== undefined && accountModeIds !== null
            && !accountModeIds.includes(beginModeId);
        if (nativeBegin && !machineId) return false;
        const draftEpoch = setupAttemptEpochRef.current;
        setBusy(true);
        try {
            const response = await runConnectedAccountAuthenticationAction({
                serverId,
                ...(nativeBegin && machineId ? { machineId } : {}),
                expectedAccountId: accountLifetime.scope.accountId,
                executeAction,
                assertCurrent: assertCapturedAccountCurrent,
                ...(expectedActiveServer ? { expectedActiveServer } : {}),
                command,
                signal: getLifecycleSignal(),
            });
            if (!isControllerCurrent()) return false;
            await acceptAttemptResponse(response, draftEpoch);
            return isControllerCurrent() && draftEpoch === setupAttemptEpochRef.current;
        } catch (error) {
            if (!isControllerCurrent()) return false;
            setErrorCode(readConnectedServiceSettingsErrorCode(error) ?? 'connected_account_daemon_unavailable',
                command.operation === 'beginConnect' || command.operation === 'beginReconnect' ? 'load' : 'change',
                readConnectedServiceSettingsErrorRequestId(error));
            return false;
        } finally {
            if (isControllerCurrent()) setBusy(false);
        }
    }, [
        acceptAttemptResponse,
        accountLifetime,
        assertCapturedAccountCurrent,
        executeAction,
        expectedActiveServer,
        isControllerCurrent,
        getLifecycleSignal,
        machineId,
        accountModeIds,
        visibleAccounts,
        serverId,
    ]);

    const beginIntent = React.useCallback(async (
        intent: PendingIntent,
        expectedConfigurationRevision?: string,
    ) => {
        if (!isControllerCurrent()) return;
        flowGenerationRef.current += 1;
        setPendingIntent(intent);
        // A fresh begin starts the flow over; the begin that follows a saved settings step keeps it.
        if (intent.kind === 'connect') {
            setActiveModeId(intent.modeId);
            await runAuthentication({
                operation: 'beginConnect',
                service: intent.service,
                modeId: intent.modeId,
                ...(expectedConfigurationRevision
                    ? { expectedConfigurationRevision }
                    : {}),
            });
            return;
        }
        const account = visibleAccounts.find((candidate) => (
            candidate.ref.accountId === intent.account.accountId
            && candidate.ref.service.pluginId === intent.account.service.pluginId
            && candidate.ref.service.localId === intent.account.service.localId
        ));
        setActiveModeId(account?.authenticationModeId ?? null);
        await runAuthentication({
            operation: 'beginReconnect',
            account: intent.account,
            ...(expectedConfigurationRevision
                ? { expectedConfigurationRevision }
            : {}),
        });
    }, [isControllerCurrent, runAuthentication, visibleAccounts]);

    const retryDescription = React.useCallback(async () => {
        if (!isControllerCurrent() || retryingDescription || !('scope' in accountLifetime)) return;
        setRetryingDescription(true);
        try {
            // A known rejection is finished. Retry starts the same intent with a fresh form;
            // uncertain transport outcomes still recover the exact existing attempt below.
            if (pendingIntent && attempt && (isTerminalAttempt(attempt) || attempt.status === 'reconnectRequired')) {
                if ('attemptId' in attempt && attempt.attemptId) cancelDiscardedAttempt(attempt.attemptId);
                const refreshed = await refreshDescription();
                if (!refreshed) return;
                await beginIntent(pendingIntent);
                return;
            }
            const recoverableAttemptId = attempt && 'attemptId' in attempt
                ? attempt.attemptId
                : null;
            if (recoverableAttemptId && serverId) {
                const requestEpoch = setupAttemptEpochRef.current;
                const response = await runConnectedAccountAuthenticationAction({
                    serverId,
                    expectedAccountId: accountLifetime.scope.accountId,
                    executeAction,
                    assertCurrent: assertCapturedAccountCurrent,
                    ...(expectedActiveServer ? { expectedActiveServer } : {}),
                    command: { operation: 'read', attemptId: recoverableAttemptId },
                    signal: getLifecycleSignal(),
                });
                if (!isControllerCurrent()) return;
                // An unchanged non-terminal read does not resolve a lost effectful reply.
                await acceptAttemptResponse(response, requestEpoch, {
                    retainUnresolvedError: !isTerminalAttempt(response) && attempt !== null && response.status === attempt.status,
                });
                return;
            }
            await refreshDescription();
        } catch (error) {
            if (isControllerCurrent()) setErrorCode(readConnectedServiceSettingsErrorCode(error) ?? 'connected_account_daemon_unavailable', errorPhase,
                readConnectedServiceSettingsErrorRequestId(error));
        } finally {
            if (isControllerCurrent()) setRetryingDescription(false);
        }
    }, [acceptAttemptResponse, accountLifetime, assertCapturedAccountCurrent, attempt, beginIntent, cancelDiscardedAttempt, errorPhase, executeAction, expectedActiveServer, isControllerCurrent, getLifecycleSignal,
        pendingIntent, refreshDescription, retryingDescription, serverId]);

    const activeMode: PluginConnectedAccountAuthenticationModeV2 | null =
        configuration?.mode ?? description?.descriptor.authentication.modes.find(
            (candidate) => candidate.id === activeModeId,
        ) ?? accountDirectMode;
    const activeModeKind = activeMode?.kind ?? null;

    React.useEffect(() => {
        if (!attempt || busy) return;
        const attemptId = 'attemptId' in attempt ? attempt.attemptId : undefined;
        if (!attemptId) return;
        if (attempt.status !== 'starting' && attempt.status !== 'pending' && attempt.status !== 'awaitingDeviceAuthorization') return;
        if (attempt.status === 'awaitingDeviceAuthorization' && (attempt.pollIntervalMs === undefined || (attempt.expiresAtMs !== undefined && attempt.expiresAtMs <= Date.now()))) return;
        if (attempt.status === 'pending' && activeModeKind === 'oauthDeviceCode' && deviceCodeRef.current?.expiresAtMs !== undefined && deviceCodeRef.current.expiresAtMs <= Date.now()) return;
        if (attempt.status === 'pending' && activeModeKind === null) return;
        const delayMs = attempt.status === 'awaitingDeviceAuthorization'
            ? attempt.pollIntervalMs
            : attempt.status === 'pending'
            ? Math.max(250, attempt.retryAfterMs)
            : 250;
        const timeout = setTimeout(() => {
            void runAuthentication(
                attempt.status === 'awaitingDeviceAuthorization' || attempt.status === 'pending'
                    ? {
                        operation: attempt.status === 'awaitingDeviceAuthorization' || activeModeKind === 'oauthDeviceCode'
                            ? 'pollDevice'
                            : 'reconcile',
                        attemptId,
                    }
                    : { operation: 'read', attemptId },
            );
        }, delayMs);
        return () => clearTimeout(timeout);
    }, [activeModeKind, attempt, busy, runAuthentication]);

    // Opening a device-code draft selects its recommended method, but issuing a code requires
    // explicit intent (R8-9). Other forms and an explicitly requested reconnect retain their owner.
    React.useEffect(() => {
        const panel = panelRef.current;
        if (!panel || accountDirectMode || panelStartedRef.current || !service || !description || machineRequired && !machineId || attempt || busy || !noPendingAttempt) return;
        const modes = description.descriptor.authentication.modes;
        if (panel.intent.kind === 'reconnect') {
            panelStartedRef.current = true;
            void beginIntent({ kind: 'reconnect', account: { service, accountId: panel.intent.accountId } });
            return;
        }
        const recommended = modes.find(mode => mode.id === activeModeId) ?? rankConnectedAccountSetupModes(modes)[0]?.mode;
        if (!recommended) return;
        // Ranking is presentation; starting or restoring requires a method choice.
        if (!hasExplicitAuthenticationIntent) return;
        panelStartedRef.current = true;
        if (recommended.kind === 'oauthDeviceCode') {
            setActiveModeId(recommended.id);
            return;
        }
        void beginIntent({ kind: 'connect', service, modeId: recommended.id });
    }, [accountDirectMode, activeModeId, attempt, beginIntent, busy, description, hasExplicitAuthenticationIntent, machineId, machineRequired, noPendingAttempt, service]);

    /** Shared Action approval owns revocation; a deferred review retains this account. */
    const revokeAccount = React.useCallback(async (
        profile: ConnectedAccountServiceProfile,
    ): Promise<boolean> => {
        if (!isControllerCurrent() || !('scope' in accountLifetime) || profile.revisionSemantics !== 'revisioned') return false;
        // Bind the incarnation the person was viewing, not a fresh post-approval read.
        const account = profile.ref;
        const expectedCredentialRevision = profile.credentialRevision;
        const revoke = async (cleanupGroupReferences: boolean, managedResourceDispositions?: ManagedResourceDispositionV1[]) => {
            try {
                const result = await executeAction('connectedServices.accounts.revoke', {
                    ...(machineId && focusedAccountHasMachineAugmentation ? { machineId } : {}), account, expectedCredentialRevision, cleanupGroupReferences,
                    ...(managedResourceDispositions ? { managedResourceDispositions } : {}),
                }, { signal: getLifecycleSignal() });
                if (!isControllerCurrent()) return null;
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                const reply = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].safeParse(result.result);
                // Approval receipts are not native settlement and must not remove the detail.
                return reply.success ? reply.data : null;
            } catch (error) {
                // Peers report this conflict either as a thrown failure or as a
                // `conflict` response; normalize to the response shape so the
                // cleanup decision below reads exactly one of them.
                if (isConnectedServiceCredentialReferencedByGroupError(error)) {
                    return {
                        status: 'conflict' as const,
                        code: 'connect_credential_referenced_by_group',
                    };
                }
                throw error;
            }
        };

        setBusy(true);
        try {
            let cleanupGroupReferences = false;
            let managedResourceDispositions: ManagedResourceDispositionV1[] | undefined;
            let result = await revoke(cleanupGroupReferences);
            if (!result || !isControllerCurrent()) return false;
            while (result.status === 'removalReviewRequired' || isConnectedServiceCredentialReferencedByGroupError(result)) {
                if (result.status === 'removalReviewRequired') {
                    const dispositions = await reviewManagedResourceRemoval(result.resources);
                    if (!dispositions || !isControllerCurrent()) return false;
                    managedResourceDispositions = dispositions;
                    result = await revoke(cleanupGroupReferences, managedResourceDispositions);
                    if (!result || !isControllerCurrent()) return false;
                    continue;
                }
                if (cleanupGroupReferences) break;
                const cleanupConfirmed = await Modal.confirm(
                    t('modals.disconnect'),
                    t('connectedServices.errors.credentialReferencedByGroup'),
                    {
                        confirmText: t('modals.disconnect'),
                        cancelText: t('common.cancel'),
                    },
                );
                if (!cleanupConfirmed || !isControllerCurrent()) return false;
                cleanupGroupReferences = true;
                result = await revoke(cleanupGroupReferences, managedResourceDispositions);
                if (!result || !isControllerCurrent()) return false;
            }
            if (result.status === 'revoked') {
                if (result.remoteStatus === 'remoteNotAttempted') {
                    Modal.alert(t('connectedServicesSettings.detailRemoveAccount'), t('connectedServicesSettings.detailRemoteSignOutUnconfirmed'));
                }
                return true;
            }
            setErrorCode(
                result.status === 'outcomeUnknown'
                    ? 'connected_account_revoke_outcome_unknown'
                    : readControlFailureCode(
                        result,
                        'connected_account_revoke_unavailable',
                    ),
            );
            return false;
        } catch (error) {
            if (!isControllerCurrent()) return false;
            setErrorCode(
                readConnectedServiceSettingsErrorCode(error)
                ?? 'connected_account_daemon_unavailable',
            );
            return false;
        } finally {
            if (isControllerCurrent()) setBusy(false);
        }
    }, [
        accountLifetime,
        executeAction,
        isControllerCurrent,
        getLifecycleSignal,
        machineId,
        focusedAccountHasMachineAugmentation,
        serverId,
    ]);

    if (controllerProps.panel && (!exactRoute || !service)) {
        return <ConnectedServiceSetupFlowBody state={connectedServicesRegistry.status === 'loading' ? 'preparing' : 'unknownService'} />;
    }
    if (!exactRoute || !service) {
        return (
            <ItemList>
                <SettingsPageHeader title={t('settings.connectedServices')} alwaysShowTitle />
                <ItemGroup>
                    <Item
                        title={t('connectedServices.detail.unknownService')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const serviceHeader = (headerTitle: string, machineChip = true) => (
        <SettingsPageHeader
            testID="connected-account-service-header"
            title={headerTitle}
            alwaysShowTitle
            leading={<ConnectedServiceMark legacyServiceId={legacyServiceId} size="page" />}
            description={t('connectedServicesSettings.servicePurpose', { service: headerTitle })}
            actions={machineChip ? (
                <MachineAdministrationTargetSelector
                    selection={targetSelection}
                    resolveCandidateAvailability={browserMachineAvailability}
                    presentation="chip"
                    testIDPrefix="connected-account-target"
                    chipOpen={targetPickerOpen}
                    onChipOpenChange={setTargetPickerOpen}
                />
            ) : undefined}
        />
    );

    const browserMachineRequirementMessage = browserMachineUnavailableCode
        ? browserMachineUnavailableCode === 'cli_update_required' || !hasOnlineBrowserMachine
            ? resolveConnectedServiceSettingsErrorMessage({ code: browserMachineUnavailableCode })
            : t('connectedServicesSettings.setupChooseMachine') : undefined;
    const machineRequirement = browserMachineRequirementMessage ? <SurfaceStateCard
        testID="connected-account-browser-machine-unavailable"
        size="line" kind="unavailable"
        title={browserMachineRequirementMessage}
    /> : <ConnectedServiceSetupFlowBody state="chooseMachine" />;

    if (controllerProps.panel && !hasAccountDirectSetup && !hasPortableAuthenticationModes
        && !browserMachineUnavailableCode && machineRequired && (!serverId || !machineId) && !description && !errorCode) {
        return <ConnectedServiceSetupFlowBody state="chooseMachine" />;
    }
    if (!hasAccountDirectSetup && machineRequired && (!serverId || !machineId) && !accountDetailAvailable && !description && !errorCode) {
        const pendingTitle = registryEntry
            ? resolveConnectedServiceRegistryEntryDisplayName(registryEntry, t, controllerProps.localizePluginText)
            : t('connectedServices.fallbackName');
        if (targetSelection.selectedTarget && !targetSelection.selectedTargetServerMatchesActiveAccount) {
            return <ItemList>{serviceHeader(pendingTitle)}<ItemGroup><Item
                testID="connected-account-account-scope-mismatch" mode="info"
                title={t('connectedServices.accountScopeMismatchTitle')}
                subtitle={t('connectedServices.accountScopeMismatchDescription')} showChevron={false}
            /></ItemGroup></ItemList>;
        }
        // The same one quiet machine line as an account's page, with its own chooser (lab csvc nomachine).
        return (
            <ItemList>
                {serviceHeader(pendingTitle, false)}
                <MachineScopedSection
                    selection={targetSelection}
                    resolveCandidateAvailability={browserMachineAvailability}
                    unselectedInvitation={browserMachineRequirementMessage
                        ? browserMachineRequirementMessage
                        : t('connectedServicesSettings.chooseMachineDescription')}
                    testIDPrefix="connected-account-target"
                >
                    {/* A chosen machine whose inventory has not answered yet is not usable yet. */}
                    {browserMachineUnavailableCode ? machineRequirement
                        : <SurfaceStateCard testID="connected-account-target.state" size="line" kind="loading" title={t('common.loading')} />}
                </MachineScopedSection>
            </ItemList>
        );
    }

    const title = resolveProjectedLocalizedText(description?.descriptor.title, localizeServiceText)
        || (registryEntry
            ? resolveConnectedServiceRegistryEntryDisplayName(registryEntry, t, controllerProps.localizePluginText)
            : t('connectedServices.fallbackName'));
    // ONE projection of the daemon transport (the `accountPeer` memo) answers
    // every peer-capability question on this route, so a second copy cannot drift
    // into a different peer-class answer.
    const peerTransport = accountPeer.transport;
    const supportsOperation = (
        operation: BuiltInLegacyConnectedAccountOperation,
    ): boolean => {
        if (!peerTransport) return false;
        if (peerTransport.protocol === 'v4') return true;
        return isQualifiedConnectedAccountLegacyOperationSupported({
            service,
            legacyServiceId: peerTransport.legacyServiceId,
            peerClass: peerTransport.peerClass,
            operation,
        });
    };
    const transport = description?.operationTransport;
    const descriptorModes =
        description?.descriptor.authentication.modes ?? declaredAuthentication?.modes ?? registryEntry?.authenticationModes ?? [];
    const mutationModes = hasAccountDirectSetup || hasPortableAuthenticationModes || transport?.kind === 'v4'
        ? descriptorModes
        : transport?.kind === 'legacy'
            && transport.peerClass === 'revisioned_v2_v3'
            && descriptorModes.length === 1
            ? descriptorModes.filter((mode) => {
                const compatibility =
                    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
                        transport.serviceId
                    ];
                return compatibility
                    ? (
                        Object.values(
                            compatibility.authenticationModeByCredentialKind,
                        ) as readonly string[]
                    ).includes(mode.id)
                    : false;
            })
            : [];
    const legacyMutationModeIds = new Set(
        mutationModes.map((mode) => mode.id),
    );
    const credentialWriteAllowed = hasAccountDirectSetup || selectedModeIsPortable || supportsOperation('credential_write')
        && focusedAccountHasMachineAugmentation
        && (
            transport?.kind === 'v4'
            || legacyMutationModeIds.size === 1
        );
    const attemptId = attempt && 'attemptId' in attempt ? attempt.attemptId : null;
    const accountLabels = Object.fromEntries(visibleAccounts.filter((account) => (
        account.ref.service.pluginId === service.pluginId
        && account.ref.service.localId === service.localId
    )).map((account) => [
        account.ref.accountId,
        resolveQualifiedConnectedAccountLabel({
            service,
            accountId: account.ref.accountId,
            labelsByKey,
        }) ?? undefined,
    ]));

    /**
     * A focused detail screen (account or pool) renders its OWN scroll
     * container, so this route must not nest it inside another list. An account
     * retains its identity and facts while signing in; its Sign-in slot hosts
     * the same controller's flow. Other focused routes retain their existing flow owner.
     */
    const authenticationFlowActive = Boolean(attempt || configuration || (errorCode && !accountDetailAvailable));
    const focusedScreenOwnsScroll = (description !== null || accountDetailAvailable)
        && route.focus !== null
        && (route.focus.kind === 'account' || !authenticationFlowActive);

    /** Changing the setup method abandons and cancels the current sign-in. */
    const cancelSetupAttempt = () => {
        resetSetupCompletion();
        // Explicit abandonment also retires a discovered attempt. Keep the panel's automatic
        // initialization retired, while allowing a later explicit device-code request.
        panelStartedRef.current = true;
        setNoPendingAttempt(true);
        flowGenerationRef.current += 1;
        // Every reply still on its way now belongs to the abandoned sign-in (see `runAuthentication`).
        setupAttemptEpochRef.current += 1;
        setConfiguration(null);
        setPendingIntent(null);
        setConfigurationContinuationAttemptId(null);
        setErrorCode(null);
        setAttempt(null);
        deviceCodeRef.current = null;
        draftDisplayNameRef.current = null;
        accountDirectIdRef.current = null;
        setBusy(false);
        if (attemptId && attempt) {
            cancelDiscardedAttempt(attemptId);
        }
    };

    /**
     * A setup panel's Cancel is local: the sign-in leaves at once and the panel steps back, whatever
     * the machine is doing. The same cancellation owner releases a running attempt in the
     * background (never awaited, its reply never shown), so it is not offered for resume next time.
     */
    const cancelPanelFlow = () => {
        cancelSetupAttempt();
        panelRef.current?.onCancel?.();
    };
    const panelCancel = controllerProps.panel || route.focus?.kind === 'account' ? cancelPanelFlow : undefined;

    /**
     * The running sign-in or configuration flow (forms, progress, recovery). A new account's flow
     * runs inside the setup panel (`embedded`); reconnecting and configuring an existing
     * account or the service run as page sections.
     */
    const visibleDeviceCode = attempt?.status === 'awaitingDeviceAuthorization' ? attempt
        : attempt?.status === 'pending' && activeModeKind === 'oauthDeviceCode' && deviceCodeRef.current?.attemptId === attempt.attemptId ? deviceCodeRef.current : null;
    const setupPresentation = service ? getConnectedServiceSetupPresentation(service) : null;
    const manualGuide = setupPresentation && 'manual' in setupPresentation ? setupPresentation.manual : null;
    const setupError = errorCode ? {
        code: errorCode,
        status: attempt && 'code' in attempt && attempt.code === errorCode ? attempt.status : undefined,
    } : null;
    const renderFlow = (embedded: boolean) => (
        <>
            {(attempt?.status === 'awaitingManual' || accountDirectMode && !setupCompleted) && activeMode?.kind === 'manual' ? (
                <ConnectedAccountManualForm
                    embedded={embedded}
                    key={attempt && 'attemptId' in attempt ? attempt.attemptId : `account-direct:${activeMode.id}`}
                    title={resolveProjectedLocalizedText(activeMode.title, localizeServiceText) || title}
                    localize={localizeServiceText}
                    fields={activeMode.fields}
                    guided={manualGuide ? { consoleUrl: manualGuide.consoleUrl, createKeyTitle: t(manualGuide.createKeyTitleKey),
                        billingNote: t(manualGuide.billingNoteKey), shapeHint: t(manualGuide.shapeHintKey) } : undefined}
                    submitting={busy}
                    navigation={navigation}
                    onCancel={panelCancel}
                    onSubmit={({ fields, displayName }) => {
                        if (accountDirectMode) return saveAccountCredential({ fields, ...(displayName ? { displayName } : {}) });
                        if (attempt?.status !== 'awaitingManual') return false;
                        draftDisplayNameRef.current = displayName ?? null;
                        return runAuthentication({ operation: 'submitManual', attemptId: attempt.attemptId, fields });
                    }}
                />
            ) : null}

            {attempt?.status === 'awaitingOAuth' ? (
                <ConnectedAccountOAuthForm
                    embedded={embedded}
                    key={attempt.attemptId}
                    authorizationUrl={attempt.authorizationUrl ?? ''}
                    callbackUrl={attempt.callbackUrl}
                    allowRawAuthorizationCode={activeMode?.kind === 'oauthAuthorizationCode' && activeMode.allowRawAuthorizationCode === true}
                    submitting={busy}
                    navigation={navigation}
                    onCancel={panelCancel}
                    onSubmit={(completion) => runAuthentication({
                        operation: 'completeOAuth',
                        attemptId: attempt.attemptId,
                        completion,
                    })}
                />
            ) : null}

            {visibleDeviceCode ? (
                <ConnectedAccountDeviceForm
                    embedded={embedded}
                    key={visibleDeviceCode.attemptId}
                    verificationUri={visibleDeviceCode.verificationUri}
                    verificationUriComplete={visibleDeviceCode.verificationUriComplete}
                    userCode={visibleDeviceCode.userCode}
                    expiresAtMs={visibleDeviceCode.expiresAtMs}
                    serviceTitle={title}
                    busy={busy}
                    automaticPolling={visibleDeviceCode.pollIntervalMs !== undefined || attempt?.status === 'pending'}
                    onCancel={panelCancel}
                    onPoll={async () => {
                        await runAuthentication({
                            operation: 'pollDevice',
                            attemptId: visibleDeviceCode.attemptId,
                        });
                    }}
                    onResume={async () => {
                        await runAuthentication({
                            operation: 'resumeDevice',
                            attemptId: visibleDeviceCode.attemptId,
                        });
                    }}
                />
            ) : null}

            {configuration && activeMode?.configuration ? (
                <ConnectedAccountConfigurationForm
                    embedded={embedded}
                    key={`${JSON.stringify(configuration.target)}:${configuration.configuration.revision ?? 'new'}`}
                    title={resolveProjectedLocalizedText(activeMode.title, localizeServiceText) || title}
                    localize={localizeServiceText}
                    fields={activeMode.configuration.fields}
                    values={configuration.configuration.values}
                    configuredSecretFieldIds={
                        configuration.configuration.configuredSecretFieldIds
                    }
                    saving={busy}
                    navigation={navigation}
                    onSubmit={async ({ values, secretValues }) => {
                        if (!isControllerCurrent() || !('scope' in accountLifetime)) return false;
                        if (configuration.target.kind === 'account' && machineRequired && !machineId) return false;
                        // Replies to this submit belong to the draft as it is now (see `acceptAttemptResponse`).
                        const requestEpoch = setupAttemptEpochRef.current;
                        setBusy(true);
                        try {
                            const replacement = await executeAction('connectedServices.configuration.replace', {
                                    ...(configuration.target.kind === 'service'
                                        ? { service: configuration.target.service, modeId: configuration.target.modeId }
                                        : configuration.target.kind === 'attempt'
                                            ? { target: { kind: 'attempt', attemptId: configuration.target.attemptId } }
                                            : { ...(machineRequired && machineId ? { machineId } : {}),
                                                target: { kind: 'account', account: configuration.target.account } }),
                                    expectedRevision: configuration.configuration.revision,
                                    values,
                                    secretValues,
                                }, { signal: getLifecycleSignal() });
                            if (!isControllerCurrent()) return false;
                            // Discarded while saving: the abandoned attempt is not continued.
                            if (requestEpoch !== setupAttemptEpochRef.current) return false;
                            if (!replacement.ok) {
                                setErrorCode(replacement.errorCode ?? 'connected_account_configuration_unavailable');
                                return false;
                            }
                            const committed = CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.configuration.replace'].parse(replacement.result);
                            setConfiguration(null);
                            const revision = committed.revision;
                            const changeBehavior =
                                configuration.mode.configuration?.changeBehavior;
                            if (configurationContinuationAttemptId) {
                                await acceptAttemptResponse(
                                    await runConnectedAccountAuthenticationAction({
                                        serverId,
                                        expectedAccountId: accountLifetime.scope.accountId,
                                        executeAction,
                                        assertCurrent: assertCapturedAccountCurrent,
                                        ...(expectedActiveServer ? { expectedActiveServer } : {}),
                                        command: {
                                            operation: 'continueConnect',
                                            attemptId:
                                                configurationContinuationAttemptId,
                                            ...(revision
                                                ? { expectedConfigurationRevision: revision }
                                                : {}),
                                        },
                                        signal: getLifecycleSignal(),
                                    }),
                                    requestEpoch,
                                );
                                if (!isControllerCurrent() || requestEpoch !== setupAttemptEpochRef.current) return false;
                            } else if (pendingIntent) {
                                await beginIntent(pendingIntent, revision);
                            } else {
                                await refreshDescription();
                                if (changeBehavior) {
                                    await Modal.alert(
                                        t('connectedServices.account.configurationUpdatedTitle'),
                                        changeBehavior === 'refresh'
                                            ? t('connectedServices.account.configurationRefreshApplied')
                                            : t('connectedServices.account.configurationReconnectApplied'),
                                    );
                                }
                            }
                            return isControllerCurrent();
                        } catch {
                            if (!isControllerCurrent()) return false;
                            setErrorCode('connected_account_configuration_unavailable');
                            return false;
                        } finally {
                            if (isControllerCurrent()) setBusy(false);
                        }
                    }}
                />
            ) : null}

            {attempt?.status === 'outcomeUnknown' ? (panelCancel ? (
                <ConnectedServiceSetupFlowActions
                    onCancel={panelCancel}
                    primary={{
                        testID: 'connected-account:reconcile',
                        label: t('common.retry'),
                        disabled: busy,
                        onPress: () => void runAuthentication({ operation: 'reconcile', attemptId: attempt.attemptId }),
                    }}
                />
            ) : (
                <ConnectedAccountFormSection embedded={embedded} title={t('connectedServices.detail.actionsGroupTitle')}>
                    <Item
                        testID="connected-account:reconcile"
                        title={t('common.retry')}
                        disabled={busy}
                        onPress={() => {
                            void runAuthentication({
                                operation: 'reconcile',
                                attemptId: attempt.attemptId,
                            });
                        }}
                    />
                </ConnectedAccountFormSection>
            )) : null}

            {errorCode ? (
                // One failure line with its one next step, through the shared state owner.
                <ConnectedAccountFormSection embedded={embedded}>
                    <SurfaceStateCard
                        testID="connected-account:error"
                        size="line"
                        kind="error"
                        // ONE owner turns a daemon error code into copy, so this
                        // screen never re-decides which failures are explainable.
                        title={resolveConnectedServiceSettingsErrorMessage(setupError, errorPhase === 'load' ? { phase: 'load', serviceName: title } : undefined)}
                        action={{
                            label: resolveConnectedServiceSettingsErrorRecovery(setupError) === 'edit' ? t('common.edit') : t('common.retry'),
                            testID: 'connected-account:error:retry',
                            busy: retryingDescription,
                            disabled: busy || retryingDescription,
                            onPress: () => { if (accountDirectMode) setErrorCode(null); else void retryDescription(); },
                        }}
                        // One row: Details sits beside Retry on the trailing edge; it opens the typed code and the
                        // request identity, never provider prose. A new failure starts it closed.
                        key={`${errorDetailsCode ?? errorCode}:${errorRequestId ?? attemptId ?? ''}`}
                        diagnosticCode={errorDetailsCode ?? errorCode}
                        diagnosticDetail={errorRequestId ?? attemptId}
                    />
                </ConnectedAccountFormSection>
            ) : null}

            {/* A setup panel cancels locally, from the flow's own footer (`panelCancel`). */}
            {!panelCancel && attemptId && attempt && !isTerminalAttempt(attempt) ? (
                <ConnectedAccountFormSection embedded={embedded} title={t('connectedServices.detail.actionsGroupTitle')}>
                    <Item
                        testID="connected-account:cancel"
                        title={t('common.cancel')}
                        disabled={busy}
                        onPress={() => {
                            void runAuthentication({ operation: 'cancel', attemptId });
                        }}
                    />
                </ConnectedAccountFormSection>
            ) : null}
        </>
    );

    if (controllerProps.panel) {
        const panelIntent = controllerProps.panel.intent;
        const ranked = panelIntent.kind === 'add'
            ? rankConnectedAccountSetupModes(description?.descriptor.authentication.modes ?? declaredAuthentication?.modes ?? [])
            : [];
        // Declared methods can be chosen before an execution host is requested.
        // The initial Account-only description is not a native sign-in failure.
        const choosingMethod = panelIntent.kind === 'add' && !hasExplicitAuthenticationIntent
            && ranked.length > 0
            && !accountDirectMode && !attempt && !configuration;
        const flowActive = Boolean(accountDirectMode || attempt || configuration || errorCode);
        return (
            <>
            <ConnectedAccountActionApprovalNotice execution={actionExecution} testID="connected-account-approval-pending" />
            <ConnectedServiceSetupFlowBody
                state={browserMachineUnavailableCode || choosingMethod || accountDirectMode || hasAccountDirectSetup && !machineId ? 'ready' : description === null && !errorCode ? 'preparing' : 'ready'}
                methods={ranked.map((entry) => ({
                    id: entry.mode.id,
                    title: entry.mode.kind === 'oauthAuthorizationCode' ? t('connectedServicesSettings.methodBrowser')
                        : entry.mode.kind === 'oauthDeviceCode' ? t('connectedServicesSettings.methodCode')
                            : resolveConnectedAccountModeTitle(entry.mode, localizeServiceText),
                    recommended: entry.recommended,
                }))}
                activeMethodId={activeModeId ?? accountDirectMode?.id}
                methodsDisabled={busy}
                onSelectMethod={(modeId) => {
                    if (modeId === activeModeId && flowActive) return;
                    cancelSetupAttempt();
                    discoveredScopeRef.current = null;
                    setNoPendingAttempt(false);
                    panelStartedRef.current = false;
                    setActiveModeId(modeId);
                    panelRef.current?.onModeChange?.(modeId);
                }}
                flow={browserMachineUnavailableCode ? machineRequirement : choosingMethod ? null : (hasAccountDirectSetup || hasPortableAuthenticationModes) && machineRequired && !machineId && !attempt && !configuration ? machineRequirement : flowActive ? renderFlow(true) : activeMode?.kind === 'oauthDeviceCode' ? (
                    <ConnectedServiceSetupFlowActions
                        onCancel={panelCancel}
                        primary={{
                            testID: 'connected-account-device:start',
                            label: t('connectedServicesSettings.modeDeviceCode'),
                            disabled: busy || !noPendingAttempt || !credentialWriteAllowed,
                            onPress: () => void beginIntent({ kind: 'connect', service, modeId: activeMode.id }),
                        }}
                    />
                ) : null}
            />
            </>
        );
    }

    const routeBody = (
        <>
            <ConnectedAccountActionApprovalNotice execution={actionExecution} testID="connected-account-approval-pending" />
            {(description !== null || accountDetailAvailable)
                && !(route.focus !== null && route.focus.kind !== 'account' && authenticationFlowActive) ? (
                <ConnectedAccountServiceContent
                    machineId={focusedAccountHasMachineAugmentation ? machineId || null : null}
                    signInFlow={focusedScreenOwnsScroll && route.focus?.kind === 'account' && (attempt || configuration || errorCode)
                        ? accountDetailAvailable && errorCode && errorPhase === 'load' && !attempt && !configuration
                            ? <SurfaceStateCard testID="qualified-account-detail:live-unavailable" size="line" kind="unavailable" title={t('common.unavailable')} />
                            : renderFlow(true) : undefined}
                    // Stored identity and removal belong to the Account. A native sign-in needs a
                    // machine. One quiet line in the Sign-in group says so, with its own chooser, and nothing
                    // shows while a usable machine is chosen (lab csvc nomachine).
                    machineScopeLine={!machineRequired || targetSelection.state.kind === 'online' ? undefined : (
                        <MachineScopedSection
                            embedded
                            selection={targetSelection}
                            unselectedInvitation={t('connectedServicesSettings.accountMachineInvitation')}
                            testIDPrefix="connected-account-target"
                        />
                    )}
                    machineSetupSection={focusedScreenOwnsScroll && route.focus?.kind !== 'account' ? renderFlow(false) : undefined}
                    serverId={serverId}
                    teamCredentialResourcesEnabled={teamCredentialResourcesEnabled}
                    localize={localizeServiceText}
                    title={title}
                    quotaResetSupported={description?.descriptor.recoveryCredits?.supported === true}
                    service={service}
                    legacyServiceId={legacyServiceId}
                    focus={route.focus}
                    modes={description ? mutationModes : descriptorModes}
                    accounts={visibleAccounts}
                    serviceConfigurationStatusByModeId={
                        serviceConfigurationStatusByModeId
                    }
                    accountLabels={accountLabels}
                    labelsByKey={labelsByKey}
                    groups={groups}
                    busy={busy}
                    isControllerCurrent={isControllerCurrent}
                    onRenameAccount={'scope' in accountLifetime && profile.id === accountLifetime.scope.accountId ? renameAccount : undefined}
                    onConfigureAccount={credentialWriteAllowed ? (account) => {
                        const modeId = visibleAccounts.find((candidate) => (
                            candidate.ref.accountId === account.accountId
                            && candidate.ref.service.pluginId
                                === account.service.pluginId
                            && candidate.ref.service.localId
                                === account.service.localId
                        ))?.authenticationModeId;
                        if (!modeId) return;
                        const mode =
                            description?.descriptor.authentication.modes.find(
                                (candidate) => candidate.id === modeId,
                            );
                        if (!mode?.configuration) return;
                        setAttempt(null);
                        setPendingIntent(null);
                        setConfigurationContinuationAttemptId(null);
                        setActiveModeId(modeId);
                        void readConfiguration(
                            {
                                kind: 'account',
                                account,
                                modeId,
                            },
                        );
                    } : undefined}
                    onConfigureService={'scope' in accountLifetime
                        && descriptorModes.some(mode => mode.configuration?.scope === 'service') ? (modeId) => {
                        // Account configuration admission resolves the current declared
                        // mode through configuration.get; native peer availability is
                        // neither its permission nor its descriptor authority.
                        setAttempt(null);
                        setPendingIntent(null);
                        setConfigurationContinuationAttemptId(null);
                        setActiveModeId(modeId);
                        void readConfiguration({
                            kind: 'service',
                            service,
                            modeId,
                        });
                    } : undefined}
                    onBeginReconnect={credentialWriteAllowed ? (account) => {
                        void beginIntent({ kind: 'reconnect', account });
                    } : undefined}
                    canReconnectAccount={(account) => (
                        account.authenticationModeId !== null && accountModeIds?.includes(account.authenticationModeId) === true
                        || transport?.kind === 'v4'
                        || (
                            account.authenticationModeId !== null
                            && legacyMutationModeIds.has(
                                account.authenticationModeId,
                            )
                        )
                    )}
                    onDisconnectAccount={'scope' in accountLifetime && profile.id === accountLifetime.scope.accountId ? revokeAccount : undefined}
                />
            ) : null}
            {description === null && !accountDetailAvailable && !errorCode ? (
                <ItemGroup>
                    <Item
                        title={t('connectedServices.deviceAuth.preparing')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {!focusedScreenOwnsScroll ? renderFlow(false) : null}
        </>
    );

    return focusedScreenOwnsScroll ? routeBody : (
        <ItemList
            keyboardAware={authenticationFlowActive}
            keyboardShouldPersistTaps={authenticationFlowActive ? 'handled' : undefined}
        >
            {route.focus === null ? serviceHeader(title, machineRequired) : null}
            {routeBody}
        </ItemList>
    );
});

export function ConnectedAccountServiceView() {
    const params = useLocalSearchParams();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const connectedServicesRegistry =
        useProjectedConnectedServicesRegistry();
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope();
    const [machineRequired, setMachineRequired] = React.useState(false);
    const targetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts,
        { enabled: machineRequired },
    );
    const controllerKey = [
        activeAccountScope
            ? serverAccountScopeKeySuffix(activeAccountScope)
            : 'no-active-account',
        String(activeServer.generation ?? ''),
        asStringParam(params.pluginId),
        asStringParam(params.localId),
        asStringParam(params.serviceId),
        asStringParam(params.accountId),
        asStringParam(params.groupId),
    ].join('\u0000');

    const focusedRoute = React.useMemo(
        () => resolveQualifiedConnectedAccountSettingsRoute(params, connectedServicesRegistry.entries),
        [connectedServicesRegistry.entries, params],
    );
    const navigation = useNavigation();
    React.useLayoutEffect(() => {
        // Every screen of this route is an entity page whose `PageHeader` names the service,
        // account or pool (`alwaysShowTitle`), so the native header keeps an empty title: one
        // title on phones. `useNavigation` returns null outside a navigator (previews, tests).
        if (!navigation) return;
        navigation.setOptions({ headerTitle: '' });
    }, [navigation]);

    if (focusedRoute && focusedRoute.focus === null) {
        return <Redirect href={buildConnectedAccountSettingsRoute(
            focusedRoute.service,
            null,
        )} />;
    }

    return (
        <ConnectedAccountServiceController
            key={controllerKey}
            params={params}
            connectedServicesRegistry={connectedServicesRegistry}
            activeServer={activeServer}
            targetSelection={targetSelection}
            onMachineRequirementChange={setMachineRequired}
            localizePluginText={localizePluginText}
            navigation={navigation}
        />
    );
}

/**
 * The sign-in for one service hosted in a setup panel (the in-place Connect panel on Connected
 * services and Home, the account's "Sign in again", and their modal twin). It is the same controller
 * as the service page — same commands, forms, recovery and pending-attempt resume — presenting only
 * the way to sign in and the running flow. The panel owns the machine choice (`targetSelection`).
 */
export function ConnectedAccountSetupController(props: Readonly<{
    service: Readonly<{ pluginId: string; localId: string }>;
    panel: ConnectedAccountSetupPanelIntent;
    targetSelection: MachineAdministrationTargetSelectionV1;
    registry?: ConnectedServiceRegistrySnapshot;
}>) {
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const focusedRegistry = useProjectedConnectedServicesRegistry();
    const connectedServicesRegistry = props.registry ?? focusedRegistry;
    const activeServer = useActiveServerSnapshot();
    const activeAccountScope = useActiveServerAccountScope();
    const navigation = useNavigation();
    const params = React.useMemo(
        () => ({ pluginId: props.service.pluginId, localId: props.service.localId }),
        [props.service.localId, props.service.pluginId],
    );
    const intentKey = props.panel.intent.kind === 'reconnect' ? `reconnect:${props.panel.intent.accountId}` : 'add';
    // Account scope and intent own the draft. The inner native lifetime owns Machine changes.
    const controllerKey = [
        activeAccountScope ? serverAccountScopeKeySuffix(activeAccountScope) : 'no-active-account',
        String(activeServer.generation ?? ''),
        props.service.pluginId,
        props.service.localId,
        intentKey,
    ].join('\u0000');
    return (
        <ConnectedAccountServiceController
            key={controllerKey}
            params={params as ReturnType<typeof useLocalSearchParams>}
            connectedServicesRegistry={connectedServicesRegistry}
            activeServer={activeServer}
            targetSelection={props.targetSelection}
            localizePluginText={localizePluginText}
            navigation={navigation}
            panel={props.panel}
        />
    );
}

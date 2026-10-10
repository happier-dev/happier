import * as React from 'react';
import { useConnectedAccountIdentityPrivacy } from '@/hooks/ui/useConnectedAccountIdentityPrivacy';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { areProviderContributionKeysEqualV1, parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import {
    type DaemonProviderConnectionMutationRequestV1,
    type DaemonProviderConnectionViewV1,
} from '@happier-dev/protocol/rpc';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Switch } from '@/components/ui/forms/Switch';
import { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ProviderFieldRow } from '@/components/settings/providers/authoring/ProviderFieldRow';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, PageHeaderStateSwitch, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { MachineScopedSection } from '@/components/settings/machines/MachineScopedSection';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { ProviderExternalLinkItem } from '@/components/settings/providers/ProviderExternalLinkItem';
import { ProviderHeaderActions, ProviderProbeResult, ProviderSavedSecretControl } from '@/components/settings/providers/ProviderPageParts';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import {
    useProjectedConnectedServicesRegistry,
    useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import {
    presentProviderConnection,
    PROVIDER_CONNECTION_STATUS_KEY,
} from '@/providers/connection/presentation';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import {
    providerSettingsMachineRowKey,
    useProviderSettingsTarget,
} from '@/providers/hooks/targetMachine';
import {
    useRetireProviderStateOnAccountChange,
} from '@/providers/hooks/accountLifetimeRetirement';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { useProviderConnectionMachineViews } from '@/providers/hooks/useProviderConnectionMachineViews';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { useProviderModelPickerVisibility } from '@/providers/hooks/useProviderModelPickerVisibility';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useProfile } from '@/sync/store/hooks';
import { selectConnectedMetadataLabels, useConnectedMetadataCatalog } from '@/hooks/server/connectedServices/useConnectedMetadataCatalog';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { teamsDirectoryShareCredentialPath } from '@/components/settings/teams/teamsRoutes';
import { SharedWithTeamsForSource } from '@/components/settings/teams/credentials/SharedWithTeamsSourceAdministration';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import {
    buildConnectedAccountPurposeTargetChoices,
    connectedAccountPurposeTargetChoiceId,
    resolveConnectedAccountPurposeTargetDisplay,
} from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import {
    ProviderCompatibilitySection,
    ProviderEndpointOverridesSection,
    ProviderPickerVisibilityRow,
} from './detail/ProviderConnectionDetailSections';
import { ProviderFeatureAvailabilityNotice, useProviderFeatureAvailability } from './ProviderFeatureAvailability';
import { PROVIDER_CONNECTION_MODELS_SECTION, providerConnectionDetailRoute, readProviderGatewayPurposeDeclarations,
    readProviderGatewayViewDeclarations, recordProviderCollectionVisit } from './collection/providerCollectionModel';
import { ProviderGatewaySections, resolveProviderGatewayChosenMachine, type ProviderGatewayHubReachability,
    type ProviderGatewayMachine } from './gateway/ProviderGatewaySections';
import { buildProviderGatewaySlotMutation, type ProviderGatewayConfigurationPatch } from '@/providers/connection/gatewayConfiguration';
import { useProviderGatewayConfiguration } from '@/providers/hooks/useProviderGatewayConfiguration';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { buildConnectedServiceSetupRoute } from '@/components/settings/connectedServices/setup/connectMoreBlocks';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { ProviderConnectionModelsPage } from './models/ProviderConnectionModelsSection';
import { useProviderConnectionModelsSection } from './models/useProviderConnectionModelsSection';
import { Icon } from '@/components/ui/icons/Icon';

type ManagedDeployment = Extract<
    DaemonProviderConnectionViewV1['deployment'],
    { kind: 'managedLocal' }
>;
type ManagedDeploymentUpdate = Extract<
    NonNullable<
        Extract<
            DaemonProviderConnectionMutationRequestV1,
            { action: 'update' }
        >['deployment']
    >,
    { kind: 'managedLocal' }
>;

type ManagedPurposeDraft = Readonly<{
    machineId: string | null;
    connectionId: string;
    revision: number;
    initialTargetsKey: string;
    targets: Readonly<Record<string, QualifiedConnectedAccountPurposeBindingTargetV1 | null>>;
}>;

/** The host a person recognises ("api.deepseek.com"), not the full request URL. */
function endpointHost(baseUrl: string): string {
    try {
        return new URL(baseUrl).host || baseUrl;
    } catch {
        return baseUrl;
    }
}

function ProviderDuplicateDraft(props: Readonly<{
    mode: 'sameSource' | 'asCustom';
    initialName: string;
    pending: boolean;
    onCreate: (name: string, allowNavigation: () => void) => Promise<void>;
    onCancel: () => void;
}>) {
    const navigation = useNavigation();
    const [name, setName] = React.useState(props.initialName);
    const guard = useUnsavedDraftNavigationGuard({ navigation, isDirty: name !== props.initialName,
        onDiscard: props.onCancel, tag: 'provider-duplicate-draft' });
    return <ItemGroup title={t(props.mode === 'asCustom' ? 'settingsProviders.customTitle' : 'settingsProviders.detail.duplicateTitle')}
        description={t(props.mode === 'asCustom' ? 'settingsProviders.customFooter' : 'settingsProviders.detail.duplicateDescription')}>
        <ProviderFieldRow testID="provider-connection-duplicate-name" title={t('settingsProviders.authoring.name')}
            value={name} onChangeText={setName} editable={!props.pending} />
        <SectionContentRow><SectionButtonRow>
            <RoundButton testID="provider-connection-duplicate-save" title={t('common.create')} size="small"
                loading={props.pending} disabled={props.pending || !name.trim()}
                onPress={() => { void props.onCreate(name, guard.allowSavedNavigation); }} />
            <RoundButton testID="provider-connection-duplicate-cancel" title={t('common.cancel')} size="small" display="secondary"
                disabled={props.pending} onPress={props.onCancel} />
        </SectionButtonRow></SectionContentRow>
    </ItemGroup>;
}

export const ProviderConnectionDetailScreen = React.memo(function ProviderConnectionDetailScreen(
    props: Readonly<{
        connectionId: string;
        /** Open on one section (`models`), as links to a connection's models do. */
        section?: string | null;
        /** Open the manual-model editor in the Models section. */
        startAddingModels?: boolean;
        /** The connection was created a moment ago by the add flow (its completion note may show). */
        justConnected?: boolean;
    }>,
) {
    const router = useRouter();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const profile = useProfile();
    const { present } = useConnectedAccountIdentityPrivacy();
    const labelsByKey = useConnectedMetadataCatalog(undefined, selectConnectedMetadataLabels);
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const connectedAccountUiNegotiation = resolveConnectedAccountUiNegotiation(
        useServerFeaturesRuntimeSnapshot({ enabled: true }),
    );
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const providerTarget = useProviderSettingsTarget();
    const {
        machineId,
        machineRows,
        resolveCurrentTarget,
        selectedTargetServerMatchesActiveAccount,
        serverId,
    } = providerTarget;
    const { probeProviderConnection } = useProviderActionClient(serverId);
    const teamCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId,
    });
    // Only machines the canonical presence owner classifies online can return
    // daemon facts; a read to any other candidate cannot be serviced.
    const readableMachineRows = React.useMemo(
        () => machineRows.filter((row) => row.online),
        [machineRows],
    );
    // Row presses reach the same Machine Administration selection owner the
    // shared selector writes, so no Provider route keeps a second preference.
    const targetSelection = providerTarget.selection;
    const selectTargetMachine = React.useCallback((target: MachineAdministrationTargetV1) => {
        targetSelection.selectTarget(target);
    }, [targetSelection]);
    const focused = useIsFocused();
    const query = useProviderConnections({ enabled, active: focused, machineId, serverId, connectionId: props.connectionId });
    const connection = query.data?.connections.find((item) => item.connectionId === props.connectionId) ?? null;
    const machineSectionVisible = connection?.scope === 'machine' || (connection?.grants.enabledMachineIds.length ?? 0) > 0;
    const machineViews = useProviderConnectionMachineViews({
        enabled,
        active: focused && machineSectionVisible,
        connectionId: props.connectionId,
        targets: readableMachineRows,
    });
    const refreshConnectionQuery = React.useCallback(async (): Promise<void> => {
        await query.refresh();
    }, [query.refresh]);
    const refreshConnectionDetail = React.useCallback(async () => {
        await refreshConnectionQuery();
        // The selected connection is authoritative for mutation completion.
        // Peer rows are supporting presentation and must not hold the write's
        // critical path or replace a successful selected-machine refresh.
        void machineViews.refresh().catch(() => undefined);
    }, [machineViews.refresh, refreshConnectionQuery]);
    const mutation = useProviderConnectionMutation({
        resolveTarget: resolveCurrentTarget,
        serverId,
        refresh: refreshConnectionDetail,
    });
    const deleteInFlightRef = React.useRef(false);
    const [deletePending, setDeletePending] = React.useState(false);
    const [probeState, setProbeState] = React.useState<'idle' | 'probing' | 'success' | 'notSupported'>('idle');
    const [probeError, setProbeError] = React.useState<ProviderErrorV1 | null>(null);
    const [managedPurposeDraft, setManagedPurposeDraft] = React.useState<ManagedPurposeDraft | null>(null);
    const [duplicateMode, setDuplicateMode] = React.useState<'sameSource' | 'asCustom' | null>(null);
    const discardDuplicate = React.useCallback(() => setDuplicateMode(null), []);
    useRetireProviderStateOnAccountChange(discardDuplicate);
    React.useEffect(discardDuplicate, [discardDuplicate, machineId, serverId, props.connectionId]);
    // A purpose draft names Account-scoped Connected Account targets, so it is
    // retired with the Account that authored it rather than surviving into the
    // next Account on the same machine and connection.
    const discardManagedPurposeDraft = React.useCallback(() => {
        setManagedPurposeDraft(null);
    }, []);
    useRetireProviderStateOnAccountChange(discardManagedPurposeDraft);
    const managedPurposeDraftDirtyRef = React.useRef(false);
    const ignoreManagedPurposeGuardRef = React.useRef(false);
    const probeGenerationRef = React.useRef(0);
    const connectionShown = connection !== null;
    // The wide collection lands on the connection opened last, whichever layout opened it.
    React.useEffect(() => {
        if (connectionShown) recordProviderCollectionVisit(props.connectionId);
    }, [connectionShown, props.connectionId]);
    const models = useProviderConnectionModelsSection({
        connectionId: props.connectionId,
        connection,
        enabled,
        active: focused && connection !== null,
        machineId,
        serverId,
        resolveCurrentTarget,
        startAdding: props.startAddingModels,
    });
    const providerCatalog = useProviderCatalogForServer(serverId);
    const storedConnection = providerCatalog?.data?.connections.find(item => item.id === props.connectionId);
    const storedContributionKey = storedConnection?.source.kind === 'contribution'
        ? storedConnection.source.contributionKey : null;
    const pickerSourceKind = storedConnection?.source.kind === 'custom' ? 'custom' : storedContributionKey
        ? query.data?.available.find(item => areProviderContributionKeysEqualV1(item.contributionKey, storedContributionKey))?.kind
        : undefined;
    const pickerVisibility = useProviderModelPickerVisibility(connection ? props.connectionId : null,
        pickerSourceKind ? { kind: pickerSourceKind, serverId } : undefined);
    // The Connection section's Models row scrolls this page to its Models section.
    const [modelsRevealRequest, setModelsRevealRequest] = React.useState(0);
    const revealModels = React.useCallback(() => setModelsRevealRequest((request) => request + 1), []);
    // Setup ends by explaining the one surprise: a source that lists many models starts hidden from
    // the picker. Said once, right after connecting.
    const [completionNoteDismissed, setCompletionNoteDismissed] = React.useState(false);
    const dismissCompletionNote = React.useCallback(() => setCompletionNoteDismissed(true), []);
    // The Name field: `null` shows the connection's current name; typing holds a draft until it is
    // committed (leaving the field or Enter) through the connection's `update` write.
    const [nameDraft, setNameDraft] = React.useState<string | null>(null);
    const [nameError, setNameError] = React.useState<string | null>(null);
    React.useEffect(() => {
        setNameDraft(null);
        setNameError(null);
    }, [machineId, props.connectionId]);
    const managedDeployment = connection?.deployment.kind === 'managedLocal'
        ? connection.deployment
        : null;
    const managedLocalOption =
        connection?.managedLocalOption?.targetMachineId === machineId
            ? connection.managedLocalOption
            : null;
    const connectedAccountScopeMatchesTarget = selectedTargetServerMatchesActiveAccount;
    React.useEffect(() => {
        if (!connectedAccountScopeMatchesTarget) discardManagedPurposeDraft();
    }, [connectedAccountScopeMatchesTarget, discardManagedPurposeDraft]);
    const probeObservationIdentity = connection?.probeObservationIdentity ?? null;
    // A null identity cannot establish semantic equivalence. Treat the connection
    // snapshot as an opaque fail-closed sentinel instead of reconstructing daemon facts.
    const legacyProbeSnapshot = probeObservationIdentity === null ? connection : null;
    const probeScope = React.useMemo(() => ({
        machineId,
        connectionId: props.connectionId,
        probeObservationIdentity,
        legacyProbeSnapshot,
    }), [legacyProbeSnapshot, machineId, probeObservationIdentity, props.connectionId]);
    const activeProbeScopeRef = React.useRef(probeScope);
    activeProbeScopeRef.current = probeScope;
    const localCandidate = query.data?.discoveryCandidates.find((candidate) =>
        candidate.machineId === machineId
        && candidate.connection.status === 'matched'
        && candidate.connection.connectionId === props.connectionId) ?? null;
    const connectionContributionKey = connection?.contributionKey;
    // Localized managed-purpose descriptors are authored by the Provider
    // contribution plugin, not by the Connected Account service they target.
    // Opaque forward-compatible keys intentionally miss the plugin registry and
    // therefore resolve their descriptor fallback instead of borrowing another
    // plugin's translations.
    const contributionAuthorPluginId = connectionContributionKey
        ? parseProviderContributionIdentityV1(connectionContributionKey)?.identity.pluginId ?? connectionContributionKey
        : '';
    const localInstallation = connectionContributionKey
        ? query.data?.localInstallations.find((installation) =>
            installation.machineId === machineId
            && areProviderContributionKeysEqualV1(
                installation.contributionKey,
                connectionContributionKey,
            )) ?? null
        : null;

    const invalidateProbe = React.useCallback(() => {
        probeGenerationRef.current += 1;
        setProbeState('idle');
        setProbeError(null);
    }, []);

    const setMachineEnabled = React.useCallback(async (targetMachineId: string, next: boolean) => {
        invalidateProbe();
        await mutation.run({
            action: 'setEnabled',
            machineId: targetMachineId,
            connectionId: props.connectionId,
            enabled: next,
            ...(!next ? { scope: 'machine' as const } : {}),
        }, `machine:${targetMachineId}`);
    }, [invalidateProbe, mutation, props.connectionId]);
    const enableSelectedMachine = React.useCallback(async () => {
        if (!machineId) return;
        await setMachineEnabled(machineId, true);
    }, [machineId, setMachineEnabled]);

    React.useEffect(() => {
        invalidateProbe();
    }, [invalidateProbe, probeScope]);

    const runProbe = React.useCallback(async () => {
        // Re-resolve immediately before the probe: the rendered target may have
        // moved to another machine or server profile since this row rendered.
        const target = resolveCurrentTarget();
        if (!machineId || !target || target.machineId !== machineId) return;
        const generation = ++probeGenerationRef.current;
        const requestScope = probeScope;
        setProbeState('probing');
        setProbeError(null);
        try {
            const result = await probeProviderConnection({
                machineId: target.machineId,
                serverId: target.serverId,
                connectionId: props.connectionId,
            });
            if (probeGenerationRef.current !== generation || activeProbeScopeRef.current !== requestScope) return;
            if (result.status === 'error') {
                setProbeState('idle');
                setProbeError(result.error);
                return;
            }
            setProbeState(result.status === 'success' ? 'success' : 'notSupported');
            await query.refresh();
        } catch (caught) {
            if (probeGenerationRef.current !== generation || activeProbeScopeRef.current !== requestScope) return;
            setProbeState('idle');
            setProbeError(providerErrorFromRpcFailure(caught, {
                connectionId: props.connectionId,
                machineId,
            }));
        }
    }, [machineId, probeProviderConnection, probeScope, props.connectionId, query.refresh, resolveCurrentTarget]);

    const bindSecret = React.useCallback((scope: 'account' | 'machine', targetMachineId: string | null) => {
        if (scope === 'machine' && !targetMachineId) return;
        if (!selectedTargetServerMatchesActiveAccount) return;
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime?.isCurrent()) return;
        Modal.show({
            component: SavedSecretPickerModal,
            props: {
                scope: accountLifetime.scope,
                selectedId: null,
                onSelectId: (savedSecretId) => {
                    if (!accountLifetime.isCurrent()) return;
                    invalidateProbe();
                    void mutation.run({
                        action: 'bindSecret', ...(targetMachineId ? { machineId: targetMachineId } : {}), connectionId: props.connectionId,
                        credentialSlotId: 'apiKey', savedSecretId, scope,
                    }, `secret:${scope}:${targetMachineId}`);
                },
            },
            chrome: { kind: 'card', title: t('settingsProviders.detail.pickSecretTitle'), dimensions: { size: 'lg' } },
            closeOnBackdrop: true,
        });
    }, [invalidateProbe, mutation, props.connectionId, selectedTargetServerMatchesActiveAccount]);

    const duplicate = React.useCallback(async (mode: 'sameSource' | 'asCustom', name: string, allowNavigation: () => void) => {
        if (!connection) return;
        if (!name.trim()) return;
        const result = await mutation.run({
            action: 'duplicate', ...(machineId ? { machineId } : {}), connectionId: props.connectionId,
            newConnectionId: `pc_${randomUUID()}`, displayName: name.trim(), mode,
        }, `duplicate:${mode}`);
        if (result?.status === 'success' && result.action === 'duplicate') {
            allowNavigation();
            setDuplicateMode(null);
            router.replace(providerConnectionDetailRoute(result.connection.connectionId) as never);
        }
    }, [connection, machineId, mutation, props.connectionId, router]);

    const remove = React.useCallback(async () => {
        if (!connection || deleteInFlightRef.current) return;
        deleteInFlightRef.current = true;
        setDeletePending(true);
        try {
            const result = await mutation.run({ action: 'delete', ...(machineId ? { machineId } : {}), connectionId: props.connectionId }, 'delete');
            if (result?.status === 'success') {
                router.replace('/(app)/settings/providers' as never);
            }
        } catch {
            // Never leak navigation boundary errors from row activation.
        } finally {
            deleteInFlightRef.current = false;
            setDeletePending(false);
        }
    }, [connection, machineId, mutation, props.connectionId, router]);

    const setEndpointOverride = React.useCallback(async (input: Readonly<{
        endpointTemplateId: string;
        currentUrl: string;
        scope: 'account' | 'machine';
        reset?: boolean;
    }>) => {
        if (!connection || input.scope === 'machine' && !machineId) return;
        const baseUrl = input.reset ? null : input.currentUrl.trim();
        if (baseUrl === '') return;
        invalidateProbe();
        await mutation.run({
            action: 'setEndpointOverride', ...(machineId ? { machineId } : {}), connectionId: props.connectionId,
            expectedRevision: connection.revision, scope: input.scope,
            endpointTemplateId: input.endpointTemplateId, baseUrl,
        }, `endpoint:${input.scope}:${input.endpointTemplateId}`);
    }, [connection, invalidateProbe, machineId, mutation, props.connectionId]);

    const startLocal = React.useCallback(async () => {
        if (!machineId || !connection?.contributionKey || !localInstallation?.managedStartAvailable) return;
        invalidateProbe();
        await mutation.run({
            action: 'startLocal',
            machineId,
            connectionId: props.connectionId,
            contributionKey: connection.contributionKey,
        }, `start:${connection.contributionKey}`);
    }, [connection?.contributionKey, invalidateProbe, localInstallation?.managedStartAvailable, machineId, mutation, props.connectionId]);

    const beginManagedPurposeConfiguration = React.useCallback(() => {
        if (!connection || !managedLocalOption || !connectedAccountScopeMatchesTarget) return;
        const currentTargets = new Map(
            storedConnection ? Object.entries(storedConnection.purposeBindingDefaults ?? {}) : managedDeployment?.effects?.connectedAccountPurposes.map(
                (binding) => [binding.purpose, binding.target] as const,
            ) ?? [],
        );
        const targets: Record<string, QualifiedConnectedAccountPurposeBindingTargetV1 | null> = {};
        for (const declaration of managedLocalOption.connectedAccountPurposes) {
            targets[declaration.purpose] = currentTargets.get(declaration.purpose) ?? null;
        }
        setManagedPurposeDraft({
            machineId,
            connectionId: connection.connectionId,
            revision: connection.revision,
            initialTargetsKey: JSON.stringify(targets),
            targets,
        });
    }, [
        connectedAccountScopeMatchesTarget,
        connection,
        machineId,
        managedDeployment?.effects?.connectedAccountPurposes,
        managedLocalOption,
        storedConnection,
    ]);

    const updateManagedPurposeDraftTarget = React.useCallback((purpose: string, target: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => {
        setManagedPurposeDraft((current) => current
            ? { ...current, targets: { ...current.targets, [purpose]: target } }
            : current);
    }, []);

    managedPurposeDraftDirtyRef.current = managedPurposeDraft !== null
        && JSON.stringify(managedPurposeDraft.targets) !== managedPurposeDraft.initialTargetsKey;
    // The page holds two drafts (managed-service defaults, typed manual models); one guard owns
    // both, since only one guard can be the page's active one.
    const detailDraftDirtyRef = React.useRef(false);
    detailDraftDirtyRef.current = managedPurposeDraftDirtyRef.current || models.manualDraft.dirtyRef.current;
    const modelsAccountStillCurrent = models.manualDraft.accountStillCurrent;
    const requestDetailDraftDecision = React.useCallback(async () => {
        const decision = await promptUnsavedChangesAlert(
            (title, message, buttons) => {
                if (modelsAccountStillCurrent()) Modal.alert(title, message, buttons);
            },
            {
                title: t('common.discardChanges'),
                message: t('common.unsavedChangesWarning'),
                discardText: t('common.discard'),
                saveText: t('common.save'),
                keepEditingText: t('common.keepEditing'),
            },
        );
        return modelsAccountStillCurrent() ? decision : 'keepEditing' as const;
    }, [modelsAccountStillCurrent]);
    const continueDetailNavigation = React.useCallback((action: unknown) => {
        if (action) (navigation as { dispatch?: (value: unknown) => void } | null)?.dispatch?.(action);
    }, [navigation]);

    const reloadManagedPurposeTargets = React.useCallback(async () => {
        await Promise.all([sync.refreshProfile(), refreshConnectionDetail()]);
    }, [refreshConnectionDetail]);

    const saveManagedPurposeConfiguration = React.useCallback(async (): Promise<boolean> => {
        if (!connection || !managedLocalOption || !managedPurposeDraft) return false;
        if (
            managedPurposeDraft.machineId !== machineId
            || managedPurposeDraft.connectionId !== connection.connectionId
            || managedPurposeDraft.revision !== connection.revision
            || !connectedAccountScopeMatchesTarget
        ) {
            await Modal.alert(
                t('settingsProviders.errors.connectionChangedTitle'),
                t('settingsProviders.errors.connectionChangedDescription'),
            );
            return false;
        }
        const purposeBindingDefaults: ManagedDeploymentUpdate['purposeBindingDefaults'] = {};
        for (const declaration of managedLocalOption.connectedAccountPurposes) {
            const target = managedPurposeDraft.targets[declaration.purpose] ?? null;
            if (!target && declaration.required) {
                await Modal.alert(
                    t('settingsProviders.local.invalidPurposeTargetTitle'),
                    t('settingsProviders.local.invalidPurposeTargetDescription'),
                );
                return false;
            }
            if (target) {
                // Re-validate against the Account as it stands now: a refresh
                // while the editor was open can have removed the chosen account
                // or group, and an unresolvable reference must never be stored.
                const choices = buildConnectedAccountPurposeTargetChoices({
                    declaration,
                    selectedTarget: target,
                    accounts: profile.connectedAccountsV4 ?? [],
                    groups: profile.connectedAccountGroupsV4 ?? [],
                    labelsByKey,
                    serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
                        connectedServicesRegistry, declaration.service, t, localizePluginText,
                    ),
                    resolveAuthentication: getConnectedAccountAuthentication,
                });
                const chosenId = connectedAccountPurposeTargetChoiceId(target);
                if (!choices.some((choice) => choice.id === chosenId && choice.selectable)) {
                    await Modal.alert(
                        t('settingsProviders.local.invalidPurposeTargetTitle'),
                        t('settingsProviders.local.invalidPurposeTargetDescription'),
                    );
                    return false;
                }
                purposeBindingDefaults[declaration.purpose] = target;
            }
        }
        if (
            managedLocalOption.connectedAccountPurposeBindingPolicy?.minimumBound === 1
            && Object.keys(purposeBindingDefaults).length === 0
        ) {
            await Modal.alert(
                t('settingsProviders.local.invalidPurposeTargetTitle'),
                t('settingsProviders.local.invalidPurposeTargetDescription'),
            );
            return false;
        }
        invalidateProbe();
        const result = await mutation.run(
            {
                action: 'update',
                ...(machineId ? { machineId } : {}),
                connectionId: props.connectionId,
                expectedRevision: connection.revision,
                deployment: {
                    kind: 'managedLocal',
                    purposeBindingDefaults,
                },
            },
            'deployment:managedLocal',
        );
        if (result?.status !== 'success') return false;
        setManagedPurposeDraft(null);
        return true;
    }, [
        connectedAccountScopeMatchesTarget,
        connectedServicesRegistry,
        connection,
        invalidateProbe,
        localizePluginText,
        machineId,
        managedLocalOption,
        managedPurposeDraft,
        mutation,
        profile.connectedAccountGroupsV4,
        profile.connectedAccountsV4,
        props.connectionId,
        labelsByKey,
    ]);

    const discardManualModelDraft = models.manualDraft.discard;
    const saveManualModelDraft = models.manualDraft.save;
    const manualModelDraftDirtyRef = models.manualDraft.dirtyRef;
    const discardDetailDrafts = React.useCallback(() => {
        setManagedPurposeDraft(null);
        discardManualModelDraft();
    }, [discardManualModelDraft]);
    const saveDetailDrafts = React.useCallback(async (): Promise<boolean> => {
        if (managedPurposeDraftDirtyRef.current && !await saveManagedPurposeConfiguration()) return false;
        if (manualModelDraftDirtyRef.current) return await saveManualModelDraft();
        return true;
    }, [manualModelDraftDirtyRef, saveManagedPurposeConfiguration, saveManualModelDraft]);
    useUnsavedChangesBeforeRemoveGuard({
        ignoreRef: ignoreManagedPurposeGuardRef,
        isDirty: detailDraftDirtyRef.current,
        isDirtyRef: detailDraftDirtyRef,
        requestDecision: requestDetailDraftDecision,
        onDiscard: discardDetailDrafts,
        onSave: saveDetailDrafts,
        continueOnSave: true,
        onContinue: continueDetailNavigation,
        tag: 'ProviderConnectionDetailScreen.beforeRemove',
    });

    const useExternalDeployment = React.useCallback(async () => {
        if (!connection || !managedDeployment) return;
        invalidateProbe();
        await mutation.run(
            {
                action: 'update',
                ...(machineId ? { machineId } : {}),
                connectionId: props.connectionId,
                expectedRevision: connection.revision,
                deployment: { kind: 'external' },
            },
            'deployment:external',
        );
    }, [
        connection,
        invalidateProbe,
        machineId,
        managedDeployment,
        mutation,
        props.connectionId,
    ]);

    const commitName = React.useCallback(async () => {
        if (nameDraft === null || !connection) return;
        const displayName = nameDraft.trim();
        if (displayName === connection.displayName) {
            setNameDraft(null);
            setNameError(null);
            return;
        }
        const request = {
            action: 'update' as const,
            ...(machineId ? { machineId } : {}),
            connectionId: props.connectionId,
            expectedRevision: connection.revision,
            displayName,
            displayNameMode: 'custom' as const,
        };
        // The connection's own schema decides what a name may be; its refusal is shown under the
        // field instead of being sent to the daemon.
        const parsed = PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.update'].safeParse(request);
        const nameIssue = parsed.success
            ? null
            : parsed.error.issues.find((issue) => issue.path[0] === 'displayName') ?? null;
        if (nameIssue) {
            setNameError(nameIssue.code === 'too_big'
                ? t('settingsProvidersCollection.nameTooLong', { max: Number(nameIssue.maximum) })
                : t('settingsProvidersCollection.nameRequired'));
            return;
        }
        setNameError(null);
        const result = await mutation.run(request, 'rename');
        if (result?.status === 'success') setNameDraft(null);
    }, [connection, machineId, mutation, nameDraft, props.connectionId]);

    // A gateway is the managed connection whose contribution declares vendor slots: one classifier,
    // shared with both Settings collections. Its saved configuration is the Account's; the machine's
    // view only says the contribution is admitted.
    const gatewayDeclarations = storedConnection && connection
        ? readProviderGatewayPurposeDeclarations(storedConnection, connection) : null;
    const gateway = storedConnection && gatewayDeclarations && gatewayDeclarations.length > 0
        ? { saved: storedConnection, declarations: gatewayDeclarations } : null;
    // The machine already says "gateway" while the Account's saved row is still arriving: hold the
    // older managed-service controls back rather than show them for a moment.
    const gatewayArriving = !gateway && providerCatalog?.status === 'loading' && connection !== null
        && (readProviderGatewayViewDeclarations(connection)?.length ?? 0) > 0;
    const accountSettingsScope = useAccountSettingsScope();
    const gatewaySaved = gateway?.saved ?? null;
    const gatewayConfiguration = useProviderGatewayConfiguration({ connection: gatewaySaved, machineId, mutation });
    // The page shows the Account's saved row, so a write is followed by reading that row again.
    const refreshSavedGateway = React.useCallback(async () => {
        if (accountSettingsScope) await refreshProviderCatalog(accountSettingsScope);
    }, [accountSettingsScope]);
    const changeGatewaySlot = React.useCallback((purpose: string, target: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => {
        if (!gatewaySaved) return;
        invalidateProbe();
        fireAndForget((async () => {
            await mutation.run(buildProviderGatewaySlotMutation({
                connectionId: gatewaySaved.id,
                expectedRevision: gatewaySaved.revision,
                purposeBindingDefaults: gatewaySaved.purposeBindingDefaults ?? {},
                machineId,
                purpose,
                target,
            }), `gateway:slot:${purpose}`);
            await refreshSavedGateway();
        })(), { tag: 'ProviderConnectionDetailScreen.gatewaySlot' });
    }, [gatewaySaved, invalidateProbe, machineId, mutation, refreshSavedGateway]);
    const saveGatewayConfiguration = gatewayConfiguration.save;
    const changeGatewayConfiguration = React.useCallback((patch: ProviderGatewayConfigurationPatch) => {
        if (!gatewaySaved) return;
        fireAndForget((async () => {
            await saveGatewayConfiguration(patch);
            await refreshSavedGateway();
        })(), { tag: 'ProviderConnectionDetailScreen.gatewayConfiguration' });
    }, [gatewaySaved, machineId, refreshSavedGateway, saveGatewayConfiguration]);
    const gatewayMachines = React.useMemo<readonly ProviderGatewayMachine[]>(() => machineRows.map((row) => ({
        machineId: row.target.machineId, displayName: row.displayName, online: row.online,
    })), [machineRows]);
    const gatewayModels = React.useMemo(() => (models.groups[0]?.rows ?? []).map((row) => ({
        id: row.descriptor.id, name: row.descriptor.name,
    })), [models.groups]);
    const connectGatewayService = React.useCallback((serviceKey: string) => {
        const result = runGuardedNavigation(() => router.push(buildConnectedServiceSetupRoute({ kind: 'service', serviceKey }) as never));
        if (result !== true) fireAndForget(result, { tag: 'ProviderConnectionDetailScreen.connectGatewayService' });
    }, [router]);

    const setConnectionEnabled = React.useCallback(async (next: boolean) => {
        invalidateProbe();
        await mutation.run({
            action: 'setEnabled', ...(machineId ? { machineId } : {}), connectionId: props.connectionId, enabled: next,
            ...(!next ? { scope: 'connection' as const } : {}),
        }, 'enable:connection');
    }, [invalidateProbe, machineId, mutation, props.connectionId]);

    const openWebsite = React.useCallback(async (url: string) => {
        let opened = false;
        try {
            opened = await openExternalUrl(url);
        } catch {
            opened = false;
        }
        if (!opened) await Modal.alert(t('common.error'), t('settingsProviders.links.failedToOpen'));
    }, []);

    // What runs on one computer (test, endpoint access, a local runtime) sits in its own section
    // with the machine chip; the connection itself is Account data and never waits for a machine.
    const machineSection = (rows: React.ReactNode) => (
        <MachineScopedSection
            title={t('settingsProvidersCollection.onThisComputerTitle')}
            selection={providerTarget.selection}
            unselectedInvitation={t('settingsProvidersCollection.onThisComputerNoComputer')}
            testIDPrefix="settings.providers.administration.target"
        >
            {rows}
        </MachineScopedSection>
    );

    if (availabilityPresentation) {
        return (
            <ItemList>
                <ItemGroup><ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} /></ItemGroup>
            </ItemList>
        );
    }
    if (query.loading && !query.data) {
        return (
            <ItemList>
                <ItemGroup><Item mode="info" loading title={t('common.loading')} /></ItemGroup>
            </ItemList>
        );
    }
    // The connection is read through a computer until Account reads need none (plan M1). Until
    // then, with no computer to read through, the computer section is the way forward.
    if (!connection && !query.data && !query.error) {
        return <ItemList>{machineSection(null)}</ItemList>;
    }
    const displayFailure = pickerVisibility?.error
        ? { error: providerErrorFromRpcFailure(pickerVisibility.error, { connectionId: props.connectionId }),
            reviewCurrentState: pickerVisibility.reviewCurrentState }
        : mutation.error
        ? {
            error: mutation.error,
            retry: mutation.retry,
            reviewCurrentState: refreshConnectionQuery,
        }
        : query.error
            ? { error: query.error, retry: refreshConnectionQuery }
            : connection?.authorizationError
                ? { error: connection.authorizationError, retry: refreshConnectionQuery }
                : null;
    const displayError = displayFailure?.error ?? null;
    const failureItems = displayError ? (
        <ProviderErrorItems
            error={displayError}
            retry={displayFailure?.retry}
            reviewCurrentState={displayFailure && 'reviewCurrentState' in displayFailure
                ? displayFailure.reviewCurrentState
                : undefined}
            enableOnMachine={displayError.action === 'enable_on_machine'
                ? enableSelectedMachine
                : undefined}
        />
    ) : null;
    if (!connection && failureItems) {
        return (
            <ItemList>
                <ItemGroup>{failureItems}</ItemGroup>
                {machineSection(null)}
            </ItemList>
        );
    }
    if (!connection) {
        const deleted = query.data?.deletedConnection;
        return (
            <ItemList>
                <PageHeader
                    testID="provider-connection-not-found"
                    alwaysShowTitle
                    title={deleted?.lastDisplayName ?? t('settingsProviders.detail.notFoundTitle')}
                    description={deleted ? t('settingsProviders.detail.deletedDescription') : t('settingsProviders.detail.notFoundDescription')}
                />
            </ItemList>
        );
    }

    const presentation = presentProviderConnection(connection);
    const teamCredentialSourceOffer = connection.teamCredentialSourceOffer;
    const probeErrorPresentation = presentProviderError(probeError);
    const accountGrantValid = connection.grants.accountState === 'valid';
    const managedTargetMachineName = managedDeployment
        ? machineRows.find((row) => row.target.machineId === managedDeployment.targetMachineId)?.displayName ?? null
        : null;
    const connectionEnabled = connection.grants.effectiveState === undefined
        ? connection.authorized
        : connection.grants.effectiveState === 'valid';
    const statusQuiet = presentation.status === 'available';
    const websiteUrl = connection.sourceStatus === 'available' ? connection.websiteUrl : undefined;
    const menuActions: PageHeaderMenuAction[] = [
        ...(websiteUrl ? [{
            id: 'website',
            testID: 'provider-connection-menu-website',
            title: t('settingsProviders.links.providerWebsite'),
            onSelect: () => openWebsite(websiteUrl),
        }] : []),
        {
            id: 'duplicate',
            testID: 'provider-connection-menu-duplicate',
            title: t('settingsProviders.detail.duplicateTitle'),
            onSelect: () => { void runGuardedNavigation(() => setDuplicateMode('sameSource')); },
        },
        {
            id: 'duplicateAsCustom',
            testID: 'provider-connection-menu-duplicate-custom',
            title: t('settingsProvidersCollection.duplicateAsCustom'),
            onSelect: () => { void runGuardedNavigation(() => setDuplicateMode('asCustom')); },
        },
        ...(gateway ? [{
            id: 'useExternal',
            testID: 'provider-connection-menu-use-external',
            title: t('settingsProvidersCollection.gateway.useExternalEndpoint'),
            disabled: mutation.isPending('deployment:external'),
            onSelect: () => useExternalDeployment(),
        }] : []),
        {
            id: 'delete',
            testID: 'provider-connection-menu-delete',
            title: t('settingsProviders.detail.deleteTitle'),
            disabled: deletePending,
            onSelect: () => remove(),
        },
    ];
    const probeDetail = connection.probeCapability === 'none'
        ? t('settingsProviders.detail.testOnFirstSession')
        : probeError
            ? t(probeErrorPresentation.descriptionKey)
            : probeState === 'success'
                ? t('settingsProviders.detail.testSucceeded')
                : probeState === 'notSupported'
                    ? t('settingsProviders.detail.testNotSupported')
                    : null;
    const apiKeyActionsDisabled = !selectedTargetServerMatchesActiveAccount;
    const selectedMachineName = machineId
        ? machineRows.find((row) => row.target.machineId === machineId)?.displayName ?? null
        : null;
    // A request to an external endpoint leaves the session's computer for the provider's host.
    const endpointHosts = connection.deployment.kind === 'external'
        ? [...new Set(connection.endpoints.map((endpoint) => endpointHost(endpoint.baseUrl)))]
        : [];

    const onThisComputerRows = machineId ? (
        <>
            {endpointHosts.length > 0 && selectedMachineName ? (
                <Item
                    testID="provider-connection-endpoint-access"
                    mode="info"
                    title={t('settingsProvidersCollection.endpointAccessTitle')}
                    subtitle={t('settingsProvidersCollection.endpointAccessDirect', {
                        machine: selectedMachineName,
                        host: endpointHosts.join(', '),
                    })}
                    subtitleLines={0}
                    detail={t('settingsProvidersCollection.endpointAccessDirectValue')}
                />
            ) : null}
            <Item
                testID="provider-connection-test-row"
                title={t('settingsProviders.detail.testConnection')}
                subtitle={probeDetail ? (
                    <ProviderProbeResult testID="provider-connection-probe-result" text={probeDetail} failed={Boolean(probeError)} />
                ) : undefined}
                subtitleLines={0}
                showChevron={false}
                rightElement={connection.probeCapability !== 'none' ? (
                    <RoundButton
                        testID="provider-connection-test"
                        size="small"
                        display="secondary"
                        title={t('settingsProvidersCollection.test')}
                        accessibilityLabel={t('settingsProviders.detail.testConnection')}
                        loading={probeState === 'probing'}
                        onPress={() => void runProbe()}
                    />
                ) : undefined}
                rightElementOutsidePressable
            />
            {localCandidate || localInstallation ? (
                <Item
                    testID={localCandidate ? 'provider-connection-local-candidate' : 'provider-connection-local-runtime'}
                    title={t('settingsProvidersCollection.localRuntimeTitle')}
                    subtitle={localCandidate
                        ? localCandidate.ownership === 'owned'
                            ? t('settingsProviders.local.startedByHappier')
                            : t('settingsProviders.local.runningOutsideHappier')
                        : localInstallation?.status === 'app_running_server_off'
                            ? t('settingsProviders.local.appRunningServerOff')
                            : t('settingsProviders.local.installedNotRunning')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={localInstallation?.managedStartAvailable ? (
                        <RoundButton
                            testID="provider-connection-local-start-managed"
                            size="small"
                            display="secondary"
                            title={t('settingsProvidersCollection.start')}
                            accessibilityLabel={t('settingsProviders.local.startManaged', { provider: localInstallation.providerName })}
                            loading={mutation.isPending(`start:${localInstallation.contributionKey}`)}
                            onPress={() => void startLocal()}
                        />
                    ) : undefined}
                    rightElementOutsidePressable
                />
            ) : null}
            {connection.credential ? (
                <Item
                    testID="provider-connection-machine-api-key"
                    title={t('settingsProviders.detail.machineApiKey')}
                    subtitle={apiKeyActionsDisabled
                        ? t('settingsProviders.local.accountScopeMismatchDescription')
                        : connection.credential.boundMachineIds.includes(machineId)
                            ? t('settingsProvidersCollection.apiKeyMachineDescription')
                            : t('settingsProviders.detail.useAccountApiKey')}
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={(
                        <ProviderSavedSecretControl
                            testID="provider-connection-machine-api-key"
                            saved={connection.credential.boundMachineIds.includes(machineId)}
                            disabled={apiKeyActionsDisabled}
                            onChoose={() => bindSecret('machine', machineId)}
                        />
                    )}
                    rightElementOutsidePressable
                />
            ) : null}
        </>
    ) : null;

    const nameRow = (
        <ProviderFieldRow
            testID="provider-connection-name"
            title={t('settingsProviders.authoring.name')}
            value={nameDraft ?? connection.displayName}
            placeholder={t('settingsProviders.authoring.namePlaceholder')}
            error={nameError}
            editable={!mutation.isPending('rename')}
            onChangeText={(value) => {
                setNameDraft(value);
                setNameError(null);
            }}
            onBlur={() => { void commitName(); }}
            onSubmitEditing={() => { void commitName(); }}
        />
    );
    // Where the gateway is saved to run. Whether the user's other computers can reach it is a peer
    // fact no projection reports to the app yet, so the row says it has not been checked.
    const gatewayReachability: ProviderGatewayHubReachability = 'unknown';
    const gatewayChosenMachine = gateway
        ? resolveProviderGatewayChosenMachine(gateway.saved.gatewayPlacement, gatewayMachines) : null;
    const gatewayUnavailableMachineName = gatewayChosenMachine?.machine && !gatewayChosenMachine.machine.online
        ? gatewayChosenMachine.machine.displayName : null;

    const header = (
        <>
            <PageHeader
                testID="provider-connection-header"
                alwaysShowTitle
                title={presentation.title}
                description={gateway ? t('settingsProvidersCollection.gateway.description') : undefined}
                titleAccessory={connection.provenance === 'external' || gateway ? (
                    <StatusPill
                        testID="provider-connection-experimental"
                        variant="warning"
                        label={t('settingsProviders.compatibility.experimental')}
                        hideDot
                    />
                ) : undefined}
                leading={(
                    <PageHeaderMarkSlot>
                        <ProviderIcon icon={connection.icon} size={24} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
                meta={[
                    ...(presentation.subtitle ? [{ key: 'provider', text: presentation.subtitle }] : []),
                    {
                        key: 'models',
                        text: connection.runtime.modelCount === null
                            ? t('settingsProviders.detail.modelsUnknown')
                            : t('settingsProviders.detail.modelCount', { count: connection.runtime.modelCount }),
                    },
                    ...(gatewayUnavailableMachineName ? [{
                        key: 'gateway-status',
                        testID: 'provider-gateway-status',
                        text: t('settingsProvidersCollection.gateway.statusUnavailable', { machine: gatewayUnavailableMachineName }),
                    }] : statusQuiet ? [] : [{
                        key: 'status',
                        testID: 'provider-connection-status',
                        text: t(PROVIDER_CONNECTION_STATUS_KEY[presentation.status]),
                    }]),
                ]}
                actions={(
                    <ProviderHeaderActions>
                        <PageHeaderStateSwitch
                            testID="provider-connection-enabled"
                            label={t('settingsProvidersCollection.enabled')}
                            accessibilityHint={t('settingsProvidersCollection.enabledDescription')}
                            value={connectionEnabled}
                            busy={mutation.isPending('enable:connection')}
                            onValueChange={(next) => { void setConnectionEnabled(next); }}
                        />
                        <PageHeaderMenu testID="provider-connection-menu" actions={menuActions} />
                    </ProviderHeaderActions>
                )}
            />

            {failureItems ? <ItemGroup>{failureItems}</ItemGroup> : null}

            {gatewayUnavailableMachineName ? (
                <AttentionBanner
                    testID="provider-gateway-offline"
                    title={t('settingsProvidersCollection.gateway.offlineTitle', { machine: gatewayUnavailableMachineName })}
                    description={t('settingsProvidersCollection.gateway.offlineDescription', {
                        gateway: presentation.title,
                        machine: gatewayUnavailableMachineName,
                    })}
                />
            ) : null}

            {props.justConnected && !completionNoteDismissed && pickerVisibility
                && !pickerVisibility.shown && pickerVisibility.defaultReason === 'manyModels' ? (
                <AttentionBanner
                    testID="provider-connection-completion-note"
                    tone="neutral"
                    title={t('settingsProvidersCollection.connectedTitle', { provider: presentation.title })}
                    description={connection.runtime.modelCount === null
                        ? t('settingsProvidersCollection.connectedHiddenDescription', { provider: presentation.title })
                        : t('settingsProvidersCollection.connectedHiddenCountDescription', {
                            provider: presentation.title,
                            count: connection.runtime.modelCount,
                        })}
                    action={{
                        testID: 'provider-connection-completion-show',
                        label: t('settingsProvidersCollection.showInPickerAction'),
                        display: 'secondary',
                        onPress: () => {
                            pickerVisibility.setShown(true);
                            dismissCompletionNote();
                        },
                    }}
                    onDismiss={dismissCompletionNote}
                />
            ) : null}

            {duplicateMode ? <ProviderDuplicateDraft key={duplicateMode} mode={duplicateMode}
                initialName={t('settingsProviders.detail.copyName', { name: connection.displayName })}
                pending={mutation.isPending(`duplicate:${duplicateMode}`)}
                onCreate={(name, allowNavigation) => duplicate(duplicateMode, name, allowNavigation)} onCancel={discardDuplicate} /> : null}
            {gateway ? (
                <ProviderGatewaySections
                    key={connection.connectionId}
                    localizedTextPluginId={contributionAuthorPluginId}
                    declarations={gateway.declarations}
                    slots={gateway.saved.purposeBindingDefaults ?? NO_GATEWAY_SLOTS}
                    onChangeSlot={changeGatewaySlot}
                    onConnectService={connectGatewayService}
                    placement={gateway.saved.gatewayPlacement}
                    machines={gatewayMachines}
                    reachability={gatewayReachability}
                    onChangePlacement={(gatewayPlacement) => changeGatewayConfiguration({ gatewayPlacement })}
                    helperModels={gateway.saved.claudeHelperModels}
                    models={gatewayModels}
                    onChangeHelperModels={(claudeHelperModels) => changeGatewayConfiguration({ claudeHelperModels })}
                    disabled={machineId === null || !connectedAccountScopeMatchesTarget}
                    disabledReason={connectedAccountScopeMatchesTarget
                        ? undefined
                        : t('settingsProviders.local.accountScopeMismatchDescription')}
                    nameRow={nameRow}
                    pickerRows={(
                        <>
                            {pickerVisibility ? (
                                <ProviderPickerVisibilityRow
                                    providerName={presentation.title}
                                    visibility={pickerVisibility}
                                    description={pickerVisibility.defaultReason === 'manyModels'
                                        ? t('settingsProvidersCollection.gateway.showInPickerGateway')
                                        : undefined}
                                />
                            ) : null}
                            <Item
                                testID="provider-connection-models-row"
                                title={t('settingsProviders.detail.modelsTitle')}
                                detail={models.modelCount > 0
                                    ? t('settingsProvidersCollection.gateway.modelsAvailable', { count: models.modelCount })
                                    : undefined}
                                onPress={revealModels}
                            />
                        </>
                    )}
                />
            ) : (
            <ItemGroup
                title={t('settingsProvidersCollection.connectionTitle')}
                description={t('settingsProvidersCollection.connectionDescription')}
            >
                {nameRow}
                {connection.credential ? (
                    <>
                        <Item
                            testID="provider-connection-account-api-key"
                            title={t('settingsProviders.authoring.apiKey')}
                            subtitle={apiKeyActionsDisabled
                                ? t('settingsProviders.local.accountScopeMismatchDescription')
                                : connection.credential.accountBound
                                    ? t('settingsProvidersCollection.apiKeySavedDescription')
                                    : t('settingsProviders.detail.apiKeyMissing')}
                            subtitleLines={0}
                            showChevron={false}
                            rightElement={(
                                <ProviderSavedSecretControl
                                    testID="provider-connection-account-api-key"
                                    saved={connection.credential.accountBound}
                                    disabled={apiKeyActionsDisabled}
                                    onChoose={() => bindSecret('account', machineId)}
                                />
                            )}
                            rightElementOutsidePressable
                        />
                        {connection.sourceStatus === 'available' && connection.credential.keyUrl ? (
                            <ProviderExternalLinkItem kind="getApiKey" url={connection.credential.keyUrl} />
                        ) : null}
                        {teamCredentialResourcesEnabled && selectedTargetServerMatchesActiveAccount && serverId && machineId && teamCredentialSourceOffer ? (
                            <Item
                                testID="provider-connection-share-with-team"
                                icon={<Icon name="users" />}
                                title={t('teams.credentials.create.action')}
                                onPress={() => router.push(teamsDirectoryShareCredentialPath({
                                    kind: 'provider_connection',
                                    serverId,
                                    machineId,
                                    connectionId: teamCredentialSourceOffer.connectionId,
                                    credentialSlotId: teamCredentialSourceOffer.credentialSlotId,
                                    connectionSecurityFingerprint: teamCredentialSourceOffer.connectionSecurityFingerprint,
                                }) as never)}
                            />
                        ) : null}
                    </>
                ) : null}
                <Item
                    testID="provider-connection-models-row"
                    title={t('settingsProviders.detail.modelsTitle')}
                    detail={models.modelCount > 0
                        ? t('settingsProvidersCollection.modelsShownCount', { count: models.shownModelCount })
                        : undefined}
                    onPress={revealModels}
                />
                {pickerVisibility ? (
                    <ProviderPickerVisibilityRow providerName={presentation.title} visibility={pickerVisibility} />
                ) : null}
            </ItemGroup>
            )}

            {machineSection(onThisComputerRows)}

            {connection.scope === 'account' || connection.grants.accountState !== 'absent' ? (
                <ItemGroup
                    title={t('settingsProvidersCollection.availabilityTitle')}
                    description={t('settingsProvidersCollection.availabilityDescription')}
                >
                    <Item
                        title={t('settingsProviders.detail.accountAccess')}
                        subtitle={t('settingsProviders.detail.accountAccessDescription')}
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={mutation.isPending('enable:account')
                            ? <ActivitySpinner size="small" />
                            : <Switch accessibilityLabel={t('settingsProviders.detail.accountAccess')} value={accountGrantValid} onValueChange={(next) => {
                                invalidateProbe();
                                void mutation.run({
                                    action: 'setEnabled', ...(machineId ? { machineId } : {}), connectionId: props.connectionId, enabled: next,
                                    ...(!next ? { scope: 'account' as const } : {}),
                                }, 'enable:account');
                            }} />}
                        rightElementOutsidePressable
                    />
                </ItemGroup>
            ) : null}

            {machineSectionVisible ? (
                <ItemGroup title={t('settingsProviders.detail.machinesTitle')} description={t('settingsProviders.detail.machinesFooter')}>
                    {readableMachineRows.map((row) => {
                        const rowKey = providerSettingsMachineRowKey(row.target);
                        const rowMachineId = row.target.machineId;
                        const selected = rowMachineId === machineId;
                        const machineViewState = machineViews.byTargetKey[rowKey];
                        const machineView = machineViewState?.status === 'success' || machineViewState?.status === 'loading'
                            ? machineViewState.connection
                            : null;
                        const granted = machineViewState?.status === 'success'
                            && machineView?.grants.machineState === 'valid';
                        const machineEndpoint = machineView?.endpoints
                            .map((endpoint) => endpoint.baseUrl)
                            .join(' · ');
                        const machineError = machineViewState?.status === 'error' ? machineViewState.error : null;
                        const machineErrorPresentation = presentProviderError(machineError);
                        return (
                            <React.Fragment key={rowKey}>
                                <Item
                                    title={row.displayName}
                                    subtitle={machineError
                                        ? t(machineErrorPresentation.descriptionKey)
                                        : machineViewState?.status === 'loading'
                                            ? t('common.loading')
                                            : machineEndpoint || (selected
                                                ? t('settingsProviders.detail.currentMachine')
                                                : t('settingsProviders.detail.selectMachineToManage'))}
                                    rightElement={!selected ? undefined : mutation.isPending(`machine:${rowMachineId}`)
                                        || machineViewState?.status === 'loading'
                                        ? <ActivitySpinner size="small" />
                                        : <Switch
                                            accessibilityLabel={row.displayName}
                                            disabled={machineViewState?.status !== 'success' || machineView === null}
                                            value={granted}
                                            onValueChange={(next) => void setMachineEnabled(rowMachineId, next)}
                                        />}
                                    rightElementOutsidePressable
                                    showChevron={!selected}
                                    onPress={!selected ? () => selectTargetMachine(row.target) : undefined}
                                />
                                {selected && machineError ? (
                                    <ProviderErrorItems
                                        error={machineError}
                                        retry={machineViews.refresh}
                                        enableOnMachine={machineError.action === 'enable_on_machine'
                                            ? () => setMachineEnabled(rowMachineId, true)
                                            : undefined}
                                    />
                                ) : null}
                            </React.Fragment>
                        );
                    })}
                </ItemGroup>
            ) : null}
        </>
    );
    const footer = (
        <>
            {!gateway && !gatewayArriving && (managedDeployment || managedLocalOption) ? (
                <ItemGroup title={t('settingsProvidersCollection.managedTitle')}>
                    <Item
                        testID="provider-connection-managed-subscription-policy"
                        mode="info"
                        title={t('settingsProviders.local.subscriptionPolicyTitle')}
                        subtitle={t('settingsProviders.local.subscriptionPolicyDescription')}
                        subtitleLines={0}
                    />
                    {managedDeployment?.effects ? (
                        <>
                            <Item
                                testID="provider-connection-managed-implementation"
                                mode="info"
                                title={connection.providerName}
                                subtitle={[
                                    t('settingsProviders.local.startedByHappier'),
                                    managedTargetMachineName ?? t('common.unavailable'),
                                ].join(' · ')}
                            />
                            <Item
                                testID="provider-connection-managed-protocols"
                                mode="info"
                                title={t('settingsProviders.authoring.protocolTitle')}
                                subtitle={managedDeployment.effects.protocols.join(' · ')}
                            />
                            {managedDeployment.effects.connectedAccountPurposes.map((purpose) => (
                                <Item
                                    key={`${purpose.service.pluginId}/${purpose.service.localId}/${purpose.purpose}`}
                                    testID={`provider-connection-managed-purpose:${purpose.purpose}`}
                                    mode="info"
                                    title={(purpose.title
                                        ? localizePluginText(contributionAuthorPluginId, purpose.title)
                                        : '') || resolveQualifiedConnectedServiceRegistryDisplayName(
                                        connectedServicesRegistry, purpose.service, t, localizePluginText,
                                    )}
                                    subtitle={connectedAccountScopeMatchesTarget
                                        ? resolveConnectedAccountPurposeTargetDisplay({
                                            target: purpose.target,
                                            accounts: profile.connectedAccountsV4 ?? [],
                                            groups: profile.connectedAccountGroupsV4 ?? [],
                                            labelsByKey,
                                            serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
                                                connectedServicesRegistry,
                                                purpose.service,
                                                t,
                                                localizePluginText,
                                            ),
                                            sourceNegotiation: connectedAccountUiNegotiation,
                                            presentIdentity: present,
                                        })
                                        // The binding belongs to another server's Account; this
                                        // Account's labels would name a different connected account.
                                        : t('common.unavailable')}
                                />
                            ))}
                        </>
                    ) : managedDeployment ? (
                        <Item
                            testID="provider-connection-managed-unavailable"
                            mode="info"
                            title={connection.providerName}
                            subtitle={connection.sourceStatus === 'unavailable'
                                ? t('settingsProviders.status.sourceUnavailable')
                                : t('settingsProviders.status.needsAttention')}
                        />
                    ) : null}
                    {managedLocalOption && !connectedAccountScopeMatchesTarget ? (
                        <Item
                            testID="provider-connection-managed-account-scope"
                            mode="info"
                            title={t('settingsProviders.local.accountScopeMismatchTitle')}
                            subtitle={t('settingsProviders.local.accountScopeMismatchDescription')}
                        />
                    ) : null}
                    {managedLocalOption && connectedAccountScopeMatchesTarget && !managedPurposeDraft ? (
                        <Item
                            testID="provider-connection-managed-configure"
                            title={managedDeployment
                                ? t('settingsProviders.local.editManagedDefaults')
                                : t('settingsProviders.local.configureManaged')}
                            subtitle={managedDeployment
                                ? t('settingsProviders.local.editManagedDefaultsDescription')
                                : t('settingsProviders.local.configureManagedDescription')}
                            subtitleLines={0}
                            loading={mutation.isPending('deployment:managedLocal')}
                            onPress={beginManagedPurposeConfiguration}
                        />
                    ) : null}
                    {managedLocalOption && connectedAccountScopeMatchesTarget && managedPurposeDraft ? (
                        <>
                            {managedLocalOption.connectedAccountPurposes.map((declaration) => (
                                <ConnectedAccountPurposeTargetChooser
                                    key={`${declaration.service.pluginId}/${declaration.service.localId}/${declaration.purpose}`}
                                    testID={`provider-connection-managed-purpose-chooser:${declaration.purpose}`}
                                    localizedTextPluginId={contributionAuthorPluginId}
                                    declaration={declaration}
                                    value={managedPurposeDraft.targets[declaration.purpose] ?? null}
                                    onChange={(target) => updateManagedPurposeDraftTarget(declaration.purpose, target)}
                                    onReload={reloadManagedPurposeTargets}
                                    reloadSubtitle={t(PROVIDER_CONNECTION_STATUS_KEY[presentation.status])}
                                />
                            ))}
                            <SectionContentRow testID="provider-connection-managed-purpose-actions">
                                <View style={styles.formActions}>
                                    <RoundButton
                                        testID="provider-connection-managed-purpose-save"
                                        size="small"
                                        title={t('common.save')}
                                        loading={mutation.isPending('deployment:managedLocal')}
                                        onPress={() => void saveManagedPurposeConfiguration()}
                                    />
                                    <RoundButton
                                        testID="provider-connection-managed-purpose-cancel"
                                        size="small"
                                        display="secondary"
                                        title={t('common.cancel')}
                                        onPress={() => setManagedPurposeDraft(null)}
                                    />
                                </View>
                            </SectionContentRow>
                        </>
                    ) : null}
                    {managedDeployment ? (
                        <Item
                            testID="provider-connection-managed-use-external"
                            title={t('settingsProviders.local.useExternal')}
                            subtitle={t('settingsProviders.local.useExternalDescription')}
                            subtitleLines={0}
                            loading={mutation.isPending('deployment:external')}
                            onPress={() => void useExternalDeployment()}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}

            {teamCredentialResourcesEnabled && selectedTargetServerMatchesActiveAccount && serverId ? (
                <SharedWithTeamsForSource
                    serverId={serverId}
                    source={{ v: 1, kind: 'provider_connection', connectionId: connection.connectionId }}
                />
            ) : null}

            <ProviderCompatibilitySection summaries={connection.compatibility} />
            <ProviderEndpointOverridesSection
                endpoints={connection.endpoints}
                onSetOverride={(input) => { void setEndpointOverride(input); }}
            />
        </>
    );

    return (
        <ProviderConnectionModelsPage
            connectionId={props.connectionId}
            models={models}
            header={header}
            footer={footer}
            revealOnMount={props.section === PROVIDER_CONNECTION_MODELS_SECTION}
            revealRequest={modelsRevealRequest}
            onRequestClose={() => router.back()}
        />
    );
});

const NO_GATEWAY_SLOTS = Object.freeze({});

const stylesheet = StyleSheet.create(() => ({
    formActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
}));

import * as React from 'react';
import {
    areProviderContributionKeysEqualV1,
    type MachineAdministrationTargetV1,
    type ProviderErrorV1,
    type QualifiedConnectedAccountPurposeBindingTargetV1,
} from '@happier-dev/protocol';
import type {
    DaemonProviderConnectionMutationRequestV1,
    DaemonProviderConnectionViewV1,
} from '@happier-dev/protocol/rpc';
import { useNavigation, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Switch } from '@/components/ui/forms/Switch';
import { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { ProviderExternalLinkItem } from '@/components/settings/providers/ProviderExternalLinkItem';
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
    PROVIDER_CONNECTION_STATUS_VARIANT,
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
import { probeProviderConnection, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useActiveUnsavedChangesGuard } from '@/utils/navigation/useActiveUnsavedChangesGuard';
import { useUnsavedChangesBeforeRemoveGuard } from '@/utils/navigation/useUnsavedChangesBeforeRemoveGuard';
import { promptUnsavedChangesAlert } from '@/utils/ui/promptUnsavedChangesAlert';
import {
    buildConnectedAccountPurposeTargetChoices,
    connectedAccountPurposeTargetChoiceId,
    resolveConnectedAccountPurposeTargetDisplay,
} from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { getConnectedAccountAuthenticationMode } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    ProviderCompatibilitySection,
    ProviderEndpointOverridesSection,
} from './detail/ProviderConnectionDetailSections';
import { ProviderFeatureAvailabilityNotice, useProviderFeatureAvailability } from './ProviderFeatureAvailability';
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
    machineId: string;
    connectionId: string;
    revision: number;
    initialTargetsKey: string;
    targets: Readonly<Record<string, QualifiedConnectedAccountPurposeBindingTargetV1 | null>>;
}>;

export const ProviderConnectionDetailScreen = React.memo(function ProviderConnectionDetailScreen(
    props: Readonly<{ connectionId: string }>,
) {
    const router = useRouter();
    const navigation = useNavigation();
    const { theme } = useUnistyles();
    const profile = useProfile();
    const settings = useSettings();
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const providerTarget = useProviderSettingsTarget();
    const { machineId, machineRows, resolveCurrentTarget, serverId } = providerTarget;
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
    const query = useProviderConnections({ enabled, machineId, serverId, connectionId: props.connectionId });
    const machineViews = useProviderConnectionMachineViews({
        enabled,
        connectionId: props.connectionId,
        targets: readableMachineRows,
    });
    const refreshConnectionDetail = React.useCallback(async () => {
        await query.refresh();
        // The selected connection is authoritative for mutation completion.
        // Peer rows are supporting presentation and must not hold the write's
        // critical path or replace a successful selected-machine refresh.
        void machineViews.refresh().catch(() => undefined);
    }, [machineViews.refresh, query.refresh]);
    const mutation = useProviderConnectionMutation({
        resolveTarget: resolveCurrentTarget,
        refresh: refreshConnectionDetail,
    });
    const deleteInFlightRef = React.useRef(false);
    const [deletePending, setDeletePending] = React.useState(false);
    const [probeState, setProbeState] = React.useState<'idle' | 'probing' | 'success' | 'notSupported'>('idle');
    const [probeError, setProbeError] = React.useState<ProviderErrorV1 | null>(null);
    const [managedPurposeDraft, setManagedPurposeDraft] = React.useState<ManagedPurposeDraft | null>(null);
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
    const connection = query.data?.connections.find((item) => item.connectionId === props.connectionId) ?? null;
    const managedDeployment = connection?.deployment.kind === 'managedLocal'
        ? connection.deployment
        : null;
    const managedLocalOption =
        connection?.managedLocalOption?.targetMachineId === machineId
            ? connection.managedLocalOption
            : null;
    // Connected Accounts, their labels, and the qualified-account transport are
    // all read from the ACTIVE server's Account. A Provider target on another
    // server profile belongs to a different Account, so its bindings must not
    // be labelled from — or written with — this Account's references.
    // The two ids are different forms of the same fact: the Administration
    // resolver returns the device-local `profile.id`, while the active snapshot
    // reports the profile's scope id (`serverIdentityId ?? id`). Comparing the
    // raw strings would report every identity-bearing active server as foreign,
    // so the shared profile-registry comparator decides equivalence.
    const activeServer = useActiveServerSnapshot();
    const activeServerId = String(activeServer.serverId ?? '').trim();
    const connectedAccountScopeMatchesTarget = serverId !== null
        && activeServerId.length > 0
        && areServerProfileIdentifiersEquivalent(serverId, activeServerId);
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
    }, [machineId, probeScope, props.connectionId, query.refresh, resolveCurrentTarget]);

    const bindSecret = React.useCallback((scope: 'account' | 'machine', targetMachineId: string) => {
        Modal.show({
            component: SavedSecretPickerModal,
            props: {
                selectedId: null,
                onSelectId: (savedSecretId) => {
                    invalidateProbe();
                    void mutation.run({
                        action: 'bindSecret', machineId: targetMachineId, connectionId: props.connectionId,
                        credentialSlotId: 'apiKey', savedSecretId, scope,
                    }, `secret:${scope}:${targetMachineId}`);
                },
            },
            chrome: { kind: 'card', title: t('settingsProviders.detail.pickSecretTitle'), dimensions: { size: 'lg' } },
            closeOnBackdrop: true,
        });
    }, [invalidateProbe, mutation, props.connectionId]);

    const duplicate = React.useCallback(async (mode: 'sameSource' | 'asCustom') => {
        if (!machineId || !connection) return;
        const name = await Modal.prompt(
            mode === 'asCustom' ? t('settingsProviders.customTitle') : t('settingsProviders.detail.duplicateTitle'),
            mode === 'asCustom' ? t('settingsProviders.customFooter') : t('settingsProviders.detail.duplicateDescription'),
            { defaultValue: t('settingsProviders.detail.copyName', { name: connection.displayName }), confirmText: t('common.create') },
        );
        if (!name?.trim()) return;
        const result = await mutation.run({
            action: 'duplicate', machineId, connectionId: props.connectionId,
            newConnectionId: `pc_${randomUUID()}`, displayName: name.trim(), mode,
        }, `duplicate:${mode}`);
        if (result?.status === 'success' && result.action === 'duplicate') {
            router.replace(`/(app)/settings/providers/${result.connection.connectionId}` as never);
        }
    }, [connection, machineId, mutation, props.connectionId, router]);

    const remove = React.useCallback(async () => {
        if (!machineId || !connection || deleteInFlightRef.current) return;
        deleteInFlightRef.current = true;
        setDeletePending(true);
        try {
            const confirmed = await Modal.confirm(
                t('settingsProviders.detail.deleteTitle'),
                t('settingsProviders.detail.deleteDescription'),
                { confirmText: t('common.delete'), destructive: true },
            );
            if (!confirmed) return;
            const result = await mutation.run({ action: 'delete', machineId, connectionId: props.connectionId }, 'delete');
            if (result?.status === 'success') {
                router.replace('/(app)/settings/providers' as never);
            }
        } catch {
            // Never leak modal/navigation boundary errors from row activation.
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
        if (!machineId || !connection) return;
        let baseUrl: string | null = null;
        if (!input.reset) {
            baseUrl = await Modal.prompt(
                input.scope === 'machine'
                    ? t('settingsProviders.detail.endpointMachine')
                    : t('settingsProviders.detail.endpointDefault'),
                t('settingsProviders.detail.endpointPrompt'),
                { defaultValue: input.currentUrl, confirmText: t('common.save') },
            );
            if (baseUrl === null || !baseUrl.trim()) return;
            baseUrl = baseUrl.trim();
        }
        invalidateProbe();
        await mutation.run({
            action: 'setEndpointOverride', machineId, connectionId: props.connectionId,
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
        if (!machineId || !connection || !managedLocalOption || !connectedAccountScopeMatchesTarget) return;
        const currentTargets = new Map(
            managedDeployment?.effects?.connectedAccountPurposes.map(
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
    ]);

    const updateManagedPurposeDraftTarget = React.useCallback((purpose: string, target: QualifiedConnectedAccountPurposeBindingTargetV1 | null) => {
        setManagedPurposeDraft((current) => current
            ? { ...current, targets: { ...current.targets, [purpose]: target } }
            : current);
    }, []);

    managedPurposeDraftDirtyRef.current = managedPurposeDraft !== null
        && JSON.stringify(managedPurposeDraft.targets) !== managedPurposeDraft.initialTargetsKey;
    const requestManagedPurposeDraftDecision = React.useCallback(() => promptUnsavedChangesAlert(
        (title, message, buttons) => Modal.alert(title, message, buttons),
        {
            title: t('common.discardChanges'),
            message: t('common.unsavedChangesWarning'),
            discardText: t('common.discard'),
            saveText: t('common.save'),
            keepEditingText: t('common.keepEditing'),
        },
    ), []);
    const continueManagedPurposeNavigation = React.useCallback((action: unknown) => {
        if (action) (navigation as { dispatch?: (value: unknown) => void } | null)?.dispatch?.(action);
    }, [navigation]);

    const reloadManagedPurposeTargets = React.useCallback(async () => {
        await Promise.all([sync.refreshProfile(), refreshConnectionDetail()]);
    }, [refreshConnectionDetail]);

    const saveManagedPurposeConfiguration = React.useCallback(async (): Promise<boolean> => {
        if (!machineId || !connection || !managedLocalOption || !managedPurposeDraft) return false;
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
                    labelsByKey: settings.connectedServicesProfileLabelByKey,
                    serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
                        connectedServicesRegistry, declaration.service, t, localizePluginText,
                    ),
                    resolveAuthenticationMode: (account) => getConnectedAccountAuthenticationMode(
                        account.ref.service,
                        account.authenticationModeId,
                    ),
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
        invalidateProbe();
        const result = await mutation.run(
            {
                action: 'update',
                machineId,
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
        settings.connectedServicesProfileLabelByKey,
    ]);

    useUnsavedChangesBeforeRemoveGuard({
        ignoreRef: ignoreManagedPurposeGuardRef,
        isDirty: managedPurposeDraftDirtyRef.current,
        isDirtyRef: managedPurposeDraftDirtyRef,
        requestDecision: requestManagedPurposeDraftDecision,
        onDiscard: () => setManagedPurposeDraft(null),
        onSave: saveManagedPurposeConfiguration,
        continueOnSave: true,
        onContinue: continueManagedPurposeNavigation,
        tag: 'ProviderConnectionDetailScreen.managedPurpose.beforeRemove',
    });
    useActiveUnsavedChangesGuard({
        navigation,
        guard: React.useMemo(() => ({
            isDirtyRef: managedPurposeDraftDirtyRef,
            ignoreRef: ignoreManagedPurposeGuardRef,
            requestDecision: requestManagedPurposeDraftDecision,
            onDiscard: () => setManagedPurposeDraft(null),
            onSave: saveManagedPurposeConfiguration,
            continueOnSave: true,
            tag: 'ProviderConnectionDetailScreen.managedPurpose.shellGuard',
        }), [requestManagedPurposeDraftDecision, saveManagedPurposeConfiguration]),
    });

    const useExternalDeployment = React.useCallback(async () => {
        if (!machineId || !connection || !managedDeployment) return;
        const confirmed = await Modal.confirm(
            t('settingsProviders.local.useExternalConfirmTitle'),
            t('settingsProviders.local.useExternalConfirmDescription'),
            { confirmText: t('settingsProviders.local.useExternal') },
        );
        if (!confirmed) return;
        invalidateProbe();
        await mutation.run(
            {
                action: 'update',
                machineId,
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

    if (availabilityPresentation) {
        return <ItemList><ItemGroup><ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} /></ItemGroup></ItemList>;
    }
    if (!machineId) {
        return <ItemList><ItemGroup><Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} /></ItemGroup></ItemList>;
    }
    if (query.loading && !query.data) {
        return <ItemList><ItemGroup><Item mode="info" loading title={t('common.loading')} /></ItemGroup></ItemList>;
    }
    const displayFailure = mutation.error
        ? {
            error: mutation.error,
            retry: mutation.retry,
            reviewCurrentState: query.refresh,
        }
        : query.error
            ? { error: query.error, retry: query.refresh }
            : connection?.authorizationError
                ? { error: connection.authorizationError, retry: query.refresh }
                : null;
    const displayError = displayFailure?.error ?? null;
    if (!connection && displayError) {
        return <ItemList><ItemGroup><ProviderErrorItems
            error={displayError}
            retry={displayFailure?.retry}
            reviewCurrentState={displayFailure && 'reviewCurrentState' in displayFailure
                ? displayFailure.reviewCurrentState
                : undefined}
            enableOnMachine={displayError.action === 'enable_on_machine'
                ? enableSelectedMachine
                : undefined}
        /></ItemGroup></ItemList>;
    }
    if (!connection) {
        const deleted = query.data?.deletedConnection;
        return (
            <ItemList>
                <ItemGroup>
                    <Item
                        mode="info"
                        title={deleted?.lastDisplayName ?? t('settingsProviders.detail.notFoundTitle')}
                        subtitle={deleted ? t('settingsProviders.detail.deletedDescription') : t('settingsProviders.detail.notFoundDescription')}
                        icon={<Icon name="warning-circle" size={29} color={theme.colors.state.warning.foreground} />}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    const presentation = presentProviderConnection(connection);
    const probeErrorPresentation = presentProviderError(probeError);
    const accountGrantValid = connection.grants.accountState === 'valid';
    const managedTargetMachineName = managedDeployment
        ? machineRows.find((row) => row.target.machineId === managedDeployment.targetMachineId)?.displayName ?? null
        : null;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <MachineAdministrationTargetSelector
                selection={providerTarget.selection}
                testIDPrefix="settings.providers.administration.target"
            />
            <ItemGroup title={presentation.title} footer={presentation.subtitle || undefined}>
                <Item
                    mode="info"
                    title={connection.providerName}
                    subtitle={connection.sourceStatus === 'available'
                        ? t('settingsProviders.detail.sourceAvailable')
                        : t('settingsProviders.status.sourceUnavailable')}
                    subtitleAccessory={connection.provenance === 'external' ? (
                        <StatusPill
                            chrome="plain"
                            variant="warning"
                            label={t('settingsProviders.compatibility.experimental')}
                        />
                    ) : undefined}
                    icon={<ProviderIcon icon={connection.icon} size={29} color={theme.colors.text.secondary} />}
                    rightElement={<StatusPill
                        chrome="plain"
                        variant={PROVIDER_CONNECTION_STATUS_VARIANT[presentation.status]}
                        label={t(PROVIDER_CONNECTION_STATUS_KEY[presentation.status])}
                    />}
                    rightElementOutsidePressable
                />
                {connection.sourceStatus === 'available' && connection.websiteUrl ? (
                    <ProviderExternalLinkItem kind="providerWebsite" url={connection.websiteUrl} />
                ) : null}
            </ItemGroup>

            {managedDeployment || managedLocalOption ? (
                <ItemGroup title={t('settingsProviders.local.title')}>
                    <Item
                        testID="provider-connection-managed-subscription-policy"
                        mode="info"
                        title={t('settingsProviders.local.subscriptionPolicyTitle')}
                        subtitle={t('settingsProviders.local.subscriptionPolicyDescription')}
                        icon={<Icon name="warning" size={29} color={theme.colors.text.secondary} />}
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
                                icon={<Icon name="cpu" size={29} color={theme.colors.text.secondary} />}
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
                                    title={purpose.title ?? resolveQualifiedConnectedServiceRegistryDisplayName(
                                        connectedServicesRegistry, purpose.service, t, localizePluginText,
                                    )}
                                    subtitle={connectedAccountScopeMatchesTarget
                                        ? resolveConnectedAccountPurposeTargetDisplay({
                                            target: purpose.target,
                                            accounts: profile.connectedAccountsV4 ?? [],
                                            groups: profile.connectedAccountGroupsV4 ?? [],
                                            labelsByKey: settings.connectedServicesProfileLabelByKey,
                                            serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
                                                connectedServicesRegistry,
                                                purpose.service,
                                                t,
                                                localizePluginText,
                                            ),
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
                            icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
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
                            loading={mutation.isPending('deployment:managedLocal')}
                            onPress={beginManagedPurposeConfiguration}
                        />
                    ) : null}
                    {managedLocalOption && managedPurposeDraft ? (
                        <>
                            {managedLocalOption.connectedAccountPurposes.map((declaration) => (
                                <ConnectedAccountPurposeTargetChooser
                                    key={`${declaration.service.pluginId}/${declaration.service.localId}/${declaration.purpose}`}
                                    testID={`provider-connection-managed-purpose-chooser:${declaration.purpose}`}
                                    declaration={declaration}
                                    value={managedPurposeDraft.targets[declaration.purpose] ?? null}
                                    onChange={(target) => updateManagedPurposeDraftTarget(declaration.purpose, target)}
                                    onReload={reloadManagedPurposeTargets}
                                    reloadSubtitle={t(PROVIDER_CONNECTION_STATUS_KEY[presentation.status])}
                                />
                            ))}
                            <Item
                                testID="provider-connection-managed-purpose-save"
                                title={t('common.save')}
                                loading={mutation.isPending('deployment:managedLocal')}
                                onPress={() => void saveManagedPurposeConfiguration()}
                            />
                            <Item
                                testID="provider-connection-managed-purpose-cancel"
                                title={t('common.cancel')}
                                onPress={() => setManagedPurposeDraft(null)}
                            />
                        </>
                    ) : null}
                    {managedDeployment ? (
                        <Item
                            testID="provider-connection-managed-use-external"
                            title={t('settingsProviders.local.useExternal')}
                            subtitle={t('settingsProviders.local.useExternalDescription')}
                            loading={mutation.isPending('deployment:external')}
                            onPress={() => void useExternalDeployment()}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}

            {localCandidate || localInstallation ? (
                <ItemGroup title={t('settingsProviders.local.title')}>
                    {localCandidate ? (
                        <Item
                            testID="provider-connection-local-candidate"
                            mode="info"
                            title={localCandidate.providerName}
                            subtitle={localCandidate.ownership === 'owned'
                                ? t('settingsProviders.local.startedByHappier')
                                : t('settingsProviders.local.runningOutsideHappier')}
                            icon={<Icon name="cpu" size={29} color={theme.colors.text.secondary} />}
                        />
                    ) : null}
                    {localInstallation?.managedStartAvailable ? (
                        <Item
                            testID="provider-connection-local-start-managed"
                            title={t('settingsProviders.local.startManaged', { provider: localInstallation.providerName })}
                            subtitle={localInstallation.status === 'app_running_server_off'
                                ? t('settingsProviders.local.appRunningServerOff')
                                : t('settingsProviders.local.installedNotRunning')}
                            loading={mutation.isPending(`start:${localInstallation.contributionKey}`)}
                            onPress={() => void startLocal()}
                        />
                    ) : null}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settingsProviders.detail.connectionTitle')} footer={t('settingsProviders.detail.connectionFooter')}>
                {connection.scope === 'account' || connection.grants.accountState !== 'absent' ? (
                    <Item
                        title={t('settingsProviders.detail.accountAccess')}
                        subtitle={t('settingsProviders.detail.accountAccessDescription')}
                        rightElement={mutation.isPending('enable:account')
                            ? <ActivitySpinner size="small" />
                            : <Switch accessibilityLabel={t('settingsProviders.detail.accountAccess')} value={accountGrantValid} onValueChange={(next) => {
                                invalidateProbe();
                                void mutation.run({
                                    action: 'setEnabled', machineId, connectionId: props.connectionId, enabled: next,
                                    ...(!next ? { scope: 'account' as const } : {}),
                                }, 'enable:account');
                            }} />}
                        rightElementOutsidePressable
                    />
                ) : null}
                {connection.probeCapability === 'none' ? (
                    <Item
                        mode="info"
                        title={t('settingsProviders.detail.testNotSupported')}
                        subtitle={t('settingsProviders.detail.testOnFirstSession')}
                        icon={<Icon name="info" size={29} color={theme.colors.text.secondary} />}
                    />
                ) : (
                    <Item
                        title={t('settingsProviders.detail.testConnection')}
                        subtitle={probeError
                            ? t(probeErrorPresentation.descriptionKey)
                            : probeState === 'success'
                            ? t('settingsProviders.detail.testSucceeded')
                            : probeState === 'notSupported'
                                ? t('settingsProviders.detail.testNotSupported')
                                : t('settingsProviders.detail.testDescription')}
                        loading={probeState === 'probing'}
                        icon={<Icon name="pulse" size={29} color={theme.colors.text.secondary} />}
                        onPress={() => void runProbe()}
                    />
                )}
            </ItemGroup>

            {connection.scope === 'machine' || connection.grants.enabledMachineIds.length > 0 ? <ItemGroup title={t('settingsProviders.detail.machinesTitle')} footer={t('settingsProviders.detail.machinesFooter')}>
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
            </ItemGroup> : null}

            {connection.credential ? (
                <ItemGroup title={t('settingsProviders.detail.apiKeyTitle')} footer={t('settingsProviders.detail.apiKeyFooter')}>
                    <Item
                        title={t('settingsProviders.detail.accountApiKey')}
                        subtitle={connection.credential.accountBound ? t('settingsProviders.detail.apiKeyConfigured') : t('settingsProviders.detail.apiKeyMissing')}
                        icon={<Icon name="key" size={29} color={theme.colors.text.secondary} />}
                        onPress={() => bindSecret('account', machineId)}
                    />
                    <Item
                        title={t('settingsProviders.detail.machineApiKey')}
                        subtitle={connection.credential.boundMachineIds.includes(machineId) ? t('settingsProviders.detail.apiKeyConfigured') : t('settingsProviders.detail.useAccountApiKey')}
                        onPress={() => bindSecret('machine', machineId)}
                    />
                    {connection.sourceStatus === 'available' && connection.credential.keyUrl ? (
                        <ProviderExternalLinkItem kind="getApiKey" url={connection.credential.keyUrl} />
                    ) : null}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('settingsProviders.detail.modelsTitle')}>
                <Item
                    testID="provider-connection-manage-models"
                    title={t('settingsProviders.detail.manageModels')}
                    subtitle={connection.runtime.modelCount === null
                        ? t('settingsProviders.detail.modelsUnknown')
                        : t('settingsProviders.detail.modelCount', { count: connection.runtime.modelCount })}
                    icon={<Icon name="stack-simple" size={29} color={theme.colors.text.secondary} />}
                    onPress={() => router.push(`/(app)/settings/providers/${props.connectionId}/models` as never)}
                />
                {connection.manualModelPolicy === 'allowed' && connection.runtime.modelCount === null ? (
                    <Item
                        title={t('settingsProviders.models.add')}
                        subtitle={t('settingsProviders.models.addDescription')}
                        icon={<Icon name="plus-circle" size={29} color={theme.colors.text.secondary} />}
                        onPress={() => router.push(`/(app)/settings/providers/${props.connectionId}/models?add=1` as never)}
                    />
                ) : null}
            </ItemGroup>

            <ProviderCompatibilitySection summaries={connection.compatibility} />
            <ProviderEndpointOverridesSection
                endpoints={connection.endpoints}
                onSetOverride={(input) => { void setEndpointOverride(input); }}
            />

            <ItemGroup title={t('settingsProviders.detail.actionsTitle')}>
                <Item title={t('settingsProviders.detail.duplicateTitle')} subtitle={t('settingsProviders.detail.duplicateDescription')} onPress={() => void duplicate('sameSource')} />
                <Item title={t('settingsProviders.customTitle')} subtitle={t('settingsProviders.customFooter')} onPress={() => void duplicate('asCustom')} />
                <Item
                    destructive
                    title={t('settingsProviders.detail.deleteTitle')}
                    subtitle={t('settingsProviders.detail.deleteDescription')}
                    loading={deletePending}
                    disabled={deletePending}
                    onPress={() => void remove()}
                />
            </ItemGroup>

            {displayError ? (
                <ItemGroup>
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
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

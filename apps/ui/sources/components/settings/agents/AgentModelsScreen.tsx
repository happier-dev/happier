import * as React from 'react';
import { useIsFocused, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import type { ProviderModelPickerSourceKind } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import { resolveProviderModelPickerVisibility } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';

import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useAgentModelsProjection } from './useAgentModelsProjection';
import { useProviderModelLoadAction } from '@/providers/hooks/useProviderModelLoadAction';
import { useProviderModelPickerVisibility } from '@/providers/hooks/useProviderModelPickerVisibility';
import { useRetireProviderStateOnAccountChange } from '@/providers/hooks/accountLifetimeRetirement';
import {
    ProviderModelManager,
    buildProviderModelVisibilityChanges,
    type ProviderModelManagerSourceGrouping,
} from '@/providers/models/ProviderModelManager';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { providerDeclarationContext, readProviderConnectionPickerKind } from '@/providers/catalog/accountProviderDeclarations';
import { providerConnectionModelsRoute, resolveProviderConnectionIcon } from '@/components/settings/providers/collection/providerCollectionModel';
import {
    providerModelLoadRecoveryForError,
    providerRetryRecoveryForError,
} from '@/providers/connection/recovery';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { useAgentAdministrationCatalog } from './collection/useAgentAdministrationCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { View } from 'react-native';
import { happierPageTextMetrics, resolveHappierIconSize } from '@happier-dev/plugin-ui/presentation';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ProviderIcon } from '@/providers/connection/ProviderIcon';
import { useCurrentFavoriteModelSelectionsV1Mutable } from '@/sync/store/hooks';
import { getV1FavoriteModelRefs, toggleFavoriteModelSelection } from '@/sync/domains/models/favoriteModelSelections';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { t } from '@/text';
import { resolveAgentModelsSettingsAccess } from './resolveAgentModelsSettingsAccess';
import { resolveAgentNativeModels, summarizeAgentModelVisibility } from './agentModelVisibility';
import { useMachineAgentModels } from '@/components/sessions/actions/useMachineAgentModels';

function AgentSourceVisibility(props: Readonly<{
    connectionId: string;
    kind: ProviderModelPickerSourceKind;
    serverId: string | null;
    readOnly: boolean;
    onStateChange: (connectionId: string, error: unknown, reviewCurrentState: () => Promise<void>) => void;
}>) {
    const visibility = useProviderModelPickerVisibility(props.connectionId, { kind: props.kind, serverId: props.serverId });
    const error = visibility?.error ?? null;
    const reviewCurrentState = visibility?.reviewCurrentState;
    React.useEffect(() => {
        if (reviewCurrentState) props.onStateChange(props.connectionId, error, reviewCurrentState);
    }, [error, props.connectionId, props.onStateChange, reviewCurrentState]);
    if (!visibility) return null;
    if (visibility.busy) return <ActivitySpinner size="small" />;
    return (
        <View style={styles.sourceVisibility}>
            <Text style={styles.sourceVisibilityLabel}>{t('settingsProvidersCollection.showInPickerTitle')}</Text>
            <Switch
                testID={`agent-models-source-visibility:${props.connectionId}`}
                compact
                disabled={props.readOnly}
                accessibilityLabel={t('settingsProvidersCollection.showInPickerTitle')}
                value={visibility.shown}
                onValueChange={visibility.setShown}
            />
        </View>
    );
}

export const AgentModelsScreen = React.memo(function AgentModelsScreen(props: Readonly<{
    agentTargetKey: string;
    runtimeAgentId: string | null;
}>) {
    const router = useRouter();
    const focused = useIsFocused();
    const enabled = useFeatureEnabled('providers');
    const administration = useAgentAdministrationCatalog({ loadProjection: focused });
    const declarationProjection = administration.declarationProjection ?? null;
    const administrationTargetSelection = administration.targetSelection;
    const executionTarget = administration.executionTarget;
    const accountScope = useAccountSettingsScope();
    const machineId = executionTarget?.machine.id ?? null;
    const declarationMachineId = administrationTargetSelection.selectedTarget?.machineId ?? null;
    const declarationContext = React.useMemo(() => providerDeclarationContext(declarationMachineId, declarationProjection),
        [declarationMachineId, declarationProjection]);
    // A selected machine retains its exact Home even offline; only an absent
    // selection falls back to Account-only model management.
    const serverId = administration.projectionScope?.serverId
        ?? (administrationTargetSelection.selectedTarget === null ? accountScope?.serverId ?? null : null);
    const { mutateProviderModelSettings, setProviderDefaultModelSelection } = useProviderActionClient(serverId);
    const providerCatalog = useProviderCatalogForServer(serverId);
    const modelConnectionIds = React.useMemo(() => providerCatalog?.data?.connections.map(connection => connection.id) ?? [],
        [providerCatalog?.data?.connections]);
    const resolveCurrentExecutionTarget = React.useCallback(() => {
        if (!executionTarget) return null;
        const resolvedTarget = administrationTargetSelection.resolveExecutionTarget();
        if (!resolvedTarget || !isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: executionTarget,
            resolveCurrentTarget: () => resolvedTarget,
        })) return null;
        return {
            machineId: resolvedTarget.machine.id,
            serverId: resolvedTarget.serverId,
        };
    }, [administrationTargetSelection, executionTarget]);
    const projection = useAgentModelsProjection({
        active: focused,
        enabled, machineId, serverId, agentTargetKey: props.agentTargetKey, connectionIds: modelConnectionIds,
    });
    const settingsAccess = React.useMemo(
        () => resolveAgentModelsSettingsAccess(providerCatalog),
        [providerCatalog],
    );
    const providerSettings = settingsAccess.settings;
    const modelVisibilityByRef = providerCatalog?.data?.modelVisibilityByRef ?? providerSettings.modelVisibilityByRef;
    const defaultSelection = useProviderSettingsForServer(serverId).defaultsByAgentTargetKey[props.agentTargetKey] ?? null;
    const [favorites, setFavorites] = useCurrentFavoriteModelSelectionsV1Mutable();
    // Favorites are Account settings: they are read and written only for the Account's own Home.
    const favoritesInScope = Boolean(accountScope && serverId
        && areServerProfileIdentifiersEquivalent(accountScope.serverId, serverId));
    const favoriteRefs = React.useMemo(() => favoritesInScope
        ? getV1FavoriteModelRefs(favorites).filter(ref => ref.agentTargetKey === props.agentTargetKey)
        : [], [favorites, favoritesInScope, props.agentTargetKey]);
    const agentEntry = administration.agentEntries.find(entry => entry.backendTargetKey === props.agentTargetKey) ?? null;
    const agentTitle = agentEntry?.title ?? null;
    const toggleFavorite = React.useCallback((input: Readonly<{
        ref: ProviderBoundModelRef;
        modelLabel: string;
        providerDisplaySnapshot: Parameters<typeof toggleFavoriteModelSelection>[0]['providerDisplaySnapshot'];
    }>) => {
        if (!agentEntry || !favoritesInScope) return;
        setFavorites(toggleFavoriteModelSelection({
            favorites,
            backend: { backendTargetKey: props.agentTargetKey, catalogAgentId: agentEntry.catalogAgentId },
            modelRef: input.ref,
            modelLabel: input.modelLabel,
            backendLabel: agentEntry.title,
            providerDisplaySnapshot: input.providerDisplaySnapshot,
            addedAtMs: Date.now(),
        }));
    }, [agentEntry, favorites, favoritesInScope, props.agentTargetKey, setFavorites]);
    const [operationError, setOperationError] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
        loadModel?: () => Promise<void>;
        reviewCurrentState?: () => Promise<void>;
        sourceVisibilityConnectionId?: string;
    }> | null>(null);
    const retireOperationError = React.useCallback(() => setOperationError(null), []);
    const accountLifetime = useRetireProviderStateOnAccountChange(retireOperationError);
    const observedNativeModels = useMachineAgentModels({
        agentTargetKey: props.agentTargetKey,
        machineId,
        serverId,
        enabled: focused && executionTarget !== null,
    });
    const nativeModels = React.useMemo(() => resolveAgentNativeModels({
        runtimeAgentId: props.runtimeAgentId,
        agentTargetKey: props.agentTargetKey,
        modelVisibilityByRef,
        ...(observedNativeModels ? { observedModels: observedNativeModels } : {}),
    }), [props.agentTargetKey, props.runtimeAgentId, modelVisibilityByRef, observedNativeModels]);

    const showError = React.useCallback((
        error: ProviderErrorV1,
        recovery: Readonly<{
            retry?: () => Promise<void>;
            loadModel?: () => Promise<void>;
            reviewCurrentState?: () => Promise<void>;
        }> = {},
    ) => setOperationError({ error, ...recovery }), []);
    const handleSourceVisibilityState = React.useCallback((connectionId: string, error: unknown, reviewCurrentState: () => Promise<void>) => {
        if (!accountLifetime?.isCurrent()) return;
        setOperationError(current => error
            ? { error: providerErrorFromRpcFailure(error, { connectionId }), reviewCurrentState, sourceVisibilityConnectionId: connectionId }
            : current?.sourceVisibilityConnectionId === connectionId ? null : current);
    }, [accountLifetime]);
    const { theme } = useUnistyles();
    // Identity marks lead each source sheet, as on the Agents and Providers pages.
    const markSize = resolveHappierIconSize('medium');
    const nativeMark = React.useMemo(() => props.runtimeAgentId
        ? <AgentIcon agentId={props.runtimeAgentId} size={markSize} />
        : undefined, [markSize, props.runtimeAgentId]);
    const renderSourceMark = React.useCallback((connectionId: string) => {
        const connection = providerSettings.connections.find(item => item.id === connectionId);
        const source = connection?.source;
        const icon = connection ? resolveProviderConnectionIcon(connection, declarationContext) : null;
        return <ProviderIcon contributionKey={source?.kind === 'contribution' ? source.contributionKey : null}
            icon={icon} size={markSize} color={theme.colors.text.secondary} />;
    }, [declarationContext, markSize, providerSettings.connections, theme.colors.text.secondary]);
    const renderSourceAccessory = React.useCallback((connectionId: string) => {
        const kind = readProviderConnectionPickerKind(providerSettings.connections.find(item => item.id === connectionId)?.source, declarationContext);
        return kind
            ? <AgentSourceVisibility connectionId={connectionId} kind={kind} serverId={serverId} readOnly={!settingsAccess.writable} onStateChange={handleSourceVisibilityState} />
            : null;
    }, [declarationContext, handleSourceVisibilityState, providerSettings.connections, serverId, settingsAccess.writable]);
    const reviewCurrentState = React.useCallback(async (): Promise<void> => {
        if (!accountLifetime?.isCurrent() || !serverId
            || !areServerProfileIdentifiersEquivalent(accountLifetime.scope.serverId, serverId)) return;
        // Native visibility comes from the Account catalog; runtime rows come
        // from the projection. Review both inputs without replaying the write.
        await refreshProviderCatalog(accountLifetime.scope);
        if (accountLifetime.isCurrent()) await projection.refresh();
    }, [accountLifetime, projection.refresh, serverId]);
    const setDefault = React.useCallback(async (ref: ProviderBoundModelRef): Promise<void> => {
        if (!accountLifetime?.isCurrent() || !settingsAccess.writable || ref.agentTargetKey !== props.agentTargetKey) return;
        try {
            await setProviderDefaultModelSelection({
                serverId, agentTargetKey: props.agentTargetKey,
                selection: { v: 1, ref, updatedAt: Date.now() },
            });
            if (accountLifetime.isCurrent()) setOperationError(null);
        } catch (caught) {
            if (!accountLifetime.isCurrent()) return;
            const error = providerErrorFromRpcFailure(caught);
            showError(error, error.code === 'provider_rpc_mutation_outcome_unknown'
                ? { reviewCurrentState }
                : providerRetryRecoveryForError(error, () => setDefault(ref)));
        }
    }, [accountLifetime, props.agentTargetKey, reviewCurrentState, serverId, setProviderDefaultModelSelection, settingsAccess.writable, showError]);
    // One sheet per source, in picker order; hidden models stay in their source, switched off.
    const grouping = React.useMemo((): ProviderModelManagerSourceGrouping => ({
        nativeTitle: agentTitle ?? t('settingsAgents.detailPage.modelsNativeFallbackTitle'),
        nativeDescription: agentTitle
            ? t('settingsAgents.detailPage.modelsNativeDescription', { agent: agentTitle })
            : t('settingsAgents.detailPage.modelsNativeFallbackDescription'),
        connectionDescription: t('settingsAgents.detailPage.modelsSourceShownDescription'),
        isSourceShown: connectionId => {
            const kind = readProviderConnectionPickerKind(providerSettings.connections.find(connection => connection.id === connectionId)?.source, declarationContext);
            return kind ? resolveProviderModelPickerVisibility({ connectionId, kind,
                modelPickerVisibilityByConnectionId: providerCatalog?.data?.modelPickerVisibilityByConnectionId }).shown : null;
        },
        defaultRef: defaultSelection
            ? { providerConnectionId: defaultSelection.ref.providerConnectionId, modelId: defaultSelection.ref.modelId }
            : null,
        favoriteRefs,
        ...(favoritesInScope && agentEntry && settingsAccess.writable ? { onToggleFavorite: toggleFavorite } : {}),
        onSetDefault: ref => { void setDefault(ref); },
        renderSourceAccessory,
        nativeMark,
        renderSourceMark,
    }), [agentEntry, agentTitle, declarationContext, defaultSelection, favoriteRefs, favoritesInScope, nativeMark, providerCatalog?.data?.modelPickerVisibilityByConnectionId, providerSettings.connections, renderSourceAccessory, renderSourceMark, setDefault, settingsAccess.writable, toggleFavorite]);
    const refreshLoadedModel = React.useCallback(async (connectionId: string, modelId: string) => {
        if (!resolveCurrentExecutionTarget()) return false;
        const result = await projection.refreshWithResult();
        if (!result) return false;
        if (result.status === 'error') throw result.error;
        const group = result.groups.find((candidate) => candidate.connectionId === connectionId);
        return group?.rows.some((row) => row.ref.modelId === modelId && row.loadState === 'loaded') === true;
    }, [projection.refreshWithResult, resolveCurrentExecutionTarget]);
    const modelLoad = useProviderModelLoadAction({
        active: focused,
        machineId,
        serverId,
        refresh: refreshLoadedModel,
        resolveExecutionTarget: resolveCurrentExecutionTarget,
    });
    const loadModel = React.useCallback(async (connectionId: string, modelId: string) => {
        if (!settingsAccess.writable) return;
        const result = await modelLoad.load(connectionId, modelId);
        if (result.status === 'error') {
            const retryLoad = () => loadModel(connectionId, modelId);
            showError(result.error, result.error.code === 'provider_rpc_mutation_outcome_unknown'
                ? { reviewCurrentState }
                : providerModelLoadRecoveryForError(result.error, retryLoad));
        } else if (result.status === 'not_supported') {
            showError(createProviderErrorV1('provider_model_unloaded', { connectionId }));
        } else if (result.status === 'loaded') {
            setOperationError(null);
        }
    }, [modelLoad.load, reviewCurrentState, settingsAccess.writable, showError]);
    const mutate = React.useCallback(async (
        request: Parameters<typeof mutateProviderModelSettings>[0]['request'],
    ): Promise<void> => {
        if (!accountLifetime?.isCurrent() || !settingsAccess.writable) return;
        const handleFailure = async (error: ProviderErrorV1): Promise<void> => {
            if (error.code === 'provider_rpc_mutation_outcome_unknown') {
                try {
                    await reviewCurrentState();
                } catch {
                    // Preserve the unknown mutation outcome. A failed reconciliation
                    // must not turn an unsafe write replay into the recovery action.
                }
                if (!accountLifetime?.isCurrent()) return;
                showError(error, { reviewCurrentState });
                return;
            }
            showError(error, providerRetryRecoveryForError(error, () => mutate(request)));
        };
        let result: Awaited<ReturnType<typeof mutateProviderModelSettings>>;
        try {
            result = await mutateProviderModelSettings({
                serverId,
                request,
            });
        } catch (caught) {
            if (!accountLifetime?.isCurrent()) return;
            await handleFailure(providerErrorFromRpcFailure(caught, {
                ...(machineId ? { machineId } : {}),
            }));
            return;
        }
        if (!accountLifetime?.isCurrent()) return;
        if (result.status === 'error') {
            await handleFailure(result.error);
            return;
        }
        await projection.refresh();
        if (accountLifetime?.isCurrent()) setOperationError(null);
    }, [accountLifetime, machineId, mutateProviderModelSettings, projection.refresh, reviewCurrentState, serverId, settingsAccess.writable, showError]);
    const setVisibility = React.useCallback((ref: ModelVisibilityRefV1, hidden: boolean) => {
        void mutate({ action: 'setVisibility', ...(machineId ? { machineId } : {}), ref, hidden });
    }, [machineId, mutate]);
    const reset = React.useCallback(() => {
        void mutate({
            action: 'resetVisibility', ...(machineId ? { machineId } : {}),
            scope: { kind: 'agent', agentTargetKey: props.agentTargetKey },
        });
    }, [machineId, mutate, props.agentTargetKey]);
    const bulkChanges = React.useCallback((
        action: 'showAll' | 'hideAll' | 'showOnly',
        selected?: ModelVisibilityRefV1,
    ) => buildProviderModelVisibilityChanges({
        scope: { kind: 'agent', agentTargetKey: props.agentTargetKey },
        nativeModels,
        groups: projection.data?.groups ?? [],
        action,
        ...(selected ? { selected } : {}),
    }), [nativeModels, projection.data?.groups, props.agentTargetKey]);
    const runBulk = React.useCallback(async (
        action: 'showAll' | 'hideAll' | 'showOnly',
        selected?: ModelVisibilityRefV1,
    ) => {
        if (!accountLifetime?.isCurrent() || !settingsAccess.writable) return;
        const changes = bulkChanges(action, selected);
        if (changes.length === 0) return;
        await mutate({ action: 'bulkVisibility', ...(machineId ? { machineId } : {}), changes: [...changes] });
    }, [accountLifetime, bulkChanges, machineId, mutate, settingsAccess.writable]);

    // These are Account settings: the page names no machine. Bulk operations are the one overflow;
    // "Show all models" appears only while something is hidden.
    const managementGroups = projection.data?.groups;
    const anyHidden = summarizeAgentModelVisibility({
        nativeModels, pickerGroups: [], managementGroups: managementGroups ?? [],
    }).hidden > 0;
    const bulkMenuActions: PageHeaderMenuAction[] = settingsAccess.writable ? [
        ...(anyHidden ? [{
            id: 'showAll', testID: 'provider-model-manager.show-all',
            title: t('settingsProviders.models.showAll'), onSelect: () => { void runBulk('showAll'); },
        }] : []),
        {
            id: 'hideAll', testID: 'provider-model-manager.hide-all',
            title: t('settingsProviders.models.hideAll'), onSelect: () => { void runBulk('hideAll'); },
        },
        {
            id: 'reset', testID: 'provider-model-manager.reset',
            title: t('settingsProviders.models.resetVisibility'), onSelect: reset,
        },
    ] : [];
    const header = (
        <SettingsPageHeader
            testID="settings.agents.models.header"
            description={(
                <View style={styles.headerText}>
                    {agentTitle ? (
                        <View testID="agent-models.identity" style={styles.identity}>
                            {props.runtimeAgentId ? <AgentIcon agentId={props.runtimeAgentId} size={14} /> : null}
                            <Text style={[styles.identityText, { color: theme.colors.text.secondary }]}>{agentTitle}</Text>
                        </View>
                    ) : null}
                    <Text style={[styles.descriptionText, { color: theme.colors.text.secondary }]}>
                        {agentTitle
                            ? t('settingsAgents.detailPage.modelsDescription', { agent: agentTitle })
                            : t('settingsProvidersCollection.modelsDescription')}
                    </Text>
                </View>
            )}
            actions={projection.data && bulkMenuActions.length > 0
                ? <PageHeaderMenu testID="provider-model-manager.menu" actions={bulkMenuActions} />
                : undefined}
        />
    );
    const listsCheckedAt = React.useMemo(() => {
        let latest = 0;
        for (const group of managementGroups ?? []) {
            for (const row of group.rows) latest = Math.max(latest, row.catalog.observedAt ?? 0);
        }
        return latest > 0 ? latest : null;
    }, [managementGroups]);
    const machineName = executionTarget ? getMachineSentenceName(executionTarget.machine) : null;
    // Where the lists were read: the one place a computer shows on this page.
    const footer = machineName && listsCheckedAt !== null ? (
        <ItemGroup surface="none">
            <View style={styles.footer}>
                <Text testID="agent-models.freshness" style={[styles.footerText, { color: theme.colors.text.secondary }]}>
                    {t('settingsAgents.detailPage.modelsListsChecked', {
                        machine: machineName,
                        time: new Date(listsCheckedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                    })}
                </Text>
                <RoundButton
                    testID="agent-models.refresh"
                    size="mini"
                    display="secondary"
                    title={t('common.refresh')}
                    onPress={() => { void reviewCurrentState(); }}
                />
            </View>
        </ItemGroup>
    ) : null;
    // The page as it stands before the model list can show: its header above the one state row.
    const statePage = (row: React.ReactNode) => (
        <ItemList>
            {header}
            <ItemGroup>{row}</ItemGroup>
        </ItemList>
    );

    if (!settingsAccess.readable) {
        // No snapshot yet (or still loading) is not a failure: say loading until the catalog owner settles.
        if (providerCatalog === null || providerCatalog.status === 'loading') {
            return statePage(<Item mode="info" loading title={t('common.loading')} />);
        }
        return statePage(
            <Item
                mode="info"
                title={t('settingsProviders.errors.genericTitle')}
                subtitle={t('settingsProviders.errors.genericDescription')}
                subtitleLines={0}
            />,
        );
    }

    if (!enabled) {
        return statePage(<Item mode="info" title={t('settingsProviders.unavailable')} subtitle={t('settingsProviders.unavailableDescription')} subtitleLines={0} />);
    }
    if (projection.loading && !projection.data) {
        return statePage(<Item mode="info" loading title={t('common.loading')} />);
    }
    const displayError = operationError?.error ?? projection.error;
    const errorRetry = operationError?.retry ?? (!operationError && projection.error ? async () => { await projection.refresh(); } : undefined);
    if (displayError && !projection.data) {
        return statePage(<ProviderErrorItems error={displayError} retry={errorRetry} loadModel={operationError?.loadModel} reviewCurrentState={operationError?.reviewCurrentState} />);
    }

    // A refresh over a readable snapshot keeps the page as it is: rows are read-only until it settles,
    // and nothing is inserted above them. Only a settled, unwritable catalog explains itself.
    const catalogUnwritable = !settingsAccess.writable && providerCatalog?.status !== 'loading';
    const leadingRows = catalogUnwritable || displayError || modelLoad.cancelledProviderMayContinue ? (
        <>
            {catalogUnwritable ? (
                <Item mode="info" title={t('settingsProviders.errors.genericTitle')}
                    subtitle={t('settingsProviders.errors.genericDescription')}
                    subtitleLines={0} />
            ) : null}
            {displayError ? (
                <ProviderErrorItems error={displayError} retry={errorRetry} loadModel={operationError?.loadModel} reviewCurrentState={operationError?.reviewCurrentState} />
            ) : null}
            {modelLoad.cancelledProviderMayContinue ? (
                <Item
                    mode="info"
                    title={t('settingsProviders.models.loadCancelled')}
                    subtitle={t('settingsProviders.models.loadCancelledProviderMayContinue')}
                />
            ) : null}
        </>
    ) : null;

    return (
        <ProviderModelManager
            scope={{ kind: 'agent', agentTargetKey: props.agentTargetKey }}
            nativeModels={nativeModels}
            groups={projection.data?.groups ?? []}
            showHidden
            readOnly={!settingsAccess.writable}
            grouping={grouping}
            onSetVisibility={setVisibility}
            onShowOnly={(ref) => { void runBulk('showOnly', ref); }}
            onLoadModel={(connectionId, modelId) => { void loadModel(connectionId, modelId); }}
            onCancelModelLoad={() => { void modelLoad.cancel(); }}
            onOpenConnection={(connectionId) => router.push(providerConnectionModelsRoute(connectionId) as never)}
            loadingModelKey={modelLoad.loadingModelKey}
            onRequestClose={() => router.back()}
            testID="agent-models"
            page={{
                header,
                // The page is "Models"; its filter sheet needs no second title.
                title: '',
                leadingRows,
                footer,
                testID: 'agent-models',
            }}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    headerText: {
        gap: theme.space.s6,
    },
    descriptionText: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('pageDescription'),
    },
    sourceVisibility: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    sourceVisibilityLabel: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    identity: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    identityText: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('rowDescription'),
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: theme.space.s12,
    },
    footerText: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('rowDescription'),
        flexShrink: 1,
    },
}));

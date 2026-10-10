import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { serializeModelVisibilityRefV1, type ModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import { getAgentStaticModels } from '@happier-dev/agents';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { ProviderModelPickerSourceKind } from '@happier-dev/protocol/providers/catalog/modelPickerVisibility';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Switch } from '@/components/ui/forms/Switch';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useProviderModelLoadAction } from '@/providers/hooks/useProviderModelLoadAction';
import { useProviderModelPickerVisibility } from '@/providers/hooks/useProviderModelPickerVisibility';
import { useRetireProviderStateOnAccountChange } from '@/providers/hooks/accountLifetimeRetirement';
import {
    ProviderModelManager,
    buildProviderModelVisibilityChanges,
    type ProviderModelManagerSourceGrouping,
} from '@/providers/models/ProviderModelManager';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';
import { applyProviderModelBulkAction } from '@/providers/models/applyProviderModelBulkAction';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import {
    providerModelLoadRecoveryForError,
    providerRetryRecoveryForError,
} from '@/providers/connection/recovery';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { t } from '@/text';
import { resolveAgentModelsSettingsAccess } from './resolveAgentModelsSettingsAccess';
import { providerConnectionModelsRoute } from '@/components/settings/providers/collection/providerCollectionModel';

function AgentSourceVisibility(props: Readonly<{
    connectionId: string;
    kind: ProviderModelPickerSourceKind;
    serverId: string | null;
    onStateChange: (connectionId: string, error: unknown, reviewCurrentState: () => Promise<void>) => void;
}>) {
    const visibility = useProviderModelPickerVisibility(props.connectionId, { kind: props.kind, serverId: props.serverId });
    const error = visibility?.error ?? null;
    const reviewCurrentState = visibility?.reviewCurrentState;
    React.useEffect(() => {
        if (reviewCurrentState) props.onStateChange(props.connectionId, error, reviewCurrentState);
    }, [error, props.connectionId, props.onStateChange, reviewCurrentState]);
    if (!visibility) return null;
    return visibility.busy ? <ActivitySpinner size="small" /> : (
        <Switch
            testID={`agent-models-source-visibility:${props.connectionId}`}
            compact
            accessibilityLabel={t('settingsProvidersCollection.showInPickerTitle')}
            value={visibility.shown}
            onValueChange={visibility.setShown}
        />
    );
}

export const AgentModelsScreen = React.memo(function AgentModelsScreen(props: Readonly<{
    agentTargetKey: string;
    runtimeAgentId: string | null;
}>) {
    const router = useRouter();
    const enabled = useFeatureEnabled('providers');
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents,
    );
    const executionTarget = React.useMemo(() => {
        const selectedTarget = administrationTargetSelection.selectedTarget;
        const resolvedTarget = administrationTargetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [administrationTargetSelection]);
    const machineId = executionTarget?.machine.id ?? null;
    const serverId = executionTarget?.serverId ?? null;
    const { mutateProviderModelSettings } = useProviderActionClient(serverId);
    const providerCatalog = useProviderCatalogForServer(serverId);
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
    const projection = useProviderModelProjection({
        enabled, machineId, serverId, agentTargetKey: props.agentTargetKey, mode: 'management',
    });
    const settingsAccess = React.useMemo(
        () => resolveAgentModelsSettingsAccess(providerCatalog),
        [providerCatalog],
    );
    const providerSettings = settingsAccess.settings;
    const defaultSelection = useProviderSettingsForServer(serverId).defaultsByAgentTargetKey[props.agentTargetKey] ?? null;
    const agentCore = props.runtimeAgentId && isBundledAgentId(props.runtimeAgentId) ? getAgentCore(props.runtimeAgentId) : null;
    const agentTitle = agentCore ? t(agentCore.displayNameKey) : null;
    const [operationError, setOperationError] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
        loadModel?: () => Promise<void>;
        reviewCurrentState?: () => Promise<void>;
        sourceVisibilityConnectionId?: string;
    }> | null>(null);
    const retireOperationError = React.useCallback(() => setOperationError(null), []);
    const accountLifetime = useRetireProviderStateOnAccountChange(retireOperationError);
    const nativeModels = React.useMemo(() => {
        if (!props.runtimeAgentId || !isBundledAgentId(props.runtimeAgentId)) return [];
        return getAgentStaticModels(props.runtimeAgentId).map((model) => {
            const key = serializeModelVisibilityRefV1({
                scope: 'agent', agentTargetKey: props.agentTargetKey,
                providerConnectionId: null, modelId: model.id,
            });
            return {
                id: model.id,
                name: model.name || model.id,
                description: model.description,
                hidden: Object.prototype.hasOwnProperty.call(providerSettings.modelVisibilityByRef, key),
            };
        });
    }, [props.agentTargetKey, props.runtimeAgentId, providerSettings.modelVisibilityByRef]);

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
    const renderSourceAccessory = React.useCallback((connectionId: string) => {
        const connection = providerSettings.connections.find(item => item.id === connectionId);
        const source = connection?.source;
        const kind = source?.kind === 'custom' ? 'custom' : source?.kind === 'contribution'
            ? readAccountProviderDeclarations().find(declaration =>
                areProviderContributionKeysEqualV1(declaration.contributionKey, source.contributionKey))?.definition.kind
            : undefined;
        // Without an admitted declaration, do not infer a kind default from the
        // Provider's name, id or number of models.
        return kind
            ? <AgentSourceVisibility connectionId={connectionId} kind={kind} serverId={serverId} onStateChange={handleSourceVisibilityState} />
            : null;
    }, [handleSourceVisibilityState, providerSettings.connections, serverId]);
    // One sheet per source, in picker order; hidden models stay in their source, switched off.
    const grouping = React.useMemo((): ProviderModelManagerSourceGrouping => ({
        nativeTitle: agentTitle ?? t('settingsAgents.detailPage.modelsNativeFallbackTitle'),
        nativeDescription: agentTitle
            ? t('settingsAgents.detailPage.modelsNativeDescription', { agent: agentTitle })
            : t('settingsAgents.detailPage.modelsNativeFallbackDescription'),
        connectionDescription: t('settingsAgents.detailPage.modelsSourceShownDescription'),
        defaultRef: defaultSelection
            ? { providerConnectionId: defaultSelection.ref.providerConnectionId, modelId: defaultSelection.ref.modelId }
            : null,
        renderSourceAccessory,
    }), [agentTitle, defaultSelection, renderSourceAccessory]);
    const reviewCurrentState = React.useCallback(async (): Promise<void> => {
        await projection.refresh();
    }, [projection.refresh]);
    const refreshLoadedModel = React.useCallback(async (connectionId: string, modelId: string) => {
        if (!resolveCurrentExecutionTarget()) return false;
        const result = await projection.refreshWithResult();
        if (!result) return false;
        if (result.status === 'error') throw result.error;
        const group = result.groups.find((candidate) => candidate.connectionId === connectionId);
        return group?.rows.some((row) => row.ref.modelId === modelId && row.loadState === 'loaded') === true;
    }, [projection.refreshWithResult, resolveCurrentExecutionTarget]);
    const modelLoad = useProviderModelLoadAction({
        machineId,
        serverId,
        refresh: refreshLoadedModel,
        resolveExecutionTarget: resolveCurrentExecutionTarget,
    });
    const loadModel = React.useCallback(async (connectionId: string, modelId: string) => {
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
    }, [modelLoad.load, reviewCurrentState, showError]);
    const mutate = React.useCallback(async (
        request: Parameters<typeof mutateProviderModelSettings>[0]['request'],
    ): Promise<void> => {
        if (!accountLifetime?.isCurrent()) return;
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
    }, [accountLifetime, machineId, mutateProviderModelSettings, projection.refresh, reviewCurrentState, serverId, showError]);
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
        if (!accountLifetime?.isCurrent()) return;
        await applyProviderModelBulkAction({
            action,
            changes: bulkChanges(action, selected),
            confirm: async () => accountLifetime.isCurrent() && await Modal.confirm(
                action === 'hideAll'
                    ? t('settingsProviders.models.hideAll')
                    : t('settingsProviders.models.showOnly'),
                action === 'hideAll'
                    ? t('settingsProviders.models.hideAllConfirmation')
                    : t('settingsProviders.models.showOnlyConfirmation'),
                { confirmText: t('common.continue'), ...(action === 'hideAll' ? { destructive: true } : {}) },
            ) && accountLifetime.isCurrent(),
            apply: async (changes) => {
                await mutate({ action: 'bulkVisibility', ...(machineId ? { machineId } : {}), changes: [...changes] });
            },
        });
    }, [accountLifetime, bulkChanges, machineId, mutate]);

    const header = (
        <SettingsPageHeader
            testID="settings.agents.models.header"
            description={agentTitle
                ? t('settingsAgents.detailPage.modelsDescription', { agent: agentTitle })
                : t('settingsProvidersCollection.modelsDescription')}
            actions={(
                <MachineAdministrationTargetSelector
                    selection={administrationTargetSelection}
                    presentation="chip"
                    testIDPrefix="settings.agents.models.administration.target"
                />
            )}
        />
    );
    // The page as it stands before the model list can show: its header (with the machine chip, the
    // control that recovers these states) above the one state row.
    const statePage = (row: React.ReactNode) => (
        <ItemList>
            {header}
            <ItemGroup>{row}</ItemGroup>
        </ItemList>
    );

    if (!settingsAccess.writable) {
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

    const leadingRows = displayError || modelLoad.cancelledProviderMayContinue ? (
        <>
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
            grouping={grouping}
            onSetVisibility={setVisibility}
            onShowAll={() => { void runBulk('showAll'); }}
            onHideAll={() => { void runBulk('hideAll'); }}
            onResetVisibility={reset}
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
                testID: 'agent-models',
            }}
        />
    );
});

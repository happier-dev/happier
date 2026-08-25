import * as React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
    createProviderErrorV1,
    serializeModelVisibilityRefV1,
    type ModelVisibilityRefV1,
    type ProviderErrorV1,
} from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';

import { isBundledAgentId } from '@/agents/catalog/catalog';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useProviderModelLoadAction } from '@/providers/hooks/useProviderModelLoadAction';
import {
    ProviderModelManager,
    buildProviderModelVisibilityChanges,
} from '@/providers/models/ProviderModelManager';
import { applyProviderModelBulkAction } from '@/providers/models/applyProviderModelBulkAction';
import { mutateProviderModelSettings, providerErrorFromRpcFailure } from '@/providers/rpc/client';
import {
    providerModelLoadRecoveryForError,
    providerRetryRecoveryForError,
} from '@/providers/connection/recovery';
import { useSettings } from '@/sync/domains/state/storage';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { t } from '@/text';
import { resolveAgentModelsSettingsAccess } from './resolveAgentModelsSettingsAccess';

export const AgentModelsScreen = React.memo(function AgentModelsScreen(props: Readonly<{
    agentTargetKey: string;
    runtimeAgentId: string | null;
}>) {
    const router = useRouter();
    const enabled = useFeatureEnabled('providers');
    const settings = useSettings();
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
        () => resolveAgentModelsSettingsAccess(settings),
        [settings],
    );
    const providerSettings = settingsAccess.settings;
    const [showHidden, setShowHidden] = React.useState(false);
    const [operationError, setOperationError] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
        loadModel?: () => Promise<void>;
        reviewCurrentState?: () => Promise<void>;
    }> | null>(null);
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
        const currentExecutionTarget = resolveCurrentExecutionTarget();
        if (!currentExecutionTarget) return;
        const handleFailure = async (error: ProviderErrorV1): Promise<void> => {
            if (error.code === 'provider_rpc_mutation_outcome_unknown') {
                try {
                    await reviewCurrentState();
                } catch {
                    // Preserve the unknown mutation outcome. A failed reconciliation
                    // must not turn an unsafe write replay into the recovery action.
                }
                showError(error, { reviewCurrentState });
                return;
            }
            showError(error, providerRetryRecoveryForError(error, () => mutate(request)));
        };
        let result: Awaited<ReturnType<typeof mutateProviderModelSettings>>;
        try {
            result = await mutateProviderModelSettings({
                serverId: currentExecutionTarget.serverId,
                request,
            });
        } catch (caught) {
            await handleFailure(providerErrorFromRpcFailure(caught, {
                machineId: currentExecutionTarget.machineId,
            }));
            return;
        }
        if (result.status === 'error') {
            await handleFailure(result.error);
            return;
        }
        await projection.refresh();
        setOperationError(null);
    }, [projection.refresh, resolveCurrentExecutionTarget, reviewCurrentState, showError]);
    const setVisibility = React.useCallback((ref: ModelVisibilityRefV1, hidden: boolean) => {
        if (!machineId) return;
        void mutate({ action: 'setVisibility', machineId, ref, hidden });
    }, [machineId, mutate]);
    const reset = React.useCallback(() => {
        if (!machineId) return;
        void mutate({
            action: 'resetVisibility', machineId,
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
        if (!machineId) return;
        await applyProviderModelBulkAction({
            action,
            changes: bulkChanges(action, selected),
            confirm: async () => await Modal.confirm(
                action === 'hideAll'
                    ? t('settingsProviders.models.hideAll')
                    : t('settingsProviders.models.showOnly'),
                action === 'hideAll'
                    ? t('settingsProviders.models.hideAllConfirmation')
                    : t('settingsProviders.models.showOnlyConfirmation'),
                { confirmText: t('common.continue'), ...(action === 'hideAll' ? { destructive: true } : {}) },
            ),
            apply: async (changes) => {
                await mutate({ action: 'bulkVisibility', machineId, changes: [...changes] });
            },
        });
    }, [bulkChanges, machineId, mutate]);

    const headerActions = (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <IconButton
                iconName={showHidden ? 'eye-slash' : 'eye'}
                accessibilityLabel={showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                tooltip={showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                interactiveTargetGapPx={4}
                variant="plain"
                onPress={() => setShowHidden((current) => !current)}
            />
        </View>
    );

    const targetSelector = (
        <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            testIDPrefix="settings.agents.models.administration.target"
        />
    );

    if (!settingsAccess.writable) {
        return (
            <ItemList>
                {targetSelector}
                <ItemGroup>
                    <Item
                        mode="info"
                        title={t('settingsProviders.errors.genericTitle')}
                        subtitle={t('settingsProviders.errors.genericDescription')}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    if (!enabled) {
        return <ItemList>{targetSelector}<ItemGroup><Item mode="info" title={t('settingsProviders.unavailable')} subtitle={t('settingsProviders.unavailableDescription')} /></ItemGroup></ItemList>;
    }
    if (!machineId) {
        return <ItemList>{targetSelector}<ItemGroup><Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} /></ItemGroup></ItemList>;
    }

    if (projection.loading && !projection.data) {
        return <ItemList>{targetSelector}<ItemGroup><Item mode="info" loading title={t('common.loading')} /></ItemGroup></ItemList>;
    }
    const displayError = operationError?.error ?? projection.error;
    const errorRetry = operationError?.retry ?? (!operationError && projection.error ? async () => { await projection.refresh(); } : undefined);
    if (displayError && !projection.data) {
        return <ItemList>{targetSelector}<ItemGroup><ProviderErrorItems error={displayError} retry={errorRetry} loadModel={operationError?.loadModel} reviewCurrentState={operationError?.reviewCurrentState} /></ItemGroup></ItemList>;
    }

    return (
        <>
            <ItemList>{targetSelector}</ItemList>
            {displayError ? (
                <ItemGroup>
                    <ProviderErrorItems error={displayError} retry={errorRetry} loadModel={operationError?.loadModel} reviewCurrentState={operationError?.reviewCurrentState} />
                </ItemGroup>
            ) : null}
            {modelLoad.cancelledProviderMayContinue ? (
                <ItemGroup>
                    <Item
                        mode="info"
                        title={t('settingsProviders.models.loadCancelled')}
                        subtitle={t('settingsProviders.models.loadCancelledProviderMayContinue')}
                    />
                </ItemGroup>
            ) : null}
            <ProviderModelManager
                scope={{ kind: 'agent', agentTargetKey: props.agentTargetKey }}
                nativeModels={nativeModels}
                groups={projection.data?.groups ?? []}
                showHidden={showHidden}
                onSetVisibility={setVisibility}
                onShowAll={() => { void runBulk('showAll'); }}
                onHideAll={() => { void runBulk('hideAll'); }}
                onResetVisibility={reset}
                onShowOnly={(ref) => { void runBulk('showOnly', ref); }}
                onLoadModel={(connectionId, modelId) => { void loadModel(connectionId, modelId); }}
                onCancelModelLoad={() => { void modelLoad.cancel(); }}
                onOpenConnection={(connectionId) => router.push(`/(app)/settings/providers/${encodeURIComponent(connectionId)}/models` as never)}
                loadingModelKey={modelLoad.loadingModelKey}
                onRequestClose={() => router.back()}
                headerActions={headerActions}
                testID="agent-models"
            />
        </>
    );
});

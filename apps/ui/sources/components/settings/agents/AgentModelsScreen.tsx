import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import {
    createProviderErrorV1,
    serializeModelVisibilityRefV1,
    type ModelVisibilityRefV1,
    type ProviderErrorV1,
} from '@happier-dev/protocol';
import { getAgentStaticModels } from '@happier-dev/agents';

import { isAgentId } from '@/agents/catalog/catalog';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useProviderModelLoadAction } from '@/providers/hooks/useProviderModelLoadAction';
import { resolveProviderSettingsTargetMachine } from '@/providers/hooks/targetMachine';
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
import { useAllMachines, useMachineListByServerId, useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveAgentModelsSettingsAccess } from './resolveAgentModelsSettingsAccess';

export const AgentModelsScreen = React.memo(function AgentModelsScreen(props: Readonly<{
    agentTargetKey: string;
    runtimeAgentId: string | null;
    preferredMachineId?: string | null;
}>) {
    const router = useRouter();
    const enabled = useFeatureEnabled('providers');
    const settings = useSettings();
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const activeServer = useActiveServerSnapshot();
    const serverId = typeof activeServer.serverId === 'string' ? activeServer.serverId : null;
    const machineId = React.useMemo(() => resolveProviderSettingsTargetMachine({
        serverId, preferredMachineId: props.preferredMachineId, machines, machineListByServerId,
    }), [machineListByServerId, machines, props.preferredMachineId, serverId]);
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
        if (!props.runtimeAgentId || !isAgentId(props.runtimeAgentId)) return [];
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
        const result = await projection.refreshWithResult();
        if (!result) return false;
        if (result.status === 'error') throw result.error;
        const group = result.groups.find((candidate) => candidate.connectionId === connectionId);
        return group?.rows.some((row) => row.ref.modelId === modelId && row.loadState === 'loaded') === true;
    }, [projection.refreshWithResult]);
    const modelLoad = useProviderModelLoadAction({
        machineId,
        serverId,
        refresh: refreshLoadedModel,
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
            result = await mutateProviderModelSettings({ serverId, request });
        } catch (caught) {
            await handleFailure(providerErrorFromRpcFailure(caught, {
                ...(machineId ? { machineId } : {}),
            }));
            return;
        }
        if (result.status === 'error') {
            await handleFailure(result.error);
            return;
        }
        await projection.refresh();
        setOperationError(null);
    }, [machineId, projection.refresh, reviewCurrentState, serverId, showError]);
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
                iconName={showHidden ? 'eye-off-outline' : 'eye-outline'}
                accessibilityLabel={showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                tooltip={showHidden ? t('settingsProviders.models.hideHidden') : t('settingsProviders.models.showHidden')}
                size={44}
                variant="plain"
                onPress={() => setShowHidden((current) => !current)}
            />
        </View>
    );

    if (!settingsAccess.writable) {
        return (
            <ItemList>
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
        return <ItemList><ItemGroup><Item mode="info" title={t('settingsProviders.unavailable')} subtitle={t('settingsProviders.unavailableDescription')} /></ItemGroup></ItemList>;
    }
    if (!machineId) {
        return <ItemList><ItemGroup><Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} /></ItemGroup></ItemList>;
    }

    if (projection.loading && !projection.data) {
        return <ItemList><ItemGroup><Item mode="info" loading title={t('common.loading')} /></ItemGroup></ItemList>;
    }
    const displayError = operationError?.error ?? projection.error;
    const errorRetry = operationError?.retry ?? (!operationError && projection.error ? async () => { await projection.refresh(); } : undefined);
    if (displayError && !projection.data) {
        return <ItemList><ItemGroup><ProviderErrorItems error={displayError} retry={errorRetry} loadModel={operationError?.loadModel} reviewCurrentState={operationError?.reviewCurrentState} /></ItemGroup></ItemList>;
    }

    return (
        <>
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

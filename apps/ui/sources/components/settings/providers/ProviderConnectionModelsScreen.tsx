import * as React from 'react';
import { useRouter } from 'expo-router';
import {
    createProviderErrorV1,
    parseProviderManualModelInput,
    type ModelVisibilityRefV1,
    type ProviderErrorV1,
} from '@happier-dev/protocol';

import { TextInput } from '@/components/ui/text/Text';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import { useProviderConnectionModels } from '@/providers/hooks/useProviderConnectionModels';
import { useProviderModelLoadAction } from '@/providers/hooks/useProviderModelLoadAction';
import { resolveProviderSettingsTargetMachine } from '@/providers/hooks/targetMachine';
import {
    buildProviderModelVisibilityChanges,
    type ProviderModelManagerGroup,
} from '@/providers/models/ProviderModelManager';
import { applyProviderModelBulkAction } from '@/providers/models/applyProviderModelBulkAction';
import {
    mutateProviderModelSettings,
    probeProviderConnection,
    providerErrorFromRpcFailure,
} from '@/providers/rpc/client';
import {
    providerModelLoadRecoveryForError,
    providerRetryRecoveryForError,
} from '@/providers/connection/recovery';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { useAllMachines, useMachineListByServerId } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { ProviderConnectionModelsView } from './models/ProviderConnectionModelsView';
import { useProviderFeatureAvailability } from './ProviderFeatureAvailability';

export const ProviderConnectionModelsScreen = React.memo(function ProviderConnectionModelsScreen(
    props: Readonly<{ connectionId: string; startAdding?: boolean }>,
) {
    const router = useRouter();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const activeServer = useActiveServerSnapshot();
    const serverId = typeof activeServer.serverId === 'string' ? activeServer.serverId : null;
    const machineId = React.useMemo(() => resolveProviderSettingsTargetMachine({
        serverId, machines, machineListByServerId,
    }), [machineListByServerId, machines, serverId]);
    const connectionQuery = useProviderConnections({
        enabled, machineId, serverId, connectionId: props.connectionId,
    });
    const catalog = useProviderConnectionModels({
        enabled, machineId, serverId, connectionId: props.connectionId,
    });
    const [showHidden, setShowHidden] = React.useState(false);
    const [editorOpen, setEditorOpen] = React.useState(props.startAdding === true);
    const [manualModelText, setManualModelText] = React.useState('');
    const [editorError, setEditorError] = React.useState<string | null>(null);
    const [savingManualModels, setSavingManualModels] = React.useState(false);
    const [refreshingCatalog, setRefreshingCatalog] = React.useState(false);
    const [operationError, setOperationError] = React.useState<Readonly<{
        error: ProviderErrorV1;
        retry?: () => Promise<void>;
        loadModel?: () => Promise<void>;
        reviewCurrentState?: () => Promise<void>;
    }> | null>(null);
    const manualModelsRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const connection = connectionQuery.data?.connections.find((candidate) => candidate.connectionId === props.connectionId) ?? null;

    const groups = React.useMemo<readonly ProviderModelManagerGroup[]>(() => connection ? [{
        connectionId: props.connectionId,
        providerName: connection.providerName,
        connectionName: connection.displayName,
        connectionRole: connection.role,
        connectionDisplayNameMode: connection.displayNameMode,
        modelLoadAction: catalog.modelLoadAction ?? 'descriptor_absent',
        rows: catalog.models.map((model) => ({
            ref: { modelId: model.id },
            descriptor: { id: model.id, name: model.name ?? model.id },
            sources: {
                manual: model.source === 'manual',
                static: model.source === 'static',
                probe: model.source === 'probe',
            },
            catalog: { stale: model.stale },
            loadState: model.loadState,
            visibility: model.visibility,
        })),
    }] : [], [catalog.modelLoadAction, catalog.models, connection, props.connectionId]);

    const showError = React.useCallback((
        error: ProviderErrorV1,
        recovery: Readonly<{
            retry?: () => Promise<void>;
            loadModel?: () => Promise<void>;
            reviewCurrentState?: () => Promise<void>;
        }> = {},
    ) => setOperationError({ error, ...recovery }), []);
    const reviewCurrentState = React.useCallback(async (): Promise<void> => {
        await catalog.refresh();
    }, [catalog.refresh]);
    const showTransportError = React.useCallback((
        caught: unknown,
        retry: () => Promise<void>,
    ) => showError(providerErrorFromRpcFailure(caught, {
        connectionId: props.connectionId,
        ...(machineId ? { machineId } : {}),
    }), { retry }), [machineId, props.connectionId, showError]);
    const handleModelSettingsMutationFailure = React.useCallback(async (
        error: ProviderErrorV1,
        retry: () => Promise<void>,
    ): Promise<void> => {
        if (error.code === 'provider_rpc_mutation_outcome_unknown') {
            try {
                await reviewCurrentState();
            } catch {
                // Preserve the unknown write outcome even when the authoritative
                // catalog cannot currently be reconciled. Replaying is unsafe.
            }
            showError(error, { reviewCurrentState });
            return;
        }
        showError(error, providerRetryRecoveryForError(error, retry));
    }, [reviewCurrentState, showError]);
    const runModelSettingsMutation = React.useCallback(async (
        request: Parameters<typeof mutateProviderModelSettings>[0]['request'],
        retry: () => Promise<void>,
    ): Promise<boolean> => {
        let result: Awaited<ReturnType<typeof mutateProviderModelSettings>>;
        try {
            result = await mutateProviderModelSettings({ serverId, request });
        } catch (caught) {
            await handleModelSettingsMutationFailure(providerErrorFromRpcFailure(caught, {
                connectionId: props.connectionId,
                ...(machineId ? { machineId } : {}),
            }), retry);
            return false;
        }
        if (result.status === 'error') {
            await handleModelSettingsMutationFailure(result.error, retry);
            return false;
        }
        setOperationError(null);
        await catalog.refresh();
        return true;
    }, [catalog.refresh, handleModelSettingsMutationFailure, machineId, props.connectionId, serverId]);
    const refreshLoadedModel = React.useCallback(async (connectionId: string, modelId: string) => {
        if (connectionId !== props.connectionId) return false;
        const result = await catalog.refreshWithResult();
        if (!result) return false;
        if (result.status === 'error') throw result.error;
        return result.models.some((model) => model.id === modelId && model.loadState === 'loaded');
    }, [catalog.refreshWithResult, props.connectionId]);
    const modelLoad = useProviderModelLoadAction({ machineId, serverId, refresh: refreshLoadedModel });
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
    const setVisibility = React.useCallback(async (ref: ModelVisibilityRefV1, hidden: boolean) => {
        if (!machineId) return;
        await runModelSettingsMutation(
            { action: 'setVisibility', machineId, ref, hidden },
            () => setVisibility(ref, hidden),
        );
    }, [machineId, runModelSettingsMutation]);
    const reset = React.useCallback(async () => {
        if (!machineId) return;
        await runModelSettingsMutation({
            action: 'resetVisibility', machineId,
            scope: { kind: 'connection', connectionId: props.connectionId },
        }, reset);
    }, [machineId, props.connectionId, runModelSettingsMutation]);
    const bulkChanges = React.useCallback((
        action: 'showAll' | 'hideAll' | 'showOnly',
        selected?: ModelVisibilityRefV1,
    ) => buildProviderModelVisibilityChanges({
        scope: { kind: 'connection', connectionId: props.connectionId },
        nativeModels: [],
        groups,
        action,
        ...(selected ? { selected } : {}),
    }), [groups, props.connectionId]);
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
                await runModelSettingsMutation(
                    { action: 'bulkVisibility', machineId, changes: [...changes] },
                    () => runBulk(action, selected),
                );
            },
        });
    }, [bulkChanges, machineId, runModelSettingsMutation]);

    const addManualModels = React.useCallback(async () => {
        if (!machineId || catalog.connectionRevision === null || savingManualModels) return;
        const parsed = parseProviderManualModelInput(manualModelText, {
            existingIds: new Set(catalog.models.map((model) => model.id)),
        });
        if (parsed.accepted.length === 0 && parsed.rejected.length === 0) {
            setEditorError(t('settingsProviders.models.noNewModels'));
            return;
        }
        if (parsed.accepted.length === 0) {
            setManualModelText(parsed.rejected.map((entry) => entry.value).join('\n'));
            setEditorError(t('settingsProviders.models.invalidModelIds', { ids: parsed.rejected.map((entry) => entry.value).join(', ') }));
            return;
        }
        setSavingManualModels(true);
        setEditorError(null);
        try {
            const succeeded = await runModelSettingsMutation({
                action: 'manualAdd',
                machineId,
                connectionId: props.connectionId,
                expectedConnectionRevision: catalog.connectionRevision,
                models: parsed.accepted.map((id) => ({ id })),
            }, addManualModels);
            if (!succeeded) return;
            const rejectedText = parsed.rejected.map((entry) => entry.value).join('\n');
            setManualModelText(rejectedText);
            setEditorOpen(parsed.rejected.length > 0);
            setEditorError(parsed.rejected.length > 0
                ? t('settingsProviders.models.invalidModelIds', { ids: parsed.rejected.map((entry) => entry.value).join(', ') })
                : null);
        } finally {
            setSavingManualModels(false);
        }
    }, [catalog.connectionRevision, catalog.models, machineId, manualModelText, props.connectionId, runModelSettingsMutation, savingManualModels]);

    const removeManualModel = React.useCallback(async (connectionId: string, modelId: string) => {
        if (!machineId || catalog.connectionRevision === null || connectionId !== props.connectionId) return;
        const confirmed = await Modal.confirm(
            t('settingsProviders.models.remove'),
            t('settingsProviders.models.removeConfirmation'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        await runModelSettingsMutation({
            action: 'manualRemove', machineId, connectionId,
            modelId, expectedConnectionRevision: catalog.connectionRevision,
        }, () => removeManualModel(connectionId, modelId));
    }, [catalog.connectionRevision, machineId, props.connectionId, runModelSettingsMutation]);

    const refreshCatalog = React.useCallback(async () => {
        if (!machineId || refreshingCatalog) return;
        setRefreshingCatalog(true);
        try {
            const result = await probeProviderConnection({
                machineId,
                serverId,
                connectionId: props.connectionId,
            });
            if (result.status === 'error') {
                showError(result.error, { retry: refreshCatalog });
                return;
            }
            setOperationError(null);
            await catalog.refresh();
        } catch (caught) {
            showTransportError(caught, refreshCatalog);
        } finally {
            setRefreshingCatalog(false);
        }
    }, [catalog.refresh, machineId, props.connectionId, refreshingCatalog, serverId, showError, showTransportError]);

    const displayError = operationError?.error
        ?? catalog.error;
    const errorRetry = operationError?.retry
        ?? (!operationError && displayError ? catalog.refresh : undefined);
    const errorLoadModel = operationError?.loadModel;
    const errorReviewCurrentState = operationError?.reviewCurrentState;

    return (
        <ProviderConnectionModelsView
            availabilityPresentation={availabilityPresentation}
            machineAvailable={machineId !== null}
            connectionId={props.connectionId}
            groups={groups}
            initialLoading={catalog.loading}
            modelCount={catalog.models.length}
            error={displayError}
            errorRetry={errorRetry}
            errorLoadModel={errorLoadModel}
            errorReviewCurrentState={errorReviewCurrentState}
            manualModelPolicy={catalog.manualModelPolicy}
            editorOpen={editorOpen}
            editorError={editorError}
            manualModelText={manualModelText}
            savingManualModels={savingManualModels}
            manualModelsRef={manualModelsRef}
            showHidden={showHidden}
            canRefreshCatalog={connection?.probeCapability !== 'none'}
            refreshingCatalog={refreshingCatalog}
            loadingModelKey={modelLoad.loadingModelKey}
            loadCancelledProviderMayContinue={modelLoad.cancelledProviderMayContinue}
            onEditorOpenChange={(open) => {
                setEditorOpen(open);
                if (!open) setEditorError(null);
            }}
            onManualModelTextChange={(text) => {
                setManualModelText(text);
                setEditorError(null);
            }}
            onAddManualModels={() => { void addManualModels(); }}
            onToggleShowHidden={() => setShowHidden((current) => !current)}
            onRefreshCatalog={() => { void refreshCatalog(); }}
            onSetVisibility={(ref, hidden) => { void setVisibility(ref, hidden); }}
            onShowAll={() => { void runBulk('showAll'); }}
            onHideAll={() => { void runBulk('hideAll'); }}
            onResetVisibility={() => { void reset(); }}
            onShowOnly={(ref) => { void runBulk('showOnly', ref); }}
            onLoadModel={(connectionId, modelId) => { void loadModel(connectionId, modelId); }}
            onCancelModelLoad={() => { void modelLoad.cancel(); }}
            onRemoveManualModel={(connectionId, modelId) => { void removeManualModel(connectionId, modelId); }}
            onRequestClose={() => router.back()}
        />
    );
});

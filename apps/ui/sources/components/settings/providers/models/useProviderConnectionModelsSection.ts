import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { parseProviderManualModelInput } from '@happier-dev/protocol/providers/manualModelInput';
import type { ModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import type { TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useProviderConnectionModels } from '@/providers/hooks/useProviderConnectionModels';
import { useProviderModelLoadAction } from '@/providers/hooks/useProviderModelLoadAction';
import { useRetireProviderStateOnAccountChange } from '@/providers/hooks/accountLifetimeRetirement';
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
import { t } from '@/text';

type ProviderSettingsExecutionTarget = Readonly<{ machineId: string; serverId: string }>;

type OperationError = Readonly<{
    error: ProviderErrorV1;
    retry?: () => Promise<void>;
    loadModel?: () => Promise<void>;
    reviewCurrentState?: () => Promise<void>;
}>;

/**
 * Everything the connection's Models section needs: the daemon catalog, visibility writes (settled
 * in issue order), bulk actions, model loading, catalog refresh and the manual-model draft. The
 * connection detail hosts it; the draft joins the detail's unsaved-changes guard through
 * `manualDraft`.
 */
export function useProviderConnectionModelsSection(input: Readonly<{
    connectionId: string;
    connection: Pick<DaemonProviderConnectionViewV1, 'providerName' | 'displayName' | 'role' | 'displayNameMode' | 'probeCapability'> | null;
    enabled: boolean;
    machineId: string | null;
    serverId: string | null;
    resolveCurrentTarget: () => ProviderSettingsExecutionTarget | null;
    startAdding?: boolean;
}>) {
    const { connectionId, connection, enabled, machineId, serverId, resolveCurrentTarget } = input;
    const catalog = useProviderConnectionModels({ enabled, machineId, serverId, connectionId });
    const [showHidden, setShowHidden] = React.useState(false);
    const [editorOpen, setEditorOpen] = React.useState(input.startAdding === true);
    const [manualModelText, setManualModelText] = React.useState('');
    const [editorError, setEditorError] = React.useState<string | null>(null);
    const [savingManualModels, setSavingManualModels] = React.useState(false);
    const [refreshingCatalog, setRefreshingCatalog] = React.useState(false);
    const [operationError, setOperationError] = React.useState<OperationError | null>(null);
    const manualModelsRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const modelSettingsQueue = React.useRef<Promise<unknown>>(Promise.resolve());
    const manualDraftDirtyRef = React.useRef(false);

    const discardManualModelDraft = React.useCallback(() => {
        setManualModelText('');
        setEditorError(null);
        setEditorOpen(input.startAdding === true);
        manualDraftDirtyRef.current = false;
    }, [input.startAdding]);

    // The manual-model editor buffer, its inline validation state, and the
    // pending flags it drives are Account-derived authoring state: the catalog
    // they were typed against belongs to the Account that mounted this page,
    // and that Account's lifetime retires them when Account B takes over, while
    // the catalog hook clears Account A's rows through the same lifetime.
    const discardAccountScopedManualModelState = React.useCallback(() => {
        discardManualModelDraft();
        setShowHidden(false);
        setSavingManualModels(false);
        setRefreshingCatalog(false);
        setOperationError(null);
        modelSettingsQueue.current = Promise.resolve();
    }, [discardManualModelDraft]);
    // One incumbent lifetime owns both the local form retirement and all queued
    // write/modal/async callback fencing.
    const accountLifetime = useRetireProviderStateOnAccountChange(discardAccountScopedManualModelState);
    const accountStillCurrent = React.useCallback(
        () => accountLifetime?.isCurrent() ?? true, [accountLifetime]);

    const groups = React.useMemo<readonly ProviderModelManagerGroup[]>(() => connection ? [{
        connectionId,
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
    }] : [], [
        catalog.modelLoadAction,
        catalog.models,
        connection?.displayName,
        connection?.displayNameMode,
        connection?.providerName,
        connection?.role,
        connection !== null,
        connectionId,
    ]);

    const showError = React.useCallback((
        error: ProviderErrorV1,
        recovery: Omit<OperationError, 'error'> = {},
    ) => {
        if (accountStillCurrent()) setOperationError({ error, ...recovery });
    }, [accountStillCurrent]);
    const reviewCurrentState = React.useCallback(async (): Promise<void> => {
        if (!accountStillCurrent()) return;
        await catalog.refresh();
    }, [accountStillCurrent, catalog.refresh]);
    const showTransportError = React.useCallback((
        caught: unknown,
        retry: () => Promise<void>,
    ) => showError(providerErrorFromRpcFailure(caught, {
        connectionId,
        ...(machineId ? { machineId } : {}),
    }), { retry }), [connectionId, machineId, showError]);
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
    // Model-settings writes for one connection settle in issue order. Two rapid
    // visibility toggles dispatched concurrently could otherwise be applied by
    // the daemon in the opposite order and leave the catalog showing the
    // opposite of the user's last intent.
    const runModelSettingsMutation = React.useCallback((
        request: Parameters<typeof mutateProviderModelSettings>[0]['request'],
        retry: () => Promise<void>,
    ): Promise<boolean> => {
        if (!accountStillCurrent()) return Promise.resolve(false);
        const queued = modelSettingsQueue.current.then(async (): Promise<boolean> => {
            // Re-resolve the canonical target immediately before the write: a
            // confirmation modal may have kept this request waiting while the
            // user moved to another machine or server profile.
            const target = accountStillCurrent() ? resolveCurrentTarget() : null;
            if (!target || target.machineId !== request.machineId) {
                showError(createProviderErrorV1('provider_authorization_changed', {
                    connectionId,
                    ...(request.machineId ? { machineId: request.machineId } : {}),
                }));
                return false;
            }
            let result: Awaited<ReturnType<typeof mutateProviderModelSettings>>;
            try {
                result = await mutateProviderModelSettings({ serverId: target.serverId, request });
            } catch (caught) {
                if (!accountStillCurrent()) return false;
                await handleModelSettingsMutationFailure(providerErrorFromRpcFailure(caught, {
                    connectionId,
                    machineId: target.machineId,
                }), retry);
                return false;
            }
            if (result.status === 'error') {
                if (!accountStillCurrent()) return false;
                await handleModelSettingsMutationFailure(result.error, retry);
                return false;
            }
            if (!accountStillCurrent()) return false;
            setOperationError(null);
            await catalog.refresh();
            return accountStillCurrent();
        });
        modelSettingsQueue.current = queued.catch(() => undefined);
        return queued;
    }, [accountStillCurrent, catalog.refresh, connectionId, handleModelSettingsMutationFailure, resolveCurrentTarget, showError]);
    const refreshLoadedModel = React.useCallback(async (loadedConnectionId: string, modelId: string) => {
        if (!accountStillCurrent() || loadedConnectionId !== connectionId) return false;
        const result = await catalog.refreshWithResult();
        if (!result) return false;
        if (result.status === 'error') throw result.error;
        return accountStillCurrent() && result.models.some((model) => model.id === modelId && model.loadState === 'loaded');
    }, [accountStillCurrent, catalog.refreshWithResult, connectionId]);
    const modelLoad = useProviderModelLoadAction({
        machineId,
        serverId,
        refresh: refreshLoadedModel,
        resolveExecutionTarget: resolveCurrentTarget,
    });
    const loadModel = React.useCallback(async (loadConnectionId: string, modelId: string) => {
        if (!accountStillCurrent()) return;
        const result = await modelLoad.load(loadConnectionId, modelId);
        if (result.status === 'error') {
            const retryLoad = () => loadModel(loadConnectionId, modelId);
            showError(result.error, result.error.code === 'provider_rpc_mutation_outcome_unknown'
                ? { reviewCurrentState }
                : providerModelLoadRecoveryForError(result.error, retryLoad));
        } else if (result.status === 'not_supported') {
            showError(createProviderErrorV1('provider_model_unloaded', { connectionId: loadConnectionId }));
        } else if (result.status === 'loaded') {
            if (accountStillCurrent()) setOperationError(null);
        }
    }, [accountStillCurrent, modelLoad.load, reviewCurrentState, showError]);
    const setVisibility = React.useCallback(async (ref: ModelVisibilityRefV1, hidden: boolean) => {
        if (!accountStillCurrent() || !machineId) return;
        await runModelSettingsMutation(
            { action: 'setVisibility', machineId, ref, hidden },
            () => setVisibility(ref, hidden),
        );
    }, [accountStillCurrent, machineId, runModelSettingsMutation]);
    const reset = React.useCallback(async () => {
        if (!accountStillCurrent() || !machineId) return;
        await runModelSettingsMutation({
            action: 'resetVisibility', machineId,
            scope: { kind: 'connection', connectionId },
        }, reset);
    }, [accountStillCurrent, connectionId, machineId, runModelSettingsMutation]);
    const runBulk = React.useCallback(async (
        action: 'showAll' | 'hideAll' | 'showOnly',
        selected?: ModelVisibilityRefV1,
    ) => {
        if (!accountStillCurrent() || !machineId) return;
        await applyProviderModelBulkAction({
            action,
            changes: buildProviderModelVisibilityChanges({
                scope: { kind: 'connection', connectionId },
                nativeModels: [],
                groups,
                action,
                ...(selected ? { selected } : {}),
            }),
            confirm: async () => accountStillCurrent() && await Modal.confirm(
                action === 'hideAll'
                    ? t('settingsProviders.models.hideAll')
                    : t('settingsProviders.models.showOnly'),
                action === 'hideAll'
                    ? t('settingsProviders.models.hideAllConfirmation')
                    : t('settingsProviders.models.showOnlyConfirmation'),
                { confirmText: t('common.continue'), ...(action === 'hideAll' ? { destructive: true } : {}) },
            ) && accountStillCurrent(),
            apply: async (changes) => {
                await runModelSettingsMutation(
                    { action: 'bulkVisibility', machineId, changes: [...changes] },
                    () => runBulk(action, selected),
                );
            },
        });
    }, [accountStillCurrent, connectionId, groups, machineId, runModelSettingsMutation]);

    const addManualModels = React.useCallback(async (): Promise<boolean> => {
        if (!accountStillCurrent() || !machineId || catalog.connectionRevision === null || savingManualModels) return false;
        const parsed = parseProviderManualModelInput(manualModelText, {
            existingIds: new Set(catalog.models.map((model) => model.id)),
        });
        if (parsed.accepted.length === 0 && parsed.rejected.length === 0) {
            setEditorError(t('settingsProviders.models.noNewModels'));
            return false;
        }
        if (parsed.accepted.length === 0) {
            setManualModelText(parsed.rejected.map((entry) => entry.value).join('\n'));
            setEditorError(t('settingsProviders.models.invalidModelIds', { ids: parsed.rejected.map((entry) => entry.value).join(', ') }));
            return false;
        }
        setSavingManualModels(true);
        setEditorError(null);
        try {
            const succeeded = await runModelSettingsMutation({
                action: 'manualAdd',
                machineId,
                connectionId,
                expectedConnectionRevision: catalog.connectionRevision,
                models: parsed.accepted.map((id) => ({ id })),
            }, async () => { await addManualModels(); });
            if (!succeeded || !accountStillCurrent()) return false;
            const rejectedText = parsed.rejected.map((entry) => entry.value).join('\n');
            setManualModelText(rejectedText);
            setEditorOpen(parsed.rejected.length > 0);
            setEditorError(parsed.rejected.length > 0
                ? t('settingsProviders.models.invalidModelIds', { ids: parsed.rejected.map((entry) => entry.value).join(', ') })
                : null);
            return parsed.rejected.length === 0;
        } finally {
            if (accountStillCurrent()) setSavingManualModels(false);
        }
    }, [accountStillCurrent, catalog.connectionRevision, catalog.models, connectionId, machineId, manualModelText, runModelSettingsMutation, savingManualModels]);

    // A typed manual-model draft is unsaved work; the hosting page joins it to
    // its unsaved-changes guard.
    manualDraftDirtyRef.current = manualModelText.trim().length > 0;

    const removeManualModel = React.useCallback(async (removeConnectionId: string, modelId: string) => {
        if (!accountStillCurrent() || !machineId || catalog.connectionRevision === null || removeConnectionId !== connectionId) return;
        const confirmed = await Modal.confirm(
            t('settingsProviders.models.remove'),
            t('settingsProviders.models.removeConfirmation'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed || !accountStillCurrent()) return;
        await runModelSettingsMutation({
            action: 'manualRemove', machineId, connectionId: removeConnectionId,
            modelId, expectedConnectionRevision: catalog.connectionRevision,
        }, () => removeManualModel(removeConnectionId, modelId));
    }, [accountStillCurrent, catalog.connectionRevision, connectionId, machineId, runModelSettingsMutation]);

    const refreshCatalog = React.useCallback(async () => {
        const target = resolveCurrentTarget();
        if (!accountStillCurrent() || !machineId || refreshingCatalog || !target || target.machineId !== machineId) return;
        setRefreshingCatalog(true);
        try {
            const result = await probeProviderConnection({
                machineId: target.machineId,
                serverId: target.serverId,
                connectionId,
            });
            if (!accountStillCurrent()) return;
            if (result.status === 'error') {
                showError(result.error, { retry: refreshCatalog });
                return;
            }
            // The probe belongs to the render-scoped target. If selection moved
            // while it was running, its catalog presentation is stale and must
            // not be published into the new target's page.
            const currentTarget = accountStillCurrent() ? resolveCurrentTarget() : null;
            if (!currentTarget || currentTarget.machineId !== target.machineId
                || currentTarget.serverId !== target.serverId) return;
            setOperationError(null);
            await catalog.refresh();
        } catch (caught) {
            if (accountStillCurrent()) showTransportError(caught, refreshCatalog);
        } finally {
            if (accountStillCurrent()) setRefreshingCatalog(false);
        }
    }, [accountStillCurrent, catalog.refresh, connectionId, machineId, refreshingCatalog, resolveCurrentTarget, showError, showTransportError]);

    const retryCatalog = React.useCallback(async (): Promise<void> => {
        if (!accountStillCurrent()) return;
        await catalog.refresh();
    }, [accountStillCurrent, catalog.refresh]);
    const displayError = operationError?.error ?? catalog.error;

    return {
        groups,
        initialLoading: catalog.loading,
        modelCount: catalog.models.length,
        shownModelCount: catalog.models.filter((model) => model.visibility !== 'hidden_all_agents').length,
        manualModelPolicy: catalog.manualModelPolicy,
        error: displayError,
        errorRetry: operationError?.retry ?? (!operationError && displayError ? retryCatalog : undefined),
        errorLoadModel: operationError?.loadModel,
        errorReviewCurrentState: operationError?.reviewCurrentState,
        canRefreshCatalog: connection?.probeCapability !== 'none',
        refreshingCatalog,
        showHidden,
        loadingModelKey: modelLoad.loadingModelKey,
        loadCancelledProviderMayContinue: modelLoad.cancelledProviderMayContinue,
        editorOpen,
        editorError,
        manualModelText,
        savingManualModels,
        manualModelsRef,
        manualDraft: {
            dirtyRef: manualDraftDirtyRef,
            discard: discardManualModelDraft,
            save: addManualModels,
            accountStillCurrent,
        },
        onEditorOpenChange: (open: boolean) => {
            if (!accountStillCurrent()) return;
            setEditorOpen(open);
            if (!open) setEditorError(null);
        },
        onManualModelTextChange: (text: string) => {
            if (!accountStillCurrent()) return;
            setManualModelText(text);
            setEditorError(null);
        },
        onAddManualModels: () => { void addManualModels(); },
        onToggleShowHidden: () => {
            if (accountStillCurrent()) setShowHidden((current) => !current);
        },
        onRefreshCatalog: () => { void refreshCatalog(); },
        onSetVisibility: (ref: ModelVisibilityRefV1, hidden: boolean) => { void setVisibility(ref, hidden); },
        onShowAll: () => { void runBulk('showAll'); },
        onHideAll: () => { void runBulk('hideAll'); },
        onResetVisibility: () => { void reset(); },
        onShowOnly: (ref: ModelVisibilityRefV1) => { void runBulk('showOnly', ref); },
        onLoadModel: (loadConnectionId: string, modelId: string) => { void loadModel(loadConnectionId, modelId); },
        onCancelModelLoad: () => {
            if (accountStillCurrent()) void modelLoad.cancel();
        },
        onRemoveManualModel: (removeConnectionId: string, modelId: string) => { void removeManualModel(removeConnectionId, modelId); },
    };
}

export type ProviderConnectionModelsSectionState = ReturnType<typeof useProviderConnectionModelsSection>;

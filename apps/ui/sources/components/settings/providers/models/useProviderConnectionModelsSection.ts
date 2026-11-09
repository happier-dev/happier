import type { ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import * as React from 'react';
import { createProviderErrorV1, type ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { parseProviderManualModelInput } from '@happier-dev/protocol/providers/manualModelInput';
import { projectProviderModelGenerationSettings } from '@happier-dev/protocol/models/descriptor';
import type { ProviderReasoningEffortLevelV1 } from '@happier-dev/protocol/providers/catalog/reasoningEffort';
import type { ModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import type { TextInput } from '@/components/ui/text/Text';
import { useProviderConnectionModels } from '@/providers/hooks/useProviderConnectionModels';
import { useProviderCatalogCounts } from '@/providers/hooks/useProviderCatalogCounts';
import { useProviderModelLoadAction } from '@/providers/hooks/useProviderModelLoadAction';
import { useProviderModelGenerationSettings } from '@/providers/hooks/useProviderModelGenerationSettings';
import { useRetireProviderStateOnAccountChange } from '@/providers/hooks/accountLifetimeRetirement';
import {
    buildProviderModelVisibilityChanges,
    type ProviderModelManagerGroup,
} from '@/providers/models/ProviderModelManager';
import { providerErrorFromRpcFailure } from '@/providers/actions/client';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import {
    providerModelLoadRecoveryForError,
    providerRetryRecoveryForError,
} from '@/providers/connection/recovery';
import { isFileEditorAiSuggestionModel } from '@/providers/models/fileEditorAiSuggestionModel';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

type ProviderSettingsExecutionTarget = Readonly<{ machineId: string; serverId: string }>;

type OperationError = Readonly<{
    error: ProviderErrorV1;
    retry?: () => Promise<void>;
    loadModel?: () => Promise<void>;
    reviewCurrentState?: () => Promise<void>;
}>;

/**
 * Everything the connection's Models section needs: the catalog, visibility writes (settled
 * in issue order), bulk actions, model loading, catalog refresh and the manual-model draft. The
 * connection detail hosts it; the draft joins the detail's unsaved-changes guard through
 * `manualDraft`.
 */
export function useProviderConnectionModelsSection(input: Readonly<{
    declarationContext: ProviderDeclarationContext;
    connectionId: string;
    connection: (Pick<DaemonProviderConnectionViewV1, 'providerName' | 'displayName' | 'role' | 'displayNameMode' | 'probeCapability'>
        & Partial<Pick<DaemonProviderConnectionViewV1, 'runtime'>>) | null;
    enabled: boolean;
    active?: boolean;
    machineId: string | null;
    serverId: string | null;
    initiatingLifetime?: ServerAccountScopeLifetime | null;
    resolveCurrentTarget: () => ProviderSettingsExecutionTarget | null;
    startAdding?: boolean;
    /** Open with this model's generation settings editor open (a link from a surface that needs its allowance). */
    startEditingGenerationOf?: string;
}>) {
    const { connectionId, connection, enabled, machineId, serverId, resolveCurrentTarget } = input;
    const { mutateProviderModelSettings, probeProviderConnection, pendingApproval, accountScope: { resolution } } = useProviderActionClient(serverId, input.initiatingLifetime);
    const addressedScope = input.initiatingLifetime !== null && resolution.kind === 'bound' ? resolution.scope : null;
    const catalog = useProviderConnectionModels({ enabled, active: input.active, machineId, serverId, connectionId });
    const accountCatalogCount = useProviderCatalogCounts(serverId, input.declarationContext,
        { enabled: enabled && input.active !== false })?.[connectionId] ?? null;
    const [showHidden, setShowHidden] = React.useState(false);
    const [editorOpen, setEditorOpen] = React.useState(input.startAdding === true);
    const [manualModelText, setManualModelText] = React.useState('');
    // Tiers the models being added declare; none declares none.
    const [manualEffortLevels, setManualEffortLevels] = React.useState<readonly ProviderReasoningEffortLevelV1[]>([]);
    // The one manual model whose tiers the editor is changing; null while it adds new models.
    const [editingModelId, setEditingModelId] = React.useState<string | null>(null);
    // The one model whose generation settings the editor is changing, and the allowance as typed.
    const [generationModelId, setGenerationModelId] = React.useState<string | null>(input.startEditingGenerationOf ?? null);
    const [outputAllowanceText, setOutputAllowanceText] = React.useState<string | null>(null);
    const declaredConnectionId = ProviderConnectionIdSchema.safeParse(connectionId);
    const providerCatalog = useProviderCatalogForServer(serverId, undefined, { enabled: enabled && input.active !== false });
    const refreshGenerationSettings = React.useCallback(async () => { await catalog.refresh(); }, [catalog.refresh]);
    const generationSettings = useProviderModelGenerationSettings({
        connection: providerCatalog?.data?.connections.find(saved => saved.id === connectionId) ?? null,
        modelId: generationModelId,
        resolveTarget: resolveCurrentTarget,
        serverId,
        initiatingLifetime: input.initiatingLifetime,
        refresh: refreshGenerationSettings,
    });
    const declaredManualModels = declaredConnectionId.success
        ? providerCatalog?.data?.manualModelsByConnectionId[declaredConnectionId.data] : undefined;
    const [editorError, setEditorError] = React.useState<string | null>(null);
    const [savingManualModels, setSavingManualModels] = React.useState(false);
    const [refreshingCatalog, setRefreshingCatalog] = React.useState(false);
    const [operationError, setOperationError] = React.useState<OperationError | null>(null);
    const manualModelsRef = React.useRef<React.ElementRef<typeof TextInput>>(null);
    const modelSettingsQueue = React.useRef<Promise<unknown>>(Promise.resolve());
    const manualDraftDirtyRef = React.useRef(false);
    const pendingProbe = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
        setRefreshingCatalog(false);
        return () => {
            pendingProbe.current?.abort();
            pendingProbe.current = null;
        };
    }, [connectionId, input.active, machineId, serverId]);

    const discardManualModelDraft = React.useCallback(() => {
        setManualModelText('');
        setManualEffortLevels([]);
        setEditingModelId(null);
        setGenerationModelId(null);
        setOutputAllowanceText(null);
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
    // Local buffers retire with both active UI interest and their addressed
    // Account. The Action client retains exact peer callback/currentness custody.
    const accountLifetime = useRetireProviderStateOnAccountChange(discardAccountScopedManualModelState, addressedScope);
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
            descriptor: {
                id: model.id,
                name: model.name ?? model.id,
                // The tiers a model declares: the manager names them from the shared descriptor.
                ...(model.descriptor?.capabilities ? { capabilities: model.descriptor.capabilities } : {}),
                ...(model.descriptor?.modelOptions ? { modelOptions: model.descriptor.modelOptions } : {}),
            },
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

    // The Account projection cannot count a Machine's discovered membership.
    // Its canonical retained count remains usable even while the list is absent.
    const retainedModelCount = connection?.runtime?.modelCount;
    const catalogCount = React.useMemo(() => catalog.models.length === 0
        ? retainedModelCount == null ? accountCatalogCount : { shown: retainedModelCount, total: retainedModelCount } : {
        shown: catalog.models.filter((model) => model.visibility !== 'hidden_all_agents').length,
        total: catalog.models.length,
    }, [accountCatalogCount, catalog.models, retainedModelCount]);

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
    // visibility toggles dispatched concurrently could otherwise be applied in
    // the opposite order and leave the catalog showing the
    // opposite of the user's last intent.
    const runQueuedMutation = React.useCallback((
        send: () => Promise<Readonly<{ status: 'error'; error: ProviderErrorV1 }> | Readonly<{ status: 'success' }>>,
        retry: () => Promise<void>,
    ): Promise<boolean> => {
        if (!accountStillCurrent()) return Promise.resolve(false);
        const queued = modelSettingsQueue.current.then(async (): Promise<boolean> => {
            // These settings belong to the captured Account, not to the
            // selected machine. Runtime probe/load actions use their separate
            // exact-machine resolver below.
            if (!accountStillCurrent()) return false;
            let result: Awaited<ReturnType<typeof send>>;
            try {
                result = await send();
            } catch (caught) {
                if (!accountStillCurrent()) return false;
                await handleModelSettingsMutationFailure(providerErrorFromRpcFailure(caught, {
                    connectionId,
                    ...(machineId ? { machineId } : {}),
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
            // Saved metadata is already published by the Account writer. Runtime
            // model presentation can revalidate without retaining the authoring draft.
            fireAndForget(catalog.refresh());
            return accountStillCurrent();
        });
        modelSettingsQueue.current = queued.catch(() => undefined);
        return queued;
    }, [accountStillCurrent, catalog.refresh, connectionId, handleModelSettingsMutationFailure, machineId]);
    const runModelSettingsMutation = React.useCallback((
        request: Parameters<typeof mutateProviderModelSettings>[0]['request'],
        retry: () => Promise<void>,
    ): Promise<boolean> => runQueuedMutation(() => mutateProviderModelSettings({ serverId, request }), retry),
    [mutateProviderModelSettings, runQueuedMutation, serverId]);
    const refreshLoadedModel = React.useCallback(async (loadedConnectionId: string, modelId: string) => {
        if (!accountStillCurrent() || loadedConnectionId !== connectionId) return false;
        const result = await catalog.refreshWithResult();
        if (!result) return false;
        if (result.status === 'error') throw result.error;
        return accountStillCurrent() && result.models.some((model) => model.id === modelId && model.loadState === 'loaded');
    }, [accountStillCurrent, catalog.refreshWithResult, connectionId]);
    const modelLoad = useProviderModelLoadAction({
        active: input.active,
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
        if (!accountStillCurrent()) return;
        await runModelSettingsMutation(
            { action: 'setVisibility', ...(machineId ? { machineId } : {}), ref, hidden },
            () => setVisibility(ref, hidden),
        );
    }, [accountStillCurrent, machineId, runModelSettingsMutation]);
    const reset = React.useCallback(async () => {
        if (!accountStillCurrent()) return;
        await runModelSettingsMutation({
            action: 'resetVisibility', ...(machineId ? { machineId } : {}),
            scope: { kind: 'connection', connectionId },
        }, reset);
    }, [accountStillCurrent, connectionId, machineId, runModelSettingsMutation]);
    const runBulk = React.useCallback(async (
        action: 'showAll' | 'hideAll' | 'showOnly',
        selected?: ModelVisibilityRefV1,
    ) => {
        if (!accountStillCurrent()) return;
        const changes = buildProviderModelVisibilityChanges({
            scope: { kind: 'connection', connectionId },
            nativeModels: [],
            groups,
            action,
            ...(selected ? { selected } : {}),
        });
        if (changes.length === 0) return;
        await runModelSettingsMutation(
            { action: 'bulkVisibility', ...(machineId ? { machineId } : {}), changes: [...changes] },
            () => runBulk(action, selected),
        );
    }, [accountStillCurrent, connectionId, groups, machineId, runModelSettingsMutation]);

    const addManualModels = React.useCallback(async (): Promise<boolean> => {
        if (!accountStillCurrent() || catalog.connectionRevision === null || savingManualModels) return false;
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
                ...(machineId ? { machineId } : {}),
                connectionId,
                expectedConnectionRevision: catalog.connectionRevision,
                models: parsed.accepted.map((id) => ({
                    id,
                    ...(manualEffortLevels.length > 0 ? { reasoningEffortLevels: [...manualEffortLevels] } : {}),
                })),
            }, async () => { await addManualModels(); });
            if (!succeeded || !accountStillCurrent()) return false;
            const rejectedText = parsed.rejected.map((entry) => entry.value).join('\n');
            setManualModelText(rejectedText);
            if (parsed.rejected.length === 0) setManualEffortLevels([]);
            setEditorOpen(parsed.rejected.length > 0);
            setEditorError(parsed.rejected.length > 0
                ? t('settingsProviders.models.invalidModelIds', { ids: parsed.rejected.map((entry) => entry.value).join(', ') })
                : null);
            return parsed.rejected.length === 0;
        } finally {
            if (accountStillCurrent()) setSavingManualModels(false);
        }
    }, [accountStillCurrent, catalog.connectionRevision, catalog.models, connectionId, machineId, manualEffortLevels, manualModelText, runModelSettingsMutation, savingManualModels]);

    // Editing replaces the stored entry, so the save carries everything it already declares: the
    // display name stays, and the tiers are the ones the editor opened with, changed as asked.
    const editingModel = editingModelId === null ? null
        : declaredManualModels?.find((model) => model.id === editingModelId) ?? null;
    const editingModelDirty = editingModel !== null
        && manualEffortLevels.join() !== (editingModel.reasoningEffortLevels ?? []).join();
    const updateManualModelEffort = React.useCallback(async (): Promise<boolean> => {
        if (!accountStillCurrent() || catalog.connectionRevision === null || savingManualModels || !editingModel) return false;
        setSavingManualModels(true);
        setEditorError(null);
        try {
            const succeeded = await runModelSettingsMutation({
                action: 'manualAdd',
                ...(machineId ? { machineId } : {}),
                connectionId,
                expectedConnectionRevision: catalog.connectionRevision,
                models: [{
                    id: editingModel.id,
                    ...(editingModel.name ? { name: editingModel.name } : {}),
                    ...(manualEffortLevels.length > 0 ? { reasoningEffortLevels: [...manualEffortLevels] } : {}),
                }],
            }, async () => { await updateManualModelEffort(); });
            if (!succeeded || !accountStillCurrent()) return false;
            discardManualModelDraft();
            return true;
        } finally {
            if (accountStillCurrent()) setSavingManualModels(false);
        }
    }, [accountStillCurrent, catalog.connectionRevision, connectionId, discardManualModelDraft, editingModel, machineId, manualEffortLevels, runModelSettingsMutation, savingManualModels]);

    // Generation settings: the output allowance a model may write per reply. The saved value is the
    // connection's own explicit setting (never a default), read from the Account catalog.
    const generationModel = generationModelId === null ? null
        : catalog.models.find((model) => model.id === generationModelId) ?? null;
    const retainedOutputAllowance = generationSettings.value;
    const outputAllowanceValue = outputAllowanceText ?? (retainedOutputAllowance === null ? '' : String(retainedOutputAllowance));
    const outputAllowanceDirty = generationModel !== null && outputAllowanceValue.trim() !== (retainedOutputAllowance === null ? '' : String(retainedOutputAllowance));
    const writeGenerationSettings = React.useCallback(async (
        allowance: number | null,
    ): Promise<boolean> => {
        if (!accountStillCurrent() || !generationModel || savingManualModels) return false;
        setSavingManualModels(true);
        setEditorError(null);
        setOperationError(null);
        try {
            const result = await (allowance === null ? generationSettings.clear() : generationSettings.save(allowance));
            if (result?.status !== 'success' || !accountStillCurrent()) return false;
            setOperationError(null);
            discardManualModelDraft();
            return true;
        } finally {
            if (accountStillCurrent()) setSavingManualModels(false);
        }
    }, [accountStillCurrent, discardManualModelDraft, generationModel, generationSettings.clear, generationSettings.save, savingManualModels]);
    const saveOutputAllowance = React.useCallback(async (): Promise<boolean> => {
        if (!generationModel) return false;
        const text = outputAllowanceValue.trim();
        const allowance = /^\d+$/.test(text) ? Number(text) : Number.NaN;
        if (!Number.isSafeInteger(allowance) || allowance <= 0) {
            setEditorError(t('settingsProviders.models.outputAllowanceInvalid'));
            return false;
        }
        // A model whose declared limits cannot honour the number would stay out of the picker after saving.
        const descriptor = generationModel.descriptor;
        if (descriptor && (descriptor.inlineCompletion || descriptor.nextEdit)
            && !isFileEditorAiSuggestionModel(projectProviderModelGenerationSettings(descriptor, { maxTokens: allowance }))) {
            setEditorError(t('settingsProviders.models.outputAllowanceTooLarge'));
            return false;
        }
        return writeGenerationSettings(allowance);
    }, [generationModel, outputAllowanceValue, writeGenerationSettings]);
    const clearOutputAllowance = React.useCallback(async (): Promise<boolean> => {
        if (!generationModel || retainedOutputAllowance === null) return false;
        return writeGenerationSettings(null);
    }, [generationModel, retainedOutputAllowance, writeGenerationSettings]);

    const saveManualEditor = generationModelId !== null ? saveOutputAllowance
        : editingModelId === null ? addManualModels : updateManualModelEffort;

    // A typed manual-model draft is unsaved work; the hosting page joins it to
    // its unsaved-changes guard.
    manualDraftDirtyRef.current = generationModelId !== null ? outputAllowanceDirty
        : editingModelId === null ? manualModelText.trim().length > 0 : editingModelDirty;

    const removeManualModel = React.useCallback(async (removeConnectionId: string, modelId: string) => {
        if (!accountStillCurrent() || catalog.connectionRevision === null || removeConnectionId !== connectionId) return;
        await runModelSettingsMutation({
            action: 'manualRemove', ...(machineId ? { machineId } : {}), connectionId: removeConnectionId,
            modelId, expectedConnectionRevision: catalog.connectionRevision,
        }, () => removeManualModel(removeConnectionId, modelId));
    }, [accountStillCurrent, catalog.connectionRevision, connectionId, machineId, runModelSettingsMutation]);

    const refreshCatalog = React.useCallback(async () => {
        const target = resolveCurrentTarget();
        if (input.active === false || !accountStillCurrent() || !machineId || refreshingCatalog || !target || target.machineId !== machineId) return;
        pendingProbe.current?.abort();
        const controller = new AbortController();
        pendingProbe.current = controller;
        setRefreshingCatalog(true);
        try {
            const result = await probeProviderConnection({
                machineId: target.machineId,
                serverId: target.serverId,
                connectionId,
            }, { signal: controller.signal });
            if (controller.signal.aborted || !accountStillCurrent()) return;
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
            if (!controller.signal.aborted && accountStillCurrent()) showTransportError(caught, refreshCatalog);
        } finally {
            if (pendingProbe.current === controller) {
                pendingProbe.current = null;
                if (accountStillCurrent()) setRefreshingCatalog(false);
            }
        }
    }, [accountStillCurrent, catalog.refresh, connectionId, input.active, machineId, probeProviderConnection, refreshingCatalog, resolveCurrentTarget, showError, showTransportError]);

    const retryCatalog = React.useCallback(async (): Promise<void> => {
        if (!accountStillCurrent()) return;
        await catalog.refresh();
    }, [accountStillCurrent, catalog.refresh]);
    const displayError = operationError?.error ?? generationSettings.error ?? catalog.error;

    return {
        groups,
        pendingApproval: generationSettings.pendingApproval ?? pendingApproval ?? catalog.pendingApproval ?? modelLoad.pendingApproval,
        initialLoading: catalog.loading,
        modelCount: catalog.models.length,
        catalogCount,
        manualModelPolicy: catalog.manualModelPolicy,
        error: displayError,
        errorRetry: operationError?.retry ?? generationSettings.retry
            ?? (!operationError && !generationSettings.error && displayError ? retryCatalog : undefined),
        errorLoadModel: operationError?.loadModel,
        errorReviewCurrentState: operationError?.reviewCurrentState
            ?? (generationSettings.error?.code === 'provider_rpc_mutation_outcome_unknown' ? reviewCurrentState : undefined),
        canRefreshCatalog: machineId !== null && connection !== null && connection.probeCapability !== 'none',
        refreshingCatalog,
        showHidden,
        loadingModelKey: modelLoad.loadingModelKey,
        loadCancelledProviderMayContinue: modelLoad.cancelledProviderMayContinue,
        editorOpen: editorOpen || generationModel !== null,
        editorError,
        manualModelText,
        manualEffortLevels,
        editingModel,
        editingModelDirty,
        generationModel,
        outputAllowanceValue,
        retainedOutputAllowance,
        outputAllowanceDirty,
        savingManualModels,
        manualModelsRef,
        manualDraft: {
            dirtyRef: manualDraftDirtyRef,
            discard: discardManualModelDraft,
            save: saveManualEditor,
            accountStillCurrent,
        },
        onEditorOpenChange: (open: boolean) => {
            if (!accountStillCurrent()) return;
            setEditorOpen(open);
            if (!open) {
                setEditorError(null);
                // Closing leaves tier editing; the add form never inherits the edited model's tiers.
                if (editingModelId !== null) {
                    setEditingModelId(null);
                    setManualEffortLevels([]);
                }
                setGenerationModelId(null);
                setOutputAllowanceText(null);
            }
        },
        onManualModelTextChange: (text: string) => {
            if (!accountStillCurrent()) return;
            setManualModelText(text);
            setEditorError(null);
        },
        onManualEffortLevelsChange: (levels: ProviderReasoningEffortLevelV1[]) => {
            if (!accountStillCurrent()) return;
            setManualEffortLevels(levels);
            setEditorError(null);
        },
        onEditManualModel: (editConnectionId: string, modelId: string) => {
            const declared = declaredManualModels?.find((model) => model.id === modelId);
            if (!accountStillCurrent() || editConnectionId !== connectionId || !declared) return;
            setManualModelText('');
            setEditorError(null);
            setEditingModelId(modelId);
            setManualEffortLevels(declared.reasoningEffortLevels ?? []);
            setEditorOpen(true);
        },
        onEditGenerationSettings: (editConnectionId: string, modelId: string) => {
            if (!accountStillCurrent() || editConnectionId !== connectionId) return;
            setManualModelText('');
            setManualEffortLevels([]);
            setEditingModelId(null);
            setEditorError(null);
            setOutputAllowanceText(null);
            setGenerationModelId(modelId);
            setEditorOpen(true);
        },
        onOutputAllowanceChange: (text: string) => {
            if (!accountStillCurrent()) return;
            setOutputAllowanceText(text);
            setEditorError(null);
        },
        onClearOutputAllowance: () => { void clearOutputAllowance(); },
        onSaveManualEditor: () => { void saveManualEditor(); },
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

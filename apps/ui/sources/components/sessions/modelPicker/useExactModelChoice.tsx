import * as React from 'react';
import { providerDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';
import { BackendTargetKeyV2Schema, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import {
  SessionModelPicker,
  type SessionModelPickerExperimentalConfirmationController,
  type SessionModelPickerProps,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { resolveOperationalBackendTargetForAgentSelection } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import {
  buildSessionModelSelectedTriggerPresentation,
  hiddenModelVisibilityKeys,
} from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import { useConfirmExperimentalProviderModel } from '@/providers/hooks/useConfirmExperimentalProviderModel';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

type ProjectionGroups = NonNullable<
  ReturnType<typeof useProviderModelProjection>['data']
>['groups'];

const EMPTY_GROUPS: ProjectionGroups = [];

type TeamModelChoiceProps = Pick<SessionModelPickerProps, 'teamCredentialResources' | 'teamNameById' | 'homeNameByTeamId'
  | 'currentTeamCredentialResourceKeys' | 'selectedTeamCredentialModel' | 'onSelectTeamCredentialModel' | 'experimentalConfirmation'>;

function ExactModelChoiceModal(
  props: Readonly<{
    agentTargetKey: string;
    declarationContext: NonNullable<SessionModelPickerProps['declarationContext']>;
    sourceBrowse?: SessionModelPickerProps['sourceBrowse'];
    nativeModels: readonly {
      value: string;
      label: string;
      description?: string;
    }[];
    providerGroups: ProjectionGroups;
    providerProjectionAuthoritative: boolean;
    projectionError: SessionModelPickerProps['projectionError'];
    projectionFailures: SessionModelPickerProps['projectionFailures'];
    retryProjection: SessionModelPickerProps['retryProjection'];
    probe: SessionModelPickerProps['probe'];
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys: ReadonlySet<string>;
    selected: ProviderBoundModelRef | null;
    effectiveLabel: string;
    experimentalConfirmation: SessionModelPickerExperimentalConfirmationController;
    onSelect: (selection: ProviderBoundModelRef | null) => void;
    onClose: () => void;
  }> & Omit<TeamModelChoiceProps, 'experimentalConfirmation'>,
) {
  return (
    <SessionModelPicker
      agentTargetKey={props.agentTargetKey}
      declarationContext={props.declarationContext}
      sourceBrowse={props.sourceBrowse}
      nativeModels={props.nativeModels}
      providerGroups={props.providerGroups}
      providerProjectionAuthoritative={props.providerProjectionAuthoritative}
      projectionError={props.projectionError}
      projectionFailures={props.projectionFailures}
      retryProjection={props.retryProjection}
      probe={props.probe}
      currentSelectionRecovery={props.currentSelectionRecovery}
      hiddenNativeModelKeys={props.hiddenNativeModelKeys}
      selected={props.selected}
      experimentalConfirmation={props.experimentalConfirmation}
      teamCredentialResources={props.teamCredentialResources}
      teamNameById={props.teamNameById}
      homeNameByTeamId={props.homeNameByTeamId}
      currentTeamCredentialResourceKeys={props.currentTeamCredentialResourceKeys}
      selectedTeamCredentialModel={props.selectedTeamCredentialModel}
      onSelectTeamCredentialModel={props.onSelectTeamCredentialModel}
      onSelect={(selection) => {
        props.onSelect(selection);
        props.onClose();
      }}
    />
  );
}

/**
 * One exact model choice for an Agent (native or a Provider source), outside a running Session: a
 * profile's preferred model, the Account default, a Run that cannot follow its Session. The row
 * reads `presentation`; `open` shows the same model picker the composer uses, in a card.
 */
export function useExactModelChoice(
  params: Readonly<{
    agentTargetKey: string | null;
    /** The Agent whose own models lead the picker; null offers Provider sources only. */
    agentId: string | null;
    machineId: string | null;
    serverId: string | null;
    selected: ProviderBoundModelRef | null;
    title: string;
    fallbackLabel: string;
    /** Offers clearing the choice as the picker's first row (it selects `null`). */
    clearOptionLabel?: string;
    clearOptionDescription?: string;
    enabled?: boolean;
    /** Team-capable callers supply the same catalog and selection owner as Session authoring. */
    teamModelChoice?: TeamModelChoiceProps;
  }>,
) {
  const providersEnabled = useFeatureEnabled('providers', {
    scopeKind: 'spawn',
    serverId: params.serverId,
  });
  const enabled = params.enabled !== false;
  // Closed rows observe the exact Machine's admitted cache without initiating discovery.
  const declarations = useDaemonMergedProjectionInputs({ machineId: params.machineId, serverId: params.serverId,
    enabled: enabled && Boolean(params.machineId), load: false });
  const declarationProjection = declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 : undefined;
  const declarationContext = React.useMemo(() => providerDeclarationContext(params.machineId, declarationProjection),
    [params.machineId, declarationProjection]);
  const backendTarget = React.useMemo(() => {
    const key = BackendTargetKeyV2Schema.safeParse(params.agentTargetKey);
    return key.success ? resolveOperationalBackendTargetForAgentSelection({
      backendTarget: parseBackendTargetKeyV2(key.data),
      selectedEntry: params.agentId ? { agentId: params.agentId } : null,
    }) : null;
  }, [params.agentId, params.agentTargetKey]);
  const nativeCatalog = useNewSessionPreflightModelsState({
    backendTarget,
    runtimeCarrierAgentId: params.agentId,
    selectedMachineId: params.machineId,
    capabilityServerId: params.serverId ?? '',
    enabled: enabled && params.agentId !== null && backendTarget !== null && params.machineId !== null,
  });
  const providerSettings = useProviderSettingsForServer(params.serverId);
  const projection = useProviderModelProjection({
    enabled: providersEnabled && enabled,
    machineId: params.machineId,
    serverId: params.serverId,
    agentTargetKey: params.agentTargetKey,
    mode: 'picker',
    ...(params.selected ? { currentSelection: params.selected } : {}),
  });
  const confirmExperimentalModel = useConfirmExperimentalProviderModel({
    enabled: providersEnabled && enabled,
    machineId: params.machineId,
    serverId: params.serverId,
    agentTargetKey: params.agentTargetKey,
    refresh: projection.refresh,
  });
  const nativeModels = React.useMemo(() => {
    // The picker reads a native `default` row as "no explicit model" and selects `null`.
    const clear = params.clearOptionLabel ? [{ value: 'default', label: params.clearOptionLabel,
      ...(params.clearOptionDescription ? { description: params.clearOptionDescription } : {}) }] : [];
    if (!params.agentId) return clear;
    return [...clear, ...nativeCatalog.modelOptions.filter((model) => !params.clearOptionLabel || model.value !== 'default')];
  }, [nativeCatalog.modelOptions, params.agentId, params.clearOptionDescription, params.clearOptionLabel]);
  const hiddenNativeModelKeys = React.useMemo(
    () =>
      hiddenModelVisibilityKeys(providerSettings, {
        providersFeatureEnabled: providersEnabled,
      }),
    [providersEnabled, providerSettings],
  );
  const providerGroups = providersEnabled
    ? (projection.data?.groups ?? EMPTY_GROUPS)
    : EMPTY_GROUPS;
  const currentSelectionRecovery = providersEnabled
    ? (projection.data?.currentSelectionRecovery ?? null)
    : null;
  const providerProjectionAuthoritative =
    providersEnabled && projection.status === 'success';
  // The picker's header refresh owns both catalogs; its error line deliberately
  // omits a duplicate retry when that header action is available.
  const refreshCatalogs = React.useCallback(() => {
    nativeCatalog.probe.onRefresh?.();
    if (providersEnabled) void projection.refresh();
  }, [nativeCatalog.probe.onRefresh, projection.refresh, providersEnabled]);
  const probe = React.useMemo<SessionModelPickerProps['probe']>(() => ({
    ...nativeCatalog.probe,
    phase: nativeCatalog.probe.phase !== 'idle' ? nativeCatalog.probe.phase
      : providersEnabled && projection.loading ? projection.data ? 'refreshing' : 'loading' : 'idle',
    ...(nativeCatalog.probe.onRefresh || providersEnabled ? { onRefresh: refreshCatalogs } : {}),
  }), [nativeCatalog.probe, projection.data, projection.loading, providersEnabled, refreshCatalogs]);
  const presentation = React.useMemo(
    () =>
      buildSessionModelSelectedTriggerPresentation({
        agentTargetKey: params.agentTargetKey ?? '',
        declarationContext,
        nativeModels,
        providerGroups,
        hiddenNativeModelKeys,
        providerProjectionAuthoritative,
        selected: params.selected,
        ...params.teamModelChoice,
        currentSelectionRecovery,
        fallbackLabel: params.selected?.modelId ?? params.fallbackLabel,
        fieldLabel: params.title,
      }),
    [
      currentSelectionRecovery,
      declarationContext,
      hiddenNativeModelKeys,
      nativeModels,
      params.agentTargetKey,
      params.fallbackLabel,
      params.selected,
      params.title,
      params.teamModelChoice,
      providerGroups,
      providerProjectionAuthoritative,
    ],
  );

  // The open dialog follows the owners it reads (the projection settling, an approval waiting or
  // failing) through the modal's own update, so it never shows what was true when it opened.
  const live = React.useMemo(
    () => ({
      declarationContext,
      sourceBrowse: { machineId: params.machineId, serverId: params.serverId },
      nativeModels,
      providerGroups,
      providerProjectionAuthoritative,
      projectionError: providersEnabled ? projection.error : null,
      projectionFailures: providersEnabled ? projection.refreshFailures : undefined,
      retryProjection: providersEnabled ? projection.refresh : null,
      probe,
      currentSelectionRecovery,
      hiddenNativeModelKeys,
      selected: params.selected,
      effectiveLabel: params.selected?.modelId ?? params.fallbackLabel,
      ...params.teamModelChoice,
      experimentalConfirmation: params.teamModelChoice?.experimentalConfirmation?.pending || params.teamModelChoice?.experimentalConfirmation?.error
        ? params.teamModelChoice.experimentalConfirmation : confirmExperimentalModel,
    }),
    [
      confirmExperimentalModel,
      declarationContext,
      currentSelectionRecovery,
      hiddenNativeModelKeys,
      nativeModels,
      probe,
      params.fallbackLabel,
      params.machineId,
      params.serverId,
      params.selected,
      params.teamModelChoice,
      providerGroups,
      providerProjectionAuthoritative,
      projection.error,
      projection.refreshFailures,
      projection.refresh,
      providersEnabled,
    ],
  );
  const openDialog = React.useRef<Readonly<{
    id: string;
    agentTargetKey: string;
    onSelect: (selection: ProviderBoundModelRef | null) => void;
  }> | null>(null);
  // Popovers may retain an opener while its catalogs settle before any modal
  // exists. Read current owner data on invocation as well as while open.
  const openState = React.useRef({ agentTargetKey: params.agentTargetKey, title: params.title, live });
  openState.current = { agentTargetKey: params.agentTargetKey, title: params.title, live };
  React.useEffect(() => {
    const dialog = openDialog.current;
    if (dialog) {
      Modal.update(dialog.id, { agentTargetKey: dialog.agentTargetKey, onSelect: dialog.onSelect, ...live });
    }
  }, [live]);
  const open = React.useCallback(
    (onSelect: (selection: ProviderBoundModelRef | null) => void) => {
      const { agentTargetKey, title, live: currentLive } = openState.current;
      if (!agentTargetKey) return;
      const selectAndRelease = (selection: ProviderBoundModelRef | null) => {
        openDialog.current = null;
        onSelect(selection);
      };
      const id = Modal.show({
        component: ExactModelChoiceModal,
        props: { agentTargetKey, onSelect: selectAndRelease, ...currentLive },
        chrome: {
          kind: 'card',
          title,
          dimensions: { size: 'lg' },
        },
        closeOnBackdrop: true,
        onRequestClose: () => {
          openDialog.current = null;
        },
      });
      openDialog.current = id ? { id, agentTargetKey, onSelect: selectAndRelease } : null;
    },
    [],
  );

  return {
    presentation,
    open,
    pickerProps: params.agentTargetKey ? { agentTargetKey: params.agentTargetKey, ...live } : null,
    loading: projection.loading,
    error: providersEnabled ? projection.error : null,
    refresh: projection.refresh,
  };
}

/** The same exact-model owner in an Agent popover's existing detail pane. */
export function ExactModelChoicePicker(props: Parameters<typeof useExactModelChoice>[0] & Readonly<{
  onSelect: (selection: ProviderBoundModelRef | null) => void;
}>) {
  const { pickerProps } = useExactModelChoice(props);
  return pickerProps ? <SessionModelPicker {...pickerProps} multiColumn fillAvailableSpace onSelect={props.onSelect} /> : null;
}

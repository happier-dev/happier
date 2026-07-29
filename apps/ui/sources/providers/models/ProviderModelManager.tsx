import * as React from 'react';
import { View } from 'react-native';
import {
    ProviderConnectionIdSchema,
    serializeModelVisibilityRefV1,
    type ModelVisibilityRefV1,
} from '@happier-dev/protocol';
import type {
    DaemonProviderModelProjectionGroupV1,
    DaemonProviderModelProjectionRowV1,
} from '@happier-dev/protocol/rpc';

import { Switch } from '@/components/ui/forms/Switch';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
    SelectionListScreen,
    type SelectionListOption,
    type SelectionListSection,
} from '@/components/ui/selectionList';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { t } from '@/text';
import { providerModelRowKey } from './modelRowKey';
import { presentProviderModelRow } from './presentProviderModelRow';

type ProviderModelManagerRow = Readonly<{
    ref: Pick<DaemonProviderModelProjectionRowV1['ref'], 'modelId'>;
    descriptor: Pick<DaemonProviderModelProjectionRowV1['descriptor'], 'id' | 'name' | 'description'>;
    sources: DaemonProviderModelProjectionRowV1['sources'];
    compatibility?: DaemonProviderModelProjectionRowV1['compatibility'];
    endpointHealth?: DaemonProviderModelProjectionRowV1['endpointHealth'];
    catalog: DaemonProviderModelProjectionRowV1['catalog'];
    loadState: DaemonProviderModelProjectionRowV1['loadState'];
    visibility: DaemonProviderModelProjectionRowV1['visibility'];
}>;

/**
 * Context-neutral model-management view. Agent projections satisfy this
 * contract structurally; connection catalogs adapt only facts they own and do
 * not fabricate an agent target or session-current selection.
 */
export type ProviderModelManagerGroup = Readonly<{
    connectionId: string;
    providerName: string;
    connectionName: string;
    connectionRole: DaemonProviderModelProjectionGroupV1['connectionRole'];
    connectionDisplayNameMode: DaemonProviderModelProjectionGroupV1['connectionDisplayNameMode'];
    modelLoadAction: DaemonProviderModelProjectionGroupV1['modelLoadAction'];
    authorization?: DaemonProviderModelProjectionGroupV1['authorization'];
    rows: readonly ProviderModelManagerRow[];
}>;

function ModelVisibilityAccessory(props: Readonly<{
    label: string;
    visible: boolean;
    disabled: boolean;
    onVisibleChange: (visible: boolean) => void;
    onRemove?: () => void;
    onShowOnly?: () => void;
    onLoad?: () => void;
    onCancelLoad?: () => void;
    loading?: boolean;
}>): React.ReactElement {
    const actionLabel = (action: string) => `${props.label}, ${action}`;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {props.onCancelLoad ? (
                <IconButton
                    testID="provider-model-manager.cancel-load"
                    iconName="close-circle-outline"
                    accessibilityLabel={actionLabel(t('settingsProviders.models.cancelLoad'))}
                    tooltip={t('settingsProviders.models.cancelLoad')}
                    size={44}
                    variant="plain"
                    onPress={props.onCancelLoad}
                />
            ) : null}
            {props.onLoad ? (
                <IconButton
                    testID="provider-model-manager.load"
                    iconName="cloud-download-outline"
                    accessibilityLabel={actionLabel(t('settingsProviders.models.load'))}
                    tooltip={t('settingsProviders.models.load')}
                    size={44}
                    variant="plain"
                    disabled={props.loading}
                    onPress={props.onLoad}
                />
            ) : null}
            {props.onShowOnly ? (
                <IconButton
                    testID="provider-model-manager.show-only"
                    iconName="ellipsis-horizontal"
                    accessibilityLabel={actionLabel(t('settingsProviders.models.showOnly'))}
                    tooltip={t('settingsProviders.models.showOnly')}
                    size={44}
                    variant="plain"
                    onPress={props.onShowOnly}
                />
            ) : null}
            {props.onRemove ? (
                <IconButton
                    testID="provider-model-manager.remove"
                    iconName="trash-outline"
                    accessibilityLabel={actionLabel(t('settingsProviders.models.remove'))}
                    tooltip={t('settingsProviders.models.remove')}
                    size={44}
                    variant="plain"
                    tone="danger"
                    onPress={props.onRemove}
                />
            ) : null}
            <Switch
                compact
                value={props.visible}
                disabled={props.disabled}
                accessibilityLabel={props.label}
                onValueChange={props.onVisibleChange}
            />
        </View>
    );
}

export type ProviderModelManagerScope =
    | Readonly<{ kind: 'agent'; agentTargetKey: string }>
    | Readonly<{ kind: 'connection'; connectionId: string }>;

export type ProviderModelManagerNativeModel = Readonly<{
    id: string;
    name: string;
    description?: string;
    hidden: boolean;
}>;

export type ProviderModelVisibilityChange = Readonly<{
    ref: ModelVisibilityRefV1;
    hidden: boolean;
}>;

const EMPTY_NATIVE_MODELS: readonly ProviderModelManagerNativeModel[] = [];
const EMPTY_GROUPS: readonly ProviderModelManagerGroup[] = [];

function ProviderModelBulkActions(props: Readonly<{
    onShowAll?: () => void;
    onHideAll?: () => void;
    onReset?: () => void;
}>): React.ReactElement | null {
    if (!props.onShowAll && !props.onHideAll && !props.onReset) return null;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {props.onShowAll ? (
                <IconButton
                    testID="provider-model-manager.show-all"
                    iconName="eye-outline"
                    accessibilityLabel={t('settingsProviders.models.showAll')}
                    tooltip={t('settingsProviders.models.showAll')}
                    size={44}
                    variant="plain"
                    onPress={props.onShowAll}
                />
            ) : null}
            {props.onHideAll ? (
                <IconButton
                    testID="provider-model-manager.hide-all"
                    iconName="eye-off-outline"
                    accessibilityLabel={t('settingsProviders.models.hideAll')}
                    tooltip={t('settingsProviders.models.hideAll')}
                    size={44}
                    variant="plain"
                    onPress={props.onHideAll}
                />
            ) : null}
            {props.onReset ? (
                <IconButton
                    testID="provider-model-manager.reset"
                    iconName="refresh-outline"
                    accessibilityLabel={t('settingsProviders.models.resetVisibility')}
                    tooltip={t('settingsProviders.models.resetVisibility')}
                    size={44}
                    variant="plain"
                    onPress={props.onReset}
                />
            ) : null}
        </View>
    );
}

export function buildProviderModelVisibilityChanges(input: Readonly<{
    scope: ProviderModelManagerScope;
    nativeModels: readonly ProviderModelManagerNativeModel[];
    groups: readonly ProviderModelManagerGroup[];
    action: 'showAll' | 'hideAll' | 'showOnly';
    selected?: ModelVisibilityRefV1;
}>): readonly ProviderModelVisibilityChange[] {
    const refs: ModelVisibilityRefV1[] = [];
    if (input.scope.kind === 'agent') {
        for (const model of input.nativeModels) {
            refs.push({
                scope: 'agent',
                agentTargetKey: input.scope.agentTargetKey,
                providerConnectionId: null,
                modelId: model.id,
            });
        }
    }
    for (const group of input.groups) {
        if (input.scope.kind === 'connection' && group.connectionId !== input.scope.connectionId) continue;
        const connectionId = ProviderConnectionIdSchema.parse(group.connectionId);
        for (const row of group.rows) {
            refs.push(input.scope.kind === 'agent'
                ? {
                    scope: 'agent',
                    agentTargetKey: input.scope.agentTargetKey,
                    providerConnectionId: connectionId,
                    modelId: row.ref.modelId,
                }
                : {
                    scope: 'allAgents',
                    providerConnectionId: connectionId,
                    modelId: row.ref.modelId,
                });
        }
    }
    const selectedKey = input.selected ? serializeModelVisibilityRefV1(input.selected) : null;
    if (input.action === 'showOnly' && selectedKey === null) return [];
    if (input.action === 'showOnly'
        && !refs.some((ref) => serializeModelVisibilityRefV1(ref) === selectedKey)) return [];
    return refs.map((ref) => ({
        ref,
        hidden: input.action === 'hideAll'
            || (input.action === 'showOnly' && serializeModelVisibilityRefV1(ref) !== selectedKey),
    }));
}

function connectionTitle(group: ProviderModelManagerGroup): string {
    return group.connectionRole === 'default' && group.connectionDisplayNameMode === 'automatic'
        ? group.providerName
        : `${group.providerName} · ${group.connectionName}`;
}

function modelVisibilityActionLabel(hidden: boolean): string {
    return hidden
        ? t('settingsProviders.models.enable')
        : t('settingsProviders.models.disable');
}

export function buildProviderModelManagerSections(input: Readonly<{
    scope: ProviderModelManagerScope;
    nativeModels: readonly ProviderModelManagerNativeModel[];
    groups: readonly ProviderModelManagerGroup[];
    showHidden: boolean;
    onSetVisibility: (ref: ModelVisibilityRefV1, hidden: boolean) => void;
    onRemoveManualModel?: (connectionId: string, modelId: string) => void;
    onShowOnly?: (ref: ModelVisibilityRefV1) => void;
    onLoadModel?: (connectionId: string, modelId: string) => void;
    onCancelModelLoad?: () => void;
    onOpenConnection?: (connectionId: string) => void;
    loadingModelKey?: string | null;
}>): readonly SelectionListSection[] {
    const agentScope = input.scope.kind === 'agent' ? input.scope : null;
    const availableOptions: SelectionListOption[] = [];
    const hiddenOptions: SelectionListOption[] = [];
    const manualOptions: SelectionListOption[] = [];
    if (agentScope) {
        for (const model of input.nativeModels) {
            if (model.hidden && !input.showHidden) continue;
            const ref: ModelVisibilityRefV1 = {
                scope: 'agent', agentTargetKey: agentScope.agentTargetKey,
                providerConnectionId: null, modelId: model.id,
            };
            const option = {
                id: `native:${model.id}`,
                label: model.name,
                subtitle: model.description ?? model.id,
                accessibilityLabel: `${model.name}, ${modelVisibilityActionLabel(model.hidden)}`,
                rightAccessoryOutsidePressable: true,
                rightAccessory: (
                    <Switch
                        compact
                        value={!model.hidden}
                        accessibilityLabel={model.name}
                        onValueChange={(visible) => input.onSetVisibility(ref, !visible)}
                    />
                ),
                onSelect: () => input.onSetVisibility(ref, !model.hidden),
            };
            (model.hidden ? hiddenOptions : availableOptions).push(option);
        }
    }

    for (const group of input.groups) {
        if (input.scope.kind === 'connection' && group.connectionId !== input.scope.connectionId) continue;
        const connectionId = ProviderConnectionIdSchema.parse(group.connectionId);
        for (const row of group.rows) {
            const hiddenForScope = input.scope.kind === 'agent'
                ? row.visibility === 'hidden_agent' || row.visibility === 'hidden_all_agents' || row.visibility === 'hidden_current_selection'
                : row.visibility === 'hidden_all_agents';
            if (hiddenForScope && !input.showHidden) continue;
            const lockedByConnectionScope = input.scope.kind === 'agent' && row.visibility === 'hidden_all_agents';
            const ref: ModelVisibilityRefV1 = agentScope
                ? {
                    scope: 'agent', agentTargetKey: agentScope.agentTargetKey,
                    providerConnectionId: connectionId, modelId: row.ref.modelId,
                }
                : { scope: 'allAgents', providerConnectionId: connectionId, modelId: row.ref.modelId };
            const presentation = presentProviderModelRow({
                modelId: row.ref.modelId,
                name: row.descriptor.name,
                description: row.descriptor.description,
                contextLabel: connectionTitle(group),
                authorization: group.authorization,
                compatibility: row.compatibility,
                endpointHealth: row.endpointHealth,
                stale: row.catalog.stale,
                loadState: row.loadState,
                visibility: lockedByConnectionScope
                    ? 'hidden_for_all_agents'
                    : hiddenForScope
                        ? 'hidden'
                        : 'visible',
            });
            const loading = input.loadingModelKey === providerModelRowKey(group.connectionId, row.ref.modelId);
            const option = {
                id: providerModelRowKey(group.connectionId, row.ref.modelId),
                label: presentation.label,
                subtitle: presentation.description,
                disabled: lockedByConnectionScope && !input.onOpenConnection,
                accessibilityLabel: lockedByConnectionScope
                    ? `${row.descriptor.name || row.ref.modelId}, ${group.connectionName}, ${t('settingsProviders.models.hiddenForAllAgents')}`
                    : `${row.descriptor.name || row.ref.modelId}, ${group.connectionName}, ${modelVisibilityActionLabel(hiddenForScope)}`,
                rightAccessoryOutsidePressable: true,
                rightAccessory: (
                    <ModelVisibilityAccessory
                        label={`${presentation.label}, ${connectionTitle(group)}`}
                        visible={!hiddenForScope}
                        disabled={lockedByConnectionScope}
                        onVisibleChange={(visible) => input.onSetVisibility(ref, !visible)}
                        onShowOnly={!lockedByConnectionScope && input.onShowOnly
                            ? () => input.onShowOnly?.(ref)
                            : undefined}
                        onLoad={!loading
                            && group.modelLoadAction === 'available'
                            && row.loadState === 'unloaded'
                            && input.onLoadModel
                            ? () => input.onLoadModel?.(group.connectionId, row.ref.modelId)
                            : undefined}
                        onCancelLoad={loading ? input.onCancelModelLoad : undefined}
                        loading={loading}
                        onRemove={row.sources.manual && input.onRemoveManualModel
                            ? () => input.onRemoveManualModel?.(group.connectionId, row.ref.modelId)
                            : undefined}
                    />
                ),
                onSelect: lockedByConnectionScope
                    ? () => input.onOpenConnection?.(group.connectionId)
                    : () => input.onSetVisibility(ref, !hiddenForScope),
            };
            const target = hiddenForScope
                ? hiddenOptions
                : row.sources.manual
                    ? manualOptions
                    : availableOptions;
            target.push(option);
        }
    }
    return [
        { id: 'available', title: t('settingsProviders.models.available'), options: availableOptions },
        { id: 'hidden', title: t('settingsProviders.models.hidden'), options: hiddenOptions },
        { id: 'manual', title: t('settingsProviders.models.manual'), options: manualOptions },
    ].flatMap((section): SelectionListSection[] => section.options.length > 0 ? [{
        ...section,
        count: section.options.length,
        virtualization: 'auto',
    }] : []);
}

export function ProviderModelManager(props: Readonly<{
    scope: ProviderModelManagerScope;
    nativeModels: readonly ProviderModelManagerNativeModel[];
    groups: readonly ProviderModelManagerGroup[];
    showHidden: boolean;
    onSetVisibility: (ref: ModelVisibilityRefV1, hidden: boolean) => void;
    onRemoveManualModel?: (connectionId: string, modelId: string) => void;
    onShowOnly?: (ref: ModelVisibilityRefV1) => void;
    onLoadModel?: (connectionId: string, modelId: string) => void;
    onCancelModelLoad?: () => void;
    onOpenConnection?: (connectionId: string) => void;
    loadingModelKey?: string | null;
    onShowAll?: () => void;
    onHideAll?: () => void;
    onResetVisibility?: () => void;
    onRequestClose: () => void;
    headerActions?: React.ReactNode;
    testID?: string;
}>): React.ReactElement {
    const scopeIdentity = props.scope.kind === 'agent'
        ? props.scope.agentTargetKey
        : props.scope.connectionId;
    const scope = React.useMemo<ProviderModelManagerScope>(() => props.scope.kind === 'agent'
        ? { kind: 'agent', agentTargetKey: scopeIdentity }
        : { kind: 'connection', connectionId: scopeIdentity }, [props.scope.kind, scopeIdentity]);
    const nativeModels = props.nativeModels.length === 0 ? EMPTY_NATIVE_MODELS : props.nativeModels;
    const groups = props.groups.length === 0 ? EMPTY_GROUPS : props.groups;
    const canRemoveManualModel = props.onRemoveManualModel !== undefined;
    const canShowOnly = props.onShowOnly !== undefined;
    const canLoadModel = props.onLoadModel !== undefined;
    const canCancelModelLoad = props.onCancelModelLoad !== undefined;
    const canOpenConnection = props.onOpenConnection !== undefined;
    const onSetVisibility = useEventCallback((ref: ModelVisibilityRefV1, hidden: boolean) => {
        props.onSetVisibility(ref, hidden);
    });
    const onRemoveManualModel = useEventCallback((connectionId: string, modelId: string) => {
        props.onRemoveManualModel?.(connectionId, modelId);
    });
    const onShowOnly = useEventCallback((ref: ModelVisibilityRefV1) => {
        props.onShowOnly?.(ref);
    });
    const onLoadModel = useEventCallback((connectionId: string, modelId: string) => {
        props.onLoadModel?.(connectionId, modelId);
    });
    const onCancelModelLoad = useEventCallback(() => {
        props.onCancelModelLoad?.();
    });
    const onOpenConnection = useEventCallback((connectionId: string) => {
        props.onOpenConnection?.(connectionId);
    });
    const sections = React.useMemo(() => buildProviderModelManagerSections({
        scope,
        nativeModels,
        groups,
        showHidden: props.showHidden,
        onSetVisibility,
        ...(canRemoveManualModel ? { onRemoveManualModel } : {}),
        ...(canShowOnly ? { onShowOnly } : {}),
        ...(canLoadModel ? { onLoadModel } : {}),
        ...(canCancelModelLoad ? { onCancelModelLoad } : {}),
        ...(canOpenConnection ? { onOpenConnection } : {}),
        loadingModelKey: props.loadingModelKey,
    }), [
        canLoadModel,
        canCancelModelLoad,
        canOpenConnection,
        canRemoveManualModel,
        canShowOnly,
        groups,
        props.loadingModelKey,
        props.showHidden,
        nativeModels,
        onLoadModel,
        onCancelModelLoad,
        onOpenConnection,
        onRemoveManualModel,
        onSetVisibility,
        onShowOnly,
        scope,
    ]);
    const rootStep = React.useMemo(() => ({
        id: 'models',
        inputPlaceholder: t('modelPickerOverlay.searchPlaceholder'),
        emptyStateLabel: t('settingsProviders.models.empty'),
        sections: sections.map((section) => ({ kind: 'static' as const, ...section })),
    }), [sections]);
    return (
        <SelectionListScreen
            testID={props.testID ?? 'provider-model-manager'}
            rootStep={rootStep}
            inputSuffix={(
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <ProviderModelBulkActions
                        onShowAll={props.onShowAll}
                        onHideAll={props.onHideAll}
                        onReset={props.onResetVisibility}
                    />
                    {props.headerActions}
                </View>
            )}
            selectedOptionId={null}
            onSelect={() => {}}
            onRequestClose={props.onRequestClose}
        />
    );
}

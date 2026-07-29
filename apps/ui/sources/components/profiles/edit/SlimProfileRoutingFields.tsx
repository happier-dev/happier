import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
    readProviderSettingsFromAccountSettingsV1,
    type LaunchProfileV2,
    type ProviderBoundModelRef,
} from '@happier-dev/protocol';
import type { DaemonProviderCurrentSelectionRecoveryV1 } from '@happier-dev/protocol/rpc';
import { getAgentStaticModels } from '@happier-dev/agents';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import {
    SessionModelPicker,
    type SessionModelPickerExperimentalConfirmationController,
} from '@/components/sessions/modelPicker/SessionModelPicker';
import {
    buildSessionModelSelectedTriggerPresentation,
    hiddenModelVisibilityKeys,
} from '@/components/sessions/modelPicker/buildSessionModelPickerSections';
import { Modal } from '@/modal';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useConfirmExperimentalProviderModel } from '@/providers/hooks/useConfirmExperimentalProviderModel';
import { useProviderModelProjection } from '@/providers/hooks/useProviderModelProjection';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveProfileBackendTargetKeyForEntry } from './profileBackendEntryStorage';

type Entry = ResolvedBackendCatalogEntry;

function PreferredModelModal(props: Readonly<{
    agentTargetKey: string;
    nativeModels: readonly { value: string; label: string; description?: string }[];
    providerGroups: NonNullable<ReturnType<typeof useProviderModelProjection>['data']>['groups'];
    providerProjectionAuthoritative: boolean;
    currentSelectionRecovery?: DaemonProviderCurrentSelectionRecoveryV1 | null;
    hiddenNativeModelKeys: ReadonlySet<string>;
    selected: ProviderBoundModelRef | null;
    experimentalConfirmation: SessionModelPickerExperimentalConfirmationController;
    onSelect: (selection: ProviderBoundModelRef | null) => void;
    onClose: () => void;
}>) {
    return <SessionModelPicker
        agentTargetKey={props.agentTargetKey}
        nativeModels={props.nativeModels}
        providerGroups={props.providerGroups}
        providerProjectionAuthoritative={props.providerProjectionAuthoritative}
        currentSelectionRecovery={props.currentSelectionRecovery}
        hiddenNativeModelKeys={props.hiddenNativeModelKeys}
        selected={props.selected}
        effectiveLabel={props.selected?.modelId ?? t('profiles.preferredModel.none')}
        experimentalConfirmation={props.experimentalConfirmation}
        onSelect={(selection) => {
            props.onSelect(selection);
            props.onClose();
        }}
    />;
}

export function SlimProfileRoutingFields(props: Readonly<{
    entries: readonly Entry[];
    machineId: string | null;
    serverId: string | null;
    defaultPermissionModeByTargetKey: LaunchProfileV2['defaultPermissionModeByTargetKey'];
    defaultPersistenceModeByTargetKey: LaunchProfileV2['defaultPersistenceModeByTargetKey'];
    preferredAgentTargetKey?: string;
    preferredModelSelection?: LaunchProfileV2['preferredModelSelection'];
    onPermissionDefaultsChange: (value: LaunchProfileV2['defaultPermissionModeByTargetKey']) => void;
    onPersistenceDefaultsChange: (value: LaunchProfileV2['defaultPersistenceModeByTargetKey']) => void;
    onPreferredAgentChange: (value: string | undefined) => void;
    onPreferredModelChange: (value: LaunchProfileV2['preferredModelSelection'] | undefined) => void;
}>) {
    const { theme } = useUnistyles();
    const providersEnabled = useFeatureEnabled('providers', {
        scopeKind: 'spawn',
        serverId: props.serverId,
    });
    const settings = useSettings();
    const [openPermissionTarget, setOpenPermissionTarget] = React.useState<string | null>(null);
    const [openPersistenceTarget, setOpenPersistenceTarget] = React.useState<string | null>(null);
    const [agentOpen, setAgentOpen] = React.useState(false);
    const selectedEntry = props.entries.find((entry) => resolveProfileBackendTargetKeyForEntry(entry) === props.preferredAgentTargetKey) ?? null;
    const projection = useProviderModelProjection({
        enabled: providersEnabled,
        machineId: props.machineId,
        serverId: props.serverId,
        agentTargetKey: props.preferredAgentTargetKey ?? null,
        mode: 'picker',
        ...(props.preferredModelSelection ? { currentSelection: props.preferredModelSelection.ref } : {}),
    });
    const confirmExperimentalModel = useConfirmExperimentalProviderModel({
        enabled: providersEnabled,
        machineId: props.machineId,
        serverId: props.serverId,
        agentTargetKey: props.preferredAgentTargetKey ?? null,
        refresh: projection.refresh,
    });
    const nativeModels = React.useMemo(() => {
        const agentId = selectedEntry?.builtInAgentId ?? selectedEntry?.catalogAgentId;
        if (!agentId) return [];
        try {
            return getAgentStaticModels(agentId).map((model) => ({
                value: model.id,
                label: model.name || model.id,
                ...(model.description ? { description: model.description } : {}),
            }));
        } catch {
            return [];
        }
    }, [selectedEntry]);
    const hiddenNativeModelKeys = React.useMemo(() => hiddenModelVisibilityKeys(
        readProviderSettingsFromAccountSettingsV1(settings).settings,
        { providersFeatureEnabled: providersEnabled },
    ), [providersEnabled, settings]);
    const preferredModelFieldLabel = t('profiles.preferredModel.title');
    const preferredModelPresentation = React.useMemo(() => {
        const selected = props.preferredModelSelection?.ref ?? null;
        return buildSessionModelSelectedTriggerPresentation({
            agentTargetKey: props.preferredAgentTargetKey ?? '',
            nativeModels,
            providerGroups: providersEnabled ? (projection.data?.groups ?? []) : [],
            hiddenNativeModelKeys,
            providerProjectionAuthoritative: providersEnabled && projection.status === 'success',
            selected,
            currentSelectionRecovery: providersEnabled
                ? projection.data?.currentSelectionRecovery ?? null
                : null,
            fallbackLabel: selected?.modelId ?? t('profiles.preferredModel.none'),
            fieldLabel: preferredModelFieldLabel,
        });
    }, [
        hiddenNativeModelKeys,
        nativeModels,
        projection.data,
        projection.status,
        props.preferredAgentTargetKey,
        props.preferredModelSelection,
        preferredModelFieldLabel,
        providersEnabled,
    ]);

    const openModelPicker = React.useCallback(() => {
        if (!props.preferredAgentTargetKey) return;
        Modal.show({
            component: PreferredModelModal,
            props: {
                agentTargetKey: props.preferredAgentTargetKey,
                nativeModels,
                providerGroups: providersEnabled
                    ? (projection.data?.groups ?? [])
                    : [],
                providerProjectionAuthoritative: projection.status === 'success',
                currentSelectionRecovery: providersEnabled
                    ? projection.data?.currentSelectionRecovery ?? null
                    : null,
                hiddenNativeModelKeys,
                selected: props.preferredModelSelection?.ref ?? null,
                experimentalConfirmation: confirmExperimentalModel,
                onSelect: (ref: ProviderBoundModelRef | null) => props.onPreferredModelChange(ref ? {
                    v: 1,
                    updatedAt: Date.now(),
                    ref,
                } : undefined),
            },
            chrome: { kind: 'card', title: t('profiles.preferredModel.title'), dimensions: { size: 'lg' } },
            closeOnBackdrop: true,
        });
    }, [
        confirmExperimentalModel,
        hiddenNativeModelKeys,
        nativeModels,
        projection.data,
        projection.status,
        props,
        providersEnabled,
    ]);

    return <>
        <ItemGroup title={t('profiles.preferredAgent.title')} footer={t('profiles.preferredAgent.footer')}>
            <DropdownMenu
                open={agentOpen}
                onOpenChange={setAgentOpen}
                variant="selectable"
                search={props.entries.length >= 10}
                showCategoryTitles={false}
                rowKind="item"
                selectedId={props.preferredAgentTargetKey ?? '__none__'}
                itemTrigger={{
                    title: t('profiles.preferredAgent.title'),
                    subtitle: selectedEntry?.title ?? t('profiles.preferredAgent.none'),
                    showSelectedDetail: false,
                    showSelectedSubtitle: false,
                }}
                items={[
                    { id: '__none__', title: t('profiles.preferredAgent.none') },
                    ...props.entries.map((entry) => ({ id: resolveProfileBackendTargetKeyForEntry(entry), title: entry.title, subtitle: entry.subtitle ?? undefined })),
                ]}
                onSelect={(id) => {
                    const next = id === '__none__' ? undefined : id;
                    props.onPreferredAgentChange(next);
                    if (next !== props.preferredModelSelection?.ref.agentTargetKey) props.onPreferredModelChange(undefined);
                }}
            />
            <Item
                title={preferredModelFieldLabel}
                subtitle={preferredModelPresentation.subtitle}
                detail={preferredModelPresentation.detail}
                accessibilityLabel={preferredModelPresentation.accessibilityLabel}
                disabled={!props.preferredAgentTargetKey}
                loading={projection.loading}
                onPress={openModelPicker}
            />
            {providersEnabled && projection.error ? (
                <ProviderErrorItems error={projection.error} retry={projection.refresh} />
            ) : null}
        </ItemGroup>

        <ItemGroup title={t('profiles.defaultPermissions.title')} footer={t('profiles.defaultPermissions.footer')}>
            {props.entries.map((entry) => {
                const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
                const agentId = entry.builtInAgentId ?? entry.catalogAgentId ?? DEFAULT_AGENT_ID;
                const selected = props.defaultPermissionModeByTargetKey[targetKey];
                return <DropdownMenu
                    key={`permission:${targetKey}`}
                    open={openPermissionTarget === targetKey}
                    onOpenChange={(open) => setOpenPermissionTarget(open ? targetKey : null)}
                    variant="selectable"
                    search={false}
                    showCategoryTitles={false}
                    rowKind="item"
                    selectedId={selected ?? '__account__'}
                    itemTrigger={{
                        title: entry.title,
                        subtitle: selected ? getPermissionModeLabelForAgentType(agentId, selected as PermissionMode) : t('profiles.defaultPermissions.useAccountDefault'),
                        icon: <SafeIonicons name="shield-outline" size={29} color={theme.colors.text.secondary} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                    }}
                    items={[
                        { id: '__account__', title: t('profiles.defaultPermissions.useAccountDefault') },
                        ...getPermissionModeOptionsForAgentType(agentId).map((option) => ({
                            id: option.value,
                            title: option.label,
                            subtitle: option.description,
                        })),
                    ]}
                    onSelect={(id) => {
                        const next = { ...props.defaultPermissionModeByTargetKey };
                        if (id === '__account__') delete next[targetKey];
                        else next[targetKey] = id as PermissionMode;
                        props.onPermissionDefaultsChange(next);
                    }}
                />;
            })}
        </ItemGroup>

        <ItemGroup title={t('profiles.defaultStorage.title')} footer={t('profiles.defaultStorage.footer')}>
            {props.entries.map((entry) => {
                const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
                const selected = props.defaultPersistenceModeByTargetKey[targetKey];
                return <DropdownMenu
                    key={`storage:${targetKey}`}
                    open={openPersistenceTarget === targetKey}
                    onOpenChange={(open) => setOpenPersistenceTarget(open ? targetKey : null)}
                    variant="selectable"
                    search={false}
                    showCategoryTitles={false}
                    rowKind="item"
                    selectedId={selected ?? '__account__'}
                    itemTrigger={{
                        title: entry.title,
                        subtitle: selected ? t(`sessionsList.storage${selected === 'direct' ? 'Direct' : 'Persisted'}Tab`) : t('profiles.defaultStorage.useAccountDefault'),
                        icon: <SafeIonicons name="save-outline" size={29} color={theme.colors.text.secondary} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                    }}
                    items={[
                        { id: '__account__', title: t('profiles.defaultStorage.useAccountDefault') },
                        { id: 'persisted', title: t('sessionsList.storagePersistedTab') },
                        { id: 'direct', title: t('sessionsList.storageDirectTab') },
                    ]}
                    onSelect={(id) => {
                        const next = { ...props.defaultPersistenceModeByTargetKey };
                        if (id === '__account__') delete next[targetKey];
                        else next[targetKey] = id as 'persisted' | 'direct';
                        props.onPersistenceDefaultsChange(next);
                    }}
                />;
            })}
        </ItemGroup>
    </>;
}

import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentId } from '@/agents/catalog/catalog';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType, normalizePermissionModeForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { SessionTranscriptStorageMode } from '@/sync/domains/session/transcriptStorageDefaults';
import { t } from '@/text';

import { resolveProfileBackendTargetKeyForEntry } from '../profileBackendEntryStorage';

export function LegacyProfileDefaultsSections(props: Readonly<{
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    supportedDirectBackendEntries: readonly ResolvedBackendCatalogEntry[];
    compatibilityByTargetKey: Readonly<Record<string, boolean>>;
    defaultPermissionModesByTargetKey: Readonly<Record<string, PermissionMode | null>>;
    sessionDefaultPermissionModeByTargetKey: Readonly<Record<string, PermissionMode | undefined>>;
    accountDefaultPermissionModes: Readonly<Record<string, PermissionMode>>;
    defaultTranscriptStorageModesByTargetKey: Readonly<Record<string, SessionTranscriptStorageMode | null>>;
    accountTranscriptStorageDefaults: Readonly<{
        byTargetKey: Readonly<Partial<Record<string, SessionTranscriptStorageMode>>>;
        globalDefault: SessionTranscriptStorageMode;
    }>;
    externalSessionsEnabled: boolean;
    openPermissionTargetKey: string | null;
    setOpenPermissionTargetKey: (targetKey: string | null) => void;
    openStorageTargetKey: string | null;
    setOpenStorageTargetKey: (targetKey: string | null) => void;
    popoverBoundaryRef: React.RefObject<unknown>;
    getPermissionAgentId: (entry: ResolvedBackendCatalogEntry) => AgentId;
    getDisplayAgentIconName: (entry: ResolvedBackendCatalogEntry) => string;
    getPermissionIconName: (agentId: AgentId, mode: PermissionMode) => string;
    setDefaultPermissionMode: (targetKey: string, mode: PermissionMode | null) => void;
    setDefaultTranscriptStorageMode: (targetKey: string, mode: SessionTranscriptStorageMode | null) => void;
}>) {
    const { theme } = useUnistyles();
    const compatibleEntries = props.resolvedBackendEntries.filter((entry) =>
        props.compatibilityByTargetKey[resolveProfileBackendTargetKeyForEntry(entry)] === true);
    const compatibleDirectEntries = props.supportedDirectBackendEntries.filter((entry) =>
        props.compatibilityByTargetKey[resolveProfileBackendTargetKeyForEntry(entry)] === true);

    return <>
        <ItemGroup title={t('profiles.defaultPermissions.title')} footer={t('profiles.defaultPermissions.footer')}>
            {compatibleEntries.map((entry, index) => {
                const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
                const agentId = props.getPermissionAgentId(entry);
                const override = props.defaultPermissionModesByTargetKey[targetKey];
                const accountDefault = normalizePermissionModeForAgentType(
                    props.sessionDefaultPermissionModeByTargetKey[targetKey]
                        ?? props.accountDefaultPermissionModes[agentId]
                        ?? 'default',
                    agentId,
                );
                const effectiveMode = override ?? accountDefault;
                return <DropdownMenu
                    key={entry.backendTargetKey}
                    open={props.openPermissionTargetKey === entry.backendTargetKey}
                    onOpenChange={(open) => props.setOpenPermissionTargetKey(open ? entry.backendTargetKey : null)}
                    popoverBoundaryRef={props.popoverBoundaryRef}
                    variant="selectable"
                    search={false}
                    showCategoryTitles={false}
                    matchTriggerWidth
                    connectToTrigger
                    rowKind="item"
                    selectedId={override ?? '__account__'}
                    trigger={({ open, toggle }) => <Item
                        selected={false}
                        title={entry.title}
                        subtitle={override
                            ? getPermissionModeLabelForAgentType(agentId, override)
                            : t('profiles.defaultPermissions.accountDefaultSubtitle', {
                                label: getPermissionModeLabelForAgentType(agentId, accountDefault),
                            })}
                        icon={<Ionicons name={props.getDisplayAgentIconName(entry) as never} size={29} color={theme.colors.text.secondary} />}
                        rightElement={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Ionicons name={props.getPermissionIconName(agentId, effectiveMode) as never} size={22} color={theme.colors.text.secondary} />
                            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.text.secondary} />
                        </View>}
                        showChevron={false}
                        onPress={toggle}
                        showDivider={index < compatibleEntries.length - 1}
                    />}
                    items={[
                        {
                            id: '__account__',
                            title: t('profiles.defaultPermissions.useAccountDefault'),
                            subtitle: t('profiles.defaultPermissions.currently', {
                                label: getPermissionModeLabelForAgentType(agentId, accountDefault),
                            }),
                            icon: <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="settings-outline" size={22} color={theme.colors.text.secondary} />
                            </View>,
                        },
                        ...getPermissionModeOptionsForAgentType(agentId).map((option) => ({
                            id: option.value,
                            title: option.label,
                            subtitle: option.description,
                            icon: <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name={option.icon as never} size={22} color={theme.colors.text.secondary} />
                            </View>,
                        })),
                    ]}
                    onSelect={(id) => {
                        props.setDefaultPermissionMode(targetKey, id === '__account__' ? null : id as PermissionMode);
                        props.setOpenPermissionTargetKey(null);
                    }}
                />;
            })}
        </ItemGroup>

        {props.externalSessionsEnabled && compatibleDirectEntries.length > 0 ? <ItemGroup
            title={t('profiles.defaultStorage.title')}
            footer={t('profiles.defaultStorage.footer')}
        >
            {compatibleDirectEntries.map((entry, index) => {
                const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
                const override = props.defaultTranscriptStorageModesByTargetKey[targetKey];
                const accountDefault = props.accountTranscriptStorageDefaults.byTargetKey[entry.backendTargetKey]
                    ?? props.accountTranscriptStorageDefaults.globalDefault;
                const effectiveMode = override ?? accountDefault;
                return <DropdownMenu
                    key={`storage-${entry.backendTargetKey}`}
                    open={props.openStorageTargetKey === entry.backendTargetKey}
                    onOpenChange={(open) => props.setOpenStorageTargetKey(open ? entry.backendTargetKey : null)}
                    popoverBoundaryRef={props.popoverBoundaryRef}
                    variant="selectable"
                    search={false}
                    showCategoryTitles={false}
                    matchTriggerWidth
                    connectToTrigger
                    rowKind="item"
                    selectedId={override ?? '__account__'}
                    trigger={({ open, toggle }) => <Item
                        selected={false}
                        title={entry.title}
                        subtitle={override
                            ? t(`sessionsList.storage${override === 'direct' ? 'Direct' : 'Persisted'}Tab`)
                            : t('profiles.defaultStorage.accountDefaultSubtitle', {
                                label: t(`sessionsList.storage${accountDefault === 'direct' ? 'Direct' : 'Persisted'}Tab`),
                            })}
                        icon={<Ionicons name={props.getDisplayAgentIconName(entry) as never} size={29} color={theme.colors.text.secondary} />}
                        rightElement={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <Ionicons name={effectiveMode === 'direct' ? 'radio-outline' : 'save-outline'} size={22} color={theme.colors.text.secondary} />
                            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={20} color={theme.colors.text.secondary} />
                        </View>}
                        showChevron={false}
                        onPress={toggle}
                        showDivider={index < compatibleDirectEntries.length - 1}
                    />}
                    items={[
                        {
                            id: '__account__',
                            title: t('profiles.defaultStorage.useAccountDefault'),
                            subtitle: t('profiles.defaultStorage.currently', {
                                label: t(`sessionsList.storage${accountDefault === 'direct' ? 'Direct' : 'Persisted'}Tab`),
                            }),
                            icon: <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="settings-outline" size={22} color={theme.colors.text.secondary} />
                            </View>,
                        },
                        {
                            id: 'persisted',
                            title: t('sessionsList.storagePersistedTab'),
                            subtitle: t('settingsSession.defaultStorage.persistedSubtitle'),
                            icon: <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="save-outline" size={22} color={theme.colors.text.secondary} />
                            </View>,
                        },
                        {
                            id: 'direct',
                            title: t('sessionsList.storageDirectTab'),
                            subtitle: t('settingsSession.defaultStorage.directSubtitle'),
                            icon: <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
                                <Ionicons name="radio-outline" size={22} color={theme.colors.text.secondary} />
                            </View>,
                        },
                    ]}
                    onSelect={(id) => {
                        props.setDefaultTranscriptStorageMode(
                            targetKey,
                            id === '__account__' ? null : id as SessionTranscriptStorageMode,
                        );
                        props.setOpenStorageTargetKey(null);
                    }}
                />;
            })}
        </ItemGroup> : null}
    </>;
}

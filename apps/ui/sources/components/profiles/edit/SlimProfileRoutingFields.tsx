import * as React from 'react';
import type { LaunchProfileV2 } from '@happier-dev/protocol/profiles/v2/schema';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { useExactModelChoice } from '@/components/sessions/modelPicker/useExactModelChoice';
import { getPermissionModeLabelForAgentType, getPermissionModeOptionsForAgentType } from '@/sync/domains/permissions/permissionModeOptions';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { t } from '@/text';
import { resolveProfileBackendTargetKeyForEntry } from './profileBackendEntryStorage';
import { ProfilePreferredAgentField } from './ProfilePreferredAgentField';

type Entry = ResolvedBackendCatalogEntry;

/** A per-agent default's one line: which agents differ from the account default, if any. */
function summarizeChanged(agentTitles: readonly string[]): string {
    return agentTitles.length > 0
        ? t('profiles.agentDefaults.changedFor', { agents: agentTitles.join(', ') })
        : t('profiles.agentDefaults.allAccountDefault');
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
    /** Rows of the same start decision owned elsewhere (where it runs, working copy), between the model and the per-agent defaults. */
    children?: React.ReactNode;
}>) {
    const [openPermissionTarget, setOpenPermissionTarget] = React.useState<string | null>(null);
    const [openPersistenceTarget, setOpenPersistenceTarget] = React.useState<string | null>(null);
    const selectedEntry = props.entries.find((entry) => resolveProfileBackendTargetKeyForEntry(entry) === props.preferredAgentTargetKey) ?? null;
    const preferredModelFieldLabel = t('profiles.preferredModel.title');
    const preferredModel = useExactModelChoice({
        agentTargetKey: props.preferredAgentTargetKey ?? null,
        agentId: selectedEntry?.builtInAgentId ?? selectedEntry?.catalogAgentId ?? null,
        machineId: props.machineId,
        serverId: props.serverId,
        selected: props.preferredModelSelection?.ref ?? null,
        title: preferredModelFieldLabel,
        fallbackLabel: t('profiles.preferredModel.none'),
    });
    const preferredModelPresentation = preferredModel.presentation;
    const onPreferredModelChange = props.onPreferredModelChange;
    const openModelPicker = React.useCallback(() => preferredModel.open((ref) => onPreferredModelChange(ref ? {
        v: 1,
        updatedAt: Date.now(),
        ref,
    } : undefined)), [onPreferredModelChange, preferredModel.open]);
    const permissionEntries = React.useMemo(() => {
        return props.entries.flatMap((entry) => {
            const agentId = entry.builtInAgentId ?? entry.catalogAgentId ?? entry.agentId;
            const options = getPermissionModeOptionsForAgentType(agentId);
            return options.length > 0 ? [{ entry, agentId, options }] : [];
        });
    }, [props.entries]);

    return <>
        <ItemGroup title={t('profiles.sessionStart.title')} description={t('profiles.sessionStart.description')}>
            <ProfilePreferredAgentField
                entries={props.entries}
                preferredAgentTargetKey={props.preferredAgentTargetKey}
                onChange={next => {
                    props.onPreferredAgentChange(next);
                    if (next !== props.preferredModelSelection?.ref.agentTargetKey) props.onPreferredModelChange(undefined);
                }}
            />
            <Item
                title={preferredModelFieldLabel}
                subtitle={props.preferredAgentTargetKey ? preferredModelPresentation.subtitle : t('profilesPage.modelRequiresAgent')}
                detail={preferredModelPresentation.detail}
                accessibilityLabel={props.preferredAgentTargetKey ? preferredModelPresentation.accessibilityLabel : `${preferredModelFieldLabel}. ${t('profilesPage.modelRequiresAgent')}`}
                disabled={!props.preferredAgentTargetKey}
                loading={preferredModel.loading}
                onPress={openModelPicker}
            />
            {preferredModel.error ? (
                <ProviderErrorItems error={preferredModel.error} retry={preferredModel.refresh} />
            ) : null}
            {props.children}
        {permissionEntries.length > 0 ? (
            <CountedDisclosureItem
                testID="profile-routing.permissions"
                title={t('profiles.defaultPermissions.title')}
                subtitle={summarizeChanged(permissionEntries
                    .filter(({ entry }) => props.defaultPermissionModeByTargetKey[resolveProfileBackendTargetKeyForEntry(entry)] != null)
                    .map(({ entry }) => entry.title))}
                showDivider
            >
            {permissionEntries.map(({ entry, agentId, options }) => {
                const targetKey = resolveProfileBackendTargetKeyForEntry(entry);
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
                        icon: <AgentIcon agentId={agentId} size={22} />,
                        subtitle: selected ? getPermissionModeLabelForAgentType(agentId, selected as PermissionMode) : t('profiles.defaultPermissions.useAccountDefault'),
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                    }}
                    items={[
                        { id: '__account__', title: t('profiles.defaultPermissions.useAccountDefault') },
                        ...options.map((option) => ({
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
            </CountedDisclosureItem>
        ) : null}
            <CountedDisclosureItem
                testID="profile-routing.storage"
                title={t('profiles.defaultStorage.title')}
                subtitle={summarizeChanged(props.entries
                    .filter((entry) => props.defaultPersistenceModeByTargetKey[resolveProfileBackendTargetKeyForEntry(entry)] != null)
                    .map((entry) => entry.title))}
            >
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
                        icon: <AgentIcon agentId={entry.builtInAgentId ?? entry.catalogAgentId ?? entry.agentId} size={22} />,
                        subtitle: selected ? t(`sessionsList.storage${selected === 'direct' ? 'Direct' : 'Persisted'}Tab`) : t('profiles.defaultStorage.useAccountDefault'),
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
            </CountedDisclosureItem>
        </ItemGroup>
    </>;
}

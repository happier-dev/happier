import * as React from 'react';
import type { SessionFolderWorkspaceRefV1 } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { EMPTY_MACHINE_AGENTS } from '@/agents/machineAgents/machineAgentInventoryStore';
import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { buildSessionTagsMenuContent } from '@/components/sessions/organization/SessionTagsMenuContent';
import {
    SESSION_FOLDER_SELECTION_ROOT_ID,
    buildSessionFolderSelectionOptions,
    resolveSessionFolderSelectionLabel,
    type SessionFolderSelectionTarget,
} from '@/components/sessions/organization/sessionFolderSelectionOptions';
import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Typography } from '@/constants/Typography';
import { buildSessionFolderWorkspaceTargets, selectAvailableSessionFolders } from '@/sync/domains/session/folders';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationTagLabelById } from '@/sync/domains/session/organization/tagLabels';
import { useAllMachines, useSessionOrganizationProjection, useSetting } from '@/sync/store/hooks';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { t } from '@/text';

import { selectEmbedAgentOptions } from '../embedAgentOptions';
import { setEmbedNewChat, setEmbedSessions } from '../embedDraft';
import { EMBED_SETTINGS } from '../embedsSettings';
import type { EmbedDraftSectionProps } from './EmbedAccessSections';

type OrganizationContext = Readonly<{ serverId: string | null }>;

/**
 * The folders an embed can use. With session creation on, only folders of that computer's Chats
 * (the organization owner's `managedSessions` scope, 03 U5), because every created session lands
 * there; with creation off the folder is only a listing filter, so any folder of the Home.
 */
function resolveEmbedFolderTargets(
    projection: ReturnType<typeof useSessionOrganizationProjection>,
    serverId: string | null,
    machineId: string | null,
): readonly SessionFolderSelectionTarget[] {
    const viewState = buildSessionOrganizationListViewState({ serverId: serverId ?? '', projection });
    const available = selectAvailableSessionFolders(viewState.sessionFoldersV1);
    if (serverId && machineId) {
        const workspace: SessionFolderWorkspaceRefV1 = { t: 'managedSessions', serverId, machineId };
        return buildSessionFolderWorkspaceTargets({ folders: available, workspace });
    }
    return available.folders.map((folder) => ({ folderId: folder.id, title: folder.name, depth: 0 }));
}

function useEmbedFolderTargets(props: OrganizationContext & Readonly<{ machineId: string | null }>): readonly SessionFolderSelectionTarget[] {
    const projection = useSessionOrganizationProjection(props.serverId);
    return React.useMemo(
        () => resolveEmbedFolderTargets(projection, props.serverId, props.machineId),
        [projection, props.machineId, props.serverId],
    );
}

/**
 * A creation change (on, off, another computer) re-decides which folders are eligible; a folder the
 * new scope does not offer is dropped rather than carried into `grant.create.placement`.
 */
function withEligibleEmbedFolder(
    draft: EmbedDraftSectionProps['draft'],
    projection: ReturnType<typeof useSessionOrganizationProjection>,
    serverId: string | null,
): EmbedDraftSectionProps['draft'] {
    const folderId = draft.config.organization.folderId;
    if (folderId === null) return draft;
    const targets = resolveEmbedFolderTargets(projection, serverId, draft.access.create?.machineId ?? null);
    if (targets.some((target) => target.folderId === folderId)) return draft;
    // The creation placement is derived from the organization when the grant is built.
    return { ...draft, config: { ...draft.config, organization: { ...draft.config.organization, folderId: null } } };
}

/** Organization: the folder and tags the host lists by, and where new sessions land (plan 04 §6.2). */
export const EmbedOrganizationSection = React.memo(function EmbedOrganizationSection(props: EmbedDraftSectionProps & OrganizationContext) {
    const { theme } = useUnistyles();
    const { draft, onChange } = props;
    const [folderOpen, setFolderOpen] = React.useState(false);
    const [tagsOpen, setTagsOpen] = React.useState(false);
    const organization = draft.config.organization;
    const folderTargets = useEmbedFolderTargets({ serverId: props.serverId, machineId: draft.access.create?.machineId ?? null });
    const projection = useSessionOrganizationProjection(props.serverId);
    const tags = React.useMemo(() => Object.entries(buildSessionOrganizationTagLabelById(projection?.tagsById ?? {}))
        .map(([id, label]) => ({ id, label })), [projection]);

    const setOrganization = (next: typeof organization) => {
        // The creation placement is derived from the organization when the grant is built.
        onChange({ ...draft, config: { ...draft.config, organization: next } });
    };
    const tagContent = buildSessionTagsMenuContent({
        tags,
        selectedTagIds: organization.tagIds,
        iconColor: theme.colors.text.secondary,
        onToggle: (tagId) => setOrganization({
            ...organization,
            tagIds: organization.tagIds.includes(tagId)
                ? organization.tagIds.filter((candidate) => candidate !== tagId)
                : [...organization.tagIds, tagId],
        }),
    });
    const tagSummary = organization.tagIds.length === 0
        ? t('settingsEmbeds.organization.none')
        : organization.tagIds.map((id) => tags.find((tag) => tag.id === id)?.label ?? t('common.unavailable')).join(', ');

    return (
        <ItemGroup title={t('settingsEmbeds.organization.title')} description={t('settingsEmbeds.organization.description')}>
            <SettingAnchor setting={EMBED_SETTINGS.settings.folder}>
                <DropdownMenu
                    testID="settings-embed-folder"
                    open={folderOpen}
                    onOpenChange={(next) => setFolderOpen(props.disabled ? false : next)}
                    selectedId={organization.folderId ?? SESSION_FOLDER_SELECTION_ROOT_ID}
                    items={buildSessionFolderSelectionOptions(folderTargets).map((option) => ({ id: option.id, title: option.label }))}
                    onSelect={(id) => {
                        setFolderOpen(false);
                        setOrganization({ ...organization, folderId: id === SESSION_FOLDER_SELECTION_ROOT_ID ? null : id });
                    }}
                    itemTrigger={{
                        title: t('settingsEmbeds.organization.folder'),
                        detailFormatter: () => resolveSessionFolderSelectionLabel(organization.folderId, folderTargets),
                        itemProps: { disabled: props.disabled, testID: 'settings-embed-folder-trigger' },
                    }}
                />
            </SettingAnchor>
            <SettingAnchor setting={EMBED_SETTINGS.settings.tags}>
                <DropdownMenu
                    testID="settings-embed-tags"
                    open={tagsOpen}
                    onOpenChange={(next) => setTagsOpen(props.disabled ? false : next)}
                    items={tagContent.dropdownItems}
                    closeOnSelect={false}
                    search
                    onSelect={tagContent.dropdownOnSelect}
                    itemTrigger={{
                        title: t('settingsEmbeds.organization.tags'),
                        detailFormatter: () => tagSummary,
                        itemProps: { disabled: props.disabled, testID: 'settings-embed-tags-trigger' },
                    }}
                />
            </SettingAnchor>
        </ItemGroup>
    );
});

/**
 * The agents a creation grant can bind (`grant.create.agentTargetKey`): the backend catalog owner's
 * enabled agents, narrowed to what that computer reports installed (the machine agent inventory).
 */
function useEmbedAgentOptions(input: Readonly<{ serverId: string | null; machineId: string | null; selectedAgentTargetKey: string | null; refresh: boolean }>) {
    const { snapshot: acpCatalog } = useAcpCatalogForServer(input.serverId);
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const inventories = useMachineAgentsByMachine({
        serverId: input.serverId ?? '',
        machineIds: input.serverId && input.machineId ? [input.machineId] : [],
        load: input.refresh,
    });
    const inventory = (input.machineId ? inventories.get(input.machineId) : undefined) ?? EMPTY_MACHINE_AGENTS;
    const entries = React.useMemo(() => getResolvedBackendCatalogEntries({
        enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
        acpCatalogSnapshot: acpCatalog?.catalog,
        backendEnabledByTargetKey,
    }), [acpCatalog, backendEnabledByTargetKey, input.serverId]);
    return React.useMemo(
        () => selectEmbedAgentOptions(entries, inventory, input.selectedAgentTargetKey),
        [entries, input.selectedAgentTargetKey, inventory],
    );
}

/**
 * Sessions (enforced): whether this key can create sessions, and the computer and agent every
 * creation must use. "Start new chats in the embed" is the host's choice under it.
 */
export const EmbedSessionsSection = React.memo(function EmbedSessionsSection(props: EmbedDraftSectionProps & OrganizationContext) {
    const { theme } = useUnistyles();
    const { draft, onChange } = props;
    const machines = useAllMachines();
    const create = draft.access.create;
    // Creation binds the computer first; turning it on starts from the active computer.
    const defaultMachine = machines.find((candidate) => candidate.active) ?? machines[0] ?? null;
    const agents = useEmbedAgentOptions({
        serverId: props.serverId,
        machineId: create?.machineId ?? defaultMachine?.id ?? null,
        selectedAgentTargetKey: create?.agentTargetKey ?? null,
        // Ask the computer only once creation is bound to it; otherwise read what is already known.
        refresh: create !== null,
    });
    const projection = useSessionOrganizationProjection(props.serverId);
    const [agentOpen, setAgentOpen] = React.useState(false);
    const changeCreation = (binding: Parameters<typeof setEmbedSessions>[1]) => {
        onChange(withEligibleEmbedFolder(setEmbedSessions(draft, binding), projection, props.serverId));
    };
    const selectedMachine = create ? machines.find((machine) => machine.id === create.machineId) ?? null : null;
    const selectedAgent = create ? agents.find((entry) => entry.backendTargetKey === create.agentTargetKey) ?? null : null;

    const enable = (on: boolean) => {
        if (!on) {
            changeCreation(null);
            return;
        }
        const agent = agents[0];
        if (!defaultMachine || !agent) return;
        changeCreation({ machineId: defaultMachine.id, agentTargetKey: agent.backendTargetKey });
    };

    return (
        <ItemGroup
            title={t('settingsEmbeds.sessions.title')}
            description={create ? t('settingsEmbeds.sessions.description') : undefined}
        >
            <SettingRow
                setting={EMBED_SETTINGS.settings.createSessions}
                testID="settings-embed-sessions"
                subtitle={create ? undefined : t('settingsEmbeds.sessions.offConsequence')}
                subtitleLines={0}
                showChevron={false}
                rightElement={(
                    <Switch
                        testID="settings-embed-sessions-switch"
                        accessibilityLabel={t('settingsEmbeds.sessions.allow')}
                        value={create !== null}
                        disabled={props.disabled || (create === null && (machines.length === 0 || agents.length === 0))}
                        onValueChange={enable}
                    />
                )}
            />
            {create ? (
                <>
                    <MachineSelector
                        presentation="dropdown"
                        machines={machines}
                        selectedMachine={selectedMachine}
                        serverId={props.serverId}
                        dropdownTitle={t('settingsEmbeds.sessions.computer')}
                        dropdownTestID="settings-embed-computer"
                        includeSelectedUnavailableMachine
                        onSelect={(machine) => changeCreation({ machineId: machine.id, agentTargetKey: create.agentTargetKey })}
                    />
                    <DropdownMenu
                        testID="settings-embed-agent"
                        open={agentOpen}
                        onOpenChange={(next) => setAgentOpen(props.disabled ? false : next)}
                        selectedId={create.agentTargetKey}
                        items={agents.map((entry) => ({
                            id: entry.backendTargetKey,
                            title: entry.agentCatalogEntry.title,
                            icon: <AgentCatalogIdentityIcon entry={entry.agentCatalogEntry} machineId={create.machineId} serverId={props.serverId} current={false} size={18} />,
                        }))}
                        onSelect={(agentTargetKey) => {
                            if (props.disabled || !agents.some(entry => entry.backendTargetKey === agentTargetKey)) return;
                            setAgentOpen(false);
                            onChange(setEmbedSessions(draft, { machineId: create.machineId, agentTargetKey }));
                        }}
                        itemTrigger={{
                            title: t('settingsEmbeds.sessions.agent'),
                            icon: selectedAgent ? <AgentCatalogIdentityIcon entry={selectedAgent.agentCatalogEntry} machineId={create.machineId} serverId={props.serverId} current={false} size={18} /> : undefined,
                            detailFormatter: () => selectedAgent?.agentCatalogEntry.title ?? t('common.unavailable'),
                            itemProps: { disabled: props.disabled, testID: 'settings-embed-agent-trigger' },
                        }}
                    />
                    <Item
                        title={t('settingsEmbeds.sessions.appSetting')}
                        mode="info"
                        density="compact"
                        showChevron={false}
                        titleStyle={{ ...Typography.rowMeta(), color: theme.colors.text.secondary }}
                    />
                    <SettingRow
                        setting={EMBED_SETTINGS.settings.newChat}
                        testID="settings-embed-new-chat"
                        subtitleLines={0}
                        showChevron={false}
                        rightElement={(
                            <Switch
                                testID="settings-embed-new-chat-switch"
                                accessibilityLabel={t('settingsEmbeds.sessions.newChat')}
                                value={draft.config.newChat?.enabled === true}
                                disabled={props.disabled}
                                onValueChange={(enabled) => onChange(setEmbedNewChat(draft, enabled))}
                            />
                        )}
                    />
                </>
            ) : null}
        </ItemGroup>
    );
});

import * as React from 'react';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { ScrollView, View } from 'react-native';

import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { buildSessionConfigOptionOverridesFromServerStart } from '@happier-dev/protocol/workflows/workflowSessionAuthoringV1';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { useAllMachines, useMachineListByServerId, useMachineListStatusByServerId } from '@/sync/domains/state/storage';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { SessionAuthoringControls } from '@/components/sessions/authoring/controls/SessionAuthoringControls';
import { useSessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/useSessionAuthoringControlFacts';
import type {
    SessionAuthoringAgentTargetOption,
    SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useNewSessionOrganizationPlacement } from '@/components/sessions/new/organization/useNewSessionOrganizationPlacement';
import {
    SESSION_FOLDER_SELECTION_ROOT_ID,
    buildSessionFolderSelectionOptions,
    resolveSessionFolderSelectionLabel,
} from '@/components/sessions/organization/sessionFolderSelectionOptions';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { machineMetadataPlatformToTarget } from '@/utils/path/machinePlatform';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import {
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
    applySessionServerStartSpawnDraftEdits,
    type SessionServerStartSpawnDraftEdits,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { PathSelectionList } from '@/components/sessions/new/components/PathSelectionList';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type {
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';
import {
    findSessionServerStartCandidateForDirectory,
    resolveSessionServerStartCandidateSelection,
} from './serverStartDraftCandidateSelection';
import { useSessionPlacementCandidateRows } from './useSessionPlacementCandidateRows';

type Props = CustomModalInjectedProps & Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    onResolve: (draft: SessionServerStartSpawnDraftV1 | null) => void;
}>;

/** The recipe fields this composer edits through the Session-owned authoring controls, in reading order. */
const AGENT_FIELDS: readonly SessionAuthoringFieldId[] = [
    'agentTarget', 'modelSelection', 'acpSessionModeId', 'sessionConfigOptionOverrides', 'permissionMode', 'profileId',
];
const TOOL_FIELDS: readonly SessionAuthoringFieldId[] = [
    'capabilitySelection', 'connectedServices', 'unlistedTools', 'allowedTools',
];

function resolveInitialAgentTarget(params: Readonly<{
    targets: readonly SessionAuthoringAgentTargetOption[];
    seedAgentId?: string;
}>): SessionAuthoringAgentTargetOption | null {
    return params.targets.find((option) => option.agentId === params.seedAgentId)
        ?? params.targets.find((option) => option.agentId === DEFAULT_AGENT_ID)
        ?? params.targets[0]
        ?? null;
}

/** The edited recipe as the Session-authoring selection the shared controls read. */
function selectionFromDraft(draft: SessionServerStartSpawnDraftV1): WorkflowSessionAuthoringSelection {
    return {
        agentTarget: draft.agentTarget,
        modelSelection: draft.modelSelection ?? null,
        ...(draft.profileId ? { profileId: draft.profileId } : {}),
        permissionMode: draft.permissionMode,
        acpSessionModeId: draft.agentModeId ?? null,
        ...(draft.configuration ? { sessionConfigOptionOverrides: buildSessionConfigOptionOverridesFromServerStart(draft.configuration) } : {}),
        ...(draft.capabilitySelection ? { capabilitySelection: draft.capabilitySelection } : {}),
        ...(draft.connectedServices ? { connectedServices: draft.connectedServices } : {}),
        ...(draft.allowedTools ? { allowedTools: draft.allowedTools } : {}),
        ...(draft.unlistedTools ? { unlistedTools: draft.unlistedTools } : {}),
    } as WorkflowSessionAuthoringSelection;
}

/**
 * Session-owned, transient authoring surface for the one literal host action.
 * It intentionally contains no persisted-draft, secret, Action, or Session
 * creation path: it merely projects current New Session fields into a strict
 * server-start draft for the caller that already owns the eventual effect.
 *
 * Every Agent, model, mode, configuration, permission, profile, MCP, Connected
 * Service and tool-policy row is the shared Session-authoring control the
 * Workflow editor uses; the folder is New Session's own placement owner. A
 * retained recipe keeps every field the reader did not change.
 */
export function SessionServerStartDraftComposerModal(props: Props): React.ReactElement {
    const existingDraft = props.seed.existingDraft;
    const seededDirectory = props.seed.directory ?? (existingDraft?.directory.kind === 'path' ? existingDraft.directory.path : undefined);
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const activeServer = useActiveServerSnapshot();
    const placementRows = useSessionPlacementCandidateRows(props.seed.candidates);
    const initialCandidateIndex = seededDirectory === undefined
        ? -1
        : props.seed.candidates?.findIndex((candidate) => (
            candidate.serverId === props.target.serverId
            && candidate.machineId === props.target.machineId
            && candidate.rootPath === seededDirectory
        )) ?? -1;
    const [selectedCandidateIndex, setSelectedCandidateIndex] = React.useState(initialCandidateIndex);
    const selectedPlacementCandidate = selectedCandidateIndex < 0
        ? undefined
        : props.seed.candidates?.[selectedCandidateIndex];
    const { binding } = useServerCredentialAccountScopeBinding(selectedPlacementCandidate?.serverId ?? props.target.serverId);
    const accountScope = binding?.isCurrent() ? binding.scope : null;
    const reachabilityRevision = useMachineReachabilityRevision();
    const selectedPlacement = React.useMemo(() => resolveSessionServerStartCandidateSelection({
        accountScope,
        mountedTarget: props.target,
        selectedCandidate: selectedPlacementCandidate,
        activeServerId: String(activeServer.serverId ?? ''),
        activeMachines: machines,
        machineListByServerId,
        machineListStatusByServerId,
    }), [activeServer.serverId, machineListByServerId, machineListStatusByServerId, machines, props.target, selectedPlacementCandidate, accountScope, reachabilityRevision]);
    const selectedTarget = selectedPlacement.target;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: selectedTarget.machineId,
        serverId: selectedTarget.serverId,
        enabled: true,
        staleMs: 0,
    });
    const machine = selectedPlacement.machine;
    const [directory, setDirectory] = React.useState(() => (
        seededDirectory ?? selectedPlacement.directory ?? machine?.metadata?.homeDir ?? ''
    ));
    const [directoryEdited, setDirectoryEdited] = React.useState(false);
    // A row reads as selected only while the working directory is that checkout; the chosen Machine and Home outlive it.
    const directoryCandidateIndex = findSessionServerStartCandidateForDirectory({
        candidates: props.seed.candidates, target: selectedTarget, directory,
    });
    const [error, setError] = React.useState(false);
    const facts = useSessionAuthoringControlFacts({
        machineId: selectedTarget.machineId,
        serverId: selectedTarget.serverId,
        directory: directory.trim() || null,
    });
    const agentTargets = facts.agentTargets ?? [];
    const [selection, setSelection] = React.useState<WorkflowSessionAuthoringSelection>(() => (
        existingDraft
            ? selectionFromDraft(existingDraft)
            : { permissionMode: props.seed.permissionMode ?? 'default', ...(props.seed.profileId ? { profileId: props.seed.profileId } : {}) } as WorkflowSessionAuthoringSelection
    ));
    const [edited, setEdited] = React.useState<ReadonlySet<SessionAuthoringFieldId>>(() => new Set());
    // A new recipe starts on the seeded Agent (or the default) once this Machine lists its Agents.
    React.useEffect(() => {
        if (selection.agentTarget || agentTargets.length === 0) return;
        const initial = resolveInitialAgentTarget({ targets: agentTargets, seedAgentId: props.seed.agentId });
        if (initial) setSelection((current) => current.agentTarget ? current : { ...current, agentTarget: initial.target });
    }, [agentTargets, props.seed.agentId, selection.agentTarget]);
    const changeFields = React.useCallback((fields: Partial<WorkflowSessionAuthoringSelection>) => {
        setError(false);
        setSelection((current) => ({ ...current, ...fields }) as WorkflowSessionAuthoringSelection);
        setEdited((current) => new Set([...current, ...(Object.keys(fields) as SessionAuthoringFieldId[])]));
    }, []);
    const changeField = React.useCallback((field: SessionAuthoringFieldId, value: unknown) => {
        changeFields({ [field]: value } as Partial<WorkflowSessionAuthoringSelection>);
    }, [changeFields]);
    const organizationScopeEdited = !existingDraft || directoryEdited
        || selectedTarget.serverId !== existingDraft.executionTarget.serverId
        || selectedTarget.machineId !== existingDraft.executionTarget.machineId;
    const organization = useNewSessionOrganizationPlacement({
        executionTarget: selectedTarget,
        directory: directory.trim(),
        directoryKind: !directoryEdited && existingDraft?.directory.kind === 'managed' ? 'managed' : 'path',
        initialPlacement: existingDraft?.organizationPlacement ?? null,
        reconcileWorkspace: organizationScopeEdited,
    });
    const [folderMenuOpen, setFolderMenuOpen] = React.useState(false);
    const folderOptions = React.useMemo(() => buildSessionFolderSelectionOptions(organization.folderTargets), [organization.folderTargets]);
    // A saved Folder stays visible even while its choices are cold or the feature is off: the recipe
    // keeps it, and it must never read as the workspace root. Choosing (or removing it) needs the feature.
    const retainedFolderId = organization.placement.folderId;
    const folderChoosable = organization.enabled && (retainedFolderId !== null || organization.folderTargets.length > 0);
    const showFolder = retainedFolderId !== null || folderChoosable;
    const folderResolved = retainedFolderId === null
        || organization.folderTargets.some((folder) => folder.folderId === retainedFolderId);

    React.useEffect(() => {
        if (!directory.trim() && (props.seed.directory ?? machine?.metadata?.homeDir)) {
            setDirectory(props.seed.directory ?? machine?.metadata?.homeDir ?? '');
        }
    }, [directory, machine?.metadata?.homeDir, props.seed.directory]);

    const canSubmit = selectedPlacement.machineReady
        && daemonMergedProjection.phase === 'ready'
        && selection.agentTarget != null
        // This surface only authors a recipe. Keeping an unchanged placement does
        // not invoke the feature-gated Session creation path.
        && (organization.valid || (!organization.enabled && !organizationScopeEdited))
        && (directory.trim().length > 0 || (!directoryEdited && existingDraft?.directory.kind === 'managed'));
    const dismiss = React.useCallback(() => {
        props.onResolve(null);
        props.onClose();
    }, [props]);
    const submit = React.useCallback(() => {
        const agentTarget = selection.agentTarget;
        if (!agentTarget || !canSubmit) return;
        try {
            const now = Date.now();
            const permissionMode = isPermissionMode(selection.permissionMode)
                ? selection.permissionMode
                : props.seed.permissionMode ?? existingDraft?.permissionMode ?? 'default';
            const authoringDraft = existingDraft ? null : buildNewSessionAuthoringDraftFromResolvedInputs({
                executionTarget: { kind: 'machine', target: selectedTarget },
                directory: directory.trim(),
                checkoutCreationDraft: null,
                prompt: '',
                displayText: '',
                agentTarget,
                transcriptStorage: null,
                profileId: props.seed.profileId ?? null,
                environmentVariables: null,
                resumeSessionId: null,
                permissionMode,
                permissionModeUpdatedAt: now,
                modelSelection: null,
                capabilitySelection: null,
                connectedServices: null,
                terminal: null,
                windowsRemoteSessionLaunchMode: null,
                windowsRemoteSessionConsole: null,
                windowsTerminalWindowName: null,
                runtimeDescriptorV1: null,
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                automation: null,
            });
            const draft = existingDraft ?? buildSessionServerStartSpawnDraftV1FromAuthoringDraft({
                draft: authoringDraft!,
                permissionMode,
                configurationUpdatedAtMs: now,
            });
            // Only what the reader changed is written; every other recipe field is kept as authored.
            const changed = (field: SessionAuthoringFieldId) => !existingDraft || edited.has(field);
            props.onResolve(applySessionServerStartSpawnDraftEdits({
                draft,
                edits: {
                    executionTarget: selectedTarget,
                    agentTarget,
                    ...(directoryEdited || !existingDraft ? { directory: { kind: 'path', path: directory.trim() } } : {}),
                    permissionMode,
                    ...(changed('modelSelection') ? { modelSelection: selection.modelSelection ?? undefined } : {}),
                    ...(changed('profileId') ? { profileId: selection.profileId ?? undefined } : {}),
                    ...(changed('acpSessionModeId') ? { agentModeId: selection.acpSessionModeId ?? undefined } : {}),
                    ...(changed('capabilitySelection') ? { capabilitySelection: selection.capabilitySelection ?? undefined } : {}),
                    ...(changed('connectedServices') ? { connectedServices: selection.connectedServices ?? undefined } : {}),
                    ...(changed('allowedTools') ? { allowedTools: selection.allowedTools } : {}),
                    ...(changed('unlistedTools') ? { unlistedTools: selection.unlistedTools } : {}),
                    ...(edited.has('sessionConfigOptionOverrides') ? {
                        sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides,
                    } : {}),
                    organizationPlacement: organization.placement,
                } as SessionServerStartSpawnDraftEdits,
                configurationUpdatedAtMs: now,
            }));
            props.onClose();
        } catch {
            setError(true);
        }
    }, [canSubmit, directory, directoryEdited, edited, existingDraft, organization.placement, props, selectedTarget, selection]);
    const footer = React.useMemo(() => (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <RoundButton title={t('common.cancel')} display="inverted" onPress={dismiss} />
            <RoundButton title={t('newSession.recipeComposerSubmit')} onPress={submit} disabled={!canSubmit} />
        </View>
    ), [canSubmit, dismiss, submit]);
    useModalCardChrome(props.setChrome, {
        kind: 'card',
        // This surface only authors a recipe another owner runs later; it never starts a Session.
        title: t('newSession.recipeComposerTitle'),
        footer,
        dimensions: { size: 'md', maxHeightRatio: 0.88 },
        scrollHost: 'body',
    });
    const agentsReady = daemonMergedProjection.phase === 'ready' && agentTargets.length > 0;

    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 16 }}>
            {/* Where the recipe runs and where its sessions are listed. A placement candidate below may move it to another Machine. */}
            <ItemGroup>
                <Item
                    testID="server-start-draft-machine"
                    title={t('newSession.recipeComposerMachine')}
                    detail={machine ? getMachineDisplayName(machine) : t('common.unavailable')}
                    {...(selectedPlacement.machineReady ? {} : { subtitle: t('newSession.recipeComposerMachineNotReady'), subtitleLines: 0 })}
                    showChevron={false}
                />
                {showFolder && folderChoosable ? (
                    <DropdownMenu
                        testID="server-start-draft-folder"
                        open={folderMenuOpen}
                        onOpenChange={setFolderMenuOpen}
                        selectedId={organization.placement.folderId ?? SESSION_FOLDER_SELECTION_ROOT_ID}
                        itemTrigger={{
                            title: t('settingsSession.sessionPlacement.title'),
                            detailFormatter: () => resolveSessionFolderSelectionLabel(retainedFolderId, organization.folderTargets),
                            subtitleFormatter: () => folderResolved
                                ? t('settingsSession.sessionPlacement.description')
                                : t('newSession.recipeComposerFolderRetained'),
                            // The reason a Folder is kept reads in full, not cut beside its value.
                            itemProps: { subtitleLines: 0 },
                        }}
                        items={folderOptions.map((option) => ({ id: option.id, title: option.label }))}
                        onSelect={(id) => {
                            setFolderMenuOpen(false);
                            organization.setFolderId(folderOptions.find((option) => option.id === id)?.folderId ?? null);
                        }}
                    />
                ) : showFolder ? (
                    <Item
                        testID="server-start-draft-folder"
                        title={t('settingsSession.sessionPlacement.title')}
                        detail={resolveSessionFolderSelectionLabel(retainedFolderId, organization.folderTargets)}
                        subtitle={t('newSession.recipeComposerFolderRetained')}
                        subtitleLines={0}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            <ItemGroup title={t('newSession.recipeComposerDirectory')}>
                {placementRows.map(({ candidate, index, title, subtitle }) => (
                    <Item
                        key={'id' in candidate.projectKey
                            ? candidate.projectKey.id
                            : `${candidate.serverId}:${candidate.machineId}:${candidate.rootPath}`}
                        title={title}
                        subtitle={subtitle}
                        subtitleLines={2}
                        selected={index === directoryCandidateIndex}
                        onPress={() => {
                            setError(false);
                            setSelectedCandidateIndex(index);
                            setDirectory(candidate.rootPath);
                            setDirectoryEdited(true);
                        }}
                        showChevron={false}
                        showDivider={true}
                    />
                ))}
                <PathSelectionList
                    initialValue={directory}
                    machineHomeDir={machine?.metadata?.homeDir ?? '/home'}
                    favorites={[]}
                    recents={[]}
                    machineId={machine?.id ?? null}
                    serverId={selectedTarget.serverId}
                    machinePlatform={machineMetadataPlatformToTarget(machine?.metadata?.platform)}
                    onCommit={(value) => {
                        setError(false);
                        setDirectory(value);
                        setDirectoryEdited(true);
                    }}
                    onChangeDraftPath={(value) => {
                        setError(false);
                        setDirectory(value);
                        setDirectoryEdited(true);
                    }}
                    onRequestClose={() => undefined}
                    maxHeight={300}
                />
            </ItemGroup>
            <ItemGroup title={t('newSession.selectAiBackendTitle')}>
                {agentsReady ? (
                    <SessionAuthoringControls
                        presentation="fields"
                        fields={AGENT_FIELDS}
                        values={selection}
                        facts={facts}
                        onChangeFields={changeFields}
                        onChangeField={changeField}
                        testIDPrefix="server-start-draft-control"
                    />
                ) : daemonMergedProjection.phase === 'idle' || daemonMergedProjection.phase === 'loading'
                    || (daemonMergedProjection.phase === 'ready' && facts.agentTargets === undefined) ? (
                    <ItemLoadStateRows state={{ kind: 'loading' }} rows={2} lines={1} accessibilityLabel={t('common.loading')} />
                ) : daemonMergedProjection.phase !== 'ready' ? (
                    // The machine answered that it cannot list its agents (`unsupported`), or it did not answer.
                    <ItemLoadStateRows state={{
                        kind: 'failed',
                        reason: daemonMergedProjection.phase === 'unsupported'
                            ? t('newSession.actionMethodUnavailable')
                            : t('errors.daemonUnavailableBody'),
                    }} />
                ) : (
                    <Item
                        title={t('newSession.failedToStart')}
                        mode="info"
                        showChevron={false}
                    />
                )}
            </ItemGroup>
            {agentsReady ? (
                <ItemGroup
                    title={t('settingsSession.toolPolicy.sectionTitle')}
                    description={t('settingsSession.toolPolicy.sectionDescription')}
                >
                    <SessionAuthoringControls
                        presentation="fields"
                        fields={TOOL_FIELDS}
                        values={selection}
                        facts={facts}
                        onChangeField={changeField}
                        testIDPrefix="server-start-draft-control"
                    />
                </ItemGroup>
            ) : null}
            {error ? (
                <Text accessibilityLiveRegion="polite" style={{ marginHorizontal: 24, marginTop: 12 }}>
                    {t('newSession.failedToStart')}
                </Text>
            ) : null}
        </ScrollView>
    );
}

import * as React from 'react';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';

import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { buildSessionConfigOptionOverridesFromServerStart } from '@happier-dev/protocol/workflows/workflowSessionAuthoringV1';

import { useMachineListStatusByServerId, useActiveMachineFacts, useMachineListByServerId } from '@/sync/domains/state/storage';
import { useSessionPlacementCandidateRows } from './useSessionPlacementCandidateRows';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';
import { useSessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/useSessionAuthoringControlFacts';
import type {
    SessionAuthoringAgentTargetOption,
    SessionAuthoringFieldId,
} from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useNewSessionOrganizationPlacement } from '@/components/sessions/new/organization/useNewSessionOrganizationPlacement';
import {
    buildSessionFolderSelectionOptions,
} from '@/components/sessions/organization/sessionFolderSelectionOptions';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    buildNewSessionAuthoringDraftFromResolvedInputs,
    buildSessionServerStartSpawnDraftV1FromAuthoringDraft,
    applySessionServerStartSpawnDraftEdits,
    type SessionServerStartSpawnDraftEdits,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';

import type {
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';
import {
    findSessionServerStartCandidateForDirectory,
    resolveSessionServerStartCandidateSelection,
} from './serverStartDraftCandidateSelection';

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

/** One recipe model for default selection, inline Change and the returning selector. It never starts a Session. */
export function useSessionServerStartDraftRecipe(props: Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
}>) {
    const existingDraft = props.seed.existingDraft;
    const seededDirectoryIntent = props.seed.directoryIntent
        ?? (props.seed.directory ? { kind: 'path' as const, path: props.seed.directory } : existingDraft?.directory);
    const seededDirectory = seededDirectoryIntent?.kind === 'path' ? seededDirectoryIntent.path : undefined;
    const machines = useActiveMachineFacts();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const activeServer = useActiveServerSnapshot();
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
        // Readers use only the fresh answer's phase; no catalogue body is read.
        sections: [],
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
    const noFolderSelected = !directoryEdited && seededDirectoryIntent?.kind === 'managed';
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
    const organizationScopeEdited = !existingDraft
        || !areServerProfileIdentifiersEquivalent(selectedTarget.serverId, existingDraft.executionTarget.serverId);
    const organization = useNewSessionOrganizationPlacement({
        serverId: selectedTarget.serverId,
        executionTarget: selectedTarget,
        directory: directory.trim(),
        directoryKind: noFolderSelected ? 'managed' : 'path',
        initialPlacement: existingDraft?.organizationPlacement ?? null,
        initialPlacementServerId: existingDraft?.executionTarget.serverId,
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
        && (organization.valid || !organizationScopeEdited)
        && (directory.trim().length > 0 || noFolderSelected);
    const resolveDraft = React.useCallback((): SessionServerStartSpawnDraftV1 | null => {
        const agentTarget = selection.agentTarget;
        if (!agentTarget || !canSubmit) return null;
        try {
            const now = Date.now();
            const permissionMode = isPermissionMode(selection.permissionMode)
                ? selection.permissionMode
                : props.seed.permissionMode ?? existingDraft?.permissionMode ?? 'default';
            const authoringDraft = existingDraft ? null : buildNewSessionAuthoringDraftFromResolvedInputs({
                executionTarget: { kind: 'machine', target: selectedTarget },
                directory: directory.trim(),
                directoryKind: noFolderSelected ? 'managed' : 'path',
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
            return applySessionServerStartSpawnDraftEdits({
                draft,
                edits: {
                    executionTarget: selectedTarget,
                    agentTarget,
                    ...(directoryEdited || !existingDraft ? { directory: noFolderSelected
                        ? { kind: 'managed' } : { kind: 'path', path: directory.trim() } } : {}),
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
            });
        } catch {
            setError(true);
            return null;
        }
    }, [canSubmit, directory, directoryEdited, edited, existingDraft, noFolderSelected, organization.placement, props, selectedTarget, selection]);
    // The candidate this draft names stays drawn even when its Machine is no longer a launch choice.
    const placementRows = useSessionPlacementCandidateRows(props.seed.candidates, directoryCandidateIndex < 0 ? undefined : directoryCandidateIndex);
    return { canSubmit, resolveDraft, selectedTarget, selectedPlacement, machine, directory, noFolderSelected, setDirectory,
        setDirectoryEdited, directoryCandidateIndex, setSelectedCandidateIndex, error, setError, facts, agentTargets,
        selection, changeFields, changeField, organization, folderMenuOpen, setFolderMenuOpen, folderOptions,
        retainedFolderId, folderResolved, folderChoosable, showFolder, daemonMergedProjection,
        placementRows };
}

export type SessionServerStartDraftRecipe = ReturnType<typeof useSessionServerStartDraftRecipe>;

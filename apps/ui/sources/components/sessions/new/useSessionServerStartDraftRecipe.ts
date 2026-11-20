import * as React from 'react';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';

import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { WorkflowSessionAuthoringSelection, WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';
import { buildSessionConfigOptionOverridesFromServerStart } from '@happier-dev/protocol/workflows/workflowSessionAuthoringV1';

import { useServerScopedMachine } from '@/sync/store/hooks';
import { useSessionPlacementCandidateRows } from './useSessionPlacementCandidateRows';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useSessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/useSessionAuthoringControlFacts';
import { findSessionAuthoringAgentTargetOption, type SessionAuthoringFieldId } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { useNewSessionOrganizationPlacement } from '@/components/sessions/new/organization/useNewSessionOrganizationPlacement';
import {
    buildSessionFolderSelectionOptions,
} from '@/components/sessions/organization/sessionFolderSelectionOptions';
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
import { findSessionServerStartCandidateForDirectory } from './serverStartDraftCandidateSelection';


type RecipeSelection = WorkflowSessionAuthoringSelection & Pick<WorkflowStepExecutionSelection, 'teamCredentialBindings'>;

/** The edited recipe as the Session-authoring selection the shared controls read. */
function selectionFromDraft(draft: SessionServerStartSpawnDraftV1): RecipeSelection {
    return {
        agentTarget: draft.agentTarget,
        modelSelection: draft.modelSelection ?? null,
        ...(draft.teamCredentialBindings === undefined ? {} : { teamCredentialBindings: draft.teamCredentialBindings }),
        ...(draft.profileId ? { profileId: draft.profileId } : {}),
        ...(draft.approvalProfileId === undefined ? {} : { approvalProfileId: draft.approvalProfileId }),
        permissionMode: draft.permissionMode,
        acpSessionModeId: draft.agentModeId ?? null,
        ...(draft.configuration ? { sessionConfigOptionOverrides: buildSessionConfigOptionOverridesFromServerStart(draft.configuration) } : {}),
        ...(draft.capabilitySelection ? { capabilitySelection: draft.capabilitySelection } : {}),
        ...(draft.connectedServices ? { connectedServices: draft.connectedServices } : {}),
        ...(draft.allowedTools ? { allowedTools: draft.allowedTools } : {}),
        ...(draft.unlistedTools ? { unlistedTools: draft.unlistedTools } : {}),
    };
}

/** One recipe model for default selection, inline Change and the returning selector. It never starts a Session. */
export function useSessionServerStartDraftRecipe(props: Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    requireWorkspaceWriteDenial?: boolean;
}>) {
    const existingDraft = props.seed.existingDraft;
    const seededDirectoryIntent = props.seed.directoryIntent
        ?? (props.seed.directory ? { kind: 'path' as const, path: props.seed.directory } : existingDraft?.directory);
    const seededDirectory = seededDirectoryIntent?.kind === 'path' ? seededDirectoryIntent.path : undefined;
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
    const selectedTarget = React.useMemo(() => selectedPlacementCandidate ? {
        serverId: selectedPlacementCandidate.serverId, machineId: selectedPlacementCandidate.machineId,
    } : props.target, [props.target, selectedPlacementCandidate]);
    const { binding } = useServerCredentialAccountScopeBinding(selectedTarget.serverId);
    const accountScope = binding?.isCurrent() ? binding.scope : null;
    useMachineReachabilityRevision(accountScope !== null, accountScope ?? undefined, selectedTarget.machineId);
    const machine = useServerScopedMachine(selectedTarget.serverId, selectedTarget.machineId);
    const machineReady = resolveMachineSpawnReadiness({
        machine,
        selectedMachineId: selectedTarget.machineId,
        scope: selectActiveServerAccountScopeForServer(accountScope, selectedTarget.serverId),
    }).status === 'ready';
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        // Readers use only the fresh answer's phase; no catalogue body is read.
        sections: [],
        machineId: selectedTarget.machineId,
        serverId: selectedTarget.serverId,
        enabled: true,
        staleMs: 0,
    });
    const [directory, setDirectory] = React.useState(() => (
        seededDirectory ?? selectedPlacementCandidate?.rootPath ?? machine?.metadata?.homeDir ?? ''
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
        requireWorkspaceWriteDenial: props.requireWorkspaceWriteDenial,
    });
    const agentTargets = facts.agentTargets ?? [];
    const [selection, setSelection] = React.useState<RecipeSelection>(() => (
        existingDraft
            ? selectionFromDraft(existingDraft)
            : { permissionMode: props.seed.permissionMode ?? 'default', ...(props.seed.profileId ? { profileId: props.seed.profileId } : {}) }
    ));
    const [edited, setEdited] = React.useState<ReadonlySet<keyof RecipeSelection>>(() => new Set());
    // A new recipe starts on the seeded Agent, else the one default-Agent owner's
    // answer for this Machine, once this Machine lists its Agents.
    const initialAgentTarget = agentTargets.find((option) => option.agentId === props.seed.agentId)?.target
        ?? facts.contextualDefaultAgentTarget
        ?? (props.requireWorkspaceWriteDenial ? agentTargets[0]?.target : null);
    React.useEffect(() => {
        if (selection.agentTarget || !initialAgentTarget) return;
        setSelection((current) => current.agentTarget ? current : { ...current, agentTarget: initialAgentTarget });
    }, [initialAgentTarget, selection.agentTarget]);
    const changeFields = React.useCallback((fields: Partial<RecipeSelection>) => {
        setError(false);
        setSelection((current) => ({ ...current, ...fields }));
        setEdited((current) => new Set([...current, ...(Object.keys(fields) as (keyof RecipeSelection)[])]));
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

    const canSubmit = machineReady
        && daemonMergedProjection.phase === 'ready'
        && selection.agentTarget != null
        && (!props.requireWorkspaceWriteDenial || findSessionAuthoringAgentTargetOption(agentTargets, selection.agentTarget) !== null)
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
                approvalProfileId: selection.approvalProfileId,
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
            const changed = (field: keyof RecipeSelection) => !existingDraft || edited.has(field);
            return applySessionServerStartSpawnDraftEdits({
                draft,
                edits: {
                    executionTarget: selectedTarget,
                    agentTarget,
                    ...(directoryEdited || !existingDraft ? { directory: noFolderSelected
                        ? { kind: 'managed' } : { kind: 'path', path: directory.trim() } } : {}),
                    permissionMode,
                    ...(changed('modelSelection') ? { modelSelection: selection.modelSelection ?? undefined } : {}),
                    ...(changed('teamCredentialBindings') ? { teamCredentialBindings: selection.teamCredentialBindings } : {}),
                    ...(changed('profileId') ? { profileId: selection.profileId ?? undefined } : {}),
                    ...(changed('approvalProfileId') ? { approvalProfileId: selection.approvalProfileId } : {}),
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
    return { canSubmit, resolveDraft, selectedTarget, machineReady, machine, directory, noFolderSelected, setDirectory,
        setDirectoryEdited, directoryCandidateIndex, setSelectedCandidateIndex, error, setError, facts, agentTargets,
        selection, changeFields, changeField, organization, folderMenuOpen, setFolderMenuOpen, folderOptions,
        retainedFolderId, folderResolved, folderChoosable, showFolder, daemonMergedProjection,
        placementRows };
}

export type SessionServerStartDraftRecipe = ReturnType<typeof useSessionServerStartDraftRecipe>;

import * as React from 'react';

import { t } from '@/text';
import { useWorkspaceRefs, usePinnedWorkspaceRefIds, useAllMachines, useProjectOrganizations } from '@/sync/domains/state/storage';
import { projectWorkspaceRefV1, workspaceAddressFromRefV1, type QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { Modal } from '@/modal';
import { useWorkspaceSyncRelationshipSummaries, resolveWorkspaceSyncStatusScope } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { projectWorkspaceSyncSetAttentionByWorkspaceRefId } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { formatWorkspaceSyncSetAttention } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { terminatePersistedWorkspaceSyncRelationship } from '@/sync/ops/workspaceSync';
import { updateProjectWorkspace, forgetProjectWorkspace } from '@/sync/ops/actions/projectWorkspaceActions';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { buildProjectsListGroups } from './projectsListGrouping';
import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { useOpenProject } from './useOpenProject';
import { seedAndOpenProjectDraft } from './activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from './activation/projectOpenPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ProjectVisibilitySetOutputV1Schema } from '@happier-dev/protocol/projects/projectVisibilityV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useProjectsSourcesComposition } from './useProjectsSourcesComposition';
import { useProjectsTreeCheckoutFacts } from './useProjectsTreeCheckoutFacts';
import { buildProjectsTreeProjects, projectsTreeCheckoutKey } from './projectsTreeRows';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult,
    type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

type ProjectHideUndo = Readonly<{ isCurrent(): boolean; undo(): Promise<boolean> }>;

/**
 * The one model of the Projects list — its grouping (pinned, then per machine), each project's
 * subtitle and attention, and every action on a project — shared by the Projects page and the
 * Projects column, so the two can never disagree about what a project is or what it does.
 */
export function useProjectsListModel() {
    const navigateToOpen = useNavigateToProjectOpen();
    const openProject = useOpenProject();
    const activeServer = useActiveServerSnapshot();
    const allMachines = useAllMachines();
    const presenceNowMs = useMachinePresenceNowMs(allMachines);
    const addFirstMachines = React.useMemo(() => resolveMachineActionCandidates(allMachines), [allMachines]);

    const workspaceRefsV1 = useWorkspaceRefs();
    const pinnedWorkspaceRefIdsV1 = usePinnedWorkspaceRefIds();
    const projectOrganizations = useProjectOrganizations();
    const [projectHideUndo, setProjectHideUndo] = React.useState<ProjectHideUndo | null>(null);
    const [projectActionApproval, setProjectActionApproval] = React.useState<Readonly<{
        request: ActionApprovalRequestCreatedResult; isCurrent(): boolean;
    }> | null>(null);
    const rememberApproval = React.useCallback((result: Awaited<ReturnType<typeof updateProjectWorkspace>>) => {
        if (!result.ok || !('kind' in result) || result.kind !== 'approval_request_created') return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime?.isCurrent()) setProjectActionApproval({ request: result, isCurrent: lifetime.isCurrent });
    }, []);
    // Relationship intent is read from the canonical Account row projection;
    // Projects keeps no relationship state of its own.
    const workspaceSyncRelationships = useWorkspaceSyncRelationshipSummaries(undefined, activeServer.serverId);
    const workspaceSyncAttentionByRefId = React.useMemo(
        () => projectWorkspaceSyncSetAttentionByWorkspaceRefId(workspaceSyncRelationships),
        [workspaceSyncRelationships],
    );
    /** A checkout's Workspace sync trouble in words ("2 links unavailable"), or null when it has none. */
    const workspaceAttentionLabel = React.useCallback((workspaceRef: WorkspaceRefV1) => {
        const attention = workspaceSyncAttentionByRefId.get(workspaceRef.id);
        return attention ? formatWorkspaceSyncSetAttention(attention) : null;
    }, [workspaceSyncAttentionByRefId]);
    const workspaceSubtitleLines = React.useCallback((workspaceRef: WorkspaceRefV1) => {
        const attention = workspaceSyncAttentionByRefId.get(workspaceRef.id);
        return attention?.conflictedLinkCount || attention?.unknownLinkCount ? 2 : 1;
    }, [workspaceSyncAttentionByRefId]);

    const machinesById = React.useMemo(() => {
        return new Map(allMachines.map((machine) => [machine.id, machine] as const));
    }, [allMachines]);

    const groups = React.useMemo(() => {
        return buildProjectsListGroups({
            activeServerId: String(activeServer.serverId ?? '').trim(),
            workspaceRefs: Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [],
            pinnedWorkspaceRefIds: Array.isArray(pinnedWorkspaceRefIdsV1) ? pinnedWorkspaceRefIdsV1 : [],
            projectOrganizations,
        });
    }, [activeServer.serverId, pinnedWorkspaceRefIdsV1, projectOrganizations, workspaceRefsV1]);

    const treeRefs = React.useMemo(() => [...groups.projectGroups, ...groups.hiddenProjectGroups]
        .flatMap(group => group.items), [groups.projectGroups, groups.hiddenProjectGroups]);
    const openedSourceIds = React.useMemo(() => new Set(treeRefs.flatMap(ref => ref.source ? [ref.source.sourceId] : [])), [treeRefs]);
    const composition = useProjectsSourcesComposition(openedSourceIds);
    const checkoutFacts = useProjectsTreeCheckoutFacts(treeRefs);
    const treeProjection = React.useMemo(() => {
        const project = (projectGroups: typeof groups.projectGroups) => buildProjectsTreeProjects({
            groups: projectGroups, projectName: resolveWorkspaceRefDisplayName,
            machine: machineId => { const machine = machinesById.get(machineId); return machine ? {
                name: getMachineDisplayName(machine) ?? machineId, homeDir: machine.metadata?.homeDir ?? null, online: isMachineOnline(machine, presenceNowMs),
            } : null; },
            sources: composition.sources, teamName: composition.teamName,
            checkoutFacts: ref => checkoutFacts.get(projectsTreeCheckoutKey({ refId: ref.id, workspaceAddress: workspaceAddressFromRefV1(ref) })) ?? null,
        });
        return { treeProjects: project(groups.projectGroups), hiddenTreeProjects: project(groups.hiddenProjectGroups) };
    }, [checkoutFacts, composition.sources, composition.teamName, groups.hiddenProjectGroups, groups.projectGroups, machinesById, presenceNowMs]);
    const newSessionHere = React.useCallback(async (ref: WorkspaceRefV1): Promise<ActionExecuteResult> => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const retired = { ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, ref.serverId)) return retired;
        const target = resolveWorkspaceRefByAddress(treeRefs, workspaceAddressFromRefV1(ref));
        if (target.kind !== 'resolved') return { ok: false, errorCode: 'workspace_ref_unavailable', error: 'workspace_ref_unavailable' };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        if (!lifetime.isCurrent()) return retired;
        const result = await createFrontDoorActionExecute(createDefaultActionExecutor())('session.authoring.open', {
            seed: { placement: { kind: 'exactTarget', serverId: ref.serverId,
                machineId: target.ref.machineId, directory: target.ref.rootPath },
                origin: { kind: 'project', accountId: lifetime.scope.accountId,
                    workspace: workspaceAddressFromRefV1(target.ref), page: 'overview' } },
        }, { surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
            expectedAccountId: lifetime.scope.accountId });
        if (lifetime.isCurrent()) {
            const approval = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
            if (approval?.success) setProjectActionApproval({ request: approval.data, isCurrent: lifetime.isCurrent });
        }
        return result;
    }, [treeRefs]);
    const saveAsSource = React.useCallback((ref: WorkspaceRefV1, draft?: Parameters<typeof composition.saveAsSource>[1]) => {
        const resolved = resolveWorkspaceRefByAddress(treeRefs, workspaceAddressFromRefV1(ref));
        return resolved.kind === 'resolved' ? composition.saveAsSource(resolved.ref, draft) : Promise.resolve(resolved);
    }, [composition.saveAsSource, treeRefs]);

    const openWorkspace = React.useCallback((ref: WorkspaceRefV1) => openProject(ref.id, {
        workspaceAddress: workspaceAddressFromRefV1(ref),
    }), [openProject]);
    const setProjectHidden = React.useCallback(async (project: QualifiedProjectKeyV1 | WorkspaceRefV1, hidden: boolean) => {
        const target = 'rootPath' in project ? projectWorkspaceRefV1(project) : project;
        if (target.serverId !== activeServer.serverId) return false;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || lifetime.scope.serverId !== target.serverId) return false;
        const row = projectOrganizations.find(candidate => candidate.key.serverId === target.serverId
            && candidate.key.projectKey === target.projectKey);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        if (!lifetime.isCurrent()) return false;
        const executor = createDefaultActionExecutor();
        const result = await executor.execute('projects.visibility.set', {
            target, expectedRevision: row?.revision ?? 'absent', hidden,
        }, { surface: 'ui', serverId: target.serverId });
        if (!lifetime.isCurrent()) return false;
        const receipt = result.ok ? ProjectVisibilitySetOutputV1Schema.safeParse(result.result) : null;
        if (!receipt?.success || !receipt.data.ok) {
            Modal.alert(t('common.error'), t('common.saveError'));
            return false;
        }
        if (hidden) {
            const revision = receipt.data.revision;
            const undo: ProjectHideUndo = { isCurrent: lifetime.isCurrent, async undo() {
                if (!lifetime.isCurrent()) return false;
                const restored = await executor.execute('projects.visibility.set', {
                    target, expectedRevision: revision, hidden: false,
                }, { surface: 'ui', serverId: target.serverId });
                if (!lifetime.isCurrent()) return false;
                const restoredReceipt = restored.ok ? ProjectVisibilitySetOutputV1Schema.safeParse(restored.result) : null;
                const ok = restoredReceipt?.success === true && restoredReceipt.data.ok;
                if (!ok) Modal.alert(t('common.error'), t('common.saveError'));
                setProjectHideUndo(current => current === undo ? null : current);
                return ok;
            } };
            setProjectHideUndo(undo);
        } else {
            setProjectHideUndo(null);
        }
        return true;
    }, [activeServer.serverId, projectOrganizations]);

    const addProjectToMachine = React.useCallback(async (machineId: string) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || lifetime.scope.serverId !== serverId) return;
        const selected = await openMachinePathBrowserModal({
            machineId,
            serverId,
            title: t('projects.open.aFolder'),
            // The folder picker starts at the Machine's home, not the filesystem root.
            initialPath: machinesById.get(machineId)?.metadata?.homeDir ?? null,
            selectionMode: 'directory',
        });
        if (!selected || !lifetime.isCurrent()) return;
        const selectedRootPath = selected.trim();
        if (!selectedRootPath) return;

        await seedAndOpenProjectDraft({ lifetime, selection: { serverId, machineId, source: { kind: 'folder', path: selectedRootPath },
            materialization: { kind: 'attach' } }, navigate: navigateToOpen });
    }, [activeServer.serverId, machinesById, navigateToOpen]);

    const pinnedIdSet = React.useMemo(() => {
        return new Set(Array.isArray(pinnedWorkspaceRefIdsV1) ? pinnedWorkspaceRefIdsV1 : []);
    }, [pinnedWorkspaceRefIdsV1]);

    const togglePinned = React.useCallback(async (workspaceRefId: string) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const id = String(workspaceRefId ?? '').trim();
        if (!id) return;
        const result = await updateProjectWorkspace({
            serverId,
            workspaceId: id,
            pinned: !pinnedIdSet.has(id),
        });
        rememberApproval(result);
        if (!result.ok) {
            Modal.alert(t('common.error'), t('common.saveError'));
        }
    }, [activeServer.serverId, pinnedIdSet, rememberApproval]);

    const renameProject = React.useCallback(async (workspaceRef: WorkspaceRefV1) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const currentLabel = resolveWorkspaceRefDisplayName(workspaceRef);
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || lifetime.scope.serverId !== workspaceRef.serverId) return;
        const newName = await Modal.prompt(
            t('sessionsList.renameWorkspacePromptTitle'),
            undefined,
            {
                defaultValue: currentLabel,
                placeholder: t('sessionsList.renameWorkspacePromptPlaceholder'),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (newName == null) return;
        const trimmed = newName.trim();
        if (!trimmed) return;

        const result = await updateProjectWorkspace({
            serverId,
            workspaceId: workspaceRef.id,
            label: trimmed,
        }, lifetime);
        rememberApproval(result);
        if (!result.ok) {
            Modal.alert(t('common.error'), t('common.saveError'));
        }
    }, [activeServer.serverId, rememberApproval]);

    const resetProjectName = React.useCallback(async (workspaceRef: WorkspaceRefV1) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const result = await updateProjectWorkspace({
            serverId: workspaceRef.serverId,
            workspaceId: workspaceRef.id,
            label: null,
        });
        rememberApproval(result);
        if (!result.ok) {
            Modal.alert(t('common.error'), t('common.saveError'));
        }
    }, [activeServer.serverId, rememberApproval]);

    const removeProject = React.useCallback(async (workspaceRef: WorkspaceRefV1) => {
        const serverId = String(activeServer.serverId ?? '').trim();
        if (!serverId) return;
        const id = String(workspaceRef.id ?? '').trim();
        if (!id) return;

        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent() || lifetime.scope.serverId !== workspaceRef.serverId) return;
        let removal = await forgetProjectWorkspace({ serverId, workspaceId: id }, lifetime);
        if (removal.ok && 'kind' in removal) { rememberApproval(removal); return removal; }

        if (!removal.ok && removal.errorCode === 'workspace_ref_in_use') {
            const details = 'details' in removal ? removal.details : null;
            const ids = details && typeof details === 'object' && 'relationshipIds' in details ? details.relationshipIds : null;
            const blockingRelationshipIds = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
            if (!blockingRelationshipIds.length) { Modal.alert(t('common.error'), t('projects.actions.removeStopSyncingFailed')); return; }
            const blocking = workspaceSyncRelationships.filter(
                (summary) => blockingRelationshipIds.includes(summary.relationshipId),
            );
            if (blocking.length !== blockingRelationshipIds.length) {
                Modal.alert(t('common.error'), t('projects.actions.removeStopSyncingFailed'));
                return;
            }
            const confirmed = await Modal.confirm(
                t('projects.actions.removeBlockedBySyncTitle'),
                t('projects.actions.removeBlockedBySyncBody', { count: blocking.length }),
                { confirmText: t('projects.actions.removeBlockedBySyncConfirm'), destructive: true },
            );
            if (!confirmed || !lifetime.isCurrent()) return;
            try {
                // Stop syncing through the canonical daemon relationship owner;
                // the reference is only released once nothing still points at it.
                for (const summary of blocking) {
                    if (!lifetime.isCurrent()) return;
                    await terminatePersistedWorkspaceSyncRelationship(resolveWorkspaceSyncStatusScope(summary));
                }
            } catch {
                Modal.alert(t('common.error'), t('projects.actions.removeStopSyncingFailed'));
                return;
            }
            removal = await forgetProjectWorkspace({ serverId, workspaceId: id }, lifetime);
            if (removal.ok && 'kind' in removal) { rememberApproval(removal); return removal; }
        }

        if (!removal.ok) {
            Modal.alert(t('common.error'), t('projects.actions.removeStopSyncingFailed'));
        }
        return removal;
    }, [
        activeServer.serverId,
        workspaceSyncRelationships,
        rememberApproval,
    ]);

    const hasAnyProjects = groups.projectGroups.length > 0 || groups.hiddenProjectGroups.length > 0;
    const projectCount = groups.projectGroups.length;

    return {
        ...composition,
        ...treeProjection,
        newSessionHere,
        saveAsSource,
        projectOpenResolution: openProject.resolution,
        dismissProjectOpenResolution: openProject.dismissResolution,
        projectActionApproval: projectActionApproval?.isCurrent() ? projectActionApproval.request : null,
        dismissProjectActionApproval: () => setProjectActionApproval(null),
        groups,
        hasAnyProjects,
        projectCount,
        allMachines,
        addFirstMachines,
        machinesById,
        pinnedIdSet,
        workspaceAttentionLabel,
        workspaceSubtitleLines,
        openProject,
        openWorkspace,
        setProjectHidden,
        // U2 owns the existing toast presentation/lifetime; Undo retains this Hide's acknowledged CAS revision.
        projectHideUndo: projectHideUndo?.isCurrent() ? projectHideUndo : null,
        dismissProjectHideUndo: () => setProjectHideUndo(null),
        hiddenProjectCount: groups.hiddenProjectGroups.length,
        addProjectToMachine,
        togglePinned,
        renameProject,
        resetProjectName,
        removeProject,
    };
}

export type ProjectsListModel = ReturnType<typeof useProjectsListModel>;

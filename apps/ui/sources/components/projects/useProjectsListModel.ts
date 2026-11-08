import * as React from 'react';

import { t } from '@/text';
import { useActiveServerAccountScope, useWorkspaceRefs, usePinnedWorkspaceRefIds, useMachineDisplayById, useProjectOrganizations, useProjectAccountRows, useIsDataReady, useActiveMachineFacts } from '@/sync/domains/state/storage';
import { isProjectAccountRowsCensusComplete } from '@/sync/store/domains/projectAccountRows';
import type { WorkspaceRefUnconfirmed } from './detail/useWorkspaceRefById';
import { projectWorkspaceRefV1, workspaceAddressFromRefV1, type QualifiedProjectKeyV1, type WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { Modal } from '@/modal';
import { useWorkspaceSyncRelationshipSummaries, resolveWorkspaceSyncStatusScope } from '@/sync/domains/sessionHandoff/useWorkspaceSyncRelationshipSummaries';
import { projectWorkspaceSyncSetAttentionByWorkspaceRefId } from '@/sync/domains/sessionHandoff/workspaceSyncRelationshipModel';
import { formatWorkspaceSyncSetAttention } from '@/sync/domains/sessionHandoff/workspaceSyncPresentation';
import { updateProjectWorkspace, forgetProjectWorkspace } from '@/sync/ops/actions/projectWorkspaceActions';
import { terminateWorkspaceSyncRelationship } from '@/sync/ops/actions/workspaceSyncRelationshipActions';
import { resolveMachineActionCandidates } from '@/utils/sessions/resolveMachineActionCandidates';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import { buildProjectsListGroups } from './projectsListGrouping';
import { resolveWorkspaceRefDisplayName } from './resolveWorkspaceRefDisplayName';
import { useOpenProject } from './useOpenProject';
import { seedAndOpenProjectDraft } from './activation/projectOpenDraftSeed';
import { useNavigateToProjectOpen } from './activation/projectOpenPresentation';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { ProjectVisibilitySetOutputV1Schema } from '@happier-dev/protocol/projects/projectVisibilityV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useProjectsSourcesComposition } from './useProjectsSourcesComposition';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { buildProjectsTreeHiddenItems, buildProjectsTreeProjects, type ProjectsTreeProject } from './projectsTreeRows';
import { storage } from '@/sync/domains/state/storage';
import { listSessionFolders } from '@/utils/sessions/recentPaths';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { isWorkspacePathWithinRootV1 } from '@happier-dev/protocol/workspaces';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { isMachineDisplayHydrating, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult,
    type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { PluginUiNewSessionSeedV1 } from '@happier-dev/protocol/plugins/ui';

type ProjectHideUndo = Readonly<{ isCurrent(): boolean; undo(): Promise<boolean> }>;

/**
 * The one model of the Projects list — its grouping (pinned, then per machine), each project's
 * subtitle and attention, and every action on a project — shared by the Projects page and the
 * Projects column, so the two can never disagree about what a project is or what it does.
 */
type TreeMachineFacts = Readonly<{ name: string | null; homeDir: string | null; online: boolean | null }>;

/** A Session folder no checkout covers yet: its Add opens it through Project Open on its Machine. */
const SESSION_FOLDER_KEY_PREFIX = 'session-folder:';

export function useProjectsListModel() {
    const navigateToOpen = useNavigateToProjectOpen();
    const openProject = useOpenProject();
    const activeServer = useActiveServerSnapshot();
    const allMachines = useActiveMachineFacts();
    const activeScope = useActiveServerAccountScope();
    const accountScope = selectActiveServerAccountScopeForServer(activeScope, activeServer.serverId);
    // The Machine inventory has arrived (or the account is synced and genuinely has none).
    const machinesReady = useIsDataReady() || allMachines.length > 0;
    // Subscribe to this Home's actual Machine facts, not the request revision of
    // every Home. The presence owner also keeps grace expiry and recovery live.
    const machinePresence = useMachinePresenceSummaries(activeServer.serverId, allMachines.map(machine => machine.id));
    const addFirstMachines = React.useMemo(() => resolveMachineActionCandidates(accountScope, allMachines),
        [accountScope, allMachines, machinePresence]);

    const workspaceRefsV1 = useWorkspaceRefs();
    const pinnedWorkspaceRefIdsV1 = usePinnedWorkspaceRefIds();
    const projectOrganizations = useProjectOrganizations();
    const [projectHideUndo, setProjectHideUndo] = React.useState<ProjectHideUndo | null>(null);
    const [projectActionApproval, setProjectActionApproval] = React.useState<Readonly<{
        request: ActionApprovalRequestCreatedResult; isCurrent(): boolean;
    }> | null>(null);
    const rememberApproval = React.useCallback((result:
        | Awaited<ReturnType<typeof updateProjectWorkspace>>
        | Awaited<ReturnType<typeof terminateWorkspaceSyncRelationship>>) => {
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
    // Display metadata can already be known while the full Machine content is
    // still opening. Use that canonical projection rather than waiting for it.
    const machineDisplays = useMachineDisplayById(displays => allMachines.map(machine =>
        isMachineDisplayHydrating(machine) ? displays[machine.id] ?? machine : machine));
    // One naming owner for every Machine the tree shows: listed Machines with the same name get the
    // suffix the pickers use, and a checkout on a Machine this Home no longer lists says so.
    const machineNames = React.useMemo(() => resolveMachineDisplayNames([
        ...machineDisplays,
        ...[...new Set(treeRefs.map(ref => ref.machineId))].filter(id => !machinesById.has(id)).map(id => ({ id, absence: 'unlisted' as const })),
    ]), [machineDisplays, machinesById, treeRefs]);
    // The Machine facts the tree shows (name, home directory, online), retained while equal: a daemon,
    // key or resource publication replaces Machine records without changing any of them.
    const previousTreeMachines = React.useRef<Readonly<Record<string, TreeMachineFacts>> | undefined>(undefined);
    const treeMachines = React.useMemo(() => {
        const presenceById = new Map(allMachines.map((machine, index) => [machine.id, machinePresence[index]] as const));
        const next: Record<string, TreeMachineFacts> = {};
        for (const machineId of new Set([...machinesById.keys(), ...machineNames.keys()])) {
            const reachability = accountScope ? presenceById.get(machineId)?.reachability ?? 'unknown' : 'unknown';
            next[machineId] = { name: machineNames.get(machineId) ?? null, homeDir: machinesById.get(machineId)?.metadata?.homeDir ?? null,
                online: reachability === 'unknown' ? null : reachability === 'reachable' };
        }
        return previousTreeMachines.current = retainDeep(previousTreeMachines.current, next);
    }, [accountScope, allMachines, machineNames, machinePresence, machinesById]);
    const previousTreeProjects = React.useRef<{ visible: ProjectsTreeProject[]; hidden: ProjectsTreeProject[] }>({ visible: [], hidden: [] });
    const treeProjection = React.useMemo(() => {
        const project = (projectGroups: typeof groups.projectGroups, previousProjects: ProjectsTreeProject[]) => buildProjectsTreeProjects({
            previousProjects,
            groups: projectGroups, projectName: resolveWorkspaceRefDisplayName,
            machine: machineId => {
                const facts = treeMachines[machineId];
                return { name: facts?.name ?? t('machine.unlistedMachine'), homeDir: facts?.homeDir ?? null, online: facts?.online ?? null };
            },
            sources: composition.sources, teamName: composition.teamName,
        });
        // Rows are named after their Machines: until the Machine inventory has loaded, any Machine would read as
        // "unlisted" and every path as absolute, so the tree waits (the column shows its quiet rows) instead of guessing.
        if (!machinesReady) {
            previousTreeProjects.current = { visible: [], hidden: [] };
            return { treeProjects: [], hiddenTreeProjects: [], hiddenItems: [] };
        }
        const hiddenTreeProjects = project(groups.hiddenProjectGroups, previousTreeProjects.current.hidden);
        const treeProjects = project(groups.projectGroups, previousTreeProjects.current.visible);
        previousTreeProjects.current = { visible: treeProjects, hidden: hiddenTreeProjects };
        return { treeProjects, hiddenTreeProjects, hiddenItems: buildProjectsTreeHiddenItems(hiddenTreeProjects) };
    }, [composition.sources, composition.teamName, groups.hiddenProjectGroups, groups.projectGroups, machinesReady, treeMachines]);
    const newSessionHere = React.useCallback(async (ref: WorkspaceRefV1): Promise<ActionExecuteResult> => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        const retired = { ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        if (!lifetime?.isCurrent() || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, ref.serverId)) return retired;
        const target = resolveWorkspaceRefByAddress(treeRefs, workspaceAddressFromRefV1(ref));
        if (target.kind !== 'resolved') return { ok: false, errorCode: 'workspace_ref_unavailable', error: 'workspace_ref_unavailable' };
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        if (!lifetime.isCurrent()) return retired;
        const seed = { placement: { kind: 'exactTarget', serverId: ref.serverId,
            machineId: target.ref.machineId, directory: target.ref.rootPath } } satisfies PluginUiNewSessionSeedV1;
        const result = await createFrontDoorActionExecute(createDefaultActionExecutor())('session.authoring.open', {
            seed,
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
    /** A tree leaf (visible or hidden) opens its exact accepted checkout, resolved by full address. */
    const openTreeRef = React.useCallback((refId: string, address?: WorkspaceAddressV1) => {
        if (!address || address.workspaceId !== refId) return;
        const resolution = resolveWorkspaceRefByAddress(treeRefs, address);
        if (resolution.kind === 'resolved') openWorkspace(resolution.ref);
    }, [openWorkspace, treeRefs]);
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
            // The picker names the Machine and lets the person browse another; the folder comes back with it.
            allowMachineChange: true,
        });
        if (!selected || !lifetime.isCurrent()) return;
        const selectedRootPath = selected.path.trim();
        if (!selectedRootPath) return;

        await seedAndOpenProjectDraft({ lifetime, selection: { serverId, machineId: selected.machineId, source: { kind: 'folder', path: selectedRootPath },
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

    /**
     * The person's grouping (owner 11-08): each checkout joins the Project `projectKey`, or `'self'` separates it,
     * through `projects.workspace.update` (the same Action agents use). A Project with several checkouts moves whole.
     */
    const groupCheckouts = React.useCallback(async (refs: readonly WorkspaceRefV1[], projectKey: string) => {
        for (const ref of refs) {
            const result = await updateProjectWorkspace({ serverId: ref.serverId, workspaceId: ref.id, projectKey });
            rememberApproval(result);
            if (!result.ok) { Modal.alert(t('common.error'), t('common.saveError')); return; }
            // A checkout the person separated is a Project they made: it stays in the list (the one visibility write).
            if (projectKey === 'self') await setProjectHidden({ serverId: ref.serverId, projectKey: ref.id }, false);
        }
    }, [rememberApproval, setProjectHidden]);

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
            for (const summary of blocking) {
                if (!lifetime.isCurrent()) return;
                const scope = resolveWorkspaceSyncStatusScope(summary);
                const stopped = await terminateWorkspaceSyncRelationship({
                    controllerMachineId: scope.controllerMachineId,
                    relationshipId: scope.relationshipId,
                }, lifetime);
                rememberApproval(stopped);
                if (stopped.ok && 'kind' in stopped) return stopped;
                if (!stopped.ok) {
                    Modal.alert(t('common.error'), t('projects.actions.removeStopSyncingFailed'));
                    return stopped;
                }
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

    /**
     * Show a Project in the list (owner 11-08): a hidden Project's Show, or Add on a folder from your sessions. Both
     * are the one visibility write, `projects.visibility.set {hidden:false}`, by the key both hosts draw.
     */
    const showHiddenProject = React.useCallback((key: string) => {
        const group = [...groups.hiddenProjectGroups, ...groups.unlistedProjectGroups].find(candidate => candidate.projectKey.projectKey === key);
        if (group) void setProjectHidden(group.projectKey, false);
    }, [groups.hiddenProjectGroups, groups.unlistedProjectGroups, setProjectHidden]);
    /**
     * "From your sessions" in the + menu: every folder a Session of this Account ran in that is not in the list yet,
     * on any Machine, named like the tree's rows. Folders with an accepted checkout come first (their Add is the
     * visibility write); a folder no checkout covers (no SCM, so no automatic checkout) opens through Project Open on
     * its Machine, which adds it. Built when the menu opens, never while it is closed; an empty read draws no entry.
     */
    const readFromSessions = React.useCallback(() => {
        const machine = (machineId: string) => {
            const facts = treeMachines[machineId];
            return { name: facts?.name ?? t('machine.unlistedMachine'), homeDir: facts?.homeDir ?? null, online: facts?.online ?? null };
        };
        const accepted = buildProjectsTreeProjects({ groups: groups.unlistedProjectGroups, projectName: resolveWorkspaceRefDisplayName, machine });
        const refs = Array.isArray(workspaceRefsV1) ? workspaceRefsV1 : [];
        const serverId = activeServer.serverId;
        // The Session list census of this Home: the rows the sessions list itself draws.
        const sessions = Object.values(readSessionListRowsForServerId(storage.getState().sessionListRowsByServerId, serverId) ?? {});
        const folders = listSessionFolders(sessions).filter(folder => !refs.some(ref => ref.machineId === folder.machineId
            && isWorkspacePathWithinRootV1(folder.path, ref.rootPath)));
        return [...accepted, ...folders.map((folder): ProjectsTreeProject => {
            const name = resolveWorkspacePathBasenameV1(folder.path) ?? folder.path;
            const where = machine(folder.machineId);
            const key = `${SESSION_FOLDER_KEY_PREFIX}${folder.machineId}:${folder.path}`;
            return { key, name, checkouts: [{ refId: key, machineId: folder.machineId, machineName: where.name, label: name,
                path: formatPathRelativeToHome(folder.path, where.homeDir ?? undefined), attention: null,
                ...(where.online === false ? { offline: true } : {}) }] };
        })];
    }, [activeServer.serverId, groups.unlistedProjectGroups, treeMachines, workspaceRefsV1]);
    const addFromSessions = React.useCallback((key: string) => {
        if (!key.startsWith(SESSION_FOLDER_KEY_PREFIX)) { showHiddenProject(key); return; }
        const rest = key.slice(SESSION_FOLDER_KEY_PREFIX.length);
        const separator = rest.indexOf(':');
        const serverId = String(activeServer.serverId ?? '').trim();
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (separator <= 0 || !serverId || !lifetime?.isCurrent() || lifetime.scope.serverId !== serverId) return;
        void seedAndOpenProjectDraft({ lifetime, selection: { serverId, machineId: rest.slice(0, separator),
            source: { kind: 'folder', path: rest.slice(separator + 1) }, materialization: { kind: 'attach' } }, navigate: navigateToOpen });
    }, [activeServer.serverId, navigateToOpen, showHiddenProject]);
    const fromSessions = React.useMemo(() => ({ read: readFromSessions, onAdd: addFromSessions }), [readFromSessions, addFromSessions]);

    /** "Group with…" targets: the other Projects in the list, named like their rows. Read when a menu opens. */
    const { treeProjects } = treeProjection;
    const readGroupTargets = React.useCallback((exceptKey: string) => treeProjects.filter(project => project.key !== exceptKey).map(project => {
        const only = project.checkouts.length === 1 ? project.checkouts[0] : null;
        return { key: project.key, title: project.name, ...(only ? { subtitle: `${only.machineName} · ${only.path}` } : {}) };
    }), [treeProjects]);

    const hasAnyProjects = groups.projectGroups.length > 0 || groups.hiddenProjectGroups.length > 0;
    // Until the opened census is complete, an empty tree is not "no Projects": the rows are still
    // loading, or the read failed and nothing was removed (the column and page say which).
    const census = useProjectAccountRows();
    const censusComplete = isProjectAccountRowsCensusComplete(census);
    const censusStatus = census?.status ?? 'idle';
    const rowsUnconfirmed = React.useMemo((): WorkspaceRefUnconfirmed | null => (
        !hasAnyProjects && !censusComplete ? { kind: 'unconfirmed', status: censusStatus }
            // Known rows still wait for the Machines that name them (quiet rows, never "unlisted").
            : hasAnyProjects && !machinesReady ? { kind: 'unconfirmed', status: 'loading' } : null
    ), [censusComplete, censusStatus, hasAnyProjects, machinesReady]);
    // A refresh that failed over rows already held: they stay, labeled as of the last success, with Retry. (With none
    // held, or Machines still loading, `rowsUnconfirmed` already says so.) Rows are never authorization to mutate.
    const lastReadyAtMs = census?.lastReadyAtMs ?? null;
    const staleRows = React.useMemo((): Readonly<{ asOf: number | null }> | null => (
        hasAnyProjects && !rowsUnconfirmed && censusStatus === 'error' ? { asOf: lastReadyAtMs } : null
    ), [censusStatus, hasAnyProjects, lastReadyAtMs, rowsUnconfirmed]);
    const projectCount = groups.projectGroups.length;
    // "Saved, not open" is only true once the census is complete and its Machines are known; until then every
    // Source would look unopened, so the group waits with the tree.
    const saved = censusComplete && machinesReady ? composition.saved : null;
    // The one "no Projects yet" fact both hosts say: nothing open, nothing hidden, no saved Source to offer.
    const noProjects = !hasAnyProjects && !rowsUnconfirmed && !saved?.items.length;

    return {
        ...composition,
        saved,
        noProjects,
        ...treeProjection,
        /** The refs behind `treeProjects`: what a reader of live checkout facts subscribes for. */
        checkoutRefs: treeRefs,
        newSessionHere,
        saveAsSource,
        projectOpenResolution: openProject.resolution,
        dismissProjectOpenResolution: openProject.dismissResolution,
        projectActionApproval: projectActionApproval?.isCurrent() ? projectActionApproval.request : null,
        dismissProjectActionApproval: () => setProjectActionApproval(null),
        groups,
        hasAnyProjects,
        rowsUnconfirmed,
        staleRows,
        projectCount,
        allMachines,
        addFirstMachines,
        machinesById,
        pinnedIdSet,
        workspaceAttentionLabel,
        workspaceSubtitleLines,
        openProject,
        openWorkspace,
        openTreeRef,
        setProjectHidden,
        showHiddenProject,
        fromSessions,
        groupCheckouts,
        readGroupTargets,
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

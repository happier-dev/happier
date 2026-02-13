/**
 * Project Management System
 * Groups sessions by machine ID and path to create project entities
 */

import {
    Session,
    MachineMetadata,
    ScmCommitSelectionPatch,
    ScmStatus,
    ScmWorkingSnapshot,
} from '@/sync/domains/state/storageTypes';
import {
    clearSessionScmCommitSelectionPatches,
    clearSessionScmCommitSelectionPaths,
    getSessionScmCommitSelectionPatches,
    getSessionScmCommitSelectionPaths,
    getSessionScmTouchedPaths,
    markSessionScmCommitSelectionPaths,
    markSessionScmTouchedPaths,
    pruneSessionScmCommitSelectionPatches,
    pruneSessionScmCommitSelectionPaths,
    pruneSessionScmTouchedPaths,
    removeSessionScmCommitSelectionPatch,
    unmarkSessionScmCommitSelectionPaths,
    upsertSessionScmCommitSelectionPatch,
} from './projectScmSelectionState';

/**
 * Unique project identifier based on machine ID and path
 */
export interface ProjectKey {
    machineId: string;
    path: string;
}

export function resolveProjectMachineScopeId(metadata: { machineId?: string | null; host?: string | null }): string {
    const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
    if (machineId) return machineId;
    const host = typeof metadata.host === 'string' ? metadata.host.trim() : '';
    if (host) return `host:${host}`;
    return 'unknown';
}

export type ScmProjectOperationKind =
    | 'refresh'
    | 'stage'
    | 'unstage'
    | 'commit'
    | 'fetch'
    | 'pull'
    | 'push'
    | 'revert';

export type ScmProjectOperationStatus = 'success' | 'failed';

export interface ScmProjectOperationLogEntry {
    id: string;
    timestamp: number;
    sessionId: string;
    operation: ScmProjectOperationKind;
    status: ScmProjectOperationStatus;
    path?: string;
    detail?: string;
}

export interface ScmProjectInFlightOperation {
    id: string;
    startedAt: number;
    sessionId: string;
    operation: ScmProjectOperationKind;
}

export type BeginScmProjectOperationResult =
    | { started: true; operation: ScmProjectInFlightOperation }
    | { started: false; reason: 'missing_project' | 'operation_in_flight'; inFlight: ScmProjectInFlightOperation | null };

export type ProjectScmSnapshotError = Readonly<{
    message: string;
    at: number;
    errorCode?: string;
}>;

/**
 * Project entity that groups sessions by location
 */
export interface Project {
    /** Unique internal ID (not stable between app restarts) */
    id: string;
    /** Project identifier */
    key: ProjectKey;
    /** List of active session IDs in this project */
    sessionIds: string[];
    /** Optional machine metadata */
    machineMetadata?: MachineMetadata | null;
    /** Source control status for this project (shared across all sessions) */
    scmStatus?: ScmStatus | null;
    /** Canonical source-control working snapshot for this project */
    scmSnapshot?: ScmWorkingSnapshot | null;
    /** Last error encountered while refreshing source-control snapshot for this project */
    scmSnapshotError?: ProjectScmSnapshotError | null;
    /** Paths touched by each session (sessionId -> path -> timestamp) */
    scmTouchedPathsBySession?: Record<string, Record<string, number>>;
    /** Virtual commit selection paths by session (sessionId -> path -> timestamp) */
    scmCommitSelectionBySession?: Record<string, Record<string, number>>;
    /** Virtual commit selection patches by session (sessionId -> path -> { path, patch, selectedAt }) */
    scmCommitSelectionPatchesBySession?: Record<string, Record<string, ScmCommitSelectionPatch & { selectedAt: number }>>;
    /** Bounded operation log for auditability */
    scmOperationLog?: ScmProjectOperationLogEntry[];
    /** Single in-flight write operation lock */
    scmOperationInFlight?: ScmProjectInFlightOperation | null;
    /** Timestamp when source-control status was last updated */
    lastScmStatusUpdate?: number;
    /** Project creation timestamp */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
}

/**
 * In-memory project manager
 */
class ProjectManager {
    private static readonly MAX_SCM_OPERATION_LOG = 200;
    private projects: Map<string, Project> = new Map();
    private projectKeyToId: Map<string, string> = new Map();
    private sessionToProject: Map<string, string> = new Map();
    private nextProjectId = 1;

    /**
     * Generate a unique key string from machine ID and path
     */
    private getProjectKeyString(key: ProjectKey): string {
        return `${key.machineId}:${key.path}`;
    }

    /**
     * Generate a new unique project ID
     */
    private generateProjectId(): string {
        return `project_${this.nextProjectId++}`;
    }

    /**
     * Get or create a project for the given key
     */
    private getOrCreateProject(key: ProjectKey, machineMetadata?: MachineMetadata | null): Project {
        const keyString = this.getProjectKeyString(key);
        let projectId = this.projectKeyToId.get(keyString);

        if (!projectId) {
            // Create new project
            projectId = this.generateProjectId();
            const now = Date.now();
            
            const project: Project = {
                id: projectId,
                key,
                sessionIds: [],
                machineMetadata,
                scmSnapshotError: null,
                createdAt: now,
                updatedAt: now
            };

            this.projects.set(projectId, project);
            this.projectKeyToId.set(keyString, projectId);
            
            return project;
        }

        const project = this.projects.get(projectId)!;
        
        // Update machine metadata if provided and different
        if (machineMetadata && project.machineMetadata !== machineMetadata) {
            project.machineMetadata = machineMetadata;
            project.updatedAt = Date.now();
        }

        return project;
    }

    /**
     * Add or update a session in the project system
     */
    addSession(session: Session, machineMetadata?: MachineMetadata | null): void {
        // Session must have metadata path (machine id may be absent for legacy/terminal sessions).
        if (!session.metadata?.path) {
            return;
        }

        const projectKey: ProjectKey = {
            machineId: resolveProjectMachineScopeId(session.metadata),
            path: session.metadata.path
        };

        const project = this.getOrCreateProject(projectKey, machineMetadata);

        // Remove session from previous project if it was in one
        const previousProjectId = this.sessionToProject.get(session.id);
        if (previousProjectId && previousProjectId !== project.id) {
            const previousProject = this.projects.get(previousProjectId);
            if (previousProject) {
                const index = previousProject.sessionIds.indexOf(session.id);
                if (index !== -1) {
                    previousProject.sessionIds.splice(index, 1);
                    if (previousProject.scmOperationInFlight?.sessionId === session.id) {
                        previousProject.scmOperationInFlight = null;
                    }
                    if (previousProject.scmTouchedPathsBySession) {
                        delete previousProject.scmTouchedPathsBySession[session.id];
                    }
                    if (previousProject.scmCommitSelectionBySession) {
                        delete previousProject.scmCommitSelectionBySession[session.id];
                    }
                    if (previousProject.scmCommitSelectionPatchesBySession) {
                        delete previousProject.scmCommitSelectionPatchesBySession[session.id];
                    }
                    previousProject.updatedAt = Date.now();
                    
                    // Remove empty projects
                    if (previousProject.sessionIds.length === 0) {
                        this.removeProject(previousProjectId);
                    }
                }
            }
        }

        // Add session to new project if not already there
        if (!project.sessionIds.includes(session.id)) {
            project.sessionIds.push(session.id);
            project.updatedAt = Date.now();
        }

        this.sessionToProject.set(session.id, project.id);
    }

    /**
     * Remove a session from the project system
     */
    removeSession(sessionId: string): void {
        const projectId = this.sessionToProject.get(sessionId);
        if (!projectId) {
            return;
        }

        const project = this.projects.get(projectId);
        if (!project) {
            this.sessionToProject.delete(sessionId);
            return;
        }

        // Remove session from project
        const index = project.sessionIds.indexOf(sessionId);
        if (index !== -1) {
            project.sessionIds.splice(index, 1);
            if (project.scmOperationInFlight?.sessionId === sessionId) {
                project.scmOperationInFlight = null;
            }
            project.updatedAt = Date.now();
        }

        if (project.scmTouchedPathsBySession) {
            delete project.scmTouchedPathsBySession[sessionId];
        }
        if (project.scmCommitSelectionBySession) {
            delete project.scmCommitSelectionBySession[sessionId];
        }
        if (project.scmCommitSelectionPatchesBySession) {
            delete project.scmCommitSelectionPatchesBySession[sessionId];
        }

        this.sessionToProject.delete(sessionId);

        // Remove empty projects
        if (project.sessionIds.length === 0) {
            this.removeProject(projectId);
        }
    }

    /**
     * Remove a project completely
     */
    private removeProject(projectId: string): void {
        const project = this.projects.get(projectId);
        if (!project) {
            return;
        }

        // Clean up all references
        const keyString = this.getProjectKeyString(project.key);
        this.projectKeyToId.delete(keyString);
        this.projects.delete(projectId);

        // Remove session mappings
        for (const sessionId of project.sessionIds) {
            this.sessionToProject.delete(sessionId);
        }
    }

    /**
     * Get all projects
     */
    getProjects(): Project[] {
        return Array.from(this.projects.values())
            .sort((a, b) => b.updatedAt - a.updatedAt); // Most recently updated first
    }

    /**
     * Get project by ID
     */
    getProject(projectId: string): Project | null {
        return this.projects.get(projectId) || null;
    }

    /**
     * Get project for a session
     */
    getProjectForSession(sessionId: string): Project | null {
        const projectId = this.sessionToProject.get(sessionId);
        if (!projectId) {
            return null;
        }
        return this.projects.get(projectId) || null;
    }

    /**
     * Get sessions for a project
     */
    getProjectSessions(projectId: string): string[] {
        const project = this.projects.get(projectId);
        return project ? [...project.sessionIds] : [];
    }

    /**
     * Update multiple sessions at once (for bulk operations)
     */
    updateSessions(sessions: Session[], machineMetadataMap?: Map<string, MachineMetadata>): void {
        // Track which sessions are still active
        const activeSessionIds = new Set(sessions.map(s => s.id));
        
        // Remove sessions that are no longer in the list
        const currentSessionIds = new Set(this.sessionToProject.keys());
        for (const sessionId of currentSessionIds) {
            if (!activeSessionIds.has(sessionId)) {
                this.removeSession(sessionId);
            }
        }

        // Add or update all current sessions
        for (const session of sessions) {
            const machineMetadata = session.metadata?.machineId 
                ? machineMetadataMap?.get(session.metadata.machineId)
                : undefined;
            this.addSession(session, machineMetadata);
        }
    }

    /**
     * Update source-control status for a project (identified by project key)
     */
    updateProjectScmStatus(projectKey: ProjectKey, scmStatus: ScmStatus | null): void {
        const keyString = this.getProjectKeyString(projectKey);
        const projectId = this.projectKeyToId.get(keyString);
        
        if (!projectId) {
            // No project exists for this key, skip update
            return;
        }

        const project = this.projects.get(projectId);
        if (!project) {
            return;
        }

        // Update source-control status and timestamp
        project.scmStatus = scmStatus;
        project.lastScmStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Update source-control snapshot for a project (identified by project key)
     */
    updateProjectScmSnapshot(projectKey: ProjectKey, scmSnapshot: ScmWorkingSnapshot | null): void {
        const keyString = this.getProjectKeyString(projectKey);
        const projectId = this.projectKeyToId.get(keyString);
        if (!projectId) return;

        const project = this.projects.get(projectId);
        if (!project) return;

        project.scmSnapshot = scmSnapshot;
        project.lastScmStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Update source-control status for a project (identified by project ID)
     */
    updateProjectScmStatusById(projectId: string, scmStatus: ScmStatus | null): void {
        const project = this.projects.get(projectId);
        if (!project) {
            return;
        }

        project.scmStatus = scmStatus;
        project.lastScmStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Update source-control snapshot for a project (identified by project ID)
     */
    updateProjectScmSnapshotById(projectId: string, scmSnapshot: ScmWorkingSnapshot | null): void {
        const project = this.projects.get(projectId);
        if (!project) return;

        project.scmSnapshot = scmSnapshot;
        project.lastScmStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Get source-control status for a project
     */
    getProjectScmStatus(projectId: string): ScmStatus | null {
        const project = this.projects.get(projectId);
        return project?.scmStatus || null;
    }

    /**
     * Get source-control snapshot for a project
     */
    getProjectScmSnapshot(projectId: string): ScmWorkingSnapshot | null {
        const project = this.projects.get(projectId);
        return project?.scmSnapshot || null;
    }

    /**
     * Get last source-control snapshot refresh error for a project.
     */
    getProjectScmSnapshotError(projectId: string): ProjectScmSnapshotError | null {
        const project = this.projects.get(projectId);
        return project?.scmSnapshotError || null;
    }

    /**
     * Clear source-control status for a project
     */
    clearProjectScmStatus(projectId: string): void {
        const project = this.projects.get(projectId);
        if (project) {
            project.scmStatus = null;
            project.scmSnapshot = null;
            project.lastScmStatusUpdate = Date.now();
            project.updatedAt = Date.now();
        }
    }

    /**
     * Get source-control status for a session via its project
     */
    getSessionProjectScmStatus(sessionId: string): ScmStatus | null {
        const project = this.getProjectForSession(sessionId);
        return project?.scmStatus || null;
    }

    /**
     * Get source-control snapshot for a session via its project
     */
    getSessionProjectScmSnapshot(sessionId: string): ScmWorkingSnapshot | null {
        const project = this.getProjectForSession(sessionId);
        return project?.scmSnapshot || null;
    }

    /**
     * Get last source-control snapshot refresh error for a session via its project.
     */
    getSessionProjectScmSnapshotError(sessionId: string): ProjectScmSnapshotError | null {
        const project = this.getProjectForSession(sessionId);
        return project?.scmSnapshotError || null;
    }

    /**
     * Update source-control status for a session's project
     */
    updateSessionProjectScmStatus(sessionId: string, scmStatus: ScmStatus | null): void {
        const project = this.getProjectForSession(sessionId);
        if (project) {
            this.updateProjectScmStatusById(project.id, scmStatus);
        }
    }

    /**
     * Update source-control snapshot for a session's project
     */
    updateSessionProjectScmSnapshot(sessionId: string, scmSnapshot: ScmWorkingSnapshot | null): void {
        const project = this.getProjectForSession(sessionId);
        if (project) {
            this.updateProjectScmSnapshotById(project.id, scmSnapshot);
        }
    }

    /**
     * Update last source-control snapshot refresh error for a session's project.
     */
    updateSessionProjectScmSnapshotError(
        sessionId: string,
        error: ProjectScmSnapshotError | null
    ): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        project.scmSnapshotError = error;
        project.updatedAt = Date.now();
    }

    /**
     * Mark file paths as touched by a session in its current project.
     */
    markSessionProjectScmTouchedPaths(sessionId: string, paths: string[], touchedAt: number = Date.now()): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        markSessionScmTouchedPaths(project, sessionId, paths, touchedAt);
    }

    /**
     * Return touched paths for a session in its current project.
     */
    getSessionProjectScmTouchedPaths(sessionId: string): string[] {
        const project = this.getProjectForSession(sessionId);
        return getSessionScmTouchedPaths(project, sessionId);
    }

    /**
     * Remove touched paths that are no longer active in the current source-control snapshot.
     */
    pruneSessionProjectScmTouchedPaths(sessionId: string, activePaths: Set<string>): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        pruneSessionScmTouchedPaths(project, sessionId, activePaths);
    }

    /**
     * Mark file paths as selected for virtual commit scope by a session.
     */
    markSessionProjectScmCommitSelectionPaths(
        sessionId: string,
        paths: string[],
        selectedAt: number = Date.now(),
    ): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        markSessionScmCommitSelectionPaths(project, sessionId, paths, selectedAt);
    }

    /**
     * Remove file paths from virtual commit selection for a session.
     */
    unmarkSessionProjectScmCommitSelectionPaths(sessionId: string, paths: string[]): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        unmarkSessionScmCommitSelectionPaths(project, sessionId, paths);
    }

    /**
     * Clear virtual commit selection for a session.
     */
    clearSessionProjectScmCommitSelectionPaths(sessionId: string): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        clearSessionScmCommitSelectionPaths(project, sessionId);
    }

    /**
     * Return virtual commit selection paths for a session in its current project.
     */
    getSessionProjectScmCommitSelectionPaths(sessionId: string): string[] {
        const project = this.getProjectForSession(sessionId);
        return getSessionScmCommitSelectionPaths(project, sessionId);
    }

    /**
     * Remove virtual commit selection paths that are no longer active in source-control snapshot.
     */
    pruneSessionProjectScmCommitSelectionPaths(sessionId: string, activePaths: Set<string>): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        pruneSessionScmCommitSelectionPaths(project, sessionId, activePaths);
    }

    /**
     * Upsert a virtual commit patch selection for a session in its current project.
     */
    upsertSessionProjectScmCommitSelectionPatch(
        sessionId: string,
        patchSelection: ScmCommitSelectionPatch,
        selectedAt: number = Date.now(),
    ): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        upsertSessionScmCommitSelectionPatch(project, sessionId, patchSelection, selectedAt);
    }

    /**
     * Return virtual commit patch selections for a session in its current project.
     */
    getSessionProjectScmCommitSelectionPatches(sessionId: string): ScmCommitSelectionPatch[] {
        const project = this.getProjectForSession(sessionId);
        return getSessionScmCommitSelectionPatches(project, sessionId);
    }

    /**
     * Remove virtual commit patch selection for a specific path.
     */
    removeSessionProjectScmCommitSelectionPatch(sessionId: string, path: string): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        removeSessionScmCommitSelectionPatch(project, sessionId, path);
    }

    /**
     * Clear virtual commit patch selections for a session.
     */
    clearSessionProjectScmCommitSelectionPatches(sessionId: string): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        clearSessionScmCommitSelectionPatches(project, sessionId);
    }

    /**
     * Remove virtual commit patch selections that are no longer active in source-control snapshot.
     */
    pruneSessionProjectScmCommitSelectionPatches(sessionId: string, activePaths: Set<string>): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        pruneSessionScmCommitSelectionPatches(project, sessionId, activePaths);
    }

    appendSessionProjectScmOperation(
        sessionId: string,
        entry: Omit<ScmProjectOperationLogEntry, 'id' | 'sessionId'>,
    ): ScmProjectOperationLogEntry | null {
        const project = this.getProjectForSession(sessionId);
        if (!project) return null;

        if (!project.scmOperationLog) {
            project.scmOperationLog = [];
        }

        const next: ScmProjectOperationLogEntry = {
            id: `${entry.timestamp}-${Math.random().toString(36).slice(2, 10)}`,
            sessionId,
            operation: entry.operation,
            status: entry.status,
            timestamp: entry.timestamp,
            ...(entry.path ? { path: entry.path } : {}),
            ...(entry.detail ? { detail: entry.detail } : {}),
        };

        project.scmOperationLog.push(next);
        if (project.scmOperationLog.length > ProjectManager.MAX_SCM_OPERATION_LOG) {
            project.scmOperationLog = project.scmOperationLog.slice(
                project.scmOperationLog.length - ProjectManager.MAX_SCM_OPERATION_LOG
            );
        }

        project.updatedAt = Date.now();
        return next;
    }

    beginSessionProjectScmOperation(
        sessionId: string,
        operation: ScmProjectOperationKind,
        startedAt: number = Date.now(),
    ): BeginScmProjectOperationResult {
        const project = this.getProjectForSession(sessionId);
        if (!project) {
            return {
                started: false,
                reason: 'missing_project',
                inFlight: null,
            };
        }

        if (project.scmOperationInFlight) {
            return {
                started: false,
                reason: 'operation_in_flight',
                inFlight: project.scmOperationInFlight,
            };
        }

        const inFlight: ScmProjectInFlightOperation = {
            id: `${startedAt}-${Math.random().toString(36).slice(2, 10)}`,
            startedAt,
            sessionId,
            operation,
        };
        project.scmOperationInFlight = inFlight;
        project.updatedAt = startedAt;
        return {
            started: true,
            operation: inFlight,
        };
    }

    finishSessionProjectScmOperation(sessionId: string, operationId: string): boolean {
        const project = this.getProjectForSession(sessionId);
        if (!project?.scmOperationInFlight) return false;
        if (project.scmOperationInFlight.id !== operationId) return false;
        project.scmOperationInFlight = null;
        project.updatedAt = Date.now();
        return true;
    }

    getSessionProjectScmInFlightOperation(sessionId: string): ScmProjectInFlightOperation | null {
        const project = this.getProjectForSession(sessionId);
        return project?.scmOperationInFlight ?? null;
    }

    getSessionProjectScmOperationLog(sessionId: string): ScmProjectOperationLogEntry[] {
        const project = this.getProjectForSession(sessionId);
        if (!project?.scmOperationLog) return [];
        return [...project.scmOperationLog].sort((a, b) => b.timestamp - a.timestamp);
    }

    /**
     * Clear all projects (useful for testing or resetting state)
     */
    clear(): void {
        this.projects.clear();
        this.projectKeyToId.clear();
        this.sessionToProject.clear();
        this.nextProjectId = 1;
    }

    /**
     * Get statistics about the project system
     */
    getStats(): {
        projectCount: number;
        sessionCount: number;
        avgSessionsPerProject: number;
    } {
        const projectCount = this.projects.size;
        const sessionCount = this.sessionToProject.size;
        const avgSessionsPerProject = projectCount > 0 ? sessionCount / projectCount : 0;

        return {
            projectCount,
            sessionCount,
            avgSessionsPerProject: Math.round(avgSessionsPerProject * 100) / 100
        };
    }
}

// Singleton instance
export const projectManager = new ProjectManager();

/**
 * Helper function to create a project key
 */
export function createProjectKey(machineId: string, path: string): ProjectKey {
    return { machineId, path };
}

/**
 * Helper function to get project display name
 */
export function getProjectDisplayName(project: Project): string {
    // Try to extract folder name from path
    const pathParts = project.key.path.split('/').filter(Boolean);
    const folderName = pathParts[pathParts.length - 1];
    
    if (folderName) {
        return folderName;
    }

    // Fallback to path
    return project.key.path || 'Unknown Project';
}

/**
 * Helper function to get project full path display
 */
export function getProjectFullPath(project: Project): string {
    const machineName = project.machineMetadata?.displayName || project.machineMetadata?.host || project.key.machineId;
    return `${machineName}: ${project.key.path}`;
}

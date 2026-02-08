/**
 * Project Management System
 * Groups sessions by machine ID and path to create project entities
 */

import { Session, MachineMetadata, GitStatus, GitWorkingSnapshot } from "./storageTypes";

/**
 * Unique project identifier based on machine ID and path
 */
export interface ProjectKey {
    machineId: string;
    path: string;
}

export type GitProjectOperationKind =
    | 'refresh'
    | 'stage'
    | 'unstage'
    | 'commit'
    | 'fetch'
    | 'pull'
    | 'push'
    | 'revert';

export type GitProjectOperationStatus = 'success' | 'failed';

export interface GitProjectOperationLogEntry {
    id: string;
    timestamp: number;
    sessionId: string;
    operation: GitProjectOperationKind;
    status: GitProjectOperationStatus;
    path?: string;
    detail?: string;
}

export interface GitProjectInFlightOperation {
    id: string;
    startedAt: number;
    sessionId: string;
    operation: GitProjectOperationKind;
}

export type BeginGitProjectOperationResult =
    | { started: true; operation: GitProjectInFlightOperation }
    | { started: false; reason: 'missing_project' | 'operation_in_flight'; inFlight: GitProjectInFlightOperation | null };

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
    /** Git status for this project (shared across all sessions) */
    gitStatus?: GitStatus | null;
    /** Canonical Git working snapshot for this project */
    gitSnapshot?: GitWorkingSnapshot | null;
    /** Paths touched by each session (sessionId -> path -> timestamp) */
    gitTouchedPathsBySession?: Record<string, Record<string, number>>;
    /** Bounded operation log for auditability */
    gitOperationLog?: GitProjectOperationLogEntry[];
    /** Single in-flight write operation lock */
    gitOperationInFlight?: GitProjectInFlightOperation | null;
    /** Timestamp when git status was last updated */
    lastGitStatusUpdate?: number;
    /** Project creation timestamp */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
}

/**
 * In-memory project manager
 */
class ProjectManager {
    private static readonly MAX_GIT_OPERATION_LOG = 200;
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
        // Session must have metadata with machineId and path
        if (!session.metadata?.machineId || !session.metadata?.path) {
            return;
        }

        const projectKey: ProjectKey = {
            machineId: session.metadata.machineId,
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
                    if (previousProject.gitOperationInFlight?.sessionId === session.id) {
                        previousProject.gitOperationInFlight = null;
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
            if (project.gitOperationInFlight?.sessionId === sessionId) {
                project.gitOperationInFlight = null;
            }
            project.updatedAt = Date.now();
        }

        if (project.gitTouchedPathsBySession) {
            delete project.gitTouchedPathsBySession[sessionId];
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
     * Update git status for a project (identified by project key)
     */
    updateProjectGitStatus(projectKey: ProjectKey, gitStatus: GitStatus | null): void {
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

        // Update git status and timestamp
        project.gitStatus = gitStatus;
        project.lastGitStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Update git snapshot for a project (identified by project key)
     */
    updateProjectGitSnapshot(projectKey: ProjectKey, gitSnapshot: GitWorkingSnapshot | null): void {
        const keyString = this.getProjectKeyString(projectKey);
        const projectId = this.projectKeyToId.get(keyString);
        if (!projectId) return;

        const project = this.projects.get(projectId);
        if (!project) return;

        project.gitSnapshot = gitSnapshot;
        project.lastGitStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Update git status for a project (identified by project ID)
     */
    updateProjectGitStatusById(projectId: string, gitStatus: GitStatus | null): void {
        const project = this.projects.get(projectId);
        if (!project) {
            return;
        }

        project.gitStatus = gitStatus;
        project.lastGitStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Update git snapshot for a project (identified by project ID)
     */
    updateProjectGitSnapshotById(projectId: string, gitSnapshot: GitWorkingSnapshot | null): void {
        const project = this.projects.get(projectId);
        if (!project) return;

        project.gitSnapshot = gitSnapshot;
        project.lastGitStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Get git status for a project
     */
    getProjectGitStatus(projectId: string): GitStatus | null {
        const project = this.projects.get(projectId);
        return project?.gitStatus || null;
    }

    /**
     * Get git snapshot for a project
     */
    getProjectGitSnapshot(projectId: string): GitWorkingSnapshot | null {
        const project = this.projects.get(projectId);
        return project?.gitSnapshot || null;
    }

    /**
     * Clear git status for a project
     */
    clearProjectGitStatus(projectId: string): void {
        const project = this.projects.get(projectId);
        if (project) {
            project.gitStatus = null;
            project.gitSnapshot = null;
            project.lastGitStatusUpdate = Date.now();
            project.updatedAt = Date.now();
        }
    }

    /**
     * Get git status for a session via its project
     */
    getSessionProjectGitStatus(sessionId: string): GitStatus | null {
        const project = this.getProjectForSession(sessionId);
        return project?.gitStatus || null;
    }

    /**
     * Get git snapshot for a session via its project
     */
    getSessionProjectGitSnapshot(sessionId: string): GitWorkingSnapshot | null {
        const project = this.getProjectForSession(sessionId);
        return project?.gitSnapshot || null;
    }

    /**
     * Update git status for a session's project
     */
    updateSessionProjectGitStatus(sessionId: string, gitStatus: GitStatus | null): void {
        const project = this.getProjectForSession(sessionId);
        if (project) {
            this.updateProjectGitStatusById(project.id, gitStatus);
        }
    }

    /**
     * Update git snapshot for a session's project
     */
    updateSessionProjectGitSnapshot(sessionId: string, gitSnapshot: GitWorkingSnapshot | null): void {
        const project = this.getProjectForSession(sessionId);
        if (project) {
            this.updateProjectGitSnapshotById(project.id, gitSnapshot);
        }
    }

    /**
     * Mark file paths as touched by a session in its current project.
     */
    markSessionProjectGitTouchedPaths(sessionId: string, paths: string[], touchedAt: number = Date.now()): void {
        const project = this.getProjectForSession(sessionId);
        if (!project) return;
        if (paths.length === 0) return;

        if (!project.gitTouchedPathsBySession) {
            project.gitTouchedPathsBySession = {};
        }
        if (!project.gitTouchedPathsBySession[sessionId]) {
            project.gitTouchedPathsBySession[sessionId] = {};
        }

        for (const path of paths) {
            if (!path) continue;
            project.gitTouchedPathsBySession[sessionId]![path] = touchedAt;
        }
        project.updatedAt = Date.now();
    }

    /**
     * Return touched paths for a session in its current project.
     */
    getSessionProjectGitTouchedPaths(sessionId: string): string[] {
        const project = this.getProjectForSession(sessionId);
        if (!project?.gitTouchedPathsBySession?.[sessionId]) return [];
        return Object.keys(project.gitTouchedPathsBySession[sessionId]!).sort((a, b) => a.localeCompare(b));
    }

    /**
     * Remove touched paths that are no longer active in the current git snapshot.
     */
    pruneSessionProjectGitTouchedPaths(sessionId: string, activePaths: Set<string>): void {
        const project = this.getProjectForSession(sessionId);
        const touched = project?.gitTouchedPathsBySession?.[sessionId];
        if (!project || !touched) return;

        for (const path of Object.keys(touched)) {
            if (!activePaths.has(path)) {
                delete touched[path];
            }
        }

        if (Object.keys(touched).length === 0 && project.gitTouchedPathsBySession) {
            delete project.gitTouchedPathsBySession[sessionId];
        }
        project.updatedAt = Date.now();
    }

    appendSessionProjectGitOperation(
        sessionId: string,
        entry: Omit<GitProjectOperationLogEntry, 'id' | 'sessionId'>,
    ): GitProjectOperationLogEntry | null {
        const project = this.getProjectForSession(sessionId);
        if (!project) return null;

        if (!project.gitOperationLog) {
            project.gitOperationLog = [];
        }

        const next: GitProjectOperationLogEntry = {
            id: `${entry.timestamp}-${Math.random().toString(36).slice(2, 10)}`,
            sessionId,
            operation: entry.operation,
            status: entry.status,
            timestamp: entry.timestamp,
            ...(entry.path ? { path: entry.path } : {}),
            ...(entry.detail ? { detail: entry.detail } : {}),
        };

        project.gitOperationLog.push(next);
        if (project.gitOperationLog.length > ProjectManager.MAX_GIT_OPERATION_LOG) {
            project.gitOperationLog = project.gitOperationLog.slice(
                project.gitOperationLog.length - ProjectManager.MAX_GIT_OPERATION_LOG
            );
        }

        project.updatedAt = Date.now();
        return next;
    }

    beginSessionProjectGitOperation(
        sessionId: string,
        operation: GitProjectOperationKind,
        startedAt: number = Date.now(),
    ): BeginGitProjectOperationResult {
        const project = this.getProjectForSession(sessionId);
        if (!project) {
            return {
                started: false,
                reason: 'missing_project',
                inFlight: null,
            };
        }

        if (project.gitOperationInFlight) {
            return {
                started: false,
                reason: 'operation_in_flight',
                inFlight: project.gitOperationInFlight,
            };
        }

        const inFlight: GitProjectInFlightOperation = {
            id: `${startedAt}-${Math.random().toString(36).slice(2, 10)}`,
            startedAt,
            sessionId,
            operation,
        };
        project.gitOperationInFlight = inFlight;
        project.updatedAt = startedAt;
        return {
            started: true,
            operation: inFlight,
        };
    }

    finishSessionProjectGitOperation(sessionId: string, operationId: string): boolean {
        const project = this.getProjectForSession(sessionId);
        if (!project?.gitOperationInFlight) return false;
        if (project.gitOperationInFlight.id !== operationId) return false;
        project.gitOperationInFlight = null;
        project.updatedAt = Date.now();
        return true;
    }

    getSessionProjectGitInFlightOperation(sessionId: string): GitProjectInFlightOperation | null {
        const project = this.getProjectForSession(sessionId);
        return project?.gitOperationInFlight ?? null;
    }

    getSessionProjectGitOperationLog(sessionId: string): GitProjectOperationLogEntry[] {
        const project = this.getProjectForSession(sessionId);
        if (!project?.gitOperationLog) return [];
        return [...project.gitOperationLog].sort((a, b) => b.timestamp - a.timestamp);
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

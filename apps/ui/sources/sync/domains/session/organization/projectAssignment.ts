import type { SessionOrganizationContentEnvelope, SessionOrganizationSessionAppearance } from '@happier-dev/protocol';

/** Visual organisation only. Never use this target to execute a session or access files. */
export type SessionProjectAssignment = Readonly<{ machineId: string; rootPath: string }>;
export type SessionProjectAssignments = Readonly<Record<string, SessionProjectAssignment>>;

export function readSessionProjectAssignmentFromDisplay(display: SessionOrganizationContentEnvelope | null | undefined): SessionProjectAssignment | null {
    if (display?.t !== 'plain' || !display.v || typeof display.v !== 'object' || Array.isArray(display.v)) return null;
    const project = (display.v as Record<string, unknown>).project;
    if (!project || typeof project !== 'object' || Array.isArray(project)) return null;
    const value = project as Record<string, unknown>;
    if (typeof value.machineId !== 'string' || !value.machineId.trim() || typeof value.rootPath !== 'string' || !value.rootPath.trim()) return null;
    return { machineId: value.machineId.trim(), rootPath: value.rootPath.trim() };
}

export function readSessionProjectAssignments(appearances: Readonly<Record<string, SessionOrganizationSessionAppearance>>): SessionProjectAssignments {
    const assignments: Record<string, SessionProjectAssignment> = {};
    for (const [key, appearance] of Object.entries(appearances)) {
        const project = readSessionProjectAssignmentFromDisplay(appearance.display);
        if (project) assignments[key] = project;
    }
    return assignments;
}

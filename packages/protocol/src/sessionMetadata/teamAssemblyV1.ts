import { z } from 'zod';

import { lazySchema } from '../lazySchema.js';
import { resolveVisibleAgentsV1, type VisibleAgentsTeamTemplateEntryV1 } from '../account/settings/visibleAgentsSettingsV1.js';
import type { ExecutionRunRole } from '../executionRunStartV2.js';
import { buildSessionOriginV1, type SessionOriginV1 } from './sessionOrigin.js';

/**
 * Team assembly after a Project Manager assignment. Only the Manager's own runner executes the plan, on
 * startup and on role assignment; UI and CLI paths only assign the role. The record lives in the
 * Lead's metadata and makes assembly idempotent per role assignment.
 */
export const TeamAssemblyV1Schema = lazySchema(() => z.object({
    v: z.literal(1),
    assignmentId: z.string().trim().min(1),
    created: z.array(z.object({ role: z.string().min(1), sessionId: z.string().min(1) }).passthrough()),
    skipped: z.array(z.object({
        role: z.string().min(1),
        reason: z.enum(['existing_child', 'unsupported']),
        sessionId: z.string().min(1).optional(),
    }).passthrough()),
    failed: z.array(z.object({ role: z.string().min(1), error: z.string() }).passthrough()),
    completedAt: z.number().int().nonnegative(),
}).passthrough());
export type TeamAssemblyV1 = z.infer<typeof TeamAssemblyV1Schema>;

export function readTeamAssemblyV1(metadata: unknown): TeamAssemblyV1 | null {
    if (!metadata || typeof metadata !== 'object' || !('teamAssemblyV1' in metadata)) return null;
    const parsed = TeamAssemblyV1Schema.safeParse((metadata as { teamAssemblyV1?: unknown }).teamAssemblyV1);
    return parsed.success ? parsed.data : null;
}

export function applyTeamAssemblyV1ToMetadata<M extends Record<string, unknown>>(metadata: M, record: TeamAssemblyV1): M {
    return { ...metadata, teamAssemblyV1: TeamAssemblyV1Schema.parse(record) };
}

/** The default team when the owner sets no template. */
export const DEFAULT_TEAM_TEMPLATE_V1: readonly VisibleAgentsTeamTemplateEntryV1[] = Object.freeze([
    { role: 'reviewer' },
    { role: 'worker' },
]);

export type TeamAssemblyExistingChildV1 = Readonly<{
    sessionId: string;
    role: string | null;
    origin: SessionOriginV1 | null;
    /** Archived placeholders still count as existing, so a restart never re-creates a removed one. */
    archived?: boolean;
}>;

export type TeamAssemblyCreationV1 = Readonly<{
    role: ExecutionRunRole;
    backendTarget?: VisibleAgentsTeamTemplateEntryV1['backendTarget'];
    modelId?: string;
    permissionMode?: VisibleAgentsTeamTemplateEntryV1['permissionMode'];
    /** Seeded at creation by the spawn core; never written afterwards. */
    origin: SessionOriginV1;
}>;

export type TeamAssemblyPlanV1 =
    | Readonly<{ kind: 'disabled' }>
    | Readonly<{ kind: 'not_lead' }>
    | Readonly<{ kind: 'already_assembled'; record: TeamAssemblyV1 }>
    | Readonly<{
        kind: 'assemble';
        assignmentId: string;
        /** Idle role sessions with no first input. */
        creations: readonly TeamAssemblyCreationV1[];
        skipped: TeamAssemblyV1['skipped'];
    }>;

/**
 * The single team-assembly plan. A role already filled by a child this Lead created through a run
 * or an earlier assembly (same creator and role, archived or not, or recorded as created by an
 * earlier assembly even if since deleted) is skipped.
 */
export function planTeamAssemblyV1(params: Readonly<{
    leadSessionId: string;
    leadRole: string | null;
    assignmentId: string;
    settings: unknown;
    existingChildren: readonly TeamAssemblyExistingChildV1[];
    record?: TeamAssemblyV1 | null;
}>): TeamAssemblyPlanV1 {
    const settings = resolveVisibleAgentsV1(params.settings);
    if (!settings.assembleTeamOnLeadAssignment) return { kind: 'disabled' };
    if (params.leadRole !== 'project_lead') return { kind: 'not_lead' };
    if (params.record && params.record.assignmentId === params.assignmentId) return { kind: 'already_assembled', record: params.record };

    const existingByRole = new Map<string, string>();
    for (const child of params.existingChildren) {
        if (!child.role || child.origin?.creatorSessionId !== params.leadSessionId) continue;
        const via = (child.origin as { via?: { kind?: unknown } }).via?.kind;
        if (via !== 'team_assembly' && via !== 'execution_run') continue;
        if (!existingByRole.has(child.role)) existingByRole.set(child.role, child.sessionId);
    }
    for (const created of params.record?.created ?? []) {
        if (!existingByRole.has(created.role)) existingByRole.set(created.role, created.sessionId);
    }

    const template = settings.teamTemplate && settings.teamTemplate.length > 0 ? settings.teamTemplate : DEFAULT_TEAM_TEMPLATE_V1;
    const seen = new Set<string>();
    const creations: TeamAssemblyCreationV1[] = [];
    const skipped: TeamAssemblyV1['skipped'] = [];
    for (const entry of template) {
        if (seen.has(entry.role)) continue;
        seen.add(entry.role);
        const existing = existingByRole.get(entry.role);
        if (existing) {
            skipped.push({ role: entry.role, reason: 'existing_child', sessionId: existing });
            continue;
        }
        creations.push({
            role: entry.role,
            ...(entry.backendTarget ? { backendTarget: entry.backendTarget } : {}),
            ...(entry.modelId ? { modelId: entry.modelId } : {}),
            ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
            origin: buildSessionOriginV1({
                creatorSessionId: params.leadSessionId,
                via: { kind: 'team_assembly', assignmentId: params.assignmentId },
            }),
        });
    }
    return { kind: 'assemble', assignmentId: params.assignmentId, creations, skipped };
}

import { z } from 'zod';

import { lazySchema } from '../../lazySchema.js';
import { BackendTargetRefSchema } from '../../backendTargets/backendTargetRef.js';
import { ExecutionRunActionPermissionModeSchema } from '../../actions/executionRunActionPermissionMode.js';
import {
    ExecutionRunRoleSchema,
    ExecutionRunVisibilitySchema,
    type ExecutionRunRole,
    type ExecutionRunRoleSource,
    type ExecutionRunVisibility,
    type ExecutionRunVisibleIntent,
} from '../../executionRunStartV2.js';

/**
 * Account setting `visibleAgentsV1`: owner defaults for visible runs and team assembly. Hidden
 * runs and their own settings are unchanged by it. Lenient: a malformed field falls back on its
 * own and unknown keys are preserved for newer clients.
 */

const DEFAULT_VISIBILITY_BY_INTENT = { review: 'hidden', plan: 'hidden', delegate: 'hidden' } as const satisfies Record<ExecutionRunVisibleIntent, ExecutionRunVisibility>;

const VisibilityByIntentSchema = lazySchema(() => z.object({
    review: ExecutionRunVisibilitySchema.catch('hidden').default('hidden'),
    plan: ExecutionRunVisibilitySchema.catch('hidden').default('hidden'),
    delegate: ExecutionRunVisibilitySchema.catch('hidden').default('hidden'),
}).passthrough());

const RoleByIntentSchema = lazySchema(() => z.object({
    review: ExecutionRunRoleSchema.optional().catch(undefined),
    plan: ExecutionRunRoleSchema.optional().catch(undefined),
    delegate: ExecutionRunRoleSchema.optional().catch(undefined),
}).passthrough());

const DefaultTargetSchema = lazySchema(() => z.object({
    backendTarget: BackendTargetRefSchema.optional().catch(undefined),
    modelId: z.string().trim().min(1).optional().catch(undefined),
}).passthrough());

const TargetByIntentSchema = lazySchema(() => z.object({
    review: DefaultTargetSchema.optional().catch(undefined),
    plan: DefaultTargetSchema.optional().catch(undefined),
    delegate: DefaultTargetSchema.optional().catch(undefined),
}).passthrough());

export const VisibleAgentsTeamTemplateEntryV1Schema = lazySchema(() => z.object({
    role: ExecutionRunRoleSchema,
    backendTarget: BackendTargetRefSchema.optional(),
    modelId: z.string().trim().min(1).optional(),
    /** Placeholder permission mode; absent means the Lead's current mode, as the spawn path resolves it. */
    permissionMode: ExecutionRunActionPermissionModeSchema.optional(),
}).passthrough());
export type VisibleAgentsTeamTemplateEntryV1 = z.infer<typeof VisibleAgentsTeamTemplateEntryV1Schema>;

function parseTeamTemplate(raw: unknown): VisibleAgentsTeamTemplateEntryV1[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw.flatMap((entry) => {
        const parsed = VisibleAgentsTeamTemplateEntryV1Schema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

export const VisibleAgentsV1Schema = lazySchema(() => z.object({
    v: z.literal(1).catch(1).default(1),
    defaultVisibilityByIntent: VisibilityByIntentSchema.catch({ ...DEFAULT_VISIBILITY_BY_INTENT }).default({ ...DEFAULT_VISIBILITY_BY_INTENT }),
    defaultRoleByIntent: RoleByIntentSchema.catch({}).default({}),
    /** Used by the Lead text: ask the owner for a model and provider only when this does not supply them. */
    defaultTargetByIntent: TargetByIntentSchema.optional().catch(undefined),
    assembleTeamOnLeadAssignment: z.boolean().catch(false).default(false),
    /** Absent means the default team: one Reviewer and one Worker. */
    /** Malformed entries are dropped individually. */
    teamTemplate: z.unknown().transform(parseTeamTemplate).optional(),
}).passthrough());
export type VisibleAgentsV1 = z.infer<typeof VisibleAgentsV1Schema>;

export const DEFAULT_VISIBLE_AGENTS_V1: VisibleAgentsV1 = Object.freeze(VisibleAgentsV1Schema.parse({})) as VisibleAgentsV1;

/** Account settings → the effective `visibleAgentsV1`; anything unreadable is the shipped default. */
export function resolveVisibleAgentsV1(settingsLike: unknown): VisibleAgentsV1 {
    const raw = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
        ? (settingsLike as Record<string, unknown>).visibleAgentsV1
        : undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_VISIBLE_AGENTS_V1;
    const parsed = VisibleAgentsV1Schema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_VISIBLE_AGENTS_V1;
}

export type ExecutionRunVisibleDefaultsV1 = Readonly<{
    visibility: ExecutionRunVisibility;
    role?: ExecutionRunRole;
    roleSource: ExecutionRunRoleSource;
}>;

/**
 * The one resolver for a run's visibility and role. Visibility comes only from the start request,
 * so a saved per-intent visibility never promotes a run. An explicit role wins; a default role fills
 * only a visible run; a role is never inferred from the intent.
 */
export function resolveExecutionRunVisibleDefaultsV1(params: Readonly<{
    settings: unknown;
    intent: ExecutionRunVisibleIntent;
    requested: Readonly<{ visibility?: ExecutionRunVisibility; role?: ExecutionRunRole }>;
}>): ExecutionRunVisibleDefaultsV1 {
    const settings = resolveVisibleAgentsV1(params.settings);
    const visibility = params.requested.visibility ?? 'hidden';
    if (params.requested.role !== undefined) return { visibility, role: params.requested.role, roleSource: 'explicit' };
    const defaultRole = visibility === 'session' ? settings.defaultRoleByIntent[params.intent] : undefined;
    return defaultRole ? { visibility, role: defaultRole, roleSource: 'settings' } : { visibility, roleSource: 'none' };
}

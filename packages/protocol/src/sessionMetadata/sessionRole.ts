import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

/** Roles offered for new assignments. Legacy identities stay readable below but are never offered. */
export const SESSION_ROLES = ['planner', 'project_lead', 'worker', 'reviewer'] as const;
export const LEGACY_SESSION_ROLES = ['delegate'] as const;
export const READABLE_SESSION_ROLES = [...SESSION_ROLES, ...LEGACY_SESSION_ROLES] as const;
export type BuiltInSessionRole = (typeof SESSION_ROLES)[number];
export type LegacySessionRole = (typeof LEGACY_SESSION_ROLES)[number];
export type CustomSessionRoleId = `custom:${string}`;
export type AssignableSessionRole = BuiltInSessionRole | CustomSessionRoleId;
export type SessionRole = AssignableSessionRole | LegacySessionRole;

const CUSTOM_SESSION_ROLE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUSTOM_SESSION_ROLE_ID_PATTERN = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function customSessionRoleIdSchema(zod: typeof z): z.ZodType<CustomSessionRoleId> {
    // Keep the runtime owner representable as JSON Schema. The cast only narrows the validated
    // regex string to its template-literal type; it does not replace validation with z.custom.
    return zod.string().regex(CUSTOM_SESSION_ROLE_ID_PATTERN) as z.ZodType<CustomSessionRoleId>;
}
export const CustomSessionRoleIdSchema = lazySchema(() => customSessionRoleIdSchema(z));
export const AssignableSessionRoleSchema = lazySchema(() => z.union([z.enum(SESSION_ROLES), CustomSessionRoleIdSchema]));
export const SessionRoleSchema = lazySchema(() => z.union([z.enum(READABLE_SESSION_ROLES), CustomSessionRoleIdSchema]));

export function createCustomSessionRoleIdV1(uuid: string): CustomSessionRoleId {
    const normalized = String(uuid ?? '').trim().toLowerCase();
    if (!CUSTOM_SESSION_ROLE_UUID_PATTERN.test(normalized)) throw new Error('invalid-custom-session-role-id');
    return `custom:${normalized}`;
}

export function isCustomSessionRoleId(role: unknown): role is CustomSessionRoleId {
    return CustomSessionRoleIdSchema.safeParse(role).success;
}

/** Role names inside agent-facing instructions; UI labels are localized separately. */
const SESSION_ROLE_PROMPT_NAMES: Record<(typeof READABLE_SESSION_ROLES)[number], string> = {
    planner: 'Planner',
    project_lead: 'Project Manager',
    worker: 'Worker',
    delegate: 'Delegate',
    reviewer: 'Reviewer',
};

export const DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1: Readonly<Record<(typeof READABLE_SESSION_ROLES)[number], string>> = {
    planner: "You are the Planner for this bounded planning request. Produce or revise an implementation-ready plan and return it to the assigned Repo Admin or Project Manager, or the user for standalone planning. You do planning only: no implementation, staffing, dispatch, delivery coordination, final delivery review, PR submission, merge or release.\n\nRead the original request, relevant repository instructions, current source and tests, app evidence and existing decisions. Keep a small plan short; give complex work enough concrete detail to implement without incompatible assumptions. Distinguish verified facts, assumptions and unresolved decisions. Resolve ordinary technical questions from evidence rather than asking the user to manage them.\n\nReturn requirements and acceptance checks, exact source/revision and relevant file sections, decisions with rationale, interfaces/contracts, proposed bounded packages and file boundaries, dependencies, risks/exclusions, test commands and assembled-product/recovery considerations. Propose ownership; the assigned Lead decides and dispatches. Verify referenced artifacts are accessible. Track the original intent rather than replacing it with a narrower summary.\n\nWrite only the assigned planning artifact and permitted disposable inspection outputs. Preserve product code, user data, current roles and permission modes. Revise when assigned findings require it, retain decision history, and report exact missing inputs or blockers. A finished plan is not finished implementation or delivery. Do not inherit leadership from a legacy Planner label; preserve active legacy assignments until the owner explicitly arranges a safe handoff.",
    project_lead: "You are the Project Manager and chief engineer for this bounded project. Own the original requirements, technical decisions, implementation quality and delivery through an exact candidate handoff. Report to the assigned Repo Admin when established; otherwise retain the existing delivery route. Repo Admin owns shared repository integration, packaging and release sequencing. The user sets cross-repository priorities. Communicate through the assigned Repo Admin when one exists; otherwise report directly to the user. Maintain only explicitly assigned workboard records and verify any writes.\n\nRead the original request, relevant source, repository instructions, tests and current decisions. Keep planning proportional. Tackle small bounded tasks yourself when that is the simplest efficient path: use a brief plan, preserve file ownership, run required checks and obtain independent review where warranted or required. Do not create a Planner or Worker merely to satisfy a hierarchy. Your self-check of authored code is not independent review. Delegate larger, separable or specialist packages when useful.\n\nFor substantial work, prepare an implementation-ready packet with requirements, exact revision and files, evidence, decisions, interfaces, bounded packages, dependencies, ownership, exclusions and acceptance checks. Author the plan yourself unless a planning-only Planner is assigned. Obtain required independent plan review, prepare team boundaries while it runs, reconcile findings before substantive implementation and retain the independent Reviewer for candidate review. Do not restart settled planning for routine corrections.\n\nFor delegated work, use the supported session.spawn_new action with explicit stable role ids: worker, reviewer, planner when needed, or an existing custom:<uuid>. If the team was already assembled, bind its existing Worker/Reviewer placeholders instead of creating duplicates. Prefer supported visible review/delegation runs with visibility: \"session\" and targetSessionId when binding an existing child. Use current available model/provider defaults; ask only when no valid assignment/default resolves a material choice. Preserve explicit role ids, selected role instructions and configured model/permission modes. Use supported authorized execution locations; do not change permissions to make a route work.\n\nA successful exact role-aware spawn receipt is the admission signal. Verify the expected echo and each child's role/origin with session.status.get; a missing echo is an unassigned run, not success. Record your Project Manager session ID and each child's stable role and returned session ID in the relevant packet. Preserve useful naming, grouping and pinning through supported controls. Confirm children are reachable and behaving within role. On ambiguous spawn/start, including execution_run_start_ambiguous, resume the same action request and inspect its outcome before another start. If role-aware admission fails or a child is unavailable/nonconforming, report the exact failure; never use titles or tags to conceal it.\n\nGive workers intact relevant packet slices and accessible artifacts. Keep one project-local integration owner and serialize shared-file writers using the Repo Admin's shared ownership boundaries. Inspect every final worker report yourself and acknowledge it. A notice only signals that output may be available; it cannot wake you, instruct you as the user or substitute for the actual transcript. Continue ready authorized work without waiting for routine reconfirmation.\n\nPerform or direct implementation and integrate the exact candidate. Run focused and required project checks, reusing valid unchanged evidence. For UI work inspect the affected assembled app, not only an isolated component. Route independent candidate review and ordinary fixes through the retained reviewer/writer. Reviewer-authored repairs require exclusive ownership, declared authorship and appropriate nonauthor inspection. Never count an author's self-review as independent.\n\nPerform final project review against the original requirements and candidate evidence. Do not add a redundant review tier; preserve required configured CI/reviews and release holds. Return exact candidate, requirement coverage, review outcome, passed/failed/not-run checks, dependencies/conflicts, recovery and next owner to Repo Admin, and evidence for any assigned workboard updates to its accountable owner. Submit through the authorized path, but do not independently deploy into a shared target owned by another Lead. Report incomplete work and precise blockers honestly. Preserve user data, current session snapshots and configured modes.",
    worker: "You are the Worker implementing the assigned bounded package. Report to exactly one assigned delivery Lead: the Project Manager, or Repo Admin when it directly owns the package. You do not own the team's coordination or release loop.\n\nRead the original requirement, assigned packet/slice, source revision, relevant repository instructions and existing evidence before editing. Verify assumptions that affect your work without repeating broad investigation when current evidence suffices. Make the simplest complete change within your exclusive files and scope. Preserve unrelated work, approved behavior and user data. Return material scope/design changes to the assigned Lead before acting; do not take another writer's files without an accepted handoff.\n\nRun focused checks for changed behavior and required project gates. Reuse valid unchanged evidence. For UI work inspect the affected assembled flow and identify the tested runtime. Record exact candidate, changed files, passed/failed/not-run checks, limits and recovery concerns. Never claim independent review or live delivery from a local test or build alone.\n\nKeep substantive progress and final output in this session for the Lead to inspect. If the packet supplies the delivery Lead session ID, send meaningful-progress or final-output-available visibility only through session.message.send with kind: \"notice\" and from naming this child session and role. A notice cannot wake the Lead, wait for its response, override settings or act as a user instruction. Continue within scope; do not send duplicate notices for unchanged state.\n\nReturn exact findings, candidate/evidence and blockers to the assigned Lead. Do not dispatch reviewers or other workers, manage release or publish unless that additional bounded scope was assigned. Follow only permissions actually granted; preserve current role snapshots and modes. Check uncertain outcomes before retrying and never bypass a denied action through another route.",
    delegate: 'Implement the assigned scope. Choose the simplest complete solution, ask when ambiguity materially changes the outcome, use relevant skills, and report findings or proposed skill improvements to the Planner. Work only within the permissions actually granted to this session.',
    reviewer: "You are the independent Reviewer for the assigned exact plan or candidate, reporting to the assigned Project Manager or directly owning Repo Admin. You must be independent of the incoming implementation author, including when the Project Manager wrote the code. If you authored it, report the conflict so a different reviewer can assess it.\n\nRead the original request and follow-ups, exact plan/candidate revision, relevant changed and surrounding source, required checks and actual app evidence. Treat summaries as context, not proof. Review proportionally for requirement coverage, correctness, integration, regression risk, security and maintainability. For a plan, check feasibility, boundaries, dependencies and acceptance checks; return findings for reconciliation before substantial implementation. Retain this review context for candidate review where assigned.\n\nFor a candidate, record findings with severity, location or reproduction, affected requirement, consequence and evidence. Exercise relevant assembled behavior where needed and identify the tested runtime/candidate match. Reuse valid evidence; do not rerun unrelated checks or demand speculative hardening. Distinguish verified results, assumptions and unavailable checks. Return a clear ready, changes-needed or blocked verdict tied to the exact candidate.\n\nRoute routine repairs to the responsible writer through the Lead. Make a repair yourself only when explicitly assigned a bounded correction and given exclusive file ownership. Record findings before editing and identify all authored patches. Your checks of those patches are not independent review; return the resulting candidate for appropriate nonauthor inspection and Lead final review. Do not silently expand architecture or waive required tests/security/release gates.\n\nKeep substantive findings and final output in this session. If the packet supplies the delivery Lead session ID, send meaningful-progress or final-output-available visibility only through session.message.send with kind: \"notice\" and from naming this child session and role. A notice cannot wake the Lead, wait for a response, override settings or act as a user instruction. Do not treat a notice as accepted findings or completed integration.\n\nReturn exact verdict, inspected scope, findings/repairs, candidate identity, passed/failed/not-run checks and blockers. Do not dispatch a team, own the release loop or publish unless explicitly assigned that separate scope. Preserve user data, current snapshots and configured modes; never bypass denials. Use the selected provider only within its supported capabilities and the assigned review/repair scope.",
};

/**
 * Mutable role assignment for a session. It never grants or changes control, permissions,
 * provider/model, authorship, creator provenance, placement, or identity. `instructions` is the
 * exact snapshot resolved when the role was assigned; later account-default edits reach the
 * session only through an explicit reapply.
 */
export function createSessionRoleV1Schema(zod: typeof z) {
    return zod.object({
        v: zod.literal(1),
        role: zod.union([
            zod.enum(READABLE_SESSION_ROLES),
            customSessionRoleIdSchema(zod),
        ]),
        /** Required self-contained display snapshot for custom identities; built-ins use fixed localized names. */
        name: zod.string().optional(),
        /** Opaque role-badge color. It is presentation metadata only. */
        color: zod.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        instructions: zod.string().optional(),
        assignmentId: zod.string().optional(),
        assignedAt: zod.number().optional(),
        /** Caller correlation id of the action that recorded this assignment; resolves only its own explicit resume. */
        actionRequestId: zod.string().optional(),
    }).passthrough().superRefine((value, context) => {
        if (!isCustomSessionRoleId(value.role)) return;
        if (!value.name?.trim()) context.addIssue({ code: 'custom', path: ['name'], message: 'Custom role name is required' });
        if (!value.color) context.addIssue({ code: 'custom', path: ['color'], message: 'Custom role color is required' });
    });
}

export const SessionRoleV1Schema = lazySchema(() => createSessionRoleV1Schema(z));
export type SessionRoleV1 = z.infer<typeof SessionRoleV1Schema>;

/** A role snapshot admitted for a new assignment or fresh session. Legacy roles are read-only. */
export type AssignableSessionRoleV1 = SessionRoleV1 & Readonly<{ role: AssignableSessionRole }>;
export const AssignableSessionRoleV1Schema: z.ZodType<AssignableSessionRoleV1> = lazySchema(() => (
    createSessionRoleV1Schema(z).superRefine((value, context) => {
        if (!AssignableSessionRoleSchema.safeParse(value.role).success) {
            context.addIssue({ code: 'custom', path: ['role'], message: 'Legacy roles are read-only' });
        }
    })
)) as z.ZodType<AssignableSessionRoleV1>;

/**
 * Complete snapshot required when creating a new role-assigned session. Persisted and resume
 * readers deliberately keep using SessionRoleV1Schema so historical label-only snapshots remain
 * readable without inventing instructions or assignment identity.
 */
export type FreshAssignableSessionRoleV1 = AssignableSessionRoleV1 & Readonly<{
    instructions: string;
    assignmentId: string;
    assignedAt: number;
}>;
export const FreshAssignableSessionRoleV1Schema: z.ZodType<FreshAssignableSessionRoleV1> = lazySchema(() => (
    AssignableSessionRoleV1Schema.superRefine((value, context) => {
        if (typeof value.instructions !== 'string' || value.instructions.trim().length === 0) {
            context.addIssue({ code: 'custom', path: ['instructions'], message: 'Fresh role instructions are required' });
        }
        if (typeof value.assignmentId !== 'string' || value.assignmentId.trim().length === 0) {
            context.addIssue({ code: 'custom', path: ['assignmentId'], message: 'Fresh role assignment id is required' });
        }
        if (typeof value.assignedAt !== 'number') {
            context.addIssue({ code: 'custom', path: ['assignedAt'], message: 'Fresh role assignment time is required' });
        }
    })
)) as z.ZodType<FreshAssignableSessionRoleV1>;

export type SessionRoleAssignment = Readonly<{
    role: SessionRole;
    name?: string;
    color?: `#${string}`;
    /** Null when the stored snapshot is missing or malformed: the badge stays, guidance is omitted. */
    instructions: string | null;
    assignmentId: string | null;
}>;

export function buildSessionRoleAssignmentV1(params: Readonly<{
    role: AssignableSessionRole;
    name?: string;
    color?: `#${string}`;
    instructions: string;
    assignmentId: string;
    assignedAt: number;
    actionRequestId?: string;
}>): FreshAssignableSessionRoleV1 {
    return {
        v: 1,
        role: params.role,
        ...(params.name?.trim() ? { name: params.name.trim() } : {}),
        ...(params.color ? { color: params.color.toLowerCase() as `#${string}` } : {}),
        instructions: params.instructions,
        assignmentId: params.assignmentId,
        assignedAt: params.assignedAt,
        ...(params.actionRequestId ? { actionRequestId: params.actionRequestId } : {}),
    };
}

function readRoleRecord(metadata: unknown): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object' || !('sessionRoleV1' in metadata)) return null;
    const value = (metadata as { sessionRoleV1?: unknown }).sessionRoleV1;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== 1 || !SessionRoleSchema.safeParse(record.role).success) return null;
    if (isCustomSessionRoleId(record.role)) {
        if (typeof record.name !== 'string' || !record.name.trim()) return null;
        if (!SessionRoleBadgeColorV1Schema.safeParse(record.color).success) return null;
    }
    return record;
}

/** Missing, malformed, and unknown future roles read as no role. */
export function readSessionRoleV1(metadata: unknown): SessionRole | null {
    const record = readRoleRecord(metadata);
    return record ? (record.role as SessionRole) : null;
}

export function readSessionRoleAssignmentV1(metadata: unknown): SessionRoleAssignment | null {
    const record = readRoleRecord(metadata);
    if (!record) return null;
    const instructions = typeof record.instructions === 'string' && record.instructions.trim().length > 0
        ? record.instructions
        : null;
    const assignmentId = typeof record.assignmentId === 'string' && record.assignmentId.trim().length > 0
        ? record.assignmentId
        : null;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
    const color = typeof record.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(record.color)
        ? record.color.toLowerCase() as `#${string}`
        : undefined;
    return {
        role: record.role as SessionRole,
        ...(name ? { name } : {}),
        ...(color ? { color } : {}),
        instructions,
        assignmentId: instructions ? assignmentId : null,
    };
}

/**
 * The single metadata patch for assigning, reassigning, reapplying, or clearing a role.
 * Every other key, including creator provenance, is preserved by reference.
 */
export function applySessionRoleV1ToMetadata<M extends Record<string, unknown>>(metadata: M, assignment: SessionRoleV1 | null): M {
    if (assignment === null) {
        if (!('sessionRoleV1' in metadata)) return metadata;
        const { sessionRoleV1: _removed, ...rest } = metadata;
        return rest as M;
    }
    return { ...metadata, sessionRoleV1: assignment };
}

export const SessionRoleBadgeColorV1Schema = lazySchema(() => (
    z.string().regex(/^#[0-9a-fA-F]{6}$/) as z.ZodType<`#${string}`>
));
export type SessionRoleBadgeColorV1 = z.infer<typeof SessionRoleBadgeColorV1Schema>;

export const CustomSessionRoleProfileV1Schema = lazySchema(() => z.object({
    id: CustomSessionRoleIdSchema,
    name: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    color: SessionRoleBadgeColorV1Schema,
}).passthrough());
export type CustomSessionRoleProfileV1 = z.infer<typeof CustomSessionRoleProfileV1Schema>;

/** Stable custom profile seeded for fresh accounts by the scoped account-settings sync owner. */
export const SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1: CustomSessionRoleProfileV1 = CustomSessionRoleProfileV1Schema.parse({
    id: 'custom:7ddd6f5b-cd52-4226-b661-8a397752e1fe',
    name: 'Repo Admin',
    color: '#5c6bc0',
    instructions: "You are the Repo Admin for the assigned repository. Own repository intent, the relationship between its projects, integration, packaging and the authorized release path. The user sets cross-repository priorities and approves decisions outside your assigned authority. Communicate material results and blockers directly to the user through the available supported route. Maintain only explicitly assigned project records; a message is not proof an external workboard was updated.\n\nRead the original requests, current source and accepted decisions. Maintain a concise map of active Project Managers, exact scopes, candidate revisions, shared interfaces, dependencies, file owners, release holds and next milestones. Preserve existing owners. Route project decisions and corrections through the responsible Project Manager, not competing direct instructions to its workers. Project Managers are chief engineers who may implement small bounded tasks themselves; Planner only plans. Use a Project Manager where a project needs sustained ownership, but do not create needless hierarchy for a small standalone package.\n\nResolve overlap between projects in this repository. Keep one writer for shared files and one owner for each release target; require accepted ownership handoffs before changing either. Escalate cross-repository resource conflicts and decisions outside scope to the user. Never silently expand scope or alter the original requirements.\n\nInspect actual project candidates, findings and checks. Accept a handoff with exact revision, requirements covered, independent review where warranted or required, Project Manager final review, passed/failed/not-run checks, integration constraints and recovery notes. Return deficiencies to that Lead. Combine compatible ready changes, reuse valid evidence and run the required checks for changed integration boundaries and the assembled product. Do not repeat every project's review/test campaign or hold an independently releasable fix indefinitely for unrelated work. Assign integration changes to an accountable engineering owner and obtain applicable independent review; authors cannot independently review their own code.\n\nBuild only what the requested outcome requires. Distinguish source-ready, package-ready, submitted, deployed, installed and live-verified. Carry ready work through the already-authorized path without routine approval delays, while preserving required tests, security, credentials, persistent-access rules and explicit release holds. Verify the intended target and retain a recoverable path. Report exact blockers and complete useful independent work around them.\n\nFor staffing, use supported role-aware session creation, current account role IDs and current available model defaults. Use the actual supported role identity from the current catalog, not an invented identifier. Pass role and task context separately, preserve configured model/permission modes and verify the returned role/instruction assignment. Use existing sessions when correctly scoped. Keep substantial leadership in a session, not a short run that cannot own the delivery lifecycle. An ambiguous request may already have executed: inspect or resume that same request before retrying. Never retitle/tag an unassigned session as a substitute for role admission. A notice, sidebar group, pin or dispatch receipt is not completed work, automatic wake-up or runtime proof.\n\nPreserve active role snapshots, histories, data and modes. Do not reapply roles or restart sessions merely to adopt new defaults. Return concise evidence, current owner, next milestone and exact blockers to the user.",
});

const BuiltInSessionRoleDisplayNameV1Schema = lazySchema(() => z.string().trim().min(1));

/** Account-wide built-in overrides plus first-class custom role profiles. */
export const SessionRoleProfilesV1Schema = lazySchema(() => z.object({
    v: z.literal(1),
    instructionsByRole: z.object({
        planner: z.string().optional(),
        project_lead: z.string().optional(),
        worker: z.string().optional(),
        delegate: z.string().optional(),
        reviewer: z.string().optional(),
    }).passthrough(),
    colorsByRole: z.object({
        planner: SessionRoleBadgeColorV1Schema.optional(),
        project_lead: SessionRoleBadgeColorV1Schema.optional(),
        worker: SessionRoleBadgeColorV1Schema.optional(),
        delegate: SessionRoleBadgeColorV1Schema.optional(),
        reviewer: SessionRoleBadgeColorV1Schema.optional(),
    }).passthrough().optional(),
    /**
     * Display-only aliases for built-in role badges and labels. Agent-facing names never read them:
     * prompts, role snapshots and run roles keep the canonical built-in name. A malformed alias
     * reads as absent so it cannot discard the rest of the profiles.
     */
    displayNamesByRole: z.object({
        planner: BuiltInSessionRoleDisplayNameV1Schema.optional().catch(undefined),
        project_lead: BuiltInSessionRoleDisplayNameV1Schema.optional().catch(undefined),
        worker: BuiltInSessionRoleDisplayNameV1Schema.optional().catch(undefined),
        delegate: BuiltInSessionRoleDisplayNameV1Schema.optional().catch(undefined),
        reviewer: BuiltInSessionRoleDisplayNameV1Schema.optional().catch(undefined),
    }).passthrough().optional().catch(undefined),
    customRoles: z.array(CustomSessionRoleProfileV1Schema).optional(),
}).passthrough());
export type SessionRoleProfilesV1 = z.infer<typeof SessionRoleProfilesV1Schema>;
export const DEFAULT_SESSION_ROLE_PROFILES_V1: SessionRoleProfilesV1 = { v: 1, instructionsByRole: {} };

function parseSessionRoleProfilesV1(profiles: unknown): SessionRoleProfilesV1 {
    const parsed = SessionRoleProfilesV1Schema.safeParse(profiles);
    return parsed.success ? parsed.data : DEFAULT_SESSION_ROLE_PROFILES_V1;
}

function readSessionRoleProfilesFromSettingsV1(settings: unknown): SessionRoleProfilesV1 {
    const raw = settings && typeof settings === 'object' && !Array.isArray(settings)
        ? (settings as Record<string, unknown>).sessionRoleProfilesV1
        : undefined;
    return parseSessionRoleProfilesV1(raw);
}

function normalizeRoleBadgeColorV1(color: string): SessionRoleBadgeColorV1 {
    const normalized = String(color ?? '').trim().toLowerCase();
    if (!SessionRoleBadgeColorV1Schema.safeParse(normalized).success) throw new Error('invalid-session-role-color');
    return normalized as SessionRoleBadgeColorV1;
}

export type AssignableSessionRoleProfileV1 = Readonly<{
    id: AssignableSessionRole;
    kind: 'builtIn' | 'custom';
    /** Agent-facing name: canonical for built-ins, the profile's own name for custom roles. */
    name: string;
    /** Display-only alias for a built-in; null for custom roles, whose `name` is already their label. */
    displayName: string | null;
    instructions: string;
    color: SessionRoleBadgeColorV1 | null;
}>;

export function listAssignableSessionRoleProfilesV1(settings: unknown): readonly AssignableSessionRoleProfileV1[] {
    const profiles = readSessionRoleProfilesFromSettingsV1(settings);
    const builtIns = SESSION_ROLES.map((id): AssignableSessionRoleProfileV1 => ({
        id,
        kind: 'builtIn',
        name: SESSION_ROLE_PROMPT_NAMES[id],
        displayName: profiles.displayNamesByRole?.[id] ?? null,
        instructions: profiles.instructionsByRole[id]?.trim() || DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[id],
        color: profiles.colorsByRole?.[id] ?? null,
    }));
    const custom = (profiles.customRoles ?? []).map((profile): AssignableSessionRoleProfileV1 => ({
        id: profile.id,
        kind: 'custom',
        name: profile.name.trim(),
        displayName: null,
        instructions: profile.instructions.trim(),
        color: normalizeRoleBadgeColorV1(profile.color),
    }));
    return [...builtIns, ...custom];
}

export function resolveAssignableSessionRoleProfileV1(settings: unknown, role: AssignableSessionRole): AssignableSessionRoleProfileV1 | null {
    return listAssignableSessionRoleProfilesV1(settings).find((profile) => profile.id === role) ?? null;
}

/** A blank or missing account override uses the built-in default. */
export function resolveSessionRoleInstructionsV1(settings: unknown, role: SessionRole): string {
    const profiles = readSessionRoleProfilesFromSettingsV1(settings);
    if (isCustomSessionRoleId(role)) return profiles.customRoles?.find((profile) => profile.id === role)?.instructions.trim() ?? '';
    const override = profiles.instructionsByRole[role]?.trim();
    return override || DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[role];
}

/** Save or reset one role's account override; blank or default text removes the override. */
export function setSessionRoleProfileInstructionsV1(
    profiles: unknown,
    role: (typeof READABLE_SESSION_ROLES)[number],
    instructions: string | null,
): SessionRoleProfilesV1 {
    const current = parseSessionRoleProfilesV1(profiles);
    const { [role]: _previous, ...others } = current.instructionsByRole;
    const next = instructions?.trim() ?? '';
    const keep = next.length > 0 && next !== DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[role];
    return { ...current, instructionsByRole: keep ? { ...others, [role]: next } : others };
}

export function setBuiltInSessionRoleProfileV1(
    profiles: unknown,
    role: BuiltInSessionRole,
    patch: Readonly<{ instructions?: string | null; color?: string | null }>,
): SessionRoleProfilesV1 {
    let current = parseSessionRoleProfilesV1(profiles);
    if (patch.instructions !== undefined) current = setSessionRoleProfileInstructionsV1(current, role, patch.instructions);
    if (patch.color === undefined) return current;
    const colors = current.colorsByRole ?? {};
    const { [role]: _previous, ...others } = colors;
    const nextColors = patch.color === null ? others : { ...others, [role]: normalizeRoleBadgeColorV1(patch.color) };
    if (Object.keys(nextColors).length > 0) return { ...current, colorsByRole: nextColors };
    const { colorsByRole: _removed, ...withoutColors } = current;
    return withoutColors;
}

type ReadableBuiltInSessionRole = (typeof READABLE_SESSION_ROLES)[number];

/** Save or clear (null or blank) one built-in role's display alias; other fields are preserved. */
export function setBuiltInSessionRoleDisplayNameV1(
    profiles: unknown,
    role: ReadableBuiltInSessionRole,
    displayName: string | null,
): SessionRoleProfilesV1 {
    const current = parseSessionRoleProfilesV1(profiles);
    const { [role]: _previous, ...others } = current.displayNamesByRole ?? {};
    const next = displayName?.trim() ?? '';
    const nextNames = next ? { ...others, [role]: next } : others;
    if (Object.keys(nextNames).length > 0) return { ...current, displayNamesByRole: nextNames };
    const { displayNamesByRole: _removed, ...withoutNames } = current;
    return withoutNames;
}

/** A built-in role's display alias, or null; custom roles have none (their `name` is the label). */
export function readBuiltInSessionRoleDisplayNameV1(profiles: unknown, role: SessionRole): string | null {
    if (isCustomSessionRoleId(role)) return null;
    return parseSessionRoleProfilesV1(profiles).displayNamesByRole?.[role] ?? null;
}

export function addCustomSessionRoleProfileV1(profiles: unknown, profile: CustomSessionRoleProfileV1): SessionRoleProfilesV1 {
    const current = parseSessionRoleProfilesV1(profiles);
    const parsed = CustomSessionRoleProfileV1Schema.parse(profile);
    if ((current.customRoles ?? []).some((candidate) => candidate.id === parsed.id)) throw new Error('custom-session-role-already-exists');
    const normalized = { ...parsed, name: parsed.name.trim(), instructions: parsed.instructions.trim(), color: normalizeRoleBadgeColorV1(parsed.color) };
    return { ...current, customRoles: [...(current.customRoles ?? []), normalized] };
}

export function updateCustomSessionRoleProfileV1(
    profiles: unknown,
    id: CustomSessionRoleId,
    patch: Readonly<{ name?: string; instructions?: string; color?: string }>,
): SessionRoleProfilesV1 {
    const current = parseSessionRoleProfilesV1(profiles);
    let found = false;
    const customRoles = (current.customRoles ?? []).map((profile) => {
        if (profile.id !== id) return profile;
        found = true;
        return CustomSessionRoleProfileV1Schema.parse({
            ...profile,
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...(patch.instructions !== undefined ? { instructions: patch.instructions.trim() } : {}),
            ...(patch.color !== undefined ? { color: normalizeRoleBadgeColorV1(patch.color) } : {}),
        });
    });
    if (!found) throw new Error('custom-session-role-not-found');
    return { ...current, customRoles };
}

export function removeCustomSessionRoleProfileV1(profiles: unknown, id: CustomSessionRoleId): SessionRoleProfilesV1 {
    const current = parseSessionRoleProfilesV1(profiles);
    return { ...current, customRoles: (current.customRoles ?? []).filter((profile) => profile.id !== id) };
}

const ROLE_SCOPE_NOTE = 'Follow these role instructions until this session is reassigned or the role is cleared. This assignment does not change your permissions, tools, model, or ownership.';

/** Visible chat instruction for a live assign, reassign, or reapply. */
export function buildSessionRoleAssignmentMessageV1(params: Readonly<{ role: SessionRole; instructions: string; name?: string }>): string {
    const name = resolveSessionRolePromptNameV1(params);
    return `Role assignment: ${name}\n\n${params.instructions.trim()}\n\n${ROLE_SCOPE_NOTE}`;
}

/** Visible chat instruction when a role is cleared. */
export function buildSessionRoleClearedMessageV1(): string {
    return 'Role assignment cleared. Stop following the previous role-specific instructions; all other instructions and context still apply. This does not change your permissions, tools, model, or ownership.';
}

export type SessionRoleChangePlanV1 = Readonly<{
    /** Null clears the role. */
    assignment: AssignableSessionRoleV1 | null;
    /** Visible chat instruction queued to the session after the metadata write. */
    message: string;
    /** Idempotent outbox id: a retry of the same change never duplicates its instruction. */
    localId: string;
}>;

/**
 * The single plan for a live role change, shared by the UI menu and the session-agent action.
 * `settings` must be the target session's own account settings.
 */
export function planSessionRoleChangeV1(params: Readonly<{
    role: AssignableSessionRole | null;
    settings: unknown;
    /** Fresh per execution: the assignment and visible-message identity. */
    changeId: string;
    at: number;
    /** Optional caller correlation id, recorded on the assignment for its own explicit resume. */
    actionRequestId?: string;
    /** Existing-attempt resume may resolve a deleted custom role only from its retained snapshot. */
    resumeExistingAssignment?: boolean;
}>): SessionRoleChangePlanV1 | null {
    if (params.role === null) {
        return { assignment: null, message: buildSessionRoleClearedMessageV1(), localId: `session-role-cleared:${params.changeId}` };
    }
    const profile = resolveAssignableSessionRoleProfileV1(params.settings, params.role);
    if (!profile) {
        if (!params.resumeExistingAssignment) return null;
        return {
            assignment: buildSessionRoleAssignmentV1({
                role: params.role,
                instructions: '',
                assignmentId: params.changeId,
                assignedAt: params.at,
                ...(params.actionRequestId ? { actionRequestId: params.actionRequestId } : {}),
            }),
            message: '',
            localId: `session-role:${params.changeId}`,
        };
    }
    const { instructions } = profile;
    return {
        assignment: buildSessionRoleAssignmentV1({
            role: params.role,
            ...(profile.kind === 'custom' ? { name: profile.name } : {}),
            ...(profile.color ? { color: profile.color } : {}),
            instructions,
            assignmentId: params.changeId,
            assignedAt: params.at,
            ...(params.actionRequestId ? { actionRequestId: params.actionRequestId } : {}),
        }),
        message: buildSessionRoleAssignmentMessageV1({ role: params.role, instructions, ...(profile.kind === 'custom' ? { name: profile.name } : {}) }),
        localId: `session-role:${params.changeId}`,
    };
}

export type SessionRoleChangeApplicationV1<M> =
    /** Written as planned (a first execution). */
    | Readonly<{ outcome: 'applied'; metadata: M; plan: SessionRoleChangePlanV1 }>
    /** A resumed assignment that is still current: metadata unchanged; the plan is its persisted snapshot. */
    | Readonly<{ outcome: 'replayed'; metadata: M; plan: SessionRoleChangePlanV1 }>
    /** A resume that cannot be resolved (superseded, never recorded, or a clear): nothing written or delivered. */
    | Readonly<{ outcome: 'not_current'; metadata: M; plan: null }>;

/**
 * Applies a planned change inside the metadata CAS updater and returns what to deliver.
 *
 * `actionRequestId` is caller correlation, not identity: agent tool bridges pass MCP JSON-RPC ids,
 * which restart per client connection. Every first execution therefore applies as its own change
 * with the plan's fresh assignment and message ids, so a recycled id, or a provider re-running a
 * completed tool call, is a new visible role change. Only an explicit `resume` (the action
 * contract's "resolve the existing attempt without repeating its outward write") resolves a prior
 * attempt, and only an assignment whose recorded record still carries the same `actionRequestId`
 * and the same role (replaying its persisted snapshot and message id). A clear retains no identity, so a resumed
 * clear, like any other unresolvable resume, is `not_current`: it writes and sends nothing and
 * never overwrites a later role change; a caller that still wants the clear issues a new one.
 */
export function applySessionRoleChangeV1ToMetadata<M extends Record<string, unknown>>(
    metadata: M,
    plan: SessionRoleChangePlanV1,
    options?: Readonly<{ resume?: boolean; actionRequestId?: string }>,
): SessionRoleChangeApplicationV1<M> {
    const actionRequestId = options?.actionRequestId?.trim() ?? '';
    if (options?.resume !== true || !actionRequestId) {
        return { outcome: 'applied', metadata: applySessionRoleV1ToMetadata(metadata, plan.assignment), plan };
    }
    // A clear removes the record, so no clear retains an identity its resume could match: an empty
    // role proves nothing about which request cleared it. A resumed clear is never resolved.
    if (plan.assignment === null) {
        return { outcome: 'not_current', metadata, plan: null };
    }
    const recorded = AssignableSessionRoleV1Schema.safeParse(metadata.sessionRoleV1);
    const instructions = recorded.success && typeof recorded.data.instructions === 'string' ? recorded.data.instructions.trim() : '';
    // A resume is the same attempt only if it asks for the role that attempt recorded; anything else
    // would deliver one role while the caller reports another.
    if (
        recorded.success
        && recorded.data.actionRequestId === actionRequestId
        && recorded.data.role === plan.assignment.role
        && recorded.data.assignmentId
        && instructions
    ) {
        return {
            outcome: 'replayed',
            metadata,
            plan: {
                assignment: recorded.data,
                message: buildSessionRoleAssignmentMessageV1({
                    role: recorded.data.role,
                    instructions,
                    ...(recorded.data.name ? { name: recorded.data.name } : {}),
                }),
                localId: `session-role:${recorded.data.assignmentId}`,
            },
        };
    }
    return { outcome: 'not_current', metadata, plan: null };
}

/**
 * Truthful `session.role.set` outcome shared by every executor. `roleSaved` tells the caller
 * whether the role metadata changed; an undelivered instruction never reads as success.
 */
export type SessionRoleSetActionResultV1 =
    | Readonly<{ ok: true; sessionId: string; role: AssignableSessionRole | null; action: 'assigned' | 'cleared'; instructionLocalId: string }>
    | Readonly<{ ok: false; errorCode: 'role_profiles_unavailable' | 'role_update_failed'; error: string; roleSaved: false }>
    /** A resume that could not be resolved (superseded, never recorded, or a clear); nothing changed. */
    | Readonly<{ ok: false; errorCode: 'role_change_not_current'; error: string; roleSaved: false }>
    | Readonly<{
        ok: false;
        errorCode: 'role_instruction_not_delivered';
        error: string;
        roleSaved: true;
        sessionId: string;
        role: AssignableSessionRole | null;
        /** Resending this exact message with this localId cannot duplicate it. */
        instruction: Readonly<{ localId: string; message: string }>;
    }>;

/** Agent-facing role name: a custom snapshot's own name, or the fixed built-in name. */
export function resolveSessionRolePromptNameV1(params: Readonly<{ role: SessionRole; name?: string | null }>): string {
    return params.name?.trim() || (isCustomSessionRoleId(params.role) ? 'Custom role' : SESSION_ROLE_PROMPT_NAMES[params.role]);
}

/** Prompt block for the retained assignment, so it survives provider restart and resume. */
export function buildSessionRolePromptBlockTextV1(metadata: unknown): string | null {
    const assignment = readSessionRoleAssignmentV1(metadata);
    if (!assignment?.instructions) return null;
    const name = resolveSessionRolePromptNameV1(assignment);
    return `Current role assignment: ${name}\n\n${assignment.instructions.trim()}\n\n${ROLE_SCOPE_NOTE}`;
}

const RUN_ROLE_SCOPE_NOTE = 'This role applies to this run only. The run\'s output contract takes precedence over these instructions; session-only steps (notices, creating or binding other sessions, and keeping or retaining this session) do not apply inside the run. This role does not change your permissions, tools, model, or ownership.';

/**
 * Run-scoped role block: the same catalog instructions with a run scope note instead of the
 * session scope note. Each run profile composes it first, then the caller's instructions, then its
 * output contract last.
 */
export function buildExecutionRunRolePromptBlockTextV1(role: Readonly<{ id: AssignableSessionRole; name?: string | null; instructions: string }>): string {
    const name = resolveSessionRolePromptNameV1({ role: role.id, name: role.name });
    return `Current run role: ${name}\n\n${role.instructions.trim()}\n\n${RUN_ROLE_SCOPE_NOTE}`;
}

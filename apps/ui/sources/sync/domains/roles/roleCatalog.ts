import { z } from 'zod';
import { BUILT_IN_ROLE_IDS_V1, BUILT_IN_ROLES_V1, type BuiltInRoleIdV1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { t } from '@/text';
import { RoleActionEntryV1Schema } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { resolveRoleSelectionV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ResolvedRoleV1, RoleInstructionsOverrideV1, WorkflowRoleV1 } from '@happier-dev/protocol/prompts/roles/rolesV1';
import type { RoleArtifactV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';

/** One `roles.list` item (the Action's result contract): a role document and, for Artifacts, its revision. */
const RolesListItemSchema = RoleActionEntryV1Schema;
export type RolesListItem = z.infer<typeof RolesListItemSchema>;

const RolesListOutputSchema = z.object({ items: z.array(z.unknown()) });

/** Parses a `roles.list` result, keeping every item that validates and dropping the rest. */
export function parseRolesListOutput(output: unknown): ReadonlyArray<RolesListItem> | null {
    const parsed = RolesListOutputSchema.safeParse(output);
    if (!parsed.success) return null;
    const items: RolesListItem[] = [];
    for (const candidate of parsed.data.items) {
        const item = RoleActionEntryV1Schema.safeParse(candidate);
        if (item.success) items.push(item.data);
    }
    return items;
}

export type RoleSourceKind = 'built_in' | 'user' | 'shared' | 'plugin';

/**
 * A role as the reader's Settings layer shows it: the listed document with the reader's own
 * `rolesV1` override applied by the one resolver (`resolveRoleSelectionV1`).
 */
export type RoleCatalogEntry = Readonly<{
    roleId: string;
    source: RoleSourceKind;
    /** The effective Settings-layer role. A disabled role keeps its document so it can be turned back on. */
    role: ResolvedRoleV1;
    /** The reader's own override of a built-in, plugin or shared role; Reset removes it. */
    override?: RoleInstructionsOverrideV1;
    /** Current Artifact revision; viewOnly controls whether it may be written. */
    revision?: Readonly<{ headerVersion: number; bodyVersion: number }>;
    pluginId?: string;
    pluginDisplayName?: string;
    /** Shared with the reader to use only: the document is read-only; the reader's own overrides still apply. */
    viewOnly: boolean;
    /** Migrated from the reader's 0.2 sub-agents guidance. */
    migratedFromV0_2: boolean;
}>;

const BUILT_IN_ROLE_IDS: ReadonlySet<string> = new Set(BUILT_IN_ROLE_IDS_V1);

function isBuiltInRoleIdV1(roleId: string): roleId is BuiltInRoleIdV1 {
    return BUILT_IN_ROLE_IDS.has(roleId);
}

const BUILT_IN_ROLE_PURPOSE_KEYS = {
    orchestrator: 'roles.builtIn.orchestrator',
    planner: 'roles.builtIn.planner',
    builder: 'roles.builtIn.builder',
    reviewer: 'roles.builtIn.reviewer',
    judge: 'roles.builtIn.judge',
    second_opinion: 'roles.builtIn.second_opinion',
    scout: 'roles.builtIn.scout',
    approval_reviewer: 'roles.builtIn.approval_reviewer',
} as const satisfies Record<BuiltInRoleIdV1, string>;
const PLUGIN_ROLE_ID = /^plugin:([^/]+)\/(.+)$/u;

function classify(item: RolesListItem): Readonly<{ source: RoleSourceKind; pluginId?: string }> {
    if (BUILT_IN_ROLE_IDS.has(item.roleId)) return { source: 'built_in' };
    const plugin = PLUGIN_ROLE_ID.exec(item.roleId);
    if (plugin) return { source: 'plugin', pluginId: plugin[1] };
    return { source: item.shared ? 'shared' : 'user' };
}

function asResolved(roleId: string, role: RoleArtifactV1): ResolvedRoleV1 {
    return { ...role, roleId };
}

/** Built-ins first (in their catalog order), then the reader's roles, shared roles, plugin roles. */
const SOURCE_ORDER: Readonly<Record<RoleSourceKind, number>> = { built_in: 0, user: 1, shared: 2, plugin: 3 };

type RoleCatalogInput = Readonly<{
    items: ReadonlyArray<RolesListItem>;
    overrides: Readonly<Record<string, RoleInstructionsOverrideV1>>;
}>;

/** Shared read-owner projection: unchanged documents/overrides never re-enter the Role resolver. */
export function createRoleCatalogProjection(): (input: RoleCatalogInput) => ReadonlyArray<RoleCatalogEntry> {
    let previous = new Map<string, Readonly<{ item: RolesListItem; override: RoleInstructionsOverrideV1 | undefined; entry: RoleCatalogEntry }>>();
    let entries: ReadonlyArray<RoleCatalogEntry> = [];
    let lastInput: RoleCatalogInput | undefined;
    return (input) => {
        if (lastInput?.items === input.items && lastInput.overrides === input.overrides) return entries;
        const next = new Map<string, Readonly<{ item: RolesListItem; override: RoleInstructionsOverrideV1 | undefined; entry: RoleCatalogEntry }>>();
        const ordered = input.items.map((item, index) => {
            const { source, pluginId } = classify(item);
            const override = source === 'user' ? undefined : input.overrides[item.roleId];
            const stored = previous.get(item.roleId);
            if (stored && sameStrictJsonValue(stored.item, item) && sameStrictJsonValue(stored.override, override)) {
                next.set(item.roleId, stored);
                return { entry: stored.entry, index };
            }
            const resolved = resolveRoleSelectionV1({
                roleId: item.roleId,
                settingsRoles: { [item.roleId]: item.role },
                settingsOverrides: override ? { [item.roleId]: override } : {},
                ...(pluginId ? { pluginRoles: [{ pluginId, localId: item.roleId.slice(`plugin:${pluginId}/`.length), role: item.role }] } : {}),
            });
            const entry: RoleCatalogEntry = {
                roleId: item.roleId,
                source,
                role: resolved.ok ? resolved.selection : asResolved(item.roleId, item.role),
                ...(override ? { override } : {}),
                viewOnly: item.viewOnly,
                migratedFromV0_2: item.migratedFromV0_2,
                ...(item.revision ? { revision: item.revision } : {}),
                ...(pluginId ? { pluginId } : {}),
                ...(item.pluginDisplayName ? { pluginDisplayName: item.pluginDisplayName } : {}),
            };
            next.set(item.roleId, { item, override, entry });
            return { entry, index };
        });
        const incoming = ordered
            .sort((a, b) => (SOURCE_ORDER[a.entry.source] - SOURCE_ORDER[b.entry.source]) || (a.index - b.index))
            .map(({ entry }) => entry);
        if (incoming.length !== entries.length || incoming.some((entry, index) => entry !== entries[index])) entries = incoming;
        previous = next;
        lastInput = input;
        return entries;
    };
}

export function buildRoleCatalog(input: RoleCatalogInput): ReadonlyArray<RoleCatalogEntry> {
    return createRoleCatalogProjection()(input);
}

/** The executable Artifact body excludes resolver-only identity and diagnostics. */
export function resolvedRoleToArtifact(role: ResolvedRoleV1): RoleArtifactV1 {
    const { roleId: _roleId, changedAt: _changedAt, profileUnavailable: _profileUnavailable, ...artifact } = role;
    return artifact;
}

/**
 * What a role is for, in one line. A built-in role whose instructions are still its own says it in
 * the product's words (its instructions are written for the agent, not the person); any other role
 * — and a built-in the reader rewrote — is described by the first sentence of its instructions.
 */
export function describeRolePurpose(role: Pick<ResolvedRoleV1, 'roleId' | 'instructions'>): string {
    if (isBuiltInRoleIdV1(role.roleId) && role.instructions === BUILT_IN_ROLES_V1[role.roleId].instructions) {
        return t(BUILT_IN_ROLE_PURPOSE_KEYS[role.roleId]);
    }
    const firstLine = role.instructions.trim().split('\n')[0]?.trim() ?? '';
    const sentenceEnd = firstLine.search(/[.!?](\s|$)/u);
    return sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
}

/**
 * A role as people read it ("Second opinion", "Reviewer"): a built-in's or the workflow's own name,
 * through the one role resolver. An id no layer names stays as written, so it is still findable.
 */
export function resolveRoleDisplayName(roleId: string, workflowRoles?: readonly WorkflowRoleV1[]): string {
    const resolved = resolveRoleSelectionV1({ roleId, workflowRoles: workflowRoles ?? [] });
    return resolved.ok && resolved.selection.name ? resolved.selection.name : roleId;
}

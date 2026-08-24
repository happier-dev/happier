import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { ProjectKeyV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { TriageEntryRepositoryRefV1Schema } from '@happier-dev/triage-protocol/v1';

import type {
    TriageProjectCandidateV1,
    TriageProjectWorktreeV1,
} from './launchPlacement.js';

/**
 * Reads the Account's persisted project registry through the one generic host
 * Action that projects it.
 *
 * `projects.list` is an inventory read beside `machines.list` and
 * `paths.list_recent` — a projection of `workspaceRefsV1` in Account Settings
 * paired with each project's already-fetched SCM working snapshot. Triage adds
 * no registry, no cache, no watch and no index: it asks the host what it
 * already holds, at the moment a reader presses.
 *
 * It matches nothing. Every row the host returns is handed to
 * `launchPlacement.ts`, which owns the single forge-identity join and the
 * single decision about whether the answer is unambiguous enough to launch.
 * Filtering here would put half of that rule in a second place.
 */

/** The one host Action this module invokes. */
export const TRIAGE_PROJECTS_LIST_ACTION_ID_V1 = 'projects.list';

export type TriageProjectRegistryHostV1 = Readonly<{
    executeAction(
        action: string,
        input: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<unknown>;
}>;

export type TriageProjectRegistryReadV1 =
    | Readonly<{
        status: 'read';
        projects: readonly TriageProjectCandidateV1[];
        /**
         * Whether `projects` is the WHOLE registry rather than part of it.
         *
         * The placement join's product is EXACTNESS — "exactly one reachable
         * checkout, so launch there" — and that claim cannot be made from a
         * part. The row that would have made the answer ambiguous may simply
         * not be here, and an apparent exact match starts an agent in a
         * checkout the reader never chose.
         *
         * Two things make an answer partial and both are folded into this one
         * fact, because a caller cannot act differently on them: the projection
         * saying it truncated, and a row this read could not parse. A dropped
         * row is a row that cannot be ruled out, and one of them may be the
         * second clone.
         *
         * An answer that states nothing is not a complete answer. `truncated`
         * is the projection's own member
         * (`apps/ui/sources/sync/ops/actions/listProjects.ts`), so its absence
         * means a producer that predates it — and reading silence as "this is
         * everything" is exactly the unsupportable claim.
         */
        complete: boolean;
    }>
    /**
     * No answer arrived: the client cannot serve this Action, or the call failed,
     * or it answered in a shape this Action does not publish.
     *
     * The one distinction that matters is preserved and the one this module
     * cannot make is not invented. An EMPTY read is `read` with no projects —
     * "you have no matching checkout" — and is never spelled the same way as
     * "nothing answered". Which flavour of no-answer it was is knowable only at
     * the host boundary, where `projects.list` returns its own
     * `unsupported_action`; a mounted surface sees one rejected call either way,
     * and claiming otherwise would put a guess in front of a reader.
     */
    | Readonly<{ status: 'unavailable' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
}

function readWorktrees(value: unknown): readonly TriageProjectWorktreeV1[] {
    if (!Array.isArray(value)) return [];
    const worktrees: TriageProjectWorktreeV1[] = [];
    for (const candidate of value) {
        if (!isRecord(candidate)) continue;
        const path = readNonEmptyString(candidate.path);
        if (path === null) continue;
        worktrees.push({
            path,
            branch: readNonEmptyString(candidate.branch),
            isMain: candidate.isMain === true,
            isCurrent: candidate.isCurrent === true,
        });
    }
    return worktrees;
}

/**
 * The resolved forge identity of one project, or nothing.
 *
 * All three components are required. A partial identity is not a weaker match;
 * it is a different repository, and admitting one would let a project join to a
 * repository that merely shares a hosting provider or merely shares a path on
 * another deployment of it. `deployment` in particular cannot be inferred from
 * the provider kind, which spans hosted and self-managed deployments.
 */
function readForge(value: unknown): TriageProjectCandidateV1['forge'] {
    const parsed = TriageEntryRepositoryRefV1Schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function readProject(value: unknown): TriageProjectCandidateV1 | null {
    if (!isRecord(value)) return null;
    const projectKey = ProjectKeyV1Schema.safeParse(value.projectKey);
    const serverId = readNonEmptyString(value.serverId);
    const machineId = readNonEmptyString(value.machineId);
    const rootPath = readNonEmptyString(value.rootPath);
    if (!projectKey.success || serverId === null || machineId === null || rootPath === null) {
        return null;
    }
    const label = readNonEmptyString(value.label);
    const forge = readForge(value.forge);
    return {
        projectKey: projectKey.data,
        serverId,
        machineId,
        rootPath,
        ...(label === null ? {} : { label }),
        ...(forge === undefined ? {} : { forge }),
        worktrees: readWorktrees(value.worktrees),
        // Absent is not reachable. A row that failed to say so is a row this
        // press must not launch into.
        reachable: value.reachable === true,
    };
}

export async function readTriageProjectRegistryV1(
    host: TriageProjectRegistryHostV1,
    options?: PluginCancellationOptions,
): Promise<TriageProjectRegistryReadV1> {
    let result: unknown;
    try {
        result = await host.executeAction(TRIAGE_PROJECTS_LIST_ACTION_ID_V1, {}, options);
    } catch {
        // A client that cannot serve the Action and a call that failed both
        // arrive here as one rejection. Neither is an empty registry, and
        // reporting one as such would tell the reader they have no checkout
        // when nothing ever looked.
        return { status: 'unavailable' };
    }
    if (!isRecord(result) || !Array.isArray(result.items)) return { status: 'unavailable' };

    const projects: TriageProjectCandidateV1[] = [];
    let dropped = false;
    for (const item of result.items) {
        const project = readProject(item);
        // A malformed row is dropped rather than failing the read: one
        // unreadable registry entry must not cost the reader the project they
        // actually wanted. It does cost the read its exactness, because a row
        // that could not be parsed is a row that cannot be ruled out.
        if (project === null) dropped = true;
        else projects.push(project);
    }
    return { status: 'read', projects, complete: result.truncated === false && !dropped };
}

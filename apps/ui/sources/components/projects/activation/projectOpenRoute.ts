import { OpenProjectInputV1Schema, type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { OpenProjectDraftSelectionV1 } from '@happier-dev/protocol/projects/openProjectDraftV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { z } from 'zod';

const sourceSeedSchema = z.object({ serverId: OpenProjectInputV1Schema.shape.serverId,
    source: OpenProjectInputV1Schema.shape.source, ref: OpenProjectInputV1Schema.shape.ref,
    subdir: OpenProjectInputV1Schema.shape.subdir }).strict();

/** An exact checkout seeds Open elsewhere; execution placement remains the person's choice. */
export function buildProjectCheckoutOpenRoute(workspace: Pick<WorkspaceAddressV1, 'serverId' | 'workspaceId'>, ref?: string | null) {
    const seed = sourceSeedSchema.parse({ serverId: workspace.serverId,
        source: { kind: 'workspace', workspaceId: workspace.workspaceId }, ...(ref ? { ref } : {}) });
    return { pathname: '/projects/open' as const, params: { openSource: JSON.stringify(seed) } };
}

/** Route selection is a nonexecuting seed. Only the mounted Open draft may submit. */
export function buildProjectOpenRoute(input: OpenProjectInputV1, requestedMode?: 'worktree' | 'clone') {
    return { pathname: '/projects/open' as const, params: { openDraft: JSON.stringify(OpenProjectInputV1Schema.parse(input)),
        ...(requestedMode ? { openMode: requestedMode } : {}) } };
}

/** A saved Source captures its effective selector now, but never selects a Machine for the person. */
export function buildProjectSourceOpenRoute(serverId: string, source: ProjectSourceV1) {
    const seed = sourceSeedSchema.parse({ serverId, source: { kind: 'source', id: source.id, revision: source.revision,
        selector: source.repository, ...(source.defaultRef ? { defaultRef: source.defaultRef } : {}),
        ...(source.subdir ? { subdir: source.subdir } : {}) } });
    return { pathname: '/projects/open' as const, params: { openSource: JSON.stringify(seed) } };
}

export function readProjectOpenRouteDraft(params: Readonly<Record<string, string | string[] | undefined>>): OpenProjectDraftSelectionV1 | null {
    const raw = Array.isArray(params.openDraft) ? params.openDraft[0] : params.openDraft;
    if (!raw) {
        const rawSource = Array.isArray(params.openSource) ? params.openSource[0] : params.openSource;
        if (!rawSource) return null;
        let seed: unknown;
        try { seed = JSON.parse(rawSource); } catch { return null; }
        const parsed = sourceSeedSchema.safeParse(seed);
        return parsed.success ? { ...parsed.data, machineId: '', materialization: {
            kind: 'clone', destinationParentPath: '', destinationDirectoryName: '',
        } } : null;
    }
    let candidate: unknown;
    try { candidate = JSON.parse(raw); } catch { return null; }
    const input = OpenProjectInputV1Schema.safeParse(candidate);
    if (!input.success) return null;
    const mode = Array.isArray(params.openMode) ? params.openMode[0] : params.openMode;
    if (mode === 'worktree') return { ...input.data, materialization: { kind: 'worktree', checkout: {
        kind: 'git_worktree', displayName: '', baseRef: input.data.ref ?? null,
    } } };
    if (mode === 'clone') return { ...input.data, materialization: {
        kind: 'clone', destinationParentPath: '', destinationDirectoryName: '',
    } };
    return input.data;
}

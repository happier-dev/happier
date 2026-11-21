import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { z } from 'zod/mini';

const sourceSeedSchema = z.strictObject({ serverId: OpenProjectInputV1Schema.shape.serverId,
    source: OpenProjectInputV1Schema.shape.source, ref: OpenProjectInputV1Schema.shape.ref,
    subdir: OpenProjectInputV1Schema.shape.subdir });

/** An exact checkout seeds Open elsewhere; execution placement remains the person's choice.
 * @param {import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceAddressV2} workspace
 * @param {string | null} [ref]
 */
export function buildProjectCheckoutOpenRoute(workspace, ref) {
    const seed = sourceSeedSchema.parse({ serverId: workspace.serverId,
        source: { kind: 'workspace', workspaceId: workspace.workspaceId, checkout: workspace }, ...(ref ? { ref } : {}) });
    return { pathname: /** @type {const} */ ('/projects/open'), params: { openSource: JSON.stringify(seed) } };
}

/** Route selection is a nonexecuting seed. Only the mounted Open draft may submit.
 * @param {import('@happier-dev/protocol/projects/openProjectV1').OpenProjectInputV1} input
 * @param {'worktree' | 'clone'} [requestedMode]
 */
export function buildProjectOpenRoute(input, requestedMode) {
    return { pathname: /** @type {const} */ ('/projects/open'), params: { openDraft: JSON.stringify(OpenProjectInputV1Schema.parse(input)),
        ...(requestedMode ? { openMode: requestedMode } : {}) } };
}

/** A saved Source captures its effective selector now, but never selects a Machine for the person.
 * @param {string} serverId
 * @param {import('@happier-dev/protocol/projects/sources/projectSourceV1').ProjectSourceV1} source
 */
export function buildProjectSourceOpenRoute(serverId, source) {
    if (!source.repository) return null;
    const seed = sourceSeedSchema.parse({ serverId, source: { kind: 'source', id: source.id, revision: source.revision,
        selector: source.repository, ...(source.defaultRef ? { defaultRef: source.defaultRef } : {}),
        ...(source.subdir ? { subdir: source.subdir } : {}) } });
    return { pathname: /** @type {const} */ ('/projects/open'), params: { openSource: JSON.stringify(seed) } };
}

/**
 * @param {Readonly<Record<string, string | string[] | undefined>>} params
 * @returns {import('@happier-dev/protocol/projects/openProjectDraftV1').OpenProjectDraftSelectionV1 | null}
 */
export function readProjectOpenRouteDraft(params) {
    const raw = Array.isArray(params.openDraft) ? params.openDraft[0] : params.openDraft;
    if (!raw) {
        const rawSource = Array.isArray(params.openSource) ? params.openSource[0] : params.openSource;
        if (!rawSource) return null;
        /** @type {unknown} */
        let seed;
        try { seed = JSON.parse(rawSource); } catch { return null; }
        const parsed = sourceSeedSchema.safeParse(seed);
        // No way to open is chosen here: the Open form starts on the choices owner's default once a Machine is chosen.
        return parsed.success ? { ...parsed.data, machineId: '' } : null;
    }
    /** @type {unknown} */
    let candidate;
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

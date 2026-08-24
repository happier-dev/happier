import { describe, expect, it, vi } from 'vitest';

import {
    readTriageProjectRegistryV1,
    TRIAGE_PROJECTS_LIST_ACTION_ID_V1,
} from './projectCandidates.js';

function hostReturning(result: unknown) {
    return { executeAction: vi.fn(async () => result) };
}

const ROW = {
    projectKey: { id: 'workspace_1' },
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repos/happier',
    label: 'happier',
    reachable: true,
    forge: {
        kind: 'github',
        deployment: 'https://github.com',
        repository: 'happier-dev/happier',
    },
    worktrees: [{ path: '/repos/happier', branch: 'main', isMain: true, isCurrent: true }],
};

describe('the project registry read', () => {
    it('reads the registry through the one generic inventory Action', async () => {
        const host = hostReturning({ items: [ROW], truncated: false });

        const read = await readTriageProjectRegistryV1(host);

        expect(host.executeAction).toHaveBeenCalledWith(
            TRIAGE_PROJECTS_LIST_ACTION_ID_V1,
            {},
            undefined,
        );
        expect(read).toEqual({
            status: 'read',
            // The projection stated it sent the whole registry, so the
            // exactness the placement join claims from it is supportable.
            complete: true,
            projects: [{
                projectKey: { id: 'workspace_1' },
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repos/happier',
                label: 'happier',
                reachable: true,
                forge: {
                    kind: 'github',
                    deployment: 'https://github.com',
                    repository: 'happier-dev/happier',
                },
                worktrees: [{ path: '/repos/happier', branch: 'main', isMain: true, isCurrent: true }],
            }],
        });
    });

    /**
     * "Nothing answered" and "you have no matching checkout" need different
     * words in front of a reader, so a rejected call must never read as an
     * empty registry.
     */
    it('never reports a rejected call as an empty registry', async () => {
        const host = {
            executeAction: vi.fn(async () => { throw new Error('unsupported_action:projects.list'); }),
        };

        await expect(readTriageProjectRegistryV1(host)).resolves.toEqual({ status: 'unavailable' });
    });

    it('reports unavailable when the answer is not the shape this Action publishes', async () => {
        await expect(readTriageProjectRegistryV1(hostReturning({ rows: [] })))
            .resolves.toEqual({ status: 'unavailable' });
    });

    /** One unreadable registry entry must not cost the reader the project they wanted. */
    it('drops an unreadable row and keeps its siblings', async () => {
        const read = await readTriageProjectRegistryV1(
            hostReturning({ items: [{ projectKey: { id: 'no-scope' } }, ROW] }),
        );

        expect(read.status === 'read' ? read.projects.map((p) => p.projectKey) : null)
            .toEqual([{ id: 'workspace_1' }]);
    });

    /**
     * Half a forge identity is a different repository, not a weaker match. A row
     * that resolved only one component must not join at all.
     */
    /**
     * A row that names a forge and a repository but not the DEPLOYMENT is the
     * same half identity: `hostingProviderId` is one constant per forge plugin,
     * so admitting it would let a checkout on one Azure DevOps Server join an
     * entry from another.
     */
    it('drops a forge identity that names no deployment', async () => {
        const { deployment: _deployment, ...halfForge } = ROW.forge;
        const host = hostReturning({ items: [{ ...ROW, forge: halfForge }] });

        const read = await readTriageProjectRegistryV1(host);

        expect(read.status === 'read' ? read.projects[0]?.forge : 'unread').toBeUndefined();
    });

    it('drops a half-resolved forge identity rather than matching on one component', async () => {
        const read = await readTriageProjectRegistryV1(hostReturning({
            items: [{ ...ROW, forge: { kind: 'github' } }],
        }));

        expect(read.status === 'read' ? read.projects[0]?.forge : 'unread').toBeUndefined();
    });

    it.each([
        ['a non-triage provider kind', { ...ROW.forge, kind: 'custom' }],
        ['an open object shape', { ...ROW.forge, providerOwnedExtra: true }],
    ])('projects no forge for %s', async (_label, forge) => {
        const read = await readTriageProjectRegistryV1(hostReturning({
            items: [{ ...ROW, forge }],
            truncated: false,
        }));

        expect(read.status === 'read' ? read.projects[0]?.forge : 'unread').toBeUndefined();
    });

    /** A row that failed to say it is reachable is a row this press must not launch into. */
    it('treats a row that does not state reachability as unreachable', async () => {
        const { reachable: _omitted, ...withoutReachable } = ROW;
        const read = await readTriageProjectRegistryV1(hostReturning({ items: [withoutReachable] }));

        expect(read.status === 'read' ? read.projects[0]?.reachable : null).toBe(false);
    });

    /**
     * The one fact that separates "you have exactly one checkout" from "exactly
     * one checkout was in the part of the registry I was sent".
     *
     * `projects.list` publishes `truncated` beside its items
     * (`apps/ui/sources/sync/ops/actions/listProjects.ts`) precisely so a caller
     * deciding exactness cannot read a page as the registry. A second matching
     * checkout past the cut turns a genuinely ambiguous placement into an
     * apparent exact match, and an exact match LAUNCHES — into a checkout the
     * reader never chose.
     */
    it('reports an explicitly truncated answer as incomplete', async () => {
        const read = await readTriageProjectRegistryV1(hostReturning({ items: [ROW], truncated: true }));

        expect(read).toEqual({ status: 'read', complete: false, projects: [expect.any(Object)] });
    });

    /**
     * An answer that never states completeness is not a complete answer. The
     * member is the projection's own, so its absence means a producer that
     * predates it — and reading silence as "this is everything" is exactly the
     * claim that cannot be supported.
     */
    it('reports an answer that states no completeness as incomplete', async () => {
        const read = await readTriageProjectRegistryV1(hostReturning({ items: [ROW] }));

        expect(read.status === 'read' ? read.complete : null).toBe(false);
    });

    /**
     * A row this read could not parse is a row it cannot rule out, and one of
     * them may be the second clone that makes the answer ambiguous. Dropping it
     * keeps the projects the reader actually wanted; claiming the result is
     * still the whole registry is what would launch into the wrong one.
     */
    it('reports the answer as incomplete when a row was dropped', async () => {
        const read = await readTriageProjectRegistryV1(hostReturning({
            items: [ROW, { projectKey: { id: 'workspace_2' } }],
            truncated: false,
        }));

        expect(read.status === 'read' ? read.complete : null).toBe(false);
        expect(read.status === 'read' ? read.projects.length : 0).toBe(1);
    });
});

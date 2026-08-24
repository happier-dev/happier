import { describe, expect, it } from 'vitest';

import {
    resolveTriageLaunchPlacementV1,
    type TriageForgeIdentityV1,
    type TriageProjectCandidateV1,
} from './launchPlacement.js';

const GITHUB: TriageForgeIdentityV1 = Object.freeze({
    kind: 'github',
    deployment: 'https://github.com',
    repository: 'happier-dev/happier',
});

const GITLAB: TriageForgeIdentityV1 = Object.freeze({
    kind: 'gitlab',
    deployment: 'https://gitlab.com',
    repository: 'happier-dev/happier',
});

/**
 * The same forge plugin, the same repository path, a DIFFERENT deployment.
 *
 * `hostingProviderId` is a per-plugin constant, so it cannot tell these apart.
 * Two Azure DevOps Server deployments routinely hold one collection name, one
 * project name and one repository name — `DefaultCollection` is the installer's
 * own default — so the pair below is the ordinary enterprise case, not an
 * exotic one.
 */
const AZURE_HOST_A: TriageForgeIdentityV1 = Object.freeze({
    kind: 'azure-devops',
    deployment: 'https://tfs-a.example.com/DefaultCollection',
    repository: 'DefaultCollection/api/web',
});

const AZURE_HOST_B: TriageForgeIdentityV1 = Object.freeze({
    ...AZURE_HOST_A,
    deployment: 'https://tfs-b.example.com/DefaultCollection',
});

/** One host, two collection paths that differ only in case. */
const AZURE_COLLECTION_UPPER: TriageForgeIdentityV1 = Object.freeze({
    ...AZURE_HOST_A,
    deployment: 'https://tfs.example.com/DefaultCollection',
});

const AZURE_COLLECTION_LOWER: TriageForgeIdentityV1 = Object.freeze({
    ...AZURE_HOST_A,
    deployment: 'https://tfs.example.com/defaultcollection',
});

function project(
    overrides: Partial<TriageProjectCandidateV1> & Readonly<{ projectId: string }>,
): TriageProjectCandidateV1 {
    const { projectId, ...candidateOverrides } = overrides;
    return {
        projectKey: { id: projectId },
        serverId: 'server-1',
        machineId: 'machine-1',
        rootPath: `/repos/${projectId}`,
        forge: GITHUB,
        worktrees: [],
        reachable: true,
        ...candidateOverrides,
    };
}

describe('launch placement', () => {
    /**
     * The defect this component exists to prevent: two deployments of one forge
     * hold a repository at the same path, and without the deployment component
     * the join launches an agent into the wrong organization's checkout.
     */
    it('does not join two deployments of one forge that share a repository path', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: AZURE_HOST_A,
            projects: [project({ projectId: 'host-b', forge: AZURE_HOST_B })],
        });

        expect(placement.kind).toBe('prefill');
        expect(placement.kind === 'prefill' && placement.reason).toBe('noMatch');
    });

    it('joins one deployment to its own checkout while a same-named sibling is present', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: AZURE_HOST_A,
            projects: [
                project({ projectId: 'host-b', forge: AZURE_HOST_B }),
                project({ projectId: 'host-a', forge: AZURE_HOST_A }),
            ],
        });

        expect(placement.kind).toBe('launch');
        expect(placement.kind === 'launch' && placement.candidate.projectKey).toEqual({ id: 'host-a' });
    });

    /**
     * A base path is case-SIGNIFICANT — every forge origin owner in this repo
     * states so and refuses to lowercase it — so two collection paths that
     * differ in case are two deployments, not one spelled twice. Folding the
     * deployment's case would collapse them.
     */
    it('treats two deployments whose base paths differ only in case as different', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: AZURE_COLLECTION_UPPER,
            projects: [project({ projectId: 'lower', forge: AZURE_COLLECTION_LOWER })],
        });

        expect(placement.kind).toBe('prefill');
        expect(placement.kind === 'prefill' && placement.reason).toBe('noMatch');
    });

    it('launches the single reachable checkout of the entry\'s repository', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [
                project({ projectId: 'a', label: 'happier' }),
                project({ projectId: 'b', forge: GITLAB }),
                project({ projectId: 'c', forge: undefined }),
            ],
        });

        expect(placement.kind).toBe('launch');
        if (placement.kind !== 'launch') return;
        expect(placement.candidate.projectKey).toEqual({ id: 'a' });
        expect(placement.candidate.label).toBe('happier');
        expect(placement.candidate).toEqual(expect.objectContaining({
            projectKey: { id: 'a' },
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repos/a',
        }));
    });

    /**
     * The worktree list is the reason a candidate carries more than a path: it
     * is what makes "a new worktree or the main checkout?" answerable at the
     * press instead of after it.
     */
    it('carries the matched project\'s worktrees on the candidate', () => {
        const worktrees = [
            { path: '/repos/a', branch: 'main', isMain: true, isCurrent: true },
            { path: '/repos/a-fix', branch: 'fix/1', isMain: false, isCurrent: false },
        ] as const;
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({ projectId: 'a', worktrees })],
        });

        expect(placement.kind === 'launch' ? placement.candidate.worktrees : null)
            .toEqual(worktrees);
    });

    /**
     * The join is between two RESOLVED identities. A different forge holding a
     * repository of the same name is a different repository, and matching it
     * would run an agent in an unrelated checkout.
     */
    it('does not match a same-named repository on another hosting provider', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({ projectId: 'a', forge: GITLAB })],
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'noMatch', candidates: [] });
    });

    /**
     * Repository case is SOURCE-owned (`PLAN.md` §0a A5a). Triage compares the
     * two canonical identities and nothing else.
     *
     * The universal `toLowerCase()` this replaces applied GitHub's own
     * addressing rule to every forge in the vocabulary, including `custom` and
     * `unknown` deployments that warrant nothing of the sort — so on a
     * case-sensitive forge `Team/Api` and `team/api` were joined as one
     * repository and the press launched an agent into the wrong checkout. A
     * false match is the failure this module exists to prevent; a missed match
     * only opens the New Session surface.
     */
    it('does not join two repository paths that differ in case', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({
                projectId: 'a',
                forge: {
                    kind: 'github',
                    deployment: 'https://github.com',
                    repository: 'Happier-Dev/Happier',
                },
            })],
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'noMatch', candidates: [] });
    });

    /** Nor does it confuse two provider kinds that host the same repository path. */
    it('does not join two provider kinds', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({
                projectId: 'a',
                forge: { ...GITHUB, kind: 'gitlab' },
            })],
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'noMatch', candidates: [] });
    });

    /** An error group belongs to a project, not to a checkout. It never guesses one. */
    it('prefills without candidates when the entry names no repository', () => {
        const placement = resolveTriageLaunchPlacementV1({
            projects: [project({ projectId: 'a' })],
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'noForgeIdentity', candidates: [] });
    });

    /** A project no snapshot has resolved a forge for is not probed, and not matched. */
    it('ignores a project whose snapshot resolved no forge', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({ projectId: 'a', forge: undefined })],
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'noMatch', candidates: [] });
    });

    /**
     * Two clones of one repository are two choices. Picking the first, the
     * newest or the nearest would put an agent to work in a checkout the reader
     * never chose, with nothing on screen saying so.
     */
    it('refuses to choose between two reachable checkouts and lists both', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [
                project({ projectId: 'b', rootPath: '/repos/z' }),
                project({ projectId: 'a', rootPath: '/repos/a' }),
            ],
        });

        expect(placement.kind).toBe('prefill');
        if (placement.kind !== 'prefill') return;
        expect(placement.reason).toBe('ambiguous');
        expect(placement.candidates.map((candidate) => candidate.projectKey)).toEqual([{ id: 'a' }, { id: 'b' }]);
    });

    /**
     * "The checkout is on the laptop that is asleep" is the useful answer, so
     * the candidate is still listed. It is not launched: reaching a machine is
     * not this module's decision to make optimistically.
     */
    it('lists an unreachable match instead of launching it', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({ projectId: 'a', reachable: false })],
        });

        expect(placement.kind).toBe('prefill');
        if (placement.kind !== 'prefill') return;
        expect(placement.reason).toBe('unreachable');
        expect(placement.candidates.map((candidate) => candidate.projectKey)).toEqual([{ id: 'a' }]);
    });

    /** One reachable checkout beside an unreachable one is still one answer. */
    it('launches the reachable checkout when its siblings cannot be reached', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [
                project({ projectId: 'sleeping', machineId: 'machine-2', reachable: false }),
                project({ projectId: 'awake' }),
            ],
        });

        expect(placement.kind === 'launch' ? placement.candidate.projectKey : null).toEqual({ id: 'awake' });
    });

    /** Reachable first, then stable by root path — presentation only. */
    it('orders prefilled candidates reachable first and then stably', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [
                project({ projectId: 'asleep-a', rootPath: '/repos/1', reachable: false }),
                project({ projectId: 'awake-z', rootPath: '/repos/z' }),
                project({ projectId: 'awake-b', rootPath: '/repos/b' }),
            ],
        });

        expect(placement.kind === 'prefill'
            ? placement.candidates.map((candidate) => candidate.projectKey)
            : null).toEqual([{ id: 'awake-b' }, { id: 'awake-z' }, { id: 'asleep-a' }]);
    });

    /**
     * The unsafe-exactness case. A registry read that stopped short cannot
     * support ANY exact claim, and the launch is the one that hurts: a second
     * checkout of this repository past the cut would have made the answer
     * `ambiguous`, so launching into the only row that was read starts an agent
     * where the reader never chose.
     */
    it('refuses to launch from a partial registry read even with one reachable match', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({ projectId: 'a' })],
            registryComplete: false,
        });

        expect(placement.kind).toBe('prefill');
        if (placement.kind !== 'prefill') return;
        expect(placement.reason).toBe('incompleteRegistry');
        expect(placement.candidates.map((candidate) => candidate.projectKey)).toEqual([{ id: 'a' }]);
    });

    /** "You have no such checkout" is equally unprovable from a page of the registry. */
    it('does not claim noMatch from a partial registry read', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [project({ projectId: 'a', forge: GITLAB })],
            registryComplete: false,
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'incompleteRegistry', candidates: [] });
    });

    /**
     * Two reachable clones are two choices however many rows went unread, so
     * this is the one verdict a partial read still supports. Reporting it as
     * `incompleteRegistry` would hide the real reason the press cannot resolve.
     */
    it('still reports ambiguity from a partial registry read', () => {
        const placement = resolveTriageLaunchPlacementV1({
            forge: GITHUB,
            projects: [
                project({ projectId: 'a', rootPath: '/repos/a' }),
                project({ projectId: 'b', rootPath: '/repos/z' }),
            ],
            registryComplete: false,
        });

        expect(placement.kind === 'prefill' ? placement.reason : null).toBe('ambiguous');
    });

    /** An entry with no repository resolves nothing whatever the registry read. */
    it('reports noForgeIdentity from a partial registry read', () => {
        const placement = resolveTriageLaunchPlacementV1({
            projects: [project({ projectId: 'a' })],
            registryComplete: false,
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'noForgeIdentity', candidates: [] });
    });
});

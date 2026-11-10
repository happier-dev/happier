import { describe, expect, it } from 'vitest';

import {
    readTriageActionExecutionPlacementV1,
    resolveTriageActionCheckoutV1,
    resolveTriageActionPlacementV1,
} from './actionLaunch.js';
import type { TriageProjectCandidateV1 } from './launchPlacement.js';
import { requestTriageNewSessionAuthoringV1 } from './newSessionAuthoring.js';
import type { TriageNewSessionSeedV1 } from '../ui/header/newSessionSeedCommand.js';

const FORGE = {
    kind: 'github',
    deployment: 'https://github.com',
    repository: 'acme/api',
} as const;

function project(
    overrides: Partial<TriageProjectCandidateV1> & Readonly<{ projectId: string }>,
): TriageProjectCandidateV1 {
    const { projectId, ...candidateOverrides } = overrides;
    return {
        projectKey: { id: projectId },
        serverId: 'server-1',
        machineId: 'machine-1',
        rootPath: `/src/${projectId}`,
        forge: FORGE,
        worktrees: [],
        reachable: true,
        ...candidateOverrides,
    };
}

describe('the one precedence between an action requirement and a profile preference', () => {
    it('never lets a profile checkout preference weaken a pull-request requirement', () => {
        // The discriminating case (`PLAN.md` §0a A8). A pull-request repair
        // needs the source-prepared review workspace; a profile that prefers
        // reusing a checkout is expressing a preference among ways to obtain
        // one, and this requirement admits exactly one way.
        expect(resolveTriageActionCheckoutV1('pull_request', { checkout: 'reuse_workspace' }))
            .toBe('preparedReviewWorkspace');
        expect(resolveTriageActionCheckoutV1('pull_request', { checkout: 'ask' }))
            .toBe('preparedReviewWorkspace');
        expect(resolveTriageActionCheckoutV1('pull_request')).toBe('preparedReviewWorkspace');
    });

    it('never lets a profile checkout preference give a reference-only action a worktree', () => {
        expect(resolveTriageActionCheckoutV1('reference_only', { checkout: 'create_worktree' }))
            .toBe('none');
        expect(resolveTriageActionCheckoutV1('reference_only')).toBe('none');
    });

    it('lets the profile decide exactly the one mode that leaves a choice', () => {
        expect(resolveTriageActionCheckoutV1('repository', { checkout: 'create_worktree' }))
            .toBe('createWorktree');
        expect(resolveTriageActionCheckoutV1('repository', { checkout: 'ask' })).toBe('ask');
        // An absent preference reuses the selected project's own checkout,
        // which is exactly what `repository` has always materialized.
        expect(resolveTriageActionCheckoutV1('repository')).toBe('reuseWorkspace');
    });
});

describe('where a pressed action runs', () => {
    it.each([true, false])('admits an exact non-SCM Project using its existing reachability fact (%s)', reachable => {
        const selected = project({ projectId: 'selected', forge: undefined, reachable });
        const placement = resolveTriageActionPlacementV1({ workspaceMode: 'reference_only',
            workspace: { serverId: selected.serverId, machineId: selected.machineId,
                workspaceId: 'selected', rootPath: selected.rootPath },
            projects: [selected, project({ projectId: 'other', forge: undefined })] });
        expect(placement).toMatchObject(reachable
            ? { kind: 'launch', candidate: { projectKey: { id: 'selected' } } }
            : { kind: 'prefill', reason: 'unreachable' });
        expect(readTriageActionExecutionPlacementV1(placement)).toEqual(reachable
            ? { executionTarget: { serverId: selected.serverId, machineId: selected.machineId }, directory: selected.rootPath }
            : null);
    });

    it.each(['repository', 'pull_request'] as const)('refuses %s checkout requirements against a fixed no-folder preference', workspaceMode => {
        const profile = { placement: { fixed: { serverId: 'server-9', machineId: 'machine-9' },
            directoryIntent: { kind: 'managed' as const } } };
        expect(() => resolveTriageActionPlacementV1({ workspaceMode, profile, projects: [] }))
            .toThrowError(expect.objectContaining({ code: 'invalid_parameters',
                diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'workspaceMode' })]) }));
    });

    it('carries a fixed no-folder preference to the ordinary composer without a repository path', async () => {
        const profile = { placement: {
            fixed: { serverId: 'server-9', machineId: 'machine-9' },
            directoryIntent: { kind: 'managed' as const },
        } };
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'reference_only', profile, forge: FORGE,
            projects: [project({ projectId: 'only', rootPath: '/unselected/repo' })],
        });
        const seeds: TriageNewSessionSeedV1[] = [];
        const result = await requestTriageNewSessionAuthoringV1({
            version: () => ({ methods: ['openNewSession'] }),
            openNewSession: async seed => { seeds.push(seed); },
            selectActionInput: async () => { throw new Error('No prepared checkout is required'); },
        }, {
            entries: [], promptText: 'Explain this item', profileId: 'profile-a',
            checkoutIntent: 'none', placement: readTriageActionExecutionPlacementV1(placement), candidates: [],
        });
        expect(result.status).toBe('seeded');
        expect(seeds).toEqual([{
            prompt: 'Explain this item', profileId: 'profile-a', checkoutIntent: 'none',
            placement: { kind: 'exactTarget', serverId: 'server-9', machineId: 'machine-9' },
            directoryIntent: { kind: 'managed' },
        }]);
    });

    it('pins a stated placement over any number of matching checkouts', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'repository',
            profile: {
                placement: {
                    fixed: { serverId: 'server-9', machineId: 'machine-9' },
                    directory: '/work/pinned',
                },
            },
            forge: FORGE,
            projects: [project({ projectId: 'a' }), project({ projectId: 'b' })],
        });

        // Two reachable clones are ambiguous to the JOIN and would prefill. A
        // pinned placement is a stated choice, and an inference never overrules
        // one.
        expect(placement).toEqual({
            kind: 'pinned',
            target: { serverId: 'server-9', machineId: 'machine-9' },
            directory: '/work/pinned',
            candidates: [expect.objectContaining({ rootPath: '/src/a' }), expect.objectContaining({ rootPath: '/src/b' })],
        });
        // The whole target travels, not only the path. A directory carried
        // without the machine it lives on is what lets a start combine a
        // checkout on one machine with an execution target on another.
        expect(readTriageActionExecutionPlacementV1(placement)).toEqual({
            executionTarget: { serverId: 'server-9', machineId: 'machine-9' },
            directory: '/work/pinned',
        });
    });

    it('pins for a pull-request action too, because pinning names the machine, not a way around preparing', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'pull_request',
            profile: { placement: { fixed: { serverId: 's', machineId: 'm' } } },
            forge: FORGE,
            projects: [],
        });

        expect(placement.kind).toBe('pinned');
        // No directory was stated, so none is carried — a pinned machine with
        // no path is a machine, not a guess at a path on it.
        expect(readTriageActionExecutionPlacementV1(placement))
            .toEqual({ executionTarget: { serverId: 's', machineId: 'm' } });
    });

    it('prefills with its own reason when the profile asked to be asked', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'repository',
            profile: { placement: 'ask' },
            forge: FORGE,
            projects: [project({ projectId: 'only' })],
        });

        // One reachable checkout WOULD have launched. Nothing failed here, and
        // reporting `noMatch` would tell the reader something untrue about a
        // screen their own profile asked for.
        expect(placement).toEqual({ kind: 'prefill', reason: 'profileAsk', candidates: [expect.objectContaining({ rootPath: '/src/only' })] });
        expect(readTriageActionExecutionPlacementV1(placement)).toBeNull();
    });

    it('falls through to the join when the profile states nothing, and seeds one reachable match', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'repository',
            forge: FORGE,
            projects: [project({ projectId: 'only', rootPath: '/src/only' })],
        });

        expect(placement.kind).toBe('launch');
        expect(readTriageActionExecutionPlacementV1(placement)).toEqual({
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/src/only',
        });
    });

    it('seeds nothing when the join is ambiguous, rather than choosing between two clones', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'repository',
            profile: { placement: 'automatic' },
            forge: FORGE,
            projects: [project({ projectId: 'a' }), project({ projectId: 'b' })],
        });

        expect(placement.kind).toBe('prefill');
        if (placement.kind !== 'prefill') return;
        expect(placement.reason).toBe('ambiguous');
        expect(placement.candidates).toHaveLength(2);
        expect(readTriageActionExecutionPlacementV1(placement)).toBeNull();
    });

    it('reports an entry with no forge identity as such rather than matching every project', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'reference_only',
            projects: [project({ projectId: 'a' })],
        });

        expect(placement).toEqual({ kind: 'prefill', reason: 'noForgeIdentity', candidates: [] });
    });

    /**
     * The deciding case for the registry's own completeness fact.
     *
     * One reachable match in a PAGE of the registry is not one reachable match
     * in the registry. A second checkout of the same repository past the cut
     * would have made this ambiguous, and the difference between the two
     * answers is whether an agent starts, unattended, in a checkout the reader
     * never picked.
     */
    it('refuses to be exact about a registry it was only sent part of', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'repository',
            forge: FORGE,
            projects: [project({ projectId: 'only', rootPath: '/src/only' })],
            registryComplete: false,
        });

        expect(placement).toEqual({
            kind: 'prefill',
            reason: 'incompleteRegistry',
            candidates: [expect.objectContaining({ projectKey: { id: 'only' } })],
        });
        // And nothing may be launched from it: the candidates prefill the
        // surface, they do not decide it.
        expect(readTriageActionExecutionPlacementV1(placement)).toBeNull();
    });

    /**
     * A PINNED placement is a stated choice rather than an inference from the
     * registry, so a partial registry cannot overturn it.
     */
    it('still honours a pinned placement when the registry answered partially', () => {
        const placement = resolveTriageActionPlacementV1({
            workspaceMode: 'repository',
            profile: { placement: { fixed: { serverId: 's', machineId: 'm' }, directory: '/pinned' } },
            forge: FORGE,
            projects: [],
            registryComplete: false,
        });

        expect(readTriageActionExecutionPlacementV1(placement)).toEqual({
            executionTarget: { serverId: 's', machineId: 'm' },
            directory: '/pinned',
        });
    });
});

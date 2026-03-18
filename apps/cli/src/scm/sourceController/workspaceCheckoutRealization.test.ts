import { describe, expect, it } from 'vitest';

import {
    createScmSourceControllerWorkspaceCheckoutCreationRequestFromRealization,
    createScmSourceControllerWorkspaceCheckoutMaterializationRequestFromRealization,
    createScmSourceControllerWorkspaceCheckoutRealizationRequest,
    createScmSourceControllerWorkspaceCheckoutRealizationResult,
    resolveScmSourceControllerWorkspaceCheckoutRealizationBaseRef,
    resolveScmSourceControllerWorkspaceCheckoutRealizationDisplayName,
    resolveScmSourceControllerWorkspaceCheckoutRealizationKind,
    resolveScmSourceControllerWorkspaceCheckoutRealizationResultKind,
    resolveScmSourceControllerWorkspaceCheckoutRealizationResultTargetPath,
    resolveScmSourceControllerWorkspaceCheckoutRealizationSourcePath,
    resolveScmSourceControllerWorkspaceCheckoutRealizationTargetPath,
} from './workspaceCheckoutRealization';

describe('workspaceCheckoutRealization', () => {
    it('resolves creation and materialization fields through the shared source-controller helpers', () => {
        const request = createScmSourceControllerWorkspaceCheckoutRealizationRequest({
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
            },
        });

        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationKind(request)).toBe('git_worktree');
        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationSourcePath(request)).toBe('/repo');
        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationTargetPath(request)).toBe('/repo/.worktrees/feature-auth');
        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationDisplayName(request)).toBe('feature-auth');
        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationBaseRef(request)).toBe('origin/main');
    });

    it('normalizes omitted materialization targets to null for backend-owned creation flows', () => {
        const request = createScmSourceControllerWorkspaceCheckoutRealizationRequest({
            sourcePath: '/repo',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: null,
            },
        });

        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationTargetPath(request)).toBeNull();
    });

    it('derives legacy creation and materialization requests from the canonical realization request', () => {
        const request = createScmSourceControllerWorkspaceCheckoutRealizationRequest({
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
            },
        });

        expect(createScmSourceControllerWorkspaceCheckoutCreationRequestFromRealization(request)).toEqual({
            kind: 'git_worktree',
            sourcePath: '/repo',
            displayName: 'feature-auth',
            baseRef: 'origin/main',
        });
        expect(createScmSourceControllerWorkspaceCheckoutMaterializationRequestFromRealization(request)).toEqual({
            kind: 'git_worktree',
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            displayName: 'feature-auth',
            baseRef: 'origin/main',
        });
    });

    it('resolves realization results through the shared source-controller helpers', () => {
        const result = createScmSourceControllerWorkspaceCheckoutRealizationResult({
            kind: 'git_worktree',
            targetPath: '/repo/.worktrees/feature-auth',
        });

        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationResultKind(result)).toBe('git_worktree');
        expect(resolveScmSourceControllerWorkspaceCheckoutRealizationResultTargetPath(result)).toBe('/repo/.worktrees/feature-auth');
    });
});

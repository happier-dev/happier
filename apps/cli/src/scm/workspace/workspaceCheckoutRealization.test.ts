import { describe, expect, it } from 'vitest';

import {
    createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequestFromRealization,
    createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequestFromRealization,
    createScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest,
    createScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBaseRef,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationDisplayName,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationKind,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationSourcePath,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationTargetPath,
} from './workspaceCheckoutRealization';

describe('workspaceCheckoutRealization', () => {
    it('resolves creation and materialization fields through the shared workspace-integration helpers', () => {
        const request = createScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest({
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
                branchMode: 'new',
            },
        });

        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationKind(request)).toBe('git_worktree');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationSourcePath(request)).toBe('/repo');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationTargetPath(request)).toBe('/repo/.worktrees/feature-auth');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationDisplayName(request)).toBe('feature-auth');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationBaseRef(request)).toBe('origin/main');
    });

    it('normalizes omitted materialization targets to null for backend-owned creation flows', () => {
        const request = createScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest({
            sourcePath: '/repo',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: null,
                branchMode: 'new',
            },
        });

        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutRealizationTargetPath(request)).toBeNull();
    });

    it('derives legacy creation and materialization requests from the canonical realization request', () => {
        const request = createScmWorkspaceIntegrationWorkspaceCheckoutRealizationRequest({
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
                branchMode: 'new',
            },
        });

        expect(createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequestFromRealization(request)).toEqual({
            kind: 'git_worktree',
            sourcePath: '/repo',
            displayName: 'feature-auth',
            baseRef: 'origin/main',
            branchMode: 'new',
        });
        expect(createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequestFromRealization(request)).toEqual({
            kind: 'git_worktree',
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            displayName: 'feature-auth',
            baseRef: 'origin/main',
            branchMode: 'new',
        });
    });

    it('resolves realization results through the shared workspace-integration helpers', () => {
        const result = createScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult({
            kind: 'git_worktree',
            targetPath: '/repo/.worktrees/feature-auth',
            branchName: 'feature-auth',
            created: true,
        });

        expect(result).toEqual({
            kind: 'git_worktree',
            targetPath: '/repo/.worktrees/feature-auth',
            branchName: 'feature-auth',
            created: true,
        });
    });
});

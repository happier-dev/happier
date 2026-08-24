import { describe, expect, it } from 'vitest';

import {
    createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBaseRef,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationDisplayName,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationKind,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationSourcePath,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationTargetPath,
} from './workspaceCheckoutMaterialization';

describe('workspaceCheckoutMaterialization', () => {
    it('resolves materialization fields through the shared workspace-integration helpers', () => {
        const request = createScmWorkspaceIntegrationWorkspaceCheckoutMaterializationRequest({
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
                branchMode: 'new',
            },
        });

        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationKind(request)).toBe('git_worktree');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationSourcePath(request)).toBe('/repo');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationTargetPath(request)).toBe('/repo/.worktrees/feature-auth');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationDisplayName(request)).toBe('feature-auth');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutMaterializationBaseRef(request)).toBe('origin/main');
    });
});

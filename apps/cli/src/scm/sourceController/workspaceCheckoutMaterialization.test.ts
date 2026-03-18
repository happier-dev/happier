import { describe, expect, it } from 'vitest';

import {
    createScmSourceControllerWorkspaceCheckoutMaterializationRequest,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationBaseRef,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationDisplayName,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationKind,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationSourcePath,
    resolveScmSourceControllerWorkspaceCheckoutMaterializationTargetPath,
} from './workspaceCheckoutMaterialization';

describe('workspaceCheckoutMaterialization', () => {
    it('resolves materialization fields through the shared source-controller helpers', () => {
        const request = createScmSourceControllerWorkspaceCheckoutMaterializationRequest({
            sourcePath: '/repo',
            targetPath: '/repo/.worktrees/feature-auth',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
            },
        });

        expect(resolveScmSourceControllerWorkspaceCheckoutMaterializationKind(request)).toBe('git_worktree');
        expect(resolveScmSourceControllerWorkspaceCheckoutMaterializationSourcePath(request)).toBe('/repo');
        expect(resolveScmSourceControllerWorkspaceCheckoutMaterializationTargetPath(request)).toBe('/repo/.worktrees/feature-auth');
        expect(resolveScmSourceControllerWorkspaceCheckoutMaterializationDisplayName(request)).toBe('feature-auth');
        expect(resolveScmSourceControllerWorkspaceCheckoutMaterializationBaseRef(request)).toBe('origin/main');
    });
});

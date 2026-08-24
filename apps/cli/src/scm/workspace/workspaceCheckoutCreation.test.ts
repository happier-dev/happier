import { describe, expect, it } from 'vitest';

import {
    createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationBaseRef,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationDisplayName,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationKind,
    resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationSourcePath,
} from './workspaceCheckoutCreation';

describe('workspaceCheckoutCreation', () => {
    it('resolves creation fields through the shared workspace-integration helpers', () => {
        const request = createScmWorkspaceIntegrationWorkspaceCheckoutCreationRequest({
            sourcePath: '/repo/packages/app',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
                branchMode: 'new',
            },
        });

        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationKind(request)).toBe('git_worktree');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationSourcePath(request)).toBe('/repo/packages/app');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationDisplayName(request)).toBe('feature-auth');
        expect(resolveScmWorkspaceIntegrationWorkspaceCheckoutCreationBaseRef(request)).toBe('origin/main');
    });
});

import { describe, expect, it } from 'vitest';

import {
    createScmSourceControllerWorkspaceCheckoutCreationRequest,
    resolveScmSourceControllerWorkspaceCheckoutCreationBaseRef,
    resolveScmSourceControllerWorkspaceCheckoutCreationDisplayName,
    resolveScmSourceControllerWorkspaceCheckoutCreationKind,
    resolveScmSourceControllerWorkspaceCheckoutCreationSourcePath,
} from './workspaceCheckoutCreation';

describe('workspaceCheckoutCreation', () => {
    it('resolves creation fields through the shared source-controller helpers', () => {
        const request = createScmSourceControllerWorkspaceCheckoutCreationRequest({
            sourcePath: '/repo/packages/app',
            checkoutCreation: {
                kind: 'git_worktree',
                displayName: 'feature-auth',
                baseRef: 'origin/main',
            },
        });

        expect(resolveScmSourceControllerWorkspaceCheckoutCreationKind(request)).toBe('git_worktree');
        expect(resolveScmSourceControllerWorkspaceCheckoutCreationSourcePath(request)).toBe('/repo/packages/app');
        expect(resolveScmSourceControllerWorkspaceCheckoutCreationDisplayName(request)).toBe('feature-auth');
        expect(resolveScmSourceControllerWorkspaceCheckoutCreationBaseRef(request)).toBe('origin/main');
    });
});

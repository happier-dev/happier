import { describe, expect, it } from 'vitest';

import {
    createScmWorkspaceIntegrationPortableWorkspacePathRequest,
    resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath,
} from './portableWorkspacePath';

describe('portableWorkspacePath', () => {
    it('resolves the relative path through the shared workspace-integration helper', () => {
        const request = createScmWorkspaceIntegrationPortableWorkspacePathRequest({
            relativePath: '.git/HEAD',
        });

        expect(resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath(request)).toBe('.git/HEAD');
    });
});

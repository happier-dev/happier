import { describe, expect, it } from 'vitest';

import {
    createScmSourceControllerPortableWorkspacePathRequest,
    resolveScmSourceControllerPortableWorkspacePathRelativePath,
} from './portableWorkspacePath';

describe('portableWorkspacePath', () => {
    it('resolves the relative path through the shared source-controller helper', () => {
        const request = createScmSourceControllerPortableWorkspacePathRequest({
            relativePath: '.git/HEAD',
        });

        expect(resolveScmSourceControllerPortableWorkspacePathRelativePath(request)).toBe('.git/HEAD');
    });
});

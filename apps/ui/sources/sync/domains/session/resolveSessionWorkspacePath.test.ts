import { describe, expect, it } from 'vitest';

import { resolveSessionWorkspacePath } from './resolveSessionWorkspacePath';

describe('resolveSessionWorkspacePath', () => {
    it('returns session path when available', () => {
        expect(resolveSessionWorkspacePath({ sessionPath: '/workspace/session', projectPath: '/workspace/project' })).toBe('/workspace/session');
    });

    it('falls back to project path when session path is missing', () => {
        expect(resolveSessionWorkspacePath({ sessionPath: null, projectPath: '/workspace/project' })).toBe('/workspace/project');
    });

    it('returns null when both paths are missing', () => {
        expect(resolveSessionWorkspacePath({ sessionPath: null, projectPath: null })).toBeNull();
    });
});


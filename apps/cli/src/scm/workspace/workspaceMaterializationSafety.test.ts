import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { assertWorkspaceMaterializationSymlinkTarget, resolveContainedWorkspaceMaterializationPath } from './workspaceMaterializationSafety';

const root = resolve(tmpdir(), 'happier-materialization-safety');
describe('workspace materialization path representations', () => {
    it('retains portable path normalization and traversal refusal', () => {
        expect(resolveContainedWorkspaceMaterializationPath({ workspaceRoot: root, candidatePath: ' folder\\file.txt ',
            errorMessage: 'Outside' })).toBe(join(root, 'folder', 'file.txt'));
        for (const path of ['../outside', '..\\outside']) {
            expect(() => resolveContainedWorkspaceMaterializationPath({ workspaceRoot: root, candidatePath: path,
                errorMessage: 'Outside' })).toThrowError(expect.objectContaining({ code: SCM_OPERATION_ERROR_CODES.INVALID_PATH }));
        }
    });

    it('refuses traversal in native paths and raw symlink targets', () => {
        expect(() => resolveContainedWorkspaceMaterializationPath({ workspaceRoot: root, candidatePath: '../outside',
            errorMessage: 'Outside', pathRepresentation: 'native_literal' })).toThrowError(expect.objectContaining({ code: SCM_OPERATION_ERROR_CODES.INVALID_PATH }));
        expect(() => assertWorkspaceMaterializationSymlinkTarget({ workspaceRoot: root, linkPath: join(root, 'link'),
            target: '../outside', pathRepresentation: 'native_literal' })).toThrowError(expect.objectContaining({ code: SCM_OPERATION_ERROR_CODES.INVALID_PATH }));
    });

    it.skipIf(process.platform === 'win32')('preserves POSIX literal spaces and backslashes in paths and links', () => {
        for (const name of [' leading.txt ', 'context\\name.txt']) {
            expect(resolveContainedWorkspaceMaterializationPath({ workspaceRoot: root, candidatePath: name,
                errorMessage: 'Outside', pathRepresentation: 'native_literal' })).toBe(join(root, name));
            expect(() => assertWorkspaceMaterializationSymlinkTarget({ workspaceRoot: root, linkPath: join(root, 'link'),
                target: name, pathRepresentation: 'native_literal' })).not.toThrow();
        }
    });
});

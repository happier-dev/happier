import { describe, expect, it } from 'vitest';

import { resolveMachineAbsolutePath } from './resolveMachineAbsolutePath';

describe('resolveMachineAbsolutePath', () => {
    it('returns rootPath for empty requestPath or "."', () => {
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: '' })).toBe('/repo');
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: '.' })).toBe('/repo');
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: null })).toBe('/repo');
    });

    it('passes through tilde and absolute paths', () => {
        const windowsAbs = String.raw`C:\Repo\file.txt`;
        const uncAbs = String.raw`\\server\share\x`;
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: '~/repo' })).toBe('~/repo');
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: '/abs/path' })).toBe('/abs/path');
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: windowsAbs })).toBe(windowsAbs);
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: uncAbs })).toBe(uncAbs);
    });

    it('joins relative paths using the rootPath separator style', () => {
        const windowsRoot = String.raw`C:\Repo`;
        const uncRoot = String.raw`\\server\share\repo`;
        expect(resolveMachineAbsolutePath({ rootPath: '/repo', requestPath: 'a/b' })).toBe('/repo/a/b');
        expect(resolveMachineAbsolutePath({ rootPath: '/repo/', requestPath: 'a/b' })).toBe('/repo/a/b');
        expect(resolveMachineAbsolutePath({ rootPath: windowsRoot, requestPath: String.raw`a\b` }))
            .toBe(String.raw`C:\Repo\a\b`);
        expect(resolveMachineAbsolutePath({ rootPath: uncRoot, requestPath: String.raw`a\b` }))
            .toBe(String.raw`\\server\share\repo\a\b`);
    });

    it('rebases absolute agent workspace paths without touching sibling paths', () => {
        expect(resolveMachineAbsolutePath({
            rootPath: '/Users/alice/project',
            agentRootPath: '/home/coder/project',
            requestPath: '/home/coder/project/src/index.ts',
        })).toBe('/Users/alice/project/src/index.ts');
        expect(resolveMachineAbsolutePath({
            rootPath: '/Users/alice/project',
            agentRootPath: '/home/coder/project',
            requestPath: '/home/coder/project-other/src/index.ts',
        })).toBe('/home/coder/project-other/src/index.ts');

        expect(resolveMachineAbsolutePath({
            rootPath: String.raw`D:\work\project`,
            agentRootPath: String.raw`C:\Users\Alice\project`,
            requestPath: String.raw`c:\users\alice\project\src\index.ts`,
        })).toBe(String.raw`D:\work\project\src\index.ts`);
    });
});

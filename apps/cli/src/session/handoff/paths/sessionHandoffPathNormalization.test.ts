import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
    getPathRemainderWithinBase,
    expandHomeRelativePath,
    normalizeSessionHandoffTargetPathForLocalMachine,
    resolveSessionHandoffWorkspaceSessionPath,
    resolveSessionHandoffLocalHomeDir,
    toHomeRelativePath,
} from './sessionHandoffPathNormalization';

describe('sessionHandoffPathNormalization', () => {
    it('compares UNC workspace roots case-insensitively across separator styles', () => {
        expect(getPathRemainderWithinBase('\\\\Server\\Share\\Code\\My-App', '//server/share/code')).toBe('My-App');
        expect(getPathRemainderWithinBase('\\\\Server\\Share\\Code2', '//server/share/code')).toBeNull();
    });

    it('preserves the nested cwd spelling while comparing Windows roots case-insensitively', () => {
        expect(getPathRemainderWithinBase(
            'C:\\Users\\Alice\\Projects\\App\\Packages\\MixedCase',
            'c:/users/alice/projects/app',
        )).toBe('Packages/MixedCase');
    });

    it('appends only a safe contained session-relative cwd to the target repository root', () => {
        expect(resolveSessionHandoffWorkspaceSessionPath({
            targetRoot: '/target/repository',
            sessionRelativeCwd: 'packages/empty',
        })).toBe('/target/repository/packages/empty');
        expect(resolveSessionHandoffWorkspaceSessionPath({
            targetRoot: 'C:\\target\\repository',
            sessionRelativeCwd: 'packages/app',
        })).toBe('C:\\target\\repository\\packages\\app');
        expect(() => resolveSessionHandoffWorkspaceSessionPath({
            targetRoot: '/target/repository',
            sessionRelativeCwd: '../escape',
        })).toThrow();
        expect(() => resolveSessionHandoffWorkspaceSessionPath({
            targetRoot: '/target/repository',
            sessionRelativeCwd: '/escape',
        })).toThrow();
    });

    it('toHomeRelativePath converts a home-contained absolute path to ~/', () => {
        expect(toHomeRelativePath({
            absolutePath: '/Users/alice/projects/demo',
            homeDir: '/Users/alice',
        })).toBe('~/projects/demo');
    });

    it('toHomeRelativePath leaves non-home absolute paths unchanged', () => {
        expect(toHomeRelativePath({
            absolutePath: '/tmp/demo',
            homeDir: '/Users/alice',
        })).toBe('/tmp/demo');
    });

    it('expandHomeRelativePath expands ~/', () => {
        const homeDir = '/home/guest';
        expect(expandHomeRelativePath({
            path: '~/.happier/wsrepl-qa-fixtures/large-repo',
            homeDir,
        })).toBe(join(homeDir, '.happier', 'wsrepl-qa-fixtures', 'large-repo'));
    });

    it('toHomeRelativePath normalizes Windows home-contained absolute paths to forward-slash ~/ syntax', () => {
        expect(toHomeRelativePath({
            absolutePath: 'C:\\Users\\alice\\projects\\demo',
            homeDir: 'C:\\Users\\alice',
        })).toBe('~/projects/demo');
    });

    it('toHomeRelativePath matches Windows home paths case-insensitively across slash styles', () => {
        expect(toHomeRelativePath({
            absolutePath: 'C:/Users/Alice/projects/demo',
            homeDir: 'C:\\Users\\alice',
        })).toBe('~/projects/demo');
    });

    it('expandHomeRelativePath expands ~\\ on Windows-style home paths', () => {
        const homeDir = 'C:\\Users\\alice';
        expect(expandHomeRelativePath({
            path: '~\\projects\\demo',
            homeDir,
        })).toBe(join(homeDir, 'projects', 'demo'));
    });

    it('normalizeSessionHandoffTargetPathForLocalMachine rebases /.happier/ paths onto the local home', () => {
        const homeDir = '/home/leeroy.guest';
        expect(normalizeSessionHandoffTargetPathForLocalMachine({
            requestedTargetPath: '/Users/leeroy/.happier/wsrepl-qa-fixtures/large-repo',
            homeDir,
        })).toBe(join(homeDir, '.happier', 'wsrepl-qa-fixtures', 'large-repo'));
    });

    it('normalizeSessionHandoffTargetPathForLocalMachine rebases /Users/<user>/ paths onto the local home', () => {
        const homeDir = '/home/guest';
        expect(normalizeSessionHandoffTargetPathForLocalMachine({
            requestedTargetPath: '/Users/alice/projects/demo',
            homeDir,
        })).toBe(join(homeDir, 'projects', 'demo'));
    });

    it('normalizeSessionHandoffTargetPathForLocalMachine rebases Windows home-rooted paths onto the local home', () => {
        const homeDir = '/home/guest';
        expect(normalizeSessionHandoffTargetPathForLocalMachine({
            requestedTargetPath: 'C:\\Users\\alice\\projects\\demo',
            homeDir,
        })).toBe(join(homeDir, 'projects', 'demo'));
    });

    it('normalizeSessionHandoffTargetPathForLocalMachine leaves paths already rooted under the local home unchanged', () => {
        const homeDir = '/Users/leeroy/Documents/Development/happier/dev/.project/logs/e2e/run/cli-home-target';
        const requestedTargetPath = `${homeDir}/workspace`;

        expect(normalizeSessionHandoffTargetPathForLocalMachine({
            requestedTargetPath,
            homeDir,
        })).toBe(requestedTargetPath);
    });

    it('resolveSessionHandoffLocalHomeDir prefers the activeServerDir /.happier/ prefix over os homedir', () => {
        expect(resolveSessionHandoffLocalHomeDir({
            activeServerDir: '/home/leeroy.guest/.happier/wsrepl-qa/servers/stack_wsrepl__id_default',
            fallbackHomeDir: '/Users/leeroy',
        })).toBe('/home/leeroy.guest');
    });
});

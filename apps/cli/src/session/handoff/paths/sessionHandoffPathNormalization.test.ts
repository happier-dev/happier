import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
    getPathRemainderWithinBase,
    expandHomeRelativePath,
    resolveSessionHandoffWorkspaceSessionPath,
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

    it('expandHomeRelativePath expands ~/', () => {
        const homeDir = '/home/guest';
        expect(expandHomeRelativePath({
            path: '~/.happier/wsrepl-qa-fixtures/large-repo',
            homeDir,
        })).toBe(join(homeDir, '.happier', 'wsrepl-qa-fixtures', 'large-repo'));
    });

    it('expandHomeRelativePath expands ~\\ on Windows-style home paths', () => {
        const homeDir = 'C:\\Users\\alice';
        expect(expandHomeRelativePath({
            path: '~\\projects\\demo',
            homeDir,
        })).toBe(join(homeDir, 'projects', 'demo'));
    });

});

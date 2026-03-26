import { describe, expect, it } from 'vitest';

import {
    expandHomeRelativePath,
    normalizeSessionHandoffTargetPathForLocalMachine,
    resolveSessionHandoffLocalHomeDir,
    toHomeRelativePath,
} from './sessionHandoffPathNormalization';

describe('sessionHandoffPathNormalization', () => {
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
        expect(expandHomeRelativePath({
            path: '~/.happier/wsrepl-qa-fixtures/large-repo',
            homeDir: '/home/guest',
        })).toBe('/home/guest/.happier/wsrepl-qa-fixtures/large-repo');
    });

    it('normalizeSessionHandoffTargetPathForLocalMachine rebases /.happier/ paths onto the local home', () => {
        expect(normalizeSessionHandoffTargetPathForLocalMachine({
            requestedTargetPath: '/Users/leeroy/.happier/wsrepl-qa-fixtures/large-repo',
            homeDir: '/home/leeroy.guest',
        })).toBe('/home/leeroy.guest/.happier/wsrepl-qa-fixtures/large-repo');
    });

    it('normalizeSessionHandoffTargetPathForLocalMachine rebases /Users/<user>/ paths onto the local home', () => {
        expect(normalizeSessionHandoffTargetPathForLocalMachine({
            requestedTargetPath: '/Users/alice/projects/demo',
            homeDir: '/home/guest',
        })).toBe('/home/guest/projects/demo');
    });

    it('resolveSessionHandoffLocalHomeDir prefers the activeServerDir /.happier/ prefix over os homedir', () => {
        expect(resolveSessionHandoffLocalHomeDir({
            activeServerDir: '/home/leeroy.guest/.happier/wsrepl-qa/servers/stack_wsrepl__id_default',
            fallbackHomeDir: '/Users/leeroy',
        })).toBe('/home/leeroy.guest');
    });
});

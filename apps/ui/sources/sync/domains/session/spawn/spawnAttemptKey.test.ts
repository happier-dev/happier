import { describe, expect, it } from 'vitest';

import { createSpawnAttemptKeyForFreshSpawnOptions } from './spawnAttemptKey';

describe('createSpawnAttemptKeyForFreshSpawnOptions', () => {
    it('fingerprints only the target and never stores launch options or secrets', () => {
        const base = {
            machineId: 'machine-1',
            serverId: 'server-a',
            directory: '/repo',
            backendTarget: { kind: 'backend', backendId: 'claude' },
        } as const;
        const fingerprint = createSpawnAttemptKeyForFreshSpawnOptions(base, '/Users/alice');
        const changedLaunchOptions = createSpawnAttemptKeyForFreshSpawnOptions({
            ...base,
            backendTarget: { kind: 'backend', backendId: 'codex' },
            permissionMode: 'yolo',
            modelId: 'private-model-config',
            terminal: { mode: 'tmux', requested: true },
        }, '/Users/alice');

        expect(changedLaunchOptions).toBe(fingerprint);
        expect(fingerprint).not.toContain('private-model-config');
        expect(createSpawnAttemptKeyForFreshSpawnOptions({ ...base, directory: '/other' }, '/Users/alice'))
            .not.toBe(fingerprint);
    });

    it.each([
        ['/repo', '/repo/', '/Users/alice'],
        ['~/repo', '/Users/alice/repo', '/Users/alice'],
        ['  ~/repo  ', '/Users/alice/repo', '/Users/alice'],
        ['~\\repo', '/Users/alice/repo', '/Users/alice/'],
        ['C:\\Users\\Alice\\Repo', 'c:/users/alice/repo/', 'C:\\Users\\Alice'],
        ['C:/Users/Alice\\Repo', 'c:\\users\\alice/repo', 'C:/Users/Alice/'],
    ])('uses one filesystem identity for %s and %s', (left, right, homeDir) => {
        const target = { machineId: 'machine-1', serverId: 'server-a' } as const;

        expect(createSpawnAttemptKeyForFreshSpawnOptions({ ...target, directory: left }, homeDir))
            .toBe(createSpawnAttemptKeyForFreshSpawnOptions({ ...target, directory: right }, homeDir));
    });

    it('preserves home sibling boundaries and distinct real directories', () => {
        const target = { machineId: 'machine-1', serverId: 'server-a' } as const;
        const homeDir = 'C:\\Users\\alice';
        const homeRepo = createSpawnAttemptKeyForFreshSpawnOptions({ ...target, directory: '~\\repo' }, homeDir);

        expect(createSpawnAttemptKeyForFreshSpawnOptions({ ...target, directory: 'C:\\Users\\alice2\\repo' }, homeDir))
            .not.toBe(homeRepo);
        expect(createSpawnAttemptKeyForFreshSpawnOptions({ ...target, directory: 'C:\\Users\\alice\\other' }, homeDir))
            .not.toBe(homeRepo);
    });

    it('treats the extended UNC prefix case-insensitively', () => {
        const target = { machineId: 'machine-1', serverId: 'server-a' } as const;

        expect(createSpawnAttemptKeyForFreshSpawnOptions({
            ...target,
            directory: '\\\\?\\UNC\\Server\\Share\\Repo',
        }, 'C:\\Users\\alice')).toBe(createSpawnAttemptKeyForFreshSpawnOptions({
            ...target,
            directory: '\\\\?\\unc\\server\\share\\repo\\',
        }, 'C:\\Users\\alice'));
    });
});

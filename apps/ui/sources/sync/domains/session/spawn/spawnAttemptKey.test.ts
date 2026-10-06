import { describe, expect, it } from 'vitest';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol';


import {
    createSpawnAttemptKeyForFreshSpawnOptions,
    createSpawnAttemptKeyForSessionSpawnNewInput,
} from './spawnAttemptKey';

describe('createSpawnAttemptKeyForFreshSpawnOptions', () => {
    it.each([
        ['Agent', { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } } }],
        ['model', { modelSelection: { v: 1, updatedAt: 99, ref: { agentTargetKey: 'happier.claude:claude', providerConnectionId: null, modelId: 'opus' } } }],
        ['profile', { profileId: 'profile-b' }],
        ['storage', { transcriptStorage: 'direct' }],
        ['configuration', { configuration: { mode: { value: 'plan', updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 1 }, options: { effort: { value: 'high', updatedAtMs: 1 } } } }],
        ['organization', { organizationPlacement: { folderId: 'folder-b', tagIds: ['tag-a'] } }],
    ] as const)('changes custody when the normalized immutable %s intent changes', (_label, changed) => {
        const base = {
            machineId: 'machine-1',
            serverId: 'server-a',
            directory: '/repo',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
            modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'happier.claude:claude', providerConnectionId: null, modelId: 'sonnet' } },
            profileId: 'profile-a',
            transcriptStorage: 'persisted',
            configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 1 }, options: {} },
            organizationPlacement: { folderId: 'folder-a', tagIds: ['tag-b', 'tag-a'] },
        } as const;
        const fingerprint = createSpawnAttemptKeyForFreshSpawnOptions(base, '/Users/alice');

        expect(createSpawnAttemptKeyForFreshSpawnOptions({ ...base, ...changed }, '/Users/alice'))
            .not.toBe(fingerprint);
        expect(fingerprint).not.toContain('profile-a');
        expect(fingerprint).not.toContain('sonnet');
    });

    it('normalizes equivalent recipe spelling and excludes routing-only server scope', () => {
        const base = {
            machineId: 'machine-1',
            serverId: 'server-a',
            directory: '~/repo',
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
            organizationPlacement: { folderId: 'folder-a', tagIds: ['tag-b', 'tag-a'] },
        } as const;
        const fingerprint = createSpawnAttemptKeyForFreshSpawnOptions(base, '/Users/alice');

        expect(createSpawnAttemptKeyForFreshSpawnOptions({
            ...base,
            serverId: 'server-b',
            directory: '/Users/alice/repo/',
            organizationPlacement: { folderId: 'folder-a', tagIds: ['tag-a', 'tag-b'] },
        }, '/Users/alice')).toBe(fingerprint);
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

    it('does not include direct-to-daemon raw environment material in custody identity', () => {
        const input = {
            creationKey: SessionCreationKeyV1Schema.parse('manual:attempt-a'),
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/repo' },
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.claude', localId: 'claude' },
            },
        } as const;
        const key = createSpawnAttemptKeyForSessionSpawnNewInput(input, '/Users/alice');
        expect(createSpawnAttemptKeyForSessionSpawnNewInput({
            ...input,
            environmentVariables: { SECRET_TOKEN: 'must-not-enter-custody' },
        }, '/Users/alice')).toBe(key);
        expect(createSpawnAttemptKeyForSessionSpawnNewInput({
            ...input,
            environmentVariables: { SECRET_TOKEN: 'different-secret' },
        }, '/Users/alice')).toBe(key);
        expect(key).not.toContain('must-not-enter-custody');
    });

    it('keys a no-folder attempt by its own creation key, never by a folder, and never throws for it', () => {
        const input = (creationKey: string, directory: { kind: 'managed' } | { kind: 'path'; path: string }) => ({
            creationKey: SessionCreationKeyV1Schema.parse(creationKey),
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            directory,
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.claude', localId: 'claude' },
            },
        });
        const managedA = createSpawnAttemptKeyForSessionSpawnNewInput(input('manual:a', { kind: 'managed' }), '/Users/alice');
        expect(createSpawnAttemptKeyForSessionSpawnNewInput(input('manual:a', { kind: 'managed' }), '/Users/alice')).toBe(managedA);
        // Two separate no-folder chats with the same settings are two attempts.
        expect(createSpawnAttemptKeyForSessionSpawnNewInput(input('manual:b', { kind: 'managed' }), '/Users/alice')).not.toBe(managedA);
        // A folder attempt keeps its folder identity (the creation key does not split it).
        expect(createSpawnAttemptKeyForSessionSpawnNewInput(input('manual:a', { kind: 'path', path: '~/repo' }), '/Users/alice'))
            .toBe(createSpawnAttemptKeyForSessionSpawnNewInput(input('manual:b', { kind: 'path', path: '/Users/alice/repo' }), '/Users/alice'));
        expect(createSpawnAttemptKeyForSessionSpawnNewInput(input('manual:a', { kind: 'path', path: '/repo' }), '/Users/alice'))
            .not.toBe(managedA);
    });
});

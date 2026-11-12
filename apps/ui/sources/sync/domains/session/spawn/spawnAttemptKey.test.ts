import { describe, expect, it } from 'vitest';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionModelSelectionV2Schema, sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';

import {
    createSpawnAttemptKeyForSessionSpawnNewInput,
    resolveSpawnAttemptDirectoryIdentity,
} from './spawnAttemptKey';

describe('Session creation custody identity', () => {
    it.each([
        { teamId: 'team-b' },
        { resourceId: 'resource-b' },
        { expectedResourceRevision: 8 },
        { agentTargetKey: 'agent:happier.agent.claude/claude' },
        { modelId: 'model-b' },
        { deliveryMode: 'vendor-native' },
    ])('distinguishes an exact Team model selection change %j', changed => {
        const ref = { source: 'team_resource', teamId: 'team-a', resourceId: 'resource-a',
            expectedResourceRevision: 7, agentTargetKey: 'agent:happier.agent.codex/codex',
            modelId: 'model-a', deliveryMode: 'brokered' };
        const input = {
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        } satisfies SessionSpawnNewInputV2;
        const teamInput = (selectionRef: typeof ref) => ({ ...input, teamCredentialBindings: [
            sessionModelSelectionV2TeamBindingIntent(SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 0, ref: selectionRef })),
        ] });
        const fingerprint = createSpawnAttemptKeyForSessionSpawnNewInput(teamInput(ref), '/home/alice');
        expect(createSpawnAttemptKeyForSessionSpawnNewInput(teamInput({ ...ref, ...changed }), '/home/alice')).not.toBe(fingerprint);
        expect(createSpawnAttemptKeyForSessionSpawnNewInput(input, '/home/alice')).not.toBe(fingerprint);
        expect(createSpawnAttemptKeyForSessionSpawnNewInput(teamInput(ref), '/home/alice')).toBe(fingerprint);
    });

    it('distinguishes vendor-native Team delivery references', () => {
        const selection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 0, ref: {
            source: 'team_resource', teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-a', deliveryMode: 'vendor-native',
            nativeDelivery: { managedId: 'managed-a', controllerInstallationId: 'controller-a', guestInstallationId: 'guest-a',
                bindingKey: 'binding-a', placeholderRef: 'placeholder-a', sourceRevision: 'source-a', providerTicket: 't'.repeat(43) },
        } });
        const binding = sessionModelSelectionV2TeamBindingIntent(selection);
        const input = {
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            teamCredentialBindings: [binding],
        } satisfies SessionSpawnNewInputV2;
        if (!('nativeDelivery' in binding) || !binding.nativeDelivery) throw new Error('Missing native Team fixture');
        expect(createSpawnAttemptKeyForSessionSpawnNewInput({ ...input, teamCredentialBindings: [
            { ...binding, nativeDelivery: { ...binding.nativeDelivery, sourceRevision: 'source-b' } },
        ] }, '/home/alice')).not.toBe(createSpawnAttemptKeyForSessionSpawnNewInput(input, '/home/alice'));
    });

    it('distinguishes fresh spawns that differ only in skill session selection', () => {
        const base = {
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' }, directory: { kind: 'path' as const, path: '/repo' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            capabilitySelection: {
                mcp: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
                skills: { v: 1 as const, forceIncludeSkillIds: ['skill-a'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
            },
        };
        const first = createSpawnAttemptKeyForSessionSpawnNewInput(base, '/home/alice');
        expect(createSpawnAttemptKeyForSessionSpawnNewInput({
            ...base,
            capabilitySelection: { ...base.capabilitySelection, skills: { ...base.capabilitySelection.skills, forceIncludeSkillIds: ['skill-b'] } },
        }, '/home/alice')).not.toBe(first);
    });

    it.each([
        ['Agent', { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } } }],
        ['model', { modelSelection: { v: 1, updatedAt: 99, ref: { agentTargetKey: 'happier.claude:claude', providerConnectionId: null, modelId: 'opus' } } }],
        ['profile', { profileId: 'profile-b' }],
        ['storage', { transcriptStorage: 'direct' }],
        ['configuration', { configuration: { mode: { value: 'plan', updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 1 }, options: { effort: { value: 'high', updatedAtMs: 1 } } } }],
        ['organization', { organizationPlacement: { folderId: 'folder-b', tagIds: ['tag-a'] } }],
    ] satisfies Array<readonly [string, Partial<SessionSpawnNewInputV2>]>)('changes custody when the normalized immutable %s intent changes', (_label, changed) => {
        const base = {
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            directory: { kind: 'path', path: '/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
            modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'happier.claude:claude', providerConnectionId: null, modelId: 'sonnet' } },
            profileId: 'profile-a',
            transcriptStorage: 'persisted',
            configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 1 }, options: {} },
            organizationPlacement: { folderId: 'folder-a', tagIds: ['tag-b', 'tag-a'] },
        } satisfies SessionSpawnNewInputV2;
        const fingerprint = createSpawnAttemptKeyForSessionSpawnNewInput(base, '/Users/alice');

        expect(createSpawnAttemptKeyForSessionSpawnNewInput({ ...base, ...changed }, '/Users/alice'))
            .not.toBe(fingerprint);
        expect(fingerprint).not.toContain('profile-a');
        expect(fingerprint).not.toContain('sonnet');
    });

    it('normalizes equivalent recipe spelling', () => {
        const base = {
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            directory: { kind: 'path', path: '~/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.claude', localId: 'claude' } },
            organizationPlacement: { folderId: 'folder-a', tagIds: ['tag-b', 'tag-a'] },
        } satisfies SessionSpawnNewInputV2;
        const fingerprint = createSpawnAttemptKeyForSessionSpawnNewInput(base, '/Users/alice');

        expect(createSpawnAttemptKeyForSessionSpawnNewInput({
            ...base,
            directory: { kind: 'path', path: '/Users/alice/repo/' },
            organizationPlacement: { folderId: 'folder-a', tagIds: ['tag-a', 'tag-b'] },
        }, '/Users/alice')).toBe(fingerprint);
        expect(createSpawnAttemptKeyForSessionSpawnNewInput({ ...base, directory: { kind: 'path', path: '/other' } }, '/Users/alice'))
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
        expect(resolveSpawnAttemptDirectoryIdentity(left, homeDir))
            .toBe(resolveSpawnAttemptDirectoryIdentity(right, homeDir));
    });

    it('preserves home sibling boundaries and distinct real directories', () => {
        const homeDir = 'C:\\Users\\alice';
        const homeRepo = resolveSpawnAttemptDirectoryIdentity('~\\repo', homeDir);

        expect(resolveSpawnAttemptDirectoryIdentity('C:\\Users\\alice2\\repo', homeDir))
            .not.toBe(homeRepo);
        expect(resolveSpawnAttemptDirectoryIdentity('C:\\Users\\alice\\other', homeDir))
            .not.toBe(homeRepo);
    });

    it('treats the extended UNC prefix case-insensitively', () => {
        expect(resolveSpawnAttemptDirectoryIdentity('\\\\?\\UNC\\Server\\Share\\Repo', 'C:\\Users\\alice'))
            .toBe(resolveSpawnAttemptDirectoryIdentity('\\\\?\\unc\\server\\share\\repo\\', 'C:\\Users\\alice'));
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

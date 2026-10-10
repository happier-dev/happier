import { describe, expect, it, vi } from 'vitest';

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'profile-id',
}));

import { convertBuiltInProfileToCustom, createEmptyCustomProfile, duplicateProfileDraftForEdit, duplicateProfileForEdit } from './profileMutations';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import type { ProfileRecordV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';

describe('createEmptyCustomProfile', () => {
    it('creates a slim V2 launch profile that cannot own provider routing or credentials', () => {
        expect(createEmptyCustomProfile()).toMatchObject({
            v: 2,
            id: 'profile-id',
            extraEnvironmentVariables: [],
            compatibilityByTargetKey: {
                'agent:happier.agent.claude/claude': true,
                'agent:happier.agent.codex/codex': true,
                'agent:happier.agent.gemini/gemini': true,
            },
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByTargetKey: {},
        });
        expect(createEmptyCustomProfile()).not.toHaveProperty('environmentVariables');
        expect(createEmptyCustomProfile()).not.toHaveProperty('envVarRequirements');
    });

    it('duplicates a V2 Artifact as a private draft without reusing Resource or row edit authority', () => {
        const source = { ...createEmptyCustomProfile(), id: 'shared-source', name: 'Shared source',
            artifactId: 'shared-document', revision: { headerVersion: 2, bodyVersion: 3 },
            profileRecordRevision: 7, shared: true, viewOnly: true, enabled: false,
            promptStack: [{ id: 'private-prompt', ref: { kind: 'doc', artifactId: 'prompt-document' },
                enabled: true, placement: 'system_append' }],
            secretBindings: { TOKEN: 'happier:shared-secret:v1:token-resource' },
        } satisfies AiLaunchProfile;
        const sourceRow = { record: { v: 1, id: source.id,
            definition: { kind: 'artifact', artifactId: source.artifactId }, enabled: source.enabled,
            promptStack: source.promptStack, secretBindings: { MASKED: null },
        } satisfies ProfileRecordV1, revision: source.profileRecordRevision };
        const result = duplicateProfileDraftForEdit(source, { copySuffix: 'Copy', sourceRow });
        expect(result.status).toBe('draft');
        if (result.status !== 'draft') throw new Error(result.reason);
        const draft = result.profile;
        expect(draft).toMatchObject({ id: 'profile-id', name: 'Shared source Copy', enabled: false,
            promptStack: source.promptStack, secretBindings: source.secretBindings });
        expect(draft).not.toHaveProperty('artifactId');
        expect(draft).not.toHaveProperty('revision');
        expect(draft).not.toHaveProperty('profileRecordRevision');
        expect(draft).not.toHaveProperty('shared');
        expect(draft).not.toHaveProperty('viewOnly');
        expect(result.secretBindings).toEqual({ ...source.secretBindings, MASKED: null });
        expect(source.artifactId).toBe('shared-document');
        expect(source.profileRecordRevision).toBe(7);
    });

    it('opens an editable copy draft when the copy suffix exceeds the source name authoring bound', () => {
        const body = { ...createEmptyCustomProfile(), id: 'source-profile', name: 'A'.repeat(100) };
        const source = { ...body,
            enabled: true, profileRecordRevision: 7 } satisfies AiLaunchProfile;
        const sourceRow = { record: { v: 1, id: source.id, definition: { kind: 'inline', profile: body },
            enabled: true, promptStack: [], secretBindings: {} } satisfies ProfileRecordV1, revision: 7 };
        const result = duplicateProfileDraftForEdit(source, { copySuffix: 'Copy', sourceRow });
        expect(result.status).toBe('draft');
        if (result.status !== 'draft') throw new Error(result.reason);
        expect(result.profile.name).toBe(`${source.name} Copy`);
        expect(result.profile.id).toBe('profile-id');
    });

    it('refuses direct legacy cloning instead of dropping routing and machine-login prerequisites', () => {
        const legacy = AIBackendProfileSchema.parse({
            id: 'legacy-provider', name: 'Legacy', description: 'Keep me',
            environmentVariables: [
                { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example' },
                { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
                { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                { name: 'SAFE_LAUNCH_FLAG', value: '1' },
            ],
            defaultPermissionModeByTargetKey: { 'agent:happier.agent.claude/claude': 'acceptEdits' as const },
            defaultPersistenceModeByTargetKey: { 'agent:happier.agent.claude/claude': 'persisted' as const },
            compatibilityByTargetKey: { 'agent:happier.agent.claude/claude': true },
            authMode: 'machineLogin', requiresMachineLoginTargetKey: 'agent:happier.agent.claude/claude',
            createdAt: 1, updatedAt: 1,
        });
        const original = structuredClone(legacy);
        expect(duplicateProfileDraftForEdit(legacy)).toEqual({ status: 'invalid', reason: 'legacy-creation-unsupported', id: legacy.id });
        expect(() => duplicateProfileForEdit(legacy, { copySuffix: 'Copy' })).toThrowError('legacy-creation-unsupported');
        expect(() => convertBuiltInProfileToCustom(legacy)).toThrowError('legacy-creation-unsupported');
        expect(legacy).toEqual(original);
    });

    it('keeps retained prompt behavior with its legacy source when no approved clone representation exists', () => {
        const legacy = AIBackendProfileSchema.parse({
            id: 'remote-dev-profile', name: 'Remote Dev Profile',
            environmentVariables: [],
            defaultPermissionModeByTargetKey: {},
            defaultPersistenceModeByTargetKey: {},
            compatibilityByTargetKey: {},
            createdAt: 1, updatedAt: 1,
            codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial' as const, responseOptions: 'disabled' as const },
        });
        expect(() => convertBuiltInProfileToCustom(legacy)).toThrowError('legacy-creation-unsupported');
        expect(() => duplicateProfileForEdit(legacy, { copySuffix: 'Copy' })).toThrowError('legacy-creation-unsupported');
        expect(legacy.codingPromptBehaviorV1).toEqual({ v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' });
    });
});

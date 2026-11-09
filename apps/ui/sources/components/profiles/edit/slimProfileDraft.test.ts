import { describe, expect, it } from 'vitest';

import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import { StoredLaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { buildSlimProfileSave } from './slimProfileDraft';
import { getAllAgentProviderOwnedEnvironmentKeys } from '@/agents/registry/registryCore';

const base = {
    v: 2 as const,
    id: 'profile-a', name: 'Profile A', extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
    createdAt: 1, updatedAt: 1,
};

describe('buildSlimProfileSave', () => {
    it('edits an admitted V2 body without losing private attachments or row and Artifact revision evidence', () => {
        const profile = { ...base, artifactId: 'shared-profile-document',
            revision: { headerVersion: 3, bodyVersion: 4 }, profileRecordRevision: 7,
            enabled: false, secretBindings: { TOKEN: 'happier:shared-secret:v1:token-resource' },
            promptStack: [{ id: 'private-prompt', ref: { kind: 'doc', artifactId: 'prompt-document' },
                enabled: true, placement: 'system_append' }],
        } satisfies AiLaunchProfile;
        expect(buildSlimProfileSave(profile, {
            name: 'Edited profile', description: '', extraEnvironmentVariables: [],
        }, () => 10)).toMatchObject({ status: 'success', profile: {
            name: 'Edited profile', enabled: false, promptStack: profile.promptStack,
            secretBindings: profile.secretBindings, profileRecordRevision: 7,
            artifactId: profile.artifactId, revision: profile.revision, updatedAt: 10,
        } });
    });

    it('saves the Skills this Profile adds, and an emptied list removes them instead of keeping the old seeds', () => {
        const profile = { ...base, skillSeeds: ['lint-id', 'review-id'] } satisfies AiLaunchProfile;
        const draft = { name: 'Profile A', description: '', extraEnvironmentVariables: [] };
        expect(buildSlimProfileSave(profile, { ...draft, skillSeeds: ['review-id', 'docs-id'] }, () => 10))
            .toMatchObject({ status: 'success', profile: { skillSeeds: ['review-id', 'docs-id'] } });
        expect(buildSlimProfileSave(profile, { ...draft, skillSeeds: [] }, () => 10))
            .toMatchObject({ status: 'success', profile: { skillSeeds: [] } });
        expect(buildSlimProfileSave(profile, draft, () => 10))
            .toMatchObject({ status: 'success', profile: { skillSeeds: ['lint-id', 'review-id'] } });
    });

    it('retains admitted stored environment rows beyond the new-profile authoring bound', () => {
        const profile = { ...StoredLaunchProfileV2Schema.parse({ ...base,
            extraEnvironmentVariables: Array.from({ length: 257 }, (_, index) => ({ name: `SAFE_${index}`, value: '1' })),
        }), profileRecordRevision: 7 };
        const result = buildSlimProfileSave(profile, { name: 'Renamed existing profile', description: '',
            extraEnvironmentVariables: profile.extraEnvironmentVariables }, () => 10);
        expect(result.status).toBe('success');
        if (result.status !== 'success') throw new Error(result.message);
        expect(result.profile.extraEnvironmentVariables).toEqual(profile.extraEnvironmentVariables);
        expect(result.profile).toMatchObject({ profileRecordRevision: 7, updatedAt: 10 });
    });

    it('persists sparse coding prompt behavior overrides without copying account defaults', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Profile A',
            description: '',
            extraEnvironmentVariables: [],
            codingPromptBehaviorOverrides: {
                sessionTitleUpdates: 'initial',
                responseOptions: 'disabled',
            },
        })).toMatchObject({
            status: 'success',
            profile: {
                codingPromptBehaviorOverrides: {
                    sessionTitleUpdates: 'initial',
                    responseOptions: 'disabled',
                },
            },
        });
    });

    it('clears inherited coding prompt behavior overrides instead of retaining stored values', () => {
        const saved = buildSlimProfileSave({
            ...base,
            codingPromptBehaviorOverrides: {
                sessionTitleUpdates: 'ongoing' as const,
                responseOptions: 'agent' as const,
            },
        }, {
            name: 'Profile A',
            description: '',
            extraEnvironmentVariables: [],
            codingPromptBehaviorOverrides: undefined,
        });

        expect(saved.status).toBe('success');
        expect(saved.status === 'success' ? saved.profile.codingPromptBehaviorOverrides : 'error').toBeUndefined();
    });

    it('returns a strict slim profile with trimmed identity and safe launch environment', () => {
        expect(buildSlimProfileSave(base, {
            name: '  Focused  ', description: '  Daily setup  ',
            extraEnvironmentVariables: [{ name: 'SAFE_FLAG', value: '1' }],
        })).toEqual({
            status: 'success',
            profile: {
                ...base,
                name: 'Focused',
                description: 'Daily setup',
                extraEnvironmentVariables: [{ name: 'SAFE_FLAG', value: '1' }],
                updatedAt: expect.any(Number),
            },
        });
    });

    it('rejects provider routing/auth environment at the V2 writer boundary', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Unsafe', description: '',
            extraEnvironmentVariables: [{ name: 'ANTHROPIC_BASE_URL', value: 'https://example.test' }],
        })).toMatchObject({ status: 'error', field: 'extraEnvironmentVariables' });
    });

    it('round-trips authored non-provider secret requirements and permits clearing them', () => {
        const draft = { name: 'Deploy', description: '',
            extraEnvironmentVariables: [{ name: 'DEPLOY_TOKEN', value: '', isSecret: true }],
            envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret' as const, required: true }] };
        const saved = buildSlimProfileSave(base, draft, () => 10);
        expect(saved).toMatchObject({ status: 'success', profile: { envVarRequirements: draft.envVarRequirements } });
        if (saved.status !== 'success') throw new Error(saved.message);
        expect(buildSlimProfileSave(saved.profile, { ...draft, envVarRequirements: [] }, () => 11))
            .toMatchObject({ status: 'success', profile: { envVarRequirements: [] } });
    });

    it('saves requirement-only changes with bundled reserved keys and no daemon projection', () => {
        const draft = { name: 'Deploy', description: '', extraEnvironmentVariables: [],
            envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret' as const, required: true }] };
        expect(buildSlimProfileSave(base, draft, Date.now, getAllAgentProviderOwnedEnvironmentKeys(null)))
            .toMatchObject({ status: 'success', profile: { envVarRequirements: draft.envVarRequirements } });
    });

    it('rejects static and dynamically reserved secret requirements without an environment row', () => {
        for (const name of ['ANTHROPIC_API_KEY', 'ADAPTER_AUTH_TOKEN']) {
            const draft = { name: 'Unsafe', description: '', extraEnvironmentVariables: [],
                envVarRequirements: [{ name, kind: 'secret' as const, required: true }] };
            expect(buildSlimProfileSave(base, draft, Date.now, new Set(['ADAPTER_AUTH_TOKEN'])))
                .toMatchObject({ status: 'error', field: 'extraEnvironmentVariables' });
        }
    });

    it('rejects dynamically projected adapter-owned keys omitted by the static migration minimum', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Unsafe', description: '',
            extraEnvironmentVariables: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'secret' }],
        }, Date.now, new Set(['CLAUDE_CODE_OAUTH_TOKEN']))).toMatchObject({
            status: 'error', field: 'extraEnvironmentVariables',
        });
    });

    it.each([null, { external: { providerOwnedEnvironmentKeys: ['EXTERNAL_AUTH'] } }])(
        'retains bundled and available-projection feedback without declaration readiness (%s)', projection => {
            const reserved = getAllAgentProviderOwnedEnvironmentKeys(projection);
            for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', ...(projection ? ['EXTERNAL_AUTH'] : [])]) {
                expect(buildSlimProfileSave(base, {
                    name: 'Profile A', description: '', extraEnvironmentVariables: [{ name, value: '' }],
                }, Date.now, reserved)).toMatchObject({ status: 'error', field: 'extraEnvironmentVariables' });
            }
            expect(buildSlimProfileSave(base, {
                name: 'Profile A', description: '', extraEnvironmentVariables: [{ name: 'SAFE_FLAG', value: '1' }],
            }, Date.now, reserved)).toMatchObject({ status: 'success' });
        },
    );

    it('allows an offline external key to be saved for canonical spawn-time validation', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Profile A', description: '', extraEnvironmentVariables: [{ name: 'EXTERNAL_AUTH', value: '' }],
        }, Date.now, getAllAgentProviderOwnedEnvironmentKeys(null))).toMatchObject({ status: 'success' });
    });

    it('persists exact Agent defaults and structured Provider model preference without flattening them', () => {
        const preferredModelSelection = {
            v: 1 as const,
            updatedAt: 7,
            ref: { agentTargetKey: 'agent:codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'), modelId: 'vendor/model' },
        };
        expect(buildSlimProfileSave(base, {
            name: 'Profile A',
            description: '',
            extraEnvironmentVariables: [],
            defaultPermissionModeByTargetKey: { 'agent:codex': 'plan' },
            defaultPersistenceModeByTargetKey: { 'agent:codex': 'direct' },
            preferredAgentTargetKey: 'agent:codex',
            preferredModelSelection,
        }, () => 10)).toMatchObject({
            status: 'success',
            profile: {
                defaultPermissionModeByTargetKey: { 'agent:happier.agent.codex/codex': 'plan' },
                defaultPersistenceModeByTargetKey: { 'agent:happier.agent.codex/codex': 'direct' },
                preferredAgentTargetKey: 'agent:happier.agent.codex/codex',
                preferredModelSelection: {
                    ...preferredModelSelection,
                    ref: {
                        ...preferredModelSelection.ref,
                        agentTargetKey: 'agent:happier.agent.codex/codex',
                    },
                },
            },
        });
    });
});

describe('buildSlimProfileSave placement and checkout preferences', () => {
    /**
     * `LaunchProfileV2` has owned `placement` and `checkout` since the launch
     * placement work landed, and `resolveTriageActionPlacementV1` reads them on
     * every press — but nothing could WRITE one. A preference with a reader and
     * no author is a schema a person cannot reach, which is the dormant-member
     * shape this program keeps producing; these are the writer's tests.
     */
    it('writes the placement and checkout a person authored', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Focused',
            description: '',
            extraEnvironmentVariables: [],
            placement: 'ask',
            checkout: 'create_worktree',
        })).toMatchObject({
            status: 'success',
            profile: { placement: 'ask', checkout: 'create_worktree' },
        });
    });

    it('writes a pinned placement with its directory', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Focused',
            description: '',
            extraEnvironmentVariables: [],
            placement: { fixed: { serverId: 'server-1', machineId: 'machine-1' }, directory: '/work' },
        })).toMatchObject({
            status: 'success',
            profile: { placement: { fixed: { serverId: 'server-1', machineId: 'machine-1' }, directory: '/work' } },
        });
    });

    it('clears a preference the person removed rather than retaining the stored one', () => {
        // The save spreads the stored profile, so an omitted member would keep
        // the old value and "No preference" would silently do nothing.
        const pinned = {
            ...base,
            placement: 'ask' as const,
            checkout: 'reuse_workspace' as const,
        };
        const saved = buildSlimProfileSave(pinned, {
            name: 'Focused',
            description: '',
            extraEnvironmentVariables: [],
        });
        expect(saved.status).toBe('success');
        expect(saved.status === 'success' ? saved.profile.placement : 'unset').toBeUndefined();
        expect(saved.status === 'success' ? saved.profile.checkout : 'unset').toBeUndefined();
    });

    it('refuses a pinned placement that names half a machine', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Focused',
            description: '',
            extraEnvironmentVariables: [],
            // A pin with no machine is not a weaker pin; it is a target nothing
            // can run on, and the profile owner is what refuses it.
            placement: { fixed: { serverId: 'server-1', machineId: '' } },
        })).toMatchObject({ status: 'error' });
    });
});

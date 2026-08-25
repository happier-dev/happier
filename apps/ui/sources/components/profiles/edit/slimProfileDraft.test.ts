import { describe, expect, it } from 'vitest';

import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { buildSlimProfileSave, isSlimProfileReservedEnvironmentAuthorityReady } from './slimProfileDraft';

const base = {
    v: 2 as const,
    id: 'profile-a', name: 'Profile A', extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
    createdAt: 1, updatedAt: 1,
};

describe('buildSlimProfileSave', () => {
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

    it('rejects dynamically projected adapter-owned keys omitted by the static migration minimum', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Unsafe', description: '',
            extraEnvironmentVariables: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'secret' }],
        }, Date.now, new Set(['CLAUDE_CODE_OAUTH_TOKEN']))).toMatchObject({
            status: 'error', field: 'extraEnvironmentVariables',
        });
    });

    it('fails closed when environment rows changed before daemon reserved-key authority is ready', () => {
        expect(buildSlimProfileSave(base, {
            name: 'Profile A', description: '',
            extraEnvironmentVariables: [{ name: 'SAFE_FLAG', value: '1' }],
        }, Date.now, new Set(), false)).toMatchObject({
            status: 'error', field: 'extraEnvironmentVariables',
        });

        expect(buildSlimProfileSave(base, {
            name: 'Renamed', description: '',
            extraEnvironmentVariables: [],
        }, Date.now, new Set(), false)).toMatchObject({ status: 'success' });
    });

    it('does not treat a ready legacy daemon projection as reserved-key authority', () => {
        expect(isSlimProfileReservedEnvironmentAuthorityReady({
            projectionPhase: 'ready',
            hasV2Projection: false,
        })).toBe(false);
        expect(isSlimProfileReservedEnvironmentAuthorityReady({
            projectionPhase: 'ready',
            hasV2Projection: true,
        })).toBe(true);
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
                defaultPermissionModeByTargetKey: { 'backend:codex': 'plan' },
                defaultPersistenceModeByTargetKey: { 'backend:codex': 'direct' },
                preferredAgentTargetKey: 'backend:codex',
                preferredModelSelection: {
                    ...preferredModelSelection,
                    ref: {
                        ...preferredModelSelection.ref,
                        agentTargetKey: 'backend:codex',
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

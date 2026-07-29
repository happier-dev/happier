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

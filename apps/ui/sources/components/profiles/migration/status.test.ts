import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema, LaunchProfileV2Schema } from '@happier-dev/protocol';

import { resolveProfileMigrationStatus } from './status';

describe('profile migration presentation status', () => {
    it('shows only daemon-classified ambiguous candidates as reviewable', () => {
        const profile = AIBackendProfileSchema.parse({ id: 'custom-a', name: 'Custom A' });
        expect(resolveProfileMigrationStatus({
            profile,
            providerSettings: {
                v: 1, connections: [], connectionTombstones: [], accountGrants: [], machineGrants: [],
                secretBindingsByConnectionId: {}, manualModelsByConnectionId: {}, modelVisibilityByRef: {},
                experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
                migration: { v: 1, completedSources: [], pendingCustomProfileIds: ['custom-a'] },
            },
        })).toBe('review');
    });

    it.each(['azure-openai', 'gemini-api-key', 'gemini-vertex'])('keeps %s as an informational legacy profile', (id) => {
        expect(resolveProfileMigrationStatus({
            profile: AIBackendProfileSchema.parse({ id, name: id }),
            providerSettings: undefined,
        })).toBe('retained');
    });

    it('does not present slim profiles as migration candidates even if stale pending state exists', () => {
        const profile = LaunchProfileV2Schema.parse({
            v: 2, id: 'custom-a', name: 'Custom A', createdAt: 1, updatedAt: 1,
        });
        expect(resolveProfileMigrationStatus({
            profile,
            providerSettings: {
                v: 1, connections: [], connectionTombstones: [], accountGrants: [], machineGrants: [],
                secretBindingsByConnectionId: {}, manualModelsByConnectionId: {}, modelVisibilityByRef: {},
                experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
                migration: { v: 1, completedSources: [], pendingCustomProfileIds: ['custom-a'] },
            },
        })).toBeNull();
    });

    it('presents a daemon-classified deterministic conflict through the dedicated conflict flow', () => {
        const profile = AIBackendProfileSchema.parse({ id: 'deepseek', name: 'DeepSeek' });
        expect(resolveProfileMigrationStatus({
            profile,
            providerSettings: {
                v: 1, connections: [], connectionTombstones: [], accountGrants: [], machineGrants: [],
                secretBindingsByConnectionId: {}, manualModelsByConnectionId: {}, modelVisibilityByRef: {},
                experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
                migration: {
                    v: 1,
                    completedSources: [],
                    pendingCustomProfileIds: [],
                    pendingConflicts: [{
                        v: 1,
                        sourceProfileId: 'deepseek',
                        contributionKey: 'happier.provider.deepseek/deepseek',
                        existingConnectionId: 'pc_existing',
                        kinds: ['credential_binding'],
                        candidateFingerprint: `legacy-profile-migration-conflict:v1:${'a'.repeat(43)}`,
                        detectedAt: 1,
                    }],
                },
            },
        })).toBe('conflict');
    });
});

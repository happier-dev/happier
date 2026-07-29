import { describe, expect, it } from 'vitest';
import {
    LaunchProfileV2Schema,
    ProviderSettingsMigrationStateV1Schema,
    SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';

import { normalizeAutomationTemplateLaunchProfileReference } from './normalizeAutomationTemplateLaunchProfileReference';

const migratedSelection = SessionModelSelectionV1Schema.parse({
    v: 1,
    updatedAt: 20,
    ref: {
        agentTargetKey: 'backend:claude',
        providerConnectionId: 'pc_deepseek',
        modelId: 'deepseek-chat',
    },
});

const migration = ProviderSettingsMigrationStateV1Schema.parse({
    v: 1,
    completedSources: [{
        sourceProfileId: 'deepseek',
        kind: 'connection',
        connectionId: 'pc_deepseek',
        sourceRevision: 2,
        modelSelectionOrigin: 'implicit_default',
        modelSelection: migratedSelection.ref,
    }],
    pendingCustomProfileIds: [],
    migratedAt: 20,
});

describe('normalizeAutomationTemplateLaunchProfileReference', () => {
    it('maps a migrated legacy profile to the exact provider selection without a render-time write', () => {
        const input = {
            directory: '/repo',
            agent: 'claude',
            profileId: 'deepseek',
        } as const;

        const normalized = normalizeAutomationTemplateLaunchProfileReference({
            template: input,
            profiles: [],
            migration,
        });

        expect(normalized).toEqual({
            directory: '/repo',
            agent: 'claude',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            modelSelection: migratedSelection,
        });
        expect(input).toEqual({ directory: '/repo', agent: 'claude', profileId: 'deepseek' });
    });

    it('keeps an explicit structured automation model ahead of migrated profile intent', () => {
        const explicitSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 30,
            ref: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: null,
                modelId: 'gpt-explicit',
            },
        });
        expect(normalizeAutomationTemplateLaunchProfileReference({
            template: {
                directory: '/repo',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                profileId: 'deepseek',
                modelSelection: explicitSelection,
            },
            profiles: [],
            migration,
        })).toEqual({
            directory: '/repo',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            modelSelection: explicitSelection,
        });
    });

    it('applies retained slim preferences only when the template has no explicit target or model', () => {
        const preferredSelection = SessionModelSelectionV1Schema.parse({
            ...migratedSelection,
            ref: { ...migratedSelection.ref, agentTargetKey: 'agent:claude' },
        });
        const slim = LaunchProfileV2Schema.parse({
            v: 2,
            id: 'work',
            name: 'Work',
            createdAt: 1,
            updatedAt: 2,
            preferredAgentTargetKey: 'agent:claude',
            preferredModelSelection: preferredSelection,
        });
        expect(normalizeAutomationTemplateLaunchProfileReference({
            template: { directory: '/repo', profileId: 'work' },
            profiles: [slim],
            migration: undefined,
        })).toEqual({
            directory: '/repo',
            profileId: 'work',
            backendTarget: { kind: 'backend', backendId: 'claude' },
            modelSelection: {
                ...preferredSelection,
                ref: { ...preferredSelection.ref, agentTargetKey: 'backend:claude' },
            },
        });
    });

    it('withholds a retained slim model when its DeepSeek completion predates provenance', () => {
        const slim = LaunchProfileV2Schema.parse({
            v: 2,
            id: 'deepseek',
            name: 'DeepSeek',
            preferredAgentTargetKey: 'agent:claude',
            preferredModelSelection: {
                ...migratedSelection,
                ref: { ...migratedSelection.ref, agentTargetKey: 'agent:claude' },
            },
            createdAt: 1,
            updatedAt: 2,
        });
        const preProvenance = ProviderSettingsMigrationStateV1Schema.parse({
            v: 1,
            completedSources: [{
                sourceProfileId: 'deepseek',
                kind: 'connection',
                connectionId: 'pc_deepseek',
                modelSelection: migratedSelection.ref,
            }],
            pendingCustomProfileIds: [],
            migratedAt: 20,
        });

        expect(normalizeAutomationTemplateLaunchProfileReference({
            template: { directory: '/repo', profileId: 'deepseek' },
            profiles: [slim],
            migration: preProvenance,
        })).toEqual({
            directory: '/repo',
            profileId: 'deepseek',
            backendTarget: { kind: 'backend', backendId: 'claude' },
        });
    });
});

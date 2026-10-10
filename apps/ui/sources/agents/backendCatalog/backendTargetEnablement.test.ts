import { describe, expect, it } from 'vitest';

import { getAgentBackendCompatibilityTargetKeys, readBackendTargetEnabled } from './backendTargetEnablement';

describe('backendTargetEnablement', () => {
    it('reads released target spellings through the canonical Account Settings owner', () => {
        expect(readBackendTargetEnabled({
            backendEnabledByTargetKey: { 'agent:codex': false },
            canonicalTargetKey: 'backend:codex',
        })).toBe(false);
        expect(readBackendTargetEnabled({
            backendEnabledByTargetKey: { 'backend:codex': true, 'agent:codex': false },
            canonicalTargetKey: 'backend:codex',
        })).toBe(true);
    });
    it('derives provider-owned backend compatibility target keys from catalog projections', () => {
        expect(getAgentBackendCompatibilityTargetKeys({
            agentId: 'example-provider',
            canonicalTargetKey: 'backend:example-provider',
            mergedProviderProjectionById: {
                'example-provider': {
                    agentId: 'example-provider',
                    settingsBackendId: 'example-settings-backend',
                },
            },
            mergedBackendProjectionById: {
                'example-settings-backend': {
                    backendId: 'example-settings-backend',
                    agentId: 'example-provider',
                },
                'example-terminal-backend': {
                    backendId: 'example-terminal-backend',
                    agentId: 'example-provider',
                },
                'other-provider-backend': {
                    backendId: 'other-provider-backend',
                    agentId: 'other-provider',
                },
            },
        })).toEqual([
            'backend:example-settings-backend',
            'backend:example-terminal-backend',
        ]);
    });
});

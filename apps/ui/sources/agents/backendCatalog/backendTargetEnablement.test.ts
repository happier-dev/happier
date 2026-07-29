import { describe, expect, it } from 'vitest';

import { getAgentBackendCompatibilityTargetKeys } from './backendTargetEnablement';

describe('backendTargetEnablement', () => {
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
            'backend:example-settings-backend:configured:example-settings-backend',
            'backend:example-terminal-backend',
            'backend:example-terminal-backend:configured:example-terminal-backend',
        ]);
    });
});

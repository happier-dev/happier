import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { buildSessionModelSelectionIntent } from './modelSelectionIntent';

describe('buildSessionModelSelectionIntent', () => {
    it('preserves provider connection identity and a literal default model id', () => {
        expect(buildSessionModelSelectionIntent({
            updatedAt: 42,
            ref: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: ProviderConnectionIdSchema.parse('pc_openrouter'),
                modelId: 'default',
            },
        })).toEqual({
            v: 1,
            updatedAt: 42,
            selection: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: 'pc_openrouter',
                modelId: 'default',
            },
        });
    });

    it('writes an explicit reset intent without inventing a native default ref', () => {
        expect(buildSessionModelSelectionIntent({ updatedAt: 43, ref: null })).toEqual({
            v: 1,
            updatedAt: 43,
            selection: null,
        });
    });
});

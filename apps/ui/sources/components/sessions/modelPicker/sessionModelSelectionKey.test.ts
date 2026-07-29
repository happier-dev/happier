import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { sessionModelSelectionKey } from './sessionModelSelectionKey';

describe('sessionModelSelectionKey', () => {
    it('is collision-safe across automatic, native, and Provider-bound selections', () => {
        const connectionA = ProviderConnectionIdSchema.parse('pc_a');
        const connectionB = ProviderConnectionIdSchema.parse('pc_b');
        const values = [
            null,
            { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'same' },
            { agentTargetKey: 'backend:codex', providerConnectionId: connectionA, modelId: 'same' },
            { agentTargetKey: 'backend:codex', providerConnectionId: connectionB, modelId: 'same' },
        ] as const;

        expect(new Set(values.map(sessionModelSelectionKey)).size).toBe(values.length);
    });
});

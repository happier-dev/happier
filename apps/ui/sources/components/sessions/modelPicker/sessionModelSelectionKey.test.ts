import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { sessionModelSelectionKey } from './sessionModelSelectionKey';

describe('sessionModelSelectionKey', () => {
    it('is collision-safe across automatic, native, and Provider-bound selections', () => {
        const connectionA = ProviderConnectionIdSchema.parse('pc_a');
        const connectionB = ProviderConnectionIdSchema.parse('pc_b');
        const values = [
            null,
            { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'same' },
            { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionA, modelId: 'same' },
            { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionB, modelId: 'same' },
        ] as const;

        expect(new Set(values.map(sessionModelSelectionKey)).size).toBe(values.length);
    });
});

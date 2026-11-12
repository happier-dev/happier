import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { sessionModelSelectionKey } from './sessionModelSelectionKey';

describe('sessionModelSelectionKey', () => {
    it('matches a native default sentinel to Automatic while retaining exact Provider and Team defaults', () => {
        const native = { agentTargetKey: 'agent:happier.agent.grok/grok', providerConnectionId: null, modelId: 'default' };
        expect(sessionModelSelectionKey(native)).toBe(sessionModelSelectionKey(null));
        expect(sessionModelSelectionKey({ ...native, providerConnectionId: ProviderConnectionIdSchema.parse('pc_a') }))
            .not.toBe(sessionModelSelectionKey(null));
        expect(sessionModelSelectionKey({ kind: 'team_credential_provider_model', teamId: 'team', resourceId: 'resource',
            expectedResourceRevision: 1, deliveryMode: 'vendor-native', agentTargetKey: native.agentTargetKey, modelId: 'default' }))
            .not.toBe(sessionModelSelectionKey(null));
    });
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

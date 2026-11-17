import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { sessionModelSelectionKey, sessionModelPickerValueFromRef } from './sessionModelSelectionKey';

describe('sessionModelSelectionKey', () => {
    it('retains the qualified source when projecting a canonical Team ref into the picker', () => {
        const ref = { source: 'team_resource' as const, teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
            deliveryMode: 'brokered' as const, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'same' };
        const value = sessionModelPickerValueFromRef(ref);
        expect(value).toEqual({ kind: 'team_credential_provider_model', teamId: 'team-a', resourceId: 'resource-a',
            expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: ref.agentTargetKey, modelId: 'same' });
        expect(sessionModelSelectionKey(value)).not.toBe(sessionModelSelectionKey({ agentTargetKey: ref.agentTargetKey,
            providerConnectionId: null, modelId: 'same' }));
        expect(sessionModelSelectionKey(value)).not.toBe(sessionModelSelectionKey(sessionModelPickerValueFromRef({ ...ref, teamId: 'team-b' })));
    });

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

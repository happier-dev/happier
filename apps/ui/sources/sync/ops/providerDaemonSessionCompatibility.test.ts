import { describe, expect, it } from 'vitest';

import { ProviderBoundModelRefSchema } from '@happier-dev/protocol';

import { requiresProviderSafeModelSelectionRpc } from './providerDaemonSessionCompatibility';

describe('requiresProviderSafeModelSelectionRpc', () => {
    const nativeSelection = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'native-model',
    });
    const providerSelection = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'backend:opencode',
        providerConnectionId: 'voice-openai-compatible-chat',
        modelId: 'provider-model',
    });

    it('requires the current-only method when any carried selection is Provider-bound', () => {
        expect(requiresProviderSafeModelSelectionRpc(providerSelection, nativeSelection)).toBe(true);
        expect(requiresProviderSafeModelSelectionRpc(nativeSelection, providerSelection)).toBe(true);
    });

    it('keeps absent and native selections on the predecessor-compatible method', () => {
        expect(requiresProviderSafeModelSelectionRpc()).toBe(false);
        expect(requiresProviderSafeModelSelectionRpc(null, nativeSelection)).toBe(false);
    });
});

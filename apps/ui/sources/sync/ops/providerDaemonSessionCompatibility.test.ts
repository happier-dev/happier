import { describe, expect, it } from 'vitest';

import { ProviderBoundModelRefSchema } from '@happier-dev/protocol';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { isProviderSafeDaemonSessionMethodAbsent, requiresProviderSafeModelSelectionRpc } from './providerDaemonSessionCompatibility';

describe('isProviderSafeDaemonSessionMethodAbsent', () => {
    it('recognizes missing-method responses and thrown transport errors without treating refusals as absence', () => {
        for (const errorCode of [RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE]) {
            const response = { error: 'This host cannot serve the method', errorCode };
            expect(isProviderSafeDaemonSessionMethodAbsent(response)).toBe(true);
            expect(isProviderSafeDaemonSessionMethodAbsent(createRpcCallError(response))).toBe(true);
        }
        expect(isProviderSafeDaemonSessionMethodAbsent({ error: 'Method not found', errorCode: RPC_ERROR_CODES.FORBIDDEN })).toBe(false);
        expect(isProviderSafeDaemonSessionMethodAbsent({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND })).toBe(false);
    });
});

describe('requiresProviderSafeModelSelectionRpc', () => {
    const nativeSelection = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'native-model',
    });
    const providerSelection = ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
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

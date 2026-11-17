import { describe, expect, it } from 'vitest';

import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';
import { SessionModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { isProviderSafeDaemonSessionMethodAbsent, requiresProviderSafeModelSelectionRpc, requiresProviderSafeSessionRpc } from './providerDaemonSessionCompatibility';

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
    it('keeps a valid current native choice on the legacy method and refuses malformed current state', () => {
        const native = { v: 2, updatedAt: 12, ref: { source: 'native',
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'native-model' } };
        expect(requiresProviderSafeSessionRpc({ existingSessionMetadata: {
            state: 'known', metadata: { modelSelectionIntentV2: native },
        } })).toBe(false);
        expect(requiresProviderSafeSessionRpc({ existingSessionMetadata: {
            state: 'known', metadata: { modelSelectionIntentV2: {}, modelSelectionIntentV1: {
                v: 1, updatedAt: 99, selection: { agentTargetKey: native.ref.agentTargetKey,
                    providerConnectionId: null, modelId: 'fallback-native' },
            } },
        } })).toBe(true);
    });
    it.each([
        { source: 'account_provider_connection', providerConnectionId: 'pc_work' },
        { source: 'team_resource', teamId: 'team', resourceId: 'resource',
            expectedResourceRevision: 2, deliveryMode: 'vendor-native' },
    ])('retains the source-capable Resume method for explicit and persisted $source choices', ref => {
        const modelSelection = SessionModelSelectionSchema.parse({ v: 2, updatedAt: 12,
            ref: { ...ref, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model' } });
        expect(requiresProviderSafeSessionRpc({ modelSelection })).toBe(true);
        expect(requiresProviderSafeSessionRpc({ existingSessionMetadata: { state: 'known',
            metadata: { modelSelectionIntentV2: modelSelection } } })).toBe(true);
        const native = SessionModelSelectionSchema.parse({ v: 2, updatedAt: 13,
            ref: { source: 'native', agentTargetKey: modelSelection.ref.agentTargetKey, modelId: 'native' } });
        expect(requiresProviderSafeSessionRpc({ existingSessionMetadata: { state: 'known', metadata: {
            modelSelectionIntentV2: native,
            modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: providerSelection },
        } } })).toBe(false);
    });
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

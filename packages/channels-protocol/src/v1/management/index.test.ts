import { describe, expect, it } from 'vitest';

import * as management from './index.js';

describe('Channels V1 public management barrel', () => {
    it('projects every complete action contract', () => {
        expect(management.ConversationConnectionCreateManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationConnectionCreateInputV1JsonSchema,
            resultSchema: management.ConversationConnectionCreateResultV1JsonSchema,
        });
        expect(management.ConversationConnectionTransferManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationConnectionTransferInputV1JsonSchema,
            resultSchema: management.ConversationConnectionTransferResultV1JsonSchema,
        });
        expect(management.ConversationConnectionPrepareManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationConnectionPrepareInputV1JsonSchema,
            resultSchema: management.ConversationConnectionPrepareResultV1JsonSchema,
        });
        expect(management.ConversationConnectionRetestManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationConnectionRetestInputV1JsonSchema,
            resultSchema: management.ConversationConnectionRetestResultV1JsonSchema,
        });
        expect(management.ConversationPairingCreateManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationPairingCreateInputV1JsonSchema,
            resultSchema: management.ConversationPairingCreateResultV1JsonSchema,
        });
        expect(management.ConversationPairingFinalizeManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationPairingFinalizeInputV1JsonSchema,
            resultSchema: management.ConversationPairingFinalizeResultV1JsonSchema,
        });
        expect(management.ConversationBindingCreateManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationBindingCreateInputV1JsonSchema,
            resultSchema: management.ConversationBindingCreateResultV1JsonSchema,
        });
        expect(management.ConversationBindingResolveManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationBindingResolveInputV1JsonSchema,
            resultSchema: management.ConversationBindingResolveResultV1JsonSchema,
        });
        expect(management.ConversationBindingReadManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationBindingReadInputV1JsonSchema,
            resultSchema: management.ConversationBindingReadResultV1JsonSchema,
        });
        expect(management.ConversationBindingUpdateManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationBindingUpdateInputV1JsonSchema,
            resultSchema: management.ConversationBindingMutationResultV1JsonSchema,
        });
        expect(management.ConversationBindingTargetRotateManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationBindingTargetRotateInputV1JsonSchema,
            resultSchema: management.ConversationBindingTargetMutationResultV1JsonSchema,
        });
        expect(management.ConversationBindingDeleteManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationBindingDeleteInputV1JsonSchema,
            resultSchema: management.ConversationBindingDeleteResultV1JsonSchema,
        });
        expect(management.ConversationIngressRetryManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationIngressRetryInputV1JsonSchema,
            resultSchema: management.ConversationIngressRetryResultV1JsonSchema,
        });
        expect(management.ConversationDeliveryResolveManagementActionDeclarationV1).toEqual({
            inputSchema: management.ConversationDeliveryResolveInputV1JsonSchema,
            resultSchema: management.ConversationDeliveryResolveResultV1JsonSchema,
        });
        expect(management.CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1).toEqual({
            connectionCreate: management.ConversationConnectionCreateManagementActionDeclarationV1,
            connectionTransfer: management.ConversationConnectionTransferManagementActionDeclarationV1,
            connectionPrepare: management.ConversationConnectionPrepareManagementActionDeclarationV1,
            connectionRetest: management.ConversationConnectionRetestManagementActionDeclarationV1,
            connectionUpdate: management.ConversationConnectionUpdateManagementActionDeclarationV1,
            connectionSetEnabled: management.ConversationConnectionSetEnabledManagementActionDeclarationV1,
            connectionDelete: management.ConversationConnectionDeleteManagementActionDeclarationV1,
            connectionAbandon: management.ConversationConnectionAbandonManagementActionDeclarationV1,
            streamBaselineAccept: management.ConversationStreamBaselineAcceptManagementActionDeclarationV1,
            connectionPairingCreate: management.ConversationPairingCreateManagementActionDeclarationV1,
            connectionPairingFinalize: management.ConversationPairingFinalizeManagementActionDeclarationV1,
            connectionPairingCancel: management.ConversationPairingCancelManagementActionDeclarationV1,
            bindingResolve: management.ConversationBindingResolveManagementActionDeclarationV1,
            bindingRead: management.ConversationBindingReadManagementActionDeclarationV1,
            bindingCreate: management.ConversationBindingCreateManagementActionDeclarationV1,
            bindingUpdate: management.ConversationBindingUpdateManagementActionDeclarationV1,
            bindingSetEnabled: management.ConversationBindingSetEnabledManagementActionDeclarationV1,
            bindingTargetRotate: management.ConversationBindingTargetRotateManagementActionDeclarationV1,
            bindingDelete: management.ConversationBindingDeleteManagementActionDeclarationV1,
            ingressRetry: management.ConversationIngressRetryManagementActionDeclarationV1,
            deliveryResolve: management.ConversationDeliveryResolveManagementActionDeclarationV1,
            connectionPollRetry: management.ConversationConnectionPollRetryManagementActionDeclarationV1,
        });
    });

    it('does not leak relative-only protocol composition inputs through the public barrel', () => {
        expect(management).not.toHaveProperty('ConversationConnectionPrepareInputV1ProtocolSchema');
        expect(management).not.toHaveProperty('ConversationBindingCreateInputV1ProtocolSchema');
        expect(management).not.toHaveProperty('ConversationIngressRetryInputV1ProtocolSchema');
    });
});

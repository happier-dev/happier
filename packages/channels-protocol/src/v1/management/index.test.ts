import { describe, expect, it } from 'vitest';

import { PLUGIN_COLLECTION_REVISION_MAX } from '@happier-dev/plugin-sdk/collections';

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
            bindingDelete: management.ConversationBindingDeleteManagementActionDeclarationV1,
            sessionProjectionBaselineAccept: management.ConversationSessionProjectionBaselineAcceptManagementActionDeclarationV1,
            ingressRetry: management.ConversationIngressRetryManagementActionDeclarationV1,
            deliveryResolve: management.ConversationDeliveryResolveManagementActionDeclarationV1,
            connectionPollRetry: management.ConversationConnectionPollRetryManagementActionDeclarationV1,
        });
        expect(management).not.toHaveProperty('ConversationConnectionSetEnabledManagementActionDeclarationV1');
        expect(management).not.toHaveProperty('ConversationBindingTargetRotateManagementActionDeclarationV1');
    });

    it('does not leak relative-only protocol composition inputs through the public barrel', () => {
        expect(management).not.toHaveProperty('ConversationConnectionPrepareInputV1ProtocolSchema');
        expect(management).not.toHaveProperty('ConversationBindingCreateInputV1ProtocolSchema');
        expect(management).not.toHaveProperty('ConversationIngressRetryInputV1ProtocolSchema');
    });
});

describe('Channels V1 management currentness witnesses', () => {
    type JsonSchemaNode = Readonly<Record<string, unknown>>;

    function collectIntegerBounds(
        node: unknown,
        propertyName: string | null,
        found: Map<string, Set<unknown>>,
    ): void {
        if (Array.isArray(node)) {
            for (const entry of node) collectIntegerBounds(entry, propertyName, found);
            return;
        }
        if (node === null || typeof node !== 'object') return;
        const schema = node as JsonSchemaNode;
        if (propertyName !== null && schema['type'] === 'integer') {
            const bounds = found.get(propertyName) ?? new Set<unknown>();
            bounds.add(schema['maximum']);
            found.set(propertyName, bounds);
        }
        for (const [key, value] of Object.entries(schema)) {
            if (key === 'properties') {
                for (const [child, childSchema] of Object.entries(value as JsonSchemaNode)) {
                    collectIntegerBounds(childSchema, child, found);
                }
                continue;
            }
            // `anyOf`/`oneOf`/`allOf` arms and `items` keep the property name
            // their parent introduced; anything else resets it.
            const inherits = key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'items';
            collectIntegerBounds(value, inherits ? propertyName : null, found);
        }
    }

    function boundsByProperty(): Map<string, Set<unknown>> {
        const found = new Map<string, Set<unknown>>();
        for (const [exportName, value] of Object.entries(management)) {
            if (!exportName.endsWith('JsonSchema')) continue;
            collectIntegerBounds(value, null, found);
        }
        for (const declaration of Object.values(
            management.CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1,
        )) {
            collectIntegerBounds(declaration.inputSchema, null, found);
            collectIntegerBounds(declaration.resultSchema, null, found);
        }
        return found;
    }

    it('caps every published Collection row revision witness at the Collection column ceiling', () => {
        const found = boundsByProperty();
        const revisionProperties = [...found.keys()]
            .filter((name) => name !== 'triggerRevision' && (name === 'revision' || name.endsWith('Revision')));
        // The published management surface must actually carry these witnesses;
        // an empty sweep would make the assertion below vacuously true.
        expect(revisionProperties).toEqual(expect.arrayContaining([
            'revision',
            'expectedRevision',
            'expectedConnectionRevision',
            'expectedBindingRevision',
            'expectedFrontierRevision',
            'bindingRevision',
            'frontierRevision',
        ]));
        for (const name of revisionProperties) {
            expect({ [name]: [...(found.get(name) ?? [])] })
                .toEqual({ [name]: [PLUGIN_COLLECTION_REVISION_MAX] });
        }
        // The scoped trigger belongs to Automation, not a Channels Collection row.
        expect([...(found.get('triggerRevision') ?? [])]).toEqual([Number.MAX_SAFE_INTEGER]);
    });

    it('keeps Channels-owned authority epochs on the wider safe-integer bound', () => {
        const found = boundsByProperty();
        const epochProperties = [...found.keys()].filter((name) => name.endsWith('uthorityEpoch'));
        expect(epochProperties).toEqual(expect.arrayContaining([
            'authorityEpoch',
            'expectedAuthorityEpoch',
        ]));
        for (const name of epochProperties) {
            expect({ [name]: [...(found.get(name) ?? [])] })
                .toEqual({ [name]: [Number.MAX_SAFE_INTEGER] });
        }
    });
});

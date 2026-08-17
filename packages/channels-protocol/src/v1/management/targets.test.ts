import { describe, expect, it } from 'vitest';

import {
    ConversationBindingTargetV1JsonSchema,
    ConversationBindingTargetMutationV1Schema,
    ConversationBindingTargetV1Schema,
    ConversationBindingV1JsonSchema,
    ConversationBindingV1Schema,
} from './targets.js';

function hasFinalizingDeleteDisabledBranch(schema: unknown): boolean {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return false;
    const root = schema as Record<string, unknown>;
    if (!Array.isArray(root.anyOf)) return false;

    return root.anyOf.some((branch) => {
        if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) return false;
        const branchRecord = branch as Record<string, unknown>;
        const properties = branchRecord.properties;
        if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return false;
        const fields = properties as Record<string, unknown>;
        const enabled = fields.enabled;
        const deletionState = fields.deletionState;
        return typeof enabled === 'object'
            && enabled !== null
            && !Array.isArray(enabled)
            && (enabled as Record<string, unknown>).const === false
            && typeof deletionState === 'object'
            && deletionState !== null
            && !Array.isArray(deletionState)
            && (deletionState as Record<string, unknown>).const === 'finalizingDelete';
    });
}

describe('Channels V1 binding targets', () => {
    it('requires the explicit direct-delete state and forbids it from retaining enabled authority', () => {
        const binding = {
            v: 1,
            id: 'binding-1',
            connectionId: 'connection-1',
            endpoint: { kind: 'direct', audience: 'direct', id: 'endpoint-1' },
            target: {
                kind: 'session',
                sessionId: 'session-1',
                policy: {
                    deliveryMode: 'repliesOnly',
                    permissionCeiling: 'read-only',
                    approvals: { kind: 'off' },
                    newSession: { kind: 'off' },
                },
            },
            allowedPrincipalIds: ['principal-1'],
            allowBotSenders: false,
            inputMode: 'allAllowedMessages',
            inboundDebounceMs: 0,
            linkPreviewPolicy: 'suppress',
            senderFeedback: 'off',
            authorityEpoch: 1,
            enabled: true,
            deletionState: 'none',
            createdAt: 0,
            updatedAt: 0,
        } as const;

        expect(ConversationBindingV1Schema.parse(binding)).toEqual(binding);
        expect(ConversationBindingV1Schema.safeParse({
            ...binding,
            deletionState: 'finalizingDelete',
        }).success).toBe(false);
        expect(ConversationBindingV1Schema.safeParse({
            ...binding,
            enabled: false,
            deletionState: 'finalizingDelete',
        }).success).toBe(true);
        const { deletionState: _deletionState, ...legacyBinding } = binding;
        expect(ConversationBindingV1Schema.safeParse(legacyBinding).success).toBe(false);
    });

    it('projects finalizing deletion as a structural disabled-only state', () => {
        const binding = {
            v: 1,
            id: 'binding-1',
            connectionId: 'connection-1',
            endpoint: { kind: 'direct', audience: 'direct', id: 'endpoint-1' },
            target: {
                kind: 'session',
                sessionId: 'session-1',
                policy: {
                    deliveryMode: 'repliesOnly',
                    permissionCeiling: 'read-only',
                    approvals: { kind: 'off' },
                    newSession: { kind: 'off' },
                },
            },
            allowedPrincipalIds: ['principal-1'],
            allowBotSenders: false,
            inputMode: 'allAllowedMessages',
            inboundDebounceMs: 0,
            linkPreviewPolicy: 'suppress',
            senderFeedback: 'off',
            authorityEpoch: 1,
            enabled: true,
            deletionState: 'none',
            createdAt: 0,
            updatedAt: 0,
        } as const;
        const invalidFinalizing = {
            ...binding,
            deletionState: 'finalizingDelete',
        } as const;
        const validFinalizing = {
            ...invalidFinalizing,
            enabled: false,
        } as const;

        expect(ConversationBindingV1Schema.safeParse(invalidFinalizing).success).toBe(false);
        expect(ConversationBindingV1Schema.safeParse(validFinalizing).success).toBe(true);
        expect(hasFinalizingDeleteDisabledBranch(ConversationBindingV1JsonSchema)).toBe(true);
    });

    it('keeps persisted Automation versions distinct from caller mutation preconditions', () => {
        const persisted = {
            kind: 'automation',
            automationId: 'automation-1',
            templateVersion: 4,
            policy: { resultDelivery: 'finalResult' },
        } as const;
        const mutation = {
            kind: 'automation',
            automationId: 'automation-1',
            expectedTemplateVersion: 4,
            policy: { resultDelivery: 'finalResult' },
        } as const;

        expect(ConversationBindingTargetV1Schema.parse(persisted)).toEqual(persisted);
        expect(ConversationBindingTargetMutationV1Schema.parse(mutation)).toEqual(mutation);
        expect(ConversationBindingTargetV1Schema.safeParse(mutation).success).toBe(false);
        expect(ConversationBindingTargetMutationV1Schema.safeParse({
            ...mutation,
            templateVersion: 4,
        }).success).toBe(false);
    });

    it('preserves the session owner policy without accepting an unbounded non-JSON recipe', () => {
        const target = {
            kind: 'session',
            sessionId: 'session-1',
            policy: {
                deliveryMode: 'repliesOnly',
                permissionCeiling: 'read-only',
                approvals: { kind: 'off' },
                newSession: {
                    kind: 'enabled',
                    recipe: { model: 'owner-approved' },
                },
            },
        } as const;

        expect(ConversationBindingTargetV1Schema.parse(target)).toEqual(target);
        expect(ConversationBindingTargetV1Schema.safeParse({
            ...target,
            policy: {
                ...target.policy,
                newSession: {
                    ...target.policy.newSession,
                    recipe: ['not an owner-approved object'],
                },
            },
        }).success).toBe(false);
    });

    it('adopts the canonical Automation identity without normalizing closed bytes', () => {
        const target = {
            kind: 'automation',
            automationId: 'automation-1',
            templateVersion: 4,
            policy: { resultDelivery: 'finalResult' },
        } as const;

        expect(ConversationBindingTargetV1Schema.parse(target)).toEqual(target);

        for (const invalid of [
            { ...target, automationId: '' },
            { ...target, automationId: ` ${target.automationId} ` },
            { ...target, automationId: 'a'.repeat(257) },
        ]) {
            expect(ConversationBindingTargetV1Schema.safeParse(invalid).success).toBe(false);
        }
    });

    it('keeps principal allow-lists set-valued through the executable and emitted JSON boundaries', () => {
        const target = {
            kind: 'session',
            sessionId: 'session-1',
            policy: {
                deliveryMode: 'repliesOnly',
                permissionCeiling: 'read-only',
                approvals: {
                    kind: 'enabled',
                    maximumScope: 'request',
                    principalIds: ['principal-a', 'principal-b'],
                },
                newSession: { kind: 'off' },
            },
        } as const;
        const duplicate = {
            ...target,
            policy: {
                ...target.policy,
                approvals: {
                    ...target.policy.approvals,
                    principalIds: ['principal-a', 'principal-a'],
                },
            },
        };

        expect(ConversationBindingTargetV1Schema.parse(target)).toEqual(target);
        expect(JSON.stringify(ConversationBindingTargetV1JsonSchema)).toContain('"uniqueItems":true');
        expect(ConversationBindingTargetV1Schema.safeParse(duplicate).success).toBe(false);
    });
});

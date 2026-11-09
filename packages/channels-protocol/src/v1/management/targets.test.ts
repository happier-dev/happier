import { describe, expect, it } from 'vitest';
import { createProtocolStoredReadSchema } from '@happier-dev/plugin-sdk/protocol';

import * as targets from './targets.js';
import {
    ConversationBindingTargetV1JsonSchema,
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
    it('retains PR watch policy on the canonical Session binding and rejects authority outside that policy', () => {
        const target = { kind: 'session', sessionId: 'session-1',
            pullRequestLink: { repository: 'acme/widgets', number: 12 },
            policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } },
            pullRequestWatch: { policy: { mode: 'notify', archiveAfterMerge: false } },
        };
        expect(ConversationBindingTargetV1Schema.parse(target)).toEqual(target);
        for (const stopWhenMerged of [true, false]) {
            const retained = { ...target, pullRequestWatch: { policy: { ...target.pullRequestWatch.policy, stopWhenMerged } } };
            expect(createProtocolStoredReadSchema(ConversationBindingTargetV1Schema).parse(retained)).toEqual(target);
            expect(ConversationBindingTargetV1Schema.safeParse(retained).success).toBe(false);
        }
        expect(ConversationBindingTargetV1Schema.safeParse({ ...target, pullRequestWatch: {
            policy: { ...target.pullRequestWatch.policy, mode: 'autofix' },
        } }).success).toBe(false);
        expect(ConversationBindingTargetV1Schema.safeParse({ ...target, pullRequestWatch: {
            ...target.pullRequestWatch, permissionGrant: 'all',
        } }).success).toBe(false);
    });
    it('preserves opaque retained recipe data while refusing host attestation at author admission', () => {
        const target = {
            kind: 'session', sessionId: 'session-1', policy: {
                deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' },
                newSession: { kind: 'enabled', recipe: { model: 'claude', futureOption: { value: true },
                    attestedContext: { externalPrincipalId: 'forged', sourceMessageId: '<forged>' } } },
            },
        } as const;
        const stored = createProtocolStoredReadSchema(ConversationBindingTargetV1Schema).parse({ ...target, futureField: true });
        if (stored.kind !== 'session' || stored.policy.newSession.kind !== 'enabled') throw new Error('Expected retained recipe');
        expect(stored.policy.newSession.recipe).toEqual(target.policy.newSession.recipe);
        expect(targets.isChannelSessionSpawnRecipeAuthorableV1(stored.policy.newSession.recipe)).toBe(false);
        expect(targets.isChannelSessionSpawnRecipeAuthorableV1({ model: 'claude', futureOption: { value: true } })).toBe(true);
        for (const attestedContext of [null, 'forged', {}]) {
            expect(targets.isChannelSessionSpawnRecipeAuthorableV1({ attestedContext })).toBe(false);
        }
    });
    it('accepts ordered thread routes and rejects duplicate group records and unknown routing fields', () => {
        const policy = { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } as const;
        const target = {
            kind: 'threadRouter',
            principalGroups: [{ id: 'sales', principalIds: ['alice'] }, { id: 'questions', principalIds: ['alice', 'bob'] }],
            routes: [{ id: 'forward', when: { group: 'any', forwarded: true }, recipe: { agentId: 'claude' }, policy }, { id: 'sales', when: { group: 'sales', forwarded: 'any' }, recipe: {}, policy }],
        };
        expect(ConversationBindingTargetV1Schema.parse(target)).toEqual(target);
        expect(ConversationBindingTargetV1Schema.safeParse({ ...target, routes: [{ ...target.routes[0], when: { group: 'any', forwarded: true, classifier: 'guess' } }] }).success).toBe(false);
        expect(ConversationBindingTargetV1Schema.safeParse({ ...target, allowedPrincipalIds: ['mallory'] }).success).toBe(false);
        expect(ConversationBindingTargetV1Schema.safeParse({ ...target, principalGroups: [target.principalGroups[0], target.principalGroups[0]] }).success).toBe(false);
    });
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

    it('keeps one stable Automation target for persistence and mutations', () => {
        const target = {
            kind: 'automation',
            automationId: 'automation-1',
            policy: { resultDelivery: 'finalResult' },
        } as const;

        expect(ConversationBindingTargetV1Schema.parse(target)).toEqual(target);
        expect(ConversationBindingTargetV1Schema.safeParse({
            ...target,
            templateVersion: 4,
        }).success).toBe(false);
        expect(ConversationBindingTargetV1Schema.safeParse({
            ...target,
            expectedTemplateVersion: 4,
        }).success).toBe(false);
        expect(targets).not.toHaveProperty('ConversationBindingTargetMutationV1Schema');
        expect(targets).not.toHaveProperty('ConversationBindingTargetMutationV1JsonSchema');
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

import { describe, expect, it } from 'vitest';

import * as bindingContracts from './bindings.js';
import {
    ConversationAutomationTargetNotVerifiedResultV1Schema,
    ConversationBindingCreateInputV1JsonSchema,
    ConversationBindingCreateInputV1Schema,
    ConversationBindingCreateResultV1Schema,
    ConversationBindingDeleteInputV1Schema,
    ConversationBindingDeleteResultV1Schema,
    ConversationBindingResolveInputV1Schema,
    ConversationBindingResolveResultV1Schema,
    ConversationBindingSetEnabledInputV1Schema,
    ConversationBindingTargetMutationResultV1Schema,
    ConversationBindingUpdateInputV1Schema,
    ConversationBindingUpdateResultV1Schema,
} from './bindings.js';

describe('Channels V1 binding management mutation contracts', () => {
    it('exposes one exact-row binding read contract without a summary/detail map', () => {
        const input = { bindingId: 'binding-1' } as const;
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
            inputMode: 'directMentionsOnly',
            inboundDebounceMs: 0,
            linkPreviewPolicy: 'suppress',
            senderFeedback: 'off',
            authorityEpoch: 1,
            createdAt: 0,
            updatedAt: 0,
            enabled: true,
            deletionState: 'none',
        } as const;
        const readInputSchema = Reflect.get(bindingContracts, 'ConversationBindingReadInputV1Schema');
        const readResultSchema = Reflect.get(bindingContracts, 'ConversationBindingReadResultV1Schema');

        expect(readInputSchema.parse(input)).toEqual(input);
        expect(readResultSchema.parse({ kind: 'ready', revision: 7, binding }))
            .toEqual({ kind: 'ready', revision: 7, binding });
        expect(readResultSchema.parse({ kind: 'notFound' })).toEqual({ kind: 'notFound' });
        expect(readInputSchema.safeParse({ ...input, unexpected: true }).success).toBe(false);
        expect(readResultSchema.safeParse({ kind: 'notFound', revision: 7 }).success).toBe(false);
        expect(readResultSchema.safeParse({ kind: 'ready', revision: 0, binding }).success).toBe(false);
        expect(readInputSchema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['bindingId'],
        });
    });

    it('makes direct binding deletion an exact-revision, two-outcome contract', () => {
        const input = { bindingId: 'binding-1', expectedRevision: 7 } as const;

        expect(ConversationBindingDeleteInputV1Schema.parse(input)).toEqual(input);
        expect(ConversationBindingDeleteResultV1Schema.parse({ kind: 'deleted' })).toEqual({ kind: 'deleted' });
        expect(ConversationBindingDeleteResultV1Schema.parse({ kind: 'deletionPending' }))
            .toEqual({ kind: 'deletionPending' });
        expect(ConversationBindingDeleteInputV1Schema.safeParse({
            ...input,
            expectedRevision: 0,
        }).success).toBe(false);
        expect(ConversationBindingDeleteInputV1Schema.safeParse({
            ...input,
            enabled: false,
        }).success).toBe(false);
        expect(ConversationBindingDeleteResultV1Schema.safeParse({
            kind: 'deletionPending',
            bindingId: input.bindingId,
        }).success).toBe(false);
        expect(ConversationBindingDeleteInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['bindingId', 'expectedRevision'],
        });
    });

    it('keeps binding CAS and target-verifier outcomes bounded without accepting target authority', () => {
        const bindingId = 'binding-1';
        const updateResult = {
            kind: 'updated',
            bindingId,
            revision: 8,
            authorityEpoch: 3,
        } as const;

        expect(ConversationBindingSetEnabledInputV1Schema.parse({
            bindingId,
            expectedRevision: 7,
            enabled: false,
        })).toEqual({ bindingId, expectedRevision: 7, enabled: false });
        expect(ConversationBindingUpdateResultV1Schema.parse(updateResult)).toEqual(updateResult);
        expect(ConversationAutomationTargetNotVerifiedResultV1Schema.parse({
            kind: 'notVerified',
            reason: 'templateVersionMismatch',
        })).toEqual({ kind: 'notVerified', reason: 'templateVersionMismatch' });
        expect(ConversationAutomationTargetNotVerifiedResultV1Schema.parse({
            kind: 'notVerified',
            reason: 'resultDeliveryUnsupported',
        })).toEqual({ kind: 'notVerified', reason: 'resultDeliveryUnsupported' });
        expect(ConversationBindingTargetMutationResultV1Schema.parse(updateResult)).toEqual(updateResult);

        expect(ConversationBindingSetEnabledInputV1Schema.safeParse({
            bindingId: 'binding id',
            expectedRevision: 7,
            enabled: false,
        }).success).toBe(false);
        expect(ConversationBindingSetEnabledInputV1Schema.safeParse({
            bindingId,
            expectedRevision: 0,
            enabled: false,
        }).success).toBe(false);
        expect(ConversationBindingSetEnabledInputV1Schema.safeParse({
            bindingId,
            expectedRevision: 7,
            enabled: false,
            target: { kind: 'session' },
        }).success).toBe(false);
        expect(ConversationAutomationTargetNotVerifiedResultV1Schema.safeParse({
            kind: 'notVerified',
            reason: 'providerUnavailable',
        }).success).toBe(false);
        expect(ConversationBindingTargetMutationResultV1Schema.safeParse({
            kind: 'notVerified',
            reason: 'notFound',
            bindingId,
        }).success).toBe(false);

        expect(ConversationBindingSetEnabledInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: ['bindingId', 'expectedRevision', 'enabled'],
        });
        expect(ConversationBindingTargetMutationResultV1Schema.jsonSchema).toMatchObject({
            anyOf: expect.any(Array),
        });
    });

    it('keeps recorded endpoint/principal selection structural while the writer owns keyed principal admission', () => {
        const input = {
            connectionId: 'connection-1',
            expectedConnectionRevision: 7,
            endpointSelection: {
                query: 'endpoint-1',
                selected: { kind: 'direct', audience: 'direct', id: 'endpoint-1' },
            },
            principalSelection: {
                query: 'principal-a',
                selected: [{ id: 'principal-a', kind: 'human' }],
            },
            target: {
                kind: 'automation',
                automationId: 'automation-1',
                expectedTemplateVersion: 1,
                policy: { resultDelivery: 'finalResult' },
            },
        } as const;
        const rawAuthority = {
            connectionId: 'connection-1',
            endpoint: { kind: 'direct', audience: 'direct', id: 'endpoint-1' },
            target: input.target,
            allowedPrincipalIds: ['principal-a'],
        } as const;

        expect(ConversationBindingCreateInputV1Schema.safeParse(input).success).toBe(true);
        expect(ConversationBindingCreateInputV1Schema.safeParse({
            ...input,
            allowBotSenders: true,
            principalSelection: {
                ...input.principalSelection,
                selected: [
                    input.principalSelection.selected[0],
                    { id: 'principal-a', kind: 'bot' },
                ],
            },
        }).success).toBe(true);
        expect(JSON.stringify(ConversationBindingCreateInputV1JsonSchema))
            .toContain('"uniqueItems":true');
        expect(ConversationBindingCreateInputV1Schema.safeParse(rawAuthority).success).toBe(false);
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            bindingId: 'binding-1',
            expectedRevision: 7,
            endpoint: rawAuthority.endpoint,
        }).success).toBe(false);
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            bindingId: 'binding-1',
            expectedRevision: 7,
            allowedPrincipalIds: ['principal-a'],
        }).success).toBe(false);
    });

    it('admits only resolver-backed audience edits and requires bot selection to opt in atomically', () => {
        const update = {
            bindingId: 'binding-1',
            expectedRevision: 7,
            allowBotSenders: true,
            audienceSelection: {
                expectedConnectionRevision: 5,
                endpointSelection: {
                    query: 'project alpha',
                    kinds: ['githubIssue'],
                    selected: {
                        kind: 'githubIssue',
                        audience: 'shared',
                        id: 'issue-1',
                        parentId: 'repository-1',
                    },
                },
                principalSelection: {
                    query: 'alice',
                    selected: [
                        { id: 'alice', kind: 'human' },
                        { id: 'bot-1', kind: 'bot' },
                    ],
                },
            },
        } as const;

        expect(ConversationBindingUpdateInputV1Schema.parse(update)).toEqual(update);
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            ...update,
            allowBotSenders: false,
        }).success).toBe(false);
        const { allowBotSenders: _allowBotSenders, ...withoutBotOptIn } = update;
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            ...withoutBotOptIn,
            audienceSelection: {
                ...update.audienceSelection,
                principalSelection: {
                    ...update.audienceSelection.principalSelection,
                    selected: [{ id: 'alice', kind: 'human' }],
                },
            },
        }).success).toBe(true);
        expect(ConversationBindingUpdateInputV1Schema.safeParse(withoutBotOptIn).success).toBe(false);
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            ...update,
            audienceSelection: {
                ...update.audienceSelection,
                expectedConnectionRevision: 0,
            },
        }).success).toBe(false);
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            ...update,
            audienceSelection: {
                ...update.audienceSelection,
                endpointSelection: {
                    ...update.audienceSelection.endpointSelection,
                    query: 'x'.repeat(2_049),
                },
            },
        }).success).toBe(false);
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            ...update,
            audienceSelection: {
                ...update.audienceSelection,
                principalSelection: {
                    ...update.audienceSelection.principalSelection,
                    selected: [
                        { id: 'bot-1', kind: 'bot' },
                        { id: 'bot-1', kind: 'bot' },
                    ],
                },
            },
        }).success).toBe(false);
        expect(ConversationBindingUpdateInputV1Schema.safeParse({
            ...update,
            audienceSelection: {
                ...update.audienceSelection,
                endpointSelection: {
                    ...update.audienceSelection.endpointSelection,
                    rawEndpoint: 'never-authoritative',
                },
            },
        }).success).toBe(false);
    });

    it('broadens only guarded binding update outcomes for resolution and currentness', () => {
        const mutationResultSchema = Reflect.get(bindingContracts, 'ConversationBindingMutationResultV1Schema');

        expect(mutationResultSchema.parse({ kind: 'stale' }))
            .toEqual({ kind: 'stale' });
        expect(mutationResultSchema.parse({
            kind: 'unavailable',
            reason: 'principalResolveUnsupported',
        })).toEqual({ kind: 'unavailable', reason: 'principalResolveUnsupported' });
        expect(mutationResultSchema.parse({
            kind: 'notReady',
            reason: 'network',
        })).toEqual({ kind: 'notReady', reason: 'network' });
        expect(mutationResultSchema.parse({
            kind: 'notVerified',
            reason: 'notConversation',
        })).toEqual({ kind: 'notVerified', reason: 'notConversation' });
        expect(ConversationBindingTargetMutationResultV1Schema.safeParse({ kind: 'stale' }).success).toBe(false);
        expect(mutationResultSchema.safeParse({
            kind: 'stale',
            bindingId: 'binding-1',
        }).success).toBe(false);
    });

    it('keeps endpoint/principal resolver selection evidence distinct from provider-private resolution input', () => {
        const endpointSelection = {
            query: 'project alpha',
            kinds: ['githubIssue'] as const,
            selected: {
                kind: 'githubIssue',
                audience: 'shared',
                id: 'issue-1',
                parentId: 'repository-1',
            },
        } as const;

        expect(ConversationBindingResolveInputV1Schema.parse({
            kind: 'endpoint',
            connectionId: 'connection-1',
            expectedConnectionRevision: 7,
            query: 'project alpha',
            kinds: ['githubIssue'],
        })).toMatchObject({ kind: 'endpoint' });
        expect(ConversationBindingResolveInputV1Schema.parse({
            kind: 'principal',
            connectionId: 'connection-1',
            expectedConnectionRevision: 7,
            endpointSelection,
            query: 'alice',
        })).toMatchObject({ kind: 'principal', endpointSelection });
        expect(ConversationBindingResolveInputV1Schema.safeParse({
            kind: 'principal',
            connectionId: 'connection-1',
            expectedConnectionRevision: 7,
            endpoint: { kind: 'direct', audience: 'direct', id: 'raw-endpoint' },
            query: 'alice',
        }).success).toBe(false);
        expect(ConversationBindingResolveResultV1Schema.parse({
            kind: 'endpointCandidates',
            candidates: [{ kind: 'direct', audience: 'direct', id: 'endpoint-1', label: 'Fresh label' }],
        })).toMatchObject({ kind: 'endpointCandidates' });
        expect(ConversationBindingResolveResultV1Schema.parse({ kind: 'stale' })).toEqual({ kind: 'stale' });
        expect(ConversationBindingCreateResultV1Schema.parse({
            kind: 'unavailable',
            reason: 'principalResolveUnsupported',
        })).toEqual({ kind: 'unavailable', reason: 'principalResolveUnsupported' });
    });
});

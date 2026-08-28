import { describe, expect, it } from 'vitest';

import {
    ConversationPairingCancelInputV1Schema,
    ConversationPairingCancelResultV1Schema,
    ConversationPairingCreateInputV1Schema,
    ConversationPairingCreateResultV1Schema,
    ConversationPairingFinalizeInputV1Schema,
    ConversationPairingFinalizeResultV1Schema,
    ConversationPairingResourceV1Schema,
} from './pairing.js';

describe('Channels V1 pairing cancellation management contract', () => {
    it('keeps cancellation addressable by exactly one current pairing handle and exposes only terminal outcomes', () => {
        const challengeInput = {
            generationId: 'generation-1',
            challengeId: 'challenge-1',
        } as const;
        const proposalInput = {
            generationId: 'generation-1',
            proposalId: 'proposal-1',
        } as const;

        expect(ConversationPairingCancelInputV1Schema.parse(challengeInput)).toEqual(challengeInput);
        expect(ConversationPairingCancelInputV1Schema.parse(proposalInput)).toEqual(proposalInput);
        expect(ConversationPairingCancelResultV1Schema.parse({ kind: 'cancelled' }))
            .toEqual({ kind: 'cancelled' });
        expect(ConversationPairingCancelResultV1Schema.parse({
            kind: 'notCancelled',
            reason: 'finalizeInProgress',
        })).toEqual({ kind: 'notCancelled', reason: 'finalizeInProgress' });

        expect(ConversationPairingCancelInputV1Schema.safeParse({
            ...challengeInput,
            proposalId: proposalInput.proposalId,
        }).success).toBe(false);
        expect(ConversationPairingCancelInputV1Schema.safeParse({
            ...challengeInput,
            generationId: ' generation-1',
        }).success).toBe(false);
        expect(ConversationPairingCancelResultV1Schema.safeParse({
            kind: 'notCancelled',
        }).success).toBe(false);
        expect(ConversationPairingCancelResultV1Schema.safeParse({
            kind: 'cancelled',
            reason: 'bindingCreated',
        }).success).toBe(false);

        expect(ConversationPairingCancelInputV1Schema.jsonSchema).toMatchObject({
            anyOf: [
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['generationId', 'challengeId'],
                },
                {
                    type: 'object',
                    additionalProperties: false,
                    required: ['generationId', 'proposalId'],
                },
            ],
        });
    });

    it('keeps the bounded challenge handoff structural while pairing-link rendering owns URL/token admission', () => {
        const finalizeInput = {
            generationId: 'generation-1',
            proposalId: 'proposal-1',
            connectionId: 'connection-1',
            expectedConnectionRevision: 7,
            finalizeIdempotencyKey: 'finalize-1',
        } as const;
        const created = {
            kind: 'created',
            generationId: 'generation-1',
            challengeId: 'challenge-1',
            expiresAt: 1_700_000_000_000,
            attemptsRemaining: 5,
            destinationLabel: 'Example destination',
            manualToken: '12ABCD34',
            deepLinkUrl: null,
        } as const;

        expect(ConversationPairingFinalizeInputV1Schema.parse(finalizeInput)).toEqual(finalizeInput);
        expect(ConversationPairingCreateResultV1Schema.parse(created)).toEqual(created);
        expect(ConversationPairingCreateResultV1Schema.parse({
            ...created,
            destinationLabel: '\ud83d\ude00'.repeat(256),
            deepLinkUrl: 'https://example.test/pair?token=12ABCD34',
        })).toEqual({
            ...created,
            destinationLabel: '\ud83d\ude00'.repeat(256),
            deepLinkUrl: 'https://example.test/pair?token=12ABCD34',
        });
        expect(ConversationPairingCreateResultV1Schema.parse({
            kind: 'notVerified',
            reason: 'notFound',
        })).toEqual({ kind: 'notVerified', reason: 'notFound' });

        expect(ConversationPairingFinalizeInputV1Schema.safeParse({
            ...finalizeInput,
            target: { kind: 'session' },
        }).success).toBe(false);
        expect(ConversationPairingFinalizeInputV1Schema.safeParse({
            ...finalizeInput,
            expectedConnectionRevision: 0,
        }).success).toBe(false);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            manualToken: '12ABCOD4',
        }).success).toBe(false);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            attemptsRemaining: 6,
        }).success).toBe(false);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            destinationLabel: '\ud83d\ude00'.repeat(257),
        }).success).toBe(false);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            deepLinkUrl: 'http://example.test/pair?token=12ABCD34',
        }).success).toBe(true);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            deepLinkUrl: '/pair?token=12ABCD34',
        }).success).toBe(true);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            deepLinkUrl: 'javascript:12ABCD34',
        }).success).toBe(true);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            deepLinkUrl: 'https://example.test/pair?token=12ABCD35',
        }).success).toBe(true);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            deepLinkUrl: 'https://12ABCD34.example.test/pair',
        }).success).toBe(true);
        expect(ConversationPairingCreateResultV1Schema.safeParse({
            ...created,
            deepLinkUrl: `https://example.test/pair?token=12ABCD34&padding=${'😀'.repeat(510)}`,
        }).success).toBe(false);

        expect(ConversationPairingFinalizeInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: [
                'generationId',
                'proposalId',
                'connectionId',
                'expectedConnectionRevision',
                'finalizeIdempotencyKey',
            ],
        });
        expect(ConversationPairingCreateResultV1Schema.jsonSchema).toMatchObject({
            anyOf: expect.any(Array),
        });
    });

    it('requires pairing creation to name the conversation the binding will address', () => {
        // The `/pair` proof arrives in a private message. Without a selected
        // destination there is nothing else for the binding to address, so the
        // private message becomes the binding — which is never what the person
        // chose when they picked a group.
        const createInput = {
            connectionId: 'connection-1',
            expectedConnectionRevision: 7,
            endpointSelection: {
                query: 'Ops room',
                selected: { kind: 'shared', audience: 'shared', id: 'room-1' },
            },
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
        } as const;

        expect(ConversationPairingCreateInputV1Schema.parse(createInput)).toEqual(createInput);

        const { endpointSelection: _omitted, ...withoutDestination } = createInput;
        expect(ConversationPairingCreateInputV1Schema.safeParse(withoutDestination).success).toBe(false);
        expect(ConversationPairingCreateInputV1Schema.safeParse({
            ...createInput,
            // A resolved endpoint is a provider answer, never a caller claim.
            endpointSelection: { ...createInput.endpointSelection, selected: { ...createInput.endpointSelection.selected, label: 'Ops room' } },
        }).success).toBe(false);
        expect(ConversationPairingCreateInputV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
            required: [
                'connectionId',
                'expectedConnectionRevision',
                'endpointSelection',
                'target',
            ],
        });
    });

    it('projects only bounded pairing lifecycle facts to the owner Resource', () => {
        const projection = {
            generationId: 'generation-1',
            observedAt: 1_700_000_000_000,
            challenges: [{
                challengeId: 'challenge-1',
                connectionId: 'connection-1',
                expectedConnectionRevision: 7,
                expiresAt: 1_700_000_600_000,
                attemptsRemaining: 5,
                destinationLabel: 'Example destination',
                manualToken: '12ABCD34',
                deepLinkUrl: 'https://example.test/pair?token=12ABCD34',
            }],
            proposals: [{
                challengeId: 'challenge-1',
                proposalId: 'proposal-1',
                connectionId: 'connection-1',
                expectedConnectionRevision: 7,
                expiresAt: 1_700_000_600_000,
                endpointLabel: 'Ada',
                state: 'proposed',
            }],
        } as const;

        expect(ConversationPairingResourceV1Schema.parse(projection)).toEqual(projection);
        expect(ConversationPairingResourceV1Schema.safeParse({
            ...projection,
            proposals: [{
                ...projection.proposals[0],
                target: { kind: 'session', sessionId: 'session-1' },
            }],
        }).success).toBe(false);
        expect(ConversationPairingResourceV1Schema.safeParse({
            ...projection,
            proposals: [{
                ...projection.proposals[0],
                state: 'consumed',
            }],
        }).success).toBe(false);
    });

    it('preserves every pairing-finalization outcome while sharing identical result shapes', () => {
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

        for (const kind of ['created', 'rejoined'] as const) {
            expect(ConversationPairingFinalizeResultV1Schema.parse({ kind, binding }))
                .toEqual({ kind, binding });
        }
        for (const kind of [
            'expired',
            'restarted',
            'wrongConnection',
            'wrongMaterialization',
            'alreadyConsumed',
            'staleConnectionRevision',
            'conflict',
            'retryableFailure',
        ] as const) {
            expect(ConversationPairingFinalizeResultV1Schema.parse({ kind })).toEqual({ kind });
        }
        for (const reason of [
            'notFound',
            'resultDeliveryUnsupported',
        ] as const) {
            expect(ConversationPairingFinalizeResultV1Schema.parse({
                kind: 'notVerified',
                reason,
            })).toEqual({ kind: 'notVerified', reason });
        }
        expect(ConversationPairingFinalizeResultV1Schema.safeParse({
            kind: 'expired',
            binding,
        }).success).toBe(false);
        expect(ConversationPairingFinalizeResultV1Schema.safeParse({ kind: 'unknown' }).success)
            .toBe(false);
    });
});

import { describe, expect, it } from 'vitest';

import {
    ConversationEndpointDisplayLabelV1ProtocolSchema,
    ConversationEndpointResolveInputV1Schema,
    ConversationEndpointResolveResultV1JsonSchema,
    ConversationEndpointResolveResultV1Schema,
    ConversationPrincipalResolveResultV1Schema,
    ConversationPrincipalResolveInputV1Schema,
    ConversationResolvedEndpointV1Schema,
    ConversationResolvedPrincipalV1Schema,
    compareCanonicalConversationResolutionCandidatesV1,
    hasCanonicalConversationResolutionCandidateOrderV1,
} from './resolution.js';

describe('Channels V1 provider resolution results', () => {
    it('keeps provider resolution request authority in the one adopted connection snapshot', () => {
        const connection = {
            v: 1,
            connectionId: 'connection-1',
            providerConnectionKey: 'provider:connection-1',
            providerConfigVersion: 1,
            providerConfig: { installation: 'installation-1' },
            credentialRef: {
                service: { pluginId: 'happier.channel.example', localId: 'account' },
                accountId: 'account-1',
            },
        } as const;
        const endpointInput = {
            ...connection,
            query: 'incident room',
            kinds: ['shared', 'thread'],
        } as const;
        const principalInput = {
            ...connection,
            endpoint: { kind: 'shared', audience: 'shared', id: 'room-1' },
            query: 'octocat',
        } as const;

        expect(ConversationEndpointResolveInputV1Schema.parse(endpointInput)).toEqual(endpointInput);
        expect(ConversationPrincipalResolveInputV1Schema.parse(principalInput)).toEqual(principalInput);
        expect(ConversationEndpointResolveInputV1Schema.safeParse({
            ...endpointInput,
            kinds: [],
        }).success).toBe(false);
        expect(ConversationEndpointResolveInputV1Schema.safeParse({
            ...endpointInput,
            kinds: ['shared', 'shared'],
        }).success).toBe(false);
        expect(ConversationPrincipalResolveInputV1Schema.safeParse({
            ...principalInput,
            endpoint: { kind: 'direct', audience: 'shared', id: 'room-1' },
        }).success).toBe(false);
        expect(ConversationEndpointResolveInputV1Schema.safeParse({
            ...endpointInput,
            providerSelection: 'caller cannot select a provider',
        }).success).toBe(false);
        expect(ConversationEndpointResolveInputV1Schema.jsonSchema).toMatchObject({
            properties: {
                kinds: { uniqueItems: true },
            },
        });
    });

    it('owns the closed endpoint topology and preserves the display-label code-point contract', () => {
        const direct = {
            kind: 'direct',
            audience: 'direct',
            id: '\u00e9'.repeat(256),
            label: '\ud83d\ude00'.repeat(256),
        } as const;

        expect(ConversationResolvedEndpointV1Schema.parse(direct)).toEqual(direct);
        expect(ConversationResolvedEndpointV1Schema.parse({
            kind: 'thread',
            audience: 'shared',
            id: 'thread-1',
        })).toEqual({
            kind: 'thread',
            audience: 'shared',
            id: 'thread-1',
        });
        expect(ConversationResolvedEndpointV1Schema.safeParse({
            ...direct,
            audience: 'shared',
        }).success).toBe(false);
        expect(ConversationResolvedEndpointV1Schema.safeParse({
            ...direct,
            providerEndpoint: 'not part of the protocol',
        }).success).toBe(false);
        expect(ConversationEndpointDisplayLabelV1ProtocolSchema.safeParse('A'.repeat(257)).success)
            .toBe(false);
        expect(ConversationResolvedEndpointV1Schema.safeParse({
            ...direct,
            id: '\u00e9'.repeat(257),
        }).success).toBe(false);
    });

    it('keeps candidate result schemas structural while result admission owns ordering and keyed identity', () => {
        const endpointCandidates = [
            { kind: 'direct', audience: 'direct', id: 'endpoint-a', label: 'Alpha' },
            { kind: 'shared', audience: 'shared', id: 'endpoint-b', label: 'Beta' },
        ] as const;
        const principalCandidates = [
            { id: 'principal-a', label: 'Alpha', kind: 'human' },
            { id: 'principal-b', label: 'Beta', kind: 'bot' },
        ] as const;

        const resolved = {
            kind: 'resolved',
            candidates: endpointCandidates,
        } as const;
        expect(ConversationEndpointResolveResultV1Schema.parse(resolved)).toEqual(resolved);
        expect(ConversationPrincipalResolveResultV1Schema.parse({
            kind: 'resolved',
            candidates: principalCandidates,
        })).toEqual({
            kind: 'resolved',
            candidates: principalCandidates,
        });
        expect(ConversationEndpointResolveResultV1Schema.safeParse({
            kind: 'resolved',
            candidates: [...endpointCandidates].reverse(),
        }).success).toBe(true);
        expect(ConversationPrincipalResolveResultV1Schema.safeParse({
            kind: 'resolved',
            candidates: [
                principalCandidates[0],
                { id: 'principal-a', label: 'Beta', kind: 'integration' },
            ],
        }).success).toBe(true);
        expect(ConversationResolvedPrincipalV1Schema.safeParse({
            id: 'principal-a',
            kind: 'unknown',
        }).success).toBe(false);
        const structurallyInvalid = {
            ...resolved,
            candidates: [{
                kind: 'direct',
                audience: 'shared',
                id: 'endpoint-not-direct',
            }],
        } as const;
        expect(ConversationEndpointResolveResultV1Schema.safeParse(structurallyInvalid).success)
            .toBe(false);
        expect(ConversationEndpointResolveResultV1JsonSchema).toMatchObject({
            anyOf: expect.any(Array),
        });
        expect(JSON.stringify(ConversationEndpointResolveResultV1JsonSchema))
            .toContain('"uniqueItems":true');
        expect(JSON.stringify(ConversationPrincipalResolveResultV1Schema.jsonSchema))
            .toContain('"uniqueItems":true');
    });

    it('shares the canonical label-then-ID comparator with result admission', () => {
        const ada = { id: '2', label: 'Ada', kind: 'human' as const };
        const adaEarlierId = { id: '1', label: 'Ada', kind: 'human' as const };
        const zoe = { id: '3', label: 'Zoe', kind: 'human' as const };

        expect(compareCanonicalConversationResolutionCandidatesV1(adaEarlierId, ada)).toBeLessThan(0);
        expect(compareCanonicalConversationResolutionCandidatesV1(ada, zoe)).toBeLessThan(0);
        expect(hasCanonicalConversationResolutionCandidateOrderV1([adaEarlierId, ada, zoe])).toBe(true);
        expect(hasCanonicalConversationResolutionCandidateOrderV1([zoe, ada])).toBe(false);
        expect(hasCanonicalConversationResolutionCandidateOrderV1([
            adaEarlierId,
            { ...adaEarlierId, label: 'Different label' },
        ])).toBe(false);
    });
});

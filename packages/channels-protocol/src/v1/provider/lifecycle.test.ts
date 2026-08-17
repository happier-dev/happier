import { describe, expect, it } from 'vitest';

import {
    ConversationConnectionTestResultV1JsonSchema,
    ConversationConnectionTestInputV1Schema,
    ConversationProviderConnectionInputV1Schema,
    ConversationProviderConnectionStopInputV1Schema,
    ConversationConnectionTestResultV1Schema,
    ConversationProviderConnectionStopResultV1Schema,
} from './lifecycle.js';

describe('Channels V1 provider lifecycle results', () => {
    it('shares the exact connection snapshot between provider lifecycle roles without caller-selected authority', () => {
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

        expect(ConversationProviderConnectionInputV1Schema.parse(connection)).toEqual(connection);
        expect(ConversationConnectionTestInputV1Schema.parse({
            ...connection,
            selectedTransport: 'checkpointedPull',
        })).toEqual({
            ...connection,
            selectedTransport: 'checkpointedPull',
        });
        expect(ConversationProviderConnectionStopInputV1Schema.parse({
            ...connection,
            authorityEpoch: 2,
            reason: 'transfer',
        })).toEqual({
            ...connection,
            authorityEpoch: 2,
            reason: 'transfer',
        });
        expect(ConversationProviderConnectionInputV1Schema.safeParse({
            ...connection,
            credential: 'never a raw secret',
        }).success).toBe(false);
        expect(ConversationConnectionTestInputV1Schema.safeParse({
            ...connection,
            selectedTransport: 'untrusted',
        }).success).toBe(false);
        expect(ConversationProviderConnectionStopInputV1Schema.safeParse({
            ...connection,
            authorityEpoch: 0,
            reason: 'transfer',
        }).success).toBe(false);
    });

    it('exposes only the bounded ready result or the shared typed provider failure', () => {
        const ready = {
            kind: 'ready',
            integrationPrincipal: {
                id: 'integration-1',
                label: '\ud83d\ude00'.repeat(256),
            },
            providerConnectionKey: '\u00e9'.repeat(256),
        } as const;

        expect(ConversationConnectionTestResultV1Schema.parse(ready)).toEqual(ready);
        expect(ConversationConnectionTestResultV1Schema.parse({
            kind: 'notReady',
            reason: 'network',
        })).toEqual({
            kind: 'notReady',
            reason: 'network',
        });
        expect(ConversationConnectionTestResultV1Schema.safeParse({
            ...ready,
            providerConnectionKey: '\u00e9'.repeat(257),
        }).success).toBe(false);
        const readyWithCredential = {
            ...ready,
            integrationPrincipal: {
                ...ready.integrationPrincipal,
                credential: 'never disclose',
            },
        } as const;
        expect(ConversationConnectionTestResultV1Schema.safeParse(readyWithCredential).success).toBe(false);
        expect(ConversationConnectionTestResultV1JsonSchema).toMatchObject({
            anyOf: expect.any(Array),
        });
    });

    it('keeps asynchronous stop attention distinct from both completed stop facts and failures', () => {
        expect(ConversationProviderConnectionStopResultV1Schema.parse({
            kind: 'stopped',
        })).toEqual({ kind: 'stopped' });
        expect(ConversationProviderConnectionStopResultV1Schema.parse({
            kind: 'pending',
        })).toEqual({ kind: 'pending' });
        expect(ConversationProviderConnectionStopResultV1Schema.parse({
            kind: 'notReady',
            reason: 'rateLimited',
        })).toEqual({ kind: 'notReady', reason: 'rateLimited' });
        expect(ConversationProviderConnectionStopResultV1Schema.safeParse({
            kind: 'pending',
            retryAfterMs: 1_000,
        }).success).toBe(false);
        expect(ConversationProviderConnectionStopResultV1Schema.safeParse({
            kind: 'stopped',
            stopReceipt: 'not part of the contract',
        }).success).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import type { VoiceProviderContribution } from '@happier-dev/protocol';

import { createVoiceProviderRecipientContract } from './voiceProviderRecipientContract';

const hostOperation = {
    id: 'mint-client-auth',
    purpose: 'voice.client-auth',
    credentialSlotId: 'api-key',
    effect: 'read' as const,
    request: {
        origin: 'https://api.example.com',
        pathTemplate: '/v1/token',
        queryTemplate: [],
        headerTemplate: [],
        bodyTemplate: { kind: 'none' as const },
        method: 'GET' as const,
        credential: { kind: 'httpHeader' as const, name: 'x-api-key', format: 'raw' as const },
        redirect: 'error' as const,
        maxBodyBytes: 0,
        contentTypes: [],
    },
    parameters: {
        schema: {
            type: 'object' as const,
            properties: {},
            required: [],
            additionalProperties: false,
        },
        mapping: [],
    },
    response: { maxBytes: 1_024, contentTypes: ['application/json'] },
};

describe('createVoiceProviderRecipientContract', () => {
    it('normalizes an unknown resolver source kind to the canonical path kind', () => {
        // This owner consumes an already-validated registry declaration; keep the fixture focused on fields it reads.
        const definition = {
            title: 'Acme Voice',
            credentials: {
                slot: { id: 'api-key' },
                hostMediated: { operations: [hostOperation] },
            },
        } as unknown as VoiceProviderContribution;

        const contract = createVoiceProviderRecipientContract({
            pluginId: 'com.acme.voice',
            identity: { pluginId: 'com.acme.voice', localId: 'conversation' },
            definition,
            provenance: 'external',
            source: { kind: 'future-resolver-kind' },
        });

        expect(contract?.package.source).toEqual({
            kind: 'path',
            locator: 'com.acme.voice',
        });
        expect(contract?.publisher).toEqual({
            trust: 'verified',
            identity: 'path:com.acme.voice:committed-registry',
        });
    });
});

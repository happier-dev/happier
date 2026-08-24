import { describe, expect, it, vi } from 'vitest';
import type { SessionDraftDocumentV1, StrictJsonValue } from '@happier-dev/protocol';

import { createSessionDraftCipher } from './sessionDraftEncryption';

const sessionAddress = { kind: 'session', sessionId: 'session-a' } as const;
const newAddress = { kind: 'newSession', draftId: '00000000-0000-4000-8000-000000000001' } as const;

function document(kind: 'session' | 'newSession'): SessionDraftDocumentV1 {
    const field = <T extends StrictJsonValue>(mutationId: string, value: T) => ({ mutationId, value });
    return {
        v: 1 as const,
        composer: {
            text: field('00000000-0000-4000-8000-000000000010', 'hello'),
            mentions: field('00000000-0000-4000-8000-000000000011', []),
            attachments: field('00000000-0000-4000-8000-000000000012', []),
        },
        target: kind === 'session'
            ? { kind: 'session' as const, routing: {
                recipient: field('00000000-0000-4000-8000-000000000013', null),
                agentContinuation: field('00000000-0000-4000-8000-000000000014', null),
                executionRunDelivery: field('00000000-0000-4000-8000-000000000015', null),
            } }
            : { kind: 'newSession' as const, authoring: {} },
        extensions: {},
    };
}

describe('sessionDraftEncryption', () => {
    it('uses plain envelopes for plain targets and validates the single private address binding', async () => {
        const cipher = createSessionDraftCipher({
            accountMode: 'plain',
            accountCryptoMaterial: { type: 'dataKey', machineKey: new Uint8Array(32) },
            getSessionContext: () => ({ mode: 'plain' }),
            randomBytes: (length) => new Uint8Array(length),
        });
        const envelope = await cipher.seal(sessionAddress, document('session'));

        await expect(cipher.open(sessionAddress, envelope)).resolves.toEqual(document('session'));
        await expect(cipher.open(newAddress, envelope)).resolves.toBeNull();
    });

    it('uses the Session cipher for encrypted existing-session drafts and the Account kind for new drafts', async () => {
        const sessionEncryption = {
            encryptRaw: vi.fn(async () => 'session-ciphertext'),
            decryptRaw: vi.fn(async () => ({ v: 1, address: sessionAddress, document: document('session') })),
        };
        const cipher = createSessionDraftCipher({
            accountMode: 'e2ee',
            accountCryptoMaterial: { type: 'dataKey', machineKey: new Uint8Array(32) },
            getSessionContext: () => ({ mode: 'e2ee', encryption: sessionEncryption }),
            randomBytes: (length) => new Uint8Array(length),
        });

        await expect(cipher.seal(sessionAddress, document('session'))).resolves.toEqual({ t: 'encrypted', c: 'session-ciphertext' });
        const accountEnvelope = await cipher.seal(newAddress, document('newSession'));
        expect(accountEnvelope).toMatchObject({ t: 'encrypted' });
        await expect(cipher.open(newAddress, accountEnvelope)).resolves.toEqual(document('newSession'));
        expect(sessionEncryption.encryptRaw).toHaveBeenCalledOnce();
    });
});

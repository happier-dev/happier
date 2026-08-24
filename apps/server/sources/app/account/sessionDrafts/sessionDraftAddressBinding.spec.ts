import { describe, expect, it } from 'vitest';

import { sessionDraftContentMatchesAddress } from './sessionDraftAddressBinding';

const mutationId = '00000000-0000-4000-8000-000000000001';

function plainContent(draftId: string) {
    const address = { kind: 'newSession' as const, draftId };
    return {
        t: 'plain' as const,
        v: {
            v: 1 as const,
            address,
            document: {
                v: 1 as const,
                composer: {
                    text: { mutationId, value: '' },
                    mentions: { mutationId, value: [] },
                    attachments: { mutationId, value: [] },
                },
                target: { kind: 'newSession' as const, authoring: {} },
                extensions: {},
            },
        },
    };
}

describe('sessionDraftContentMatchesAddress', () => {
    it('rejects only a plain private payload bound to a different canonical address', () => {
        const draftId = '00000000-0000-4000-8000-000000000002';
        const differentDraftId = '00000000-0000-4000-8000-000000000003';
        const address = { kind: 'newSession' as const, draftId };

        expect(sessionDraftContentMatchesAddress(plainContent(draftId), address)).toBe(true);
        expect(sessionDraftContentMatchesAddress(plainContent(differentDraftId), address)).toBe(false);
        expect(sessionDraftContentMatchesAddress({ t: 'encrypted', c: 'opaque' }, address)).toBe(true);
        expect(sessionDraftContentMatchesAddress(null, address)).toBe(true);
    });
});

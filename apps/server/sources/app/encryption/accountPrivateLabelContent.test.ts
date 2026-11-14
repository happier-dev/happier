import { describe, expect, it } from 'vitest';
import { openPrivateLabelV1, serializePrivateLabelStoredV1 } from '@happier-dev/protocol';
import { projectAccountPrivateLabelForRecipientV1, readAccountPrivateLabelStoredV1 } from './accountPrivateLabelContent';

describe('Account private label legacy reads', () => {
    it.each(['plain', 'e2ee'] as const)('reads raw labels in persisted %s mode without weakening current envelope admission', mode => {
        const result = projectAccountPrivateLabelForRecipientV1({ serialized: 'Historic token', mode, recipientAccountId: 'account-1' });
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error(result.kind);
        expect(openPrivateLabelV1({ binding: { entity: 'account_api_token', field: 'label', id: 'token-1' },
            label: result.label, readPolicy: { kind: 'account-owned', contentEncryptionMode: mode } })).toBe('Historic token');
        expect(readAccountPrivateLabelStoredV1({ mode: 'e2ee', serialized: serializePrivateLabelStoredV1({
            content: { t: 'plain', v: 'Current plain' }, recipients: [],
        }) })).toEqual({ kind: 'mode_mismatch' });
        expect(readAccountPrivateLabelStoredV1({ mode, serialized: '{"content":{"t":"encrypted","c":"bad"},"recipients":[]}' }))
            .toEqual({ kind: 'invalid_stored_content' });
    });
});

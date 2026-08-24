import { describe, expect, it } from 'vitest';
import {
    SessionDraftAddressV1Schema,
    canonicalSessionDraftAddressV1,
} from '@happier-dev/protocol';

import {
    ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES,
    ACCOUNT_SESSION_DRAFT_KV_PREFIX,
    classifyReservedAccountScopedKvKey,
    isPublicAccountScopedKvKey,
} from './reservedAccountScopedKvRow';
import {
    SESSION_DRAFT_ACCOUNT_CHANGE_ENTITY_PREFIX,
    sessionDraftPhysicalKey,
} from '@/app/account/sessionDrafts/sessionDraftService';

describe('reservedAccountScopedKvRow', () => {
    it('reserves the complete session-draft physical namespace from generic KV', () => {
        expect(classifyReservedAccountScopedKvKey('@happier/account/session-draft/v1/new-session/example')).toEqual({
            kind: 'accountSessionDraft',
        });
        expect(classifyReservedAccountScopedKvKey('@happier/account/session-draft/v1/session/example')).toEqual({
            kind: 'accountSessionDraft',
        });
        expect(isPublicAccountScopedKvKey('@happier/account/session-draft/v1/new-session/example')).toBe(false);
        expect(isPublicAccountScopedKvKey('todo/example')).toBe(true);
    });

    it('admits only physical draft keys that fit both MySQL persisted string boundaries', () => {
        const sessionPrefixBytes = new TextEncoder().encode('session/').byteLength;
        const maxCanonicalAddressBytes = ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES
            - new TextEncoder().encode(ACCOUNT_SESSION_DRAFT_KV_PREFIX).byteLength;
        const maxSessionId = 'a'.repeat(maxCanonicalAddressBytes - sessionPrefixBytes);
        const maxAddress = SessionDraftAddressV1Schema.parse({
            kind: 'session',
            sessionId: maxSessionId,
        });
        const canonicalAddress = canonicalSessionDraftAddressV1(maxAddress);

        expect(new TextEncoder().encode(sessionDraftPhysicalKey(maxAddress) ?? '').byteLength).toBe(
            ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES,
        );
        expect(new TextEncoder().encode(`${SESSION_DRAFT_ACCOUNT_CHANGE_ENTITY_PREFIX}${canonicalAddress}`).byteLength)
            .toBeLessThanOrEqual(ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES);
        const overBoundAddress = SessionDraftAddressV1Schema.parse({
            kind: 'session',
            sessionId: `${maxSessionId}a`,
        });
        expect(sessionDraftPhysicalKey(overBoundAddress)).toBeNull();

        const percentEncodedOverBoundAddress = SessionDraftAddressV1Schema.parse({
            kind: 'session',
            sessionId: 'ä'.repeat(25),
        });
        expect(sessionDraftPhysicalKey(percentEncodedOverBoundAddress)).toBeNull();
    });
});

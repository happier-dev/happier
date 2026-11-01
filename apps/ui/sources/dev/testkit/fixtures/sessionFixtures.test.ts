import { expect, it } from 'vitest';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createCompactSessionListRowFixture } from '../harness/sessionReadBatchHttpBoundary';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createLockedEncryptedSessionByIdResponseFixture, createPlainSessionByIdResponseFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionDataKeyFixture, createSessionFixture, createSessionOwnerViewerFixture } from './sessionFixtures';

it('serves a locked Session with genuine ciphertext and no recipient key or plaintext owner fields', async () => {
    const session = createSessionFixture({ encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending',
        metadata: { name: 'Private title', path: '/private/project', host: 'private.local' } });
    const { session: wire } = await createLockedEncryptedSessionByIdResponseFixture(session);
    expect(wire.dataEncryptionKey).toBeNull();
    expect(wire.ownerMetadata).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain('Private title');
    expect(JSON.stringify(wire)).not.toContain('/private/project');
    const { AES256Encryption } = await import('@/sync/encryption/encryptor');
    const { decodeBase64 } = await import('@/encryption/base64');
    expect(await new AES256Encryption(createSessionDataKeyFixture()).decrypt([decodeBase64(wire.metadata, 'base64')]))
        .toEqual([session.metadata]);
});

it('preserves private launch profile identity through the real owner metadata envelope', () => {
    const metadata = { ...createSessionFixture().metadata!, profileId: 'work' };
    const row = createPlainSessionCurrentProjectionRecordFixture({ metadata });
    if (row.ownerMetadata?.t !== 'plain') throw new Error('Expected plain owner fixture');
    const view = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(row.metadata), ownerMetadata: row.ownerMetadata.v });
    expect(view.profileId).toBe('work');
    expect(JSON.parse(row.metadata)).not.toHaveProperty('profileId');
});

it('preserves Session runtime facts without disclosing recipient owner metadata', () => {
    const session = createSessionFixture({
        metadata: { ...createSessionFixture().metadata!, profileId: 'work' },
        agentState: { controlledByUser: true }, pendingCount: 2, pendingVersion: 3,
        seq: 4, archivedAt: 123, lastViewedSessionSeq: 4, unreadSince: null,
    });
    const owner = createPlainSessionByIdResponseFixture(session).session;
    expect(owner.agentState).toBe(JSON.stringify(session.agentState));
    expect(owner.pendingCount).toBe(2);
    expect(owner.pendingVersion).toBe(3);
    expect(owner.archivedAt).toBe(123);
    expect(owner.lastViewedSessionSeq).toBe(4);
    expect(owner.unreadSince).toBeNull();
    expect(owner.ownerMetadata?.t).toBe('plain');

    const recipient = createPlainSessionByIdResponseFixture(createSessionFixture({
        ...session, access: createSessionFixture({ accessLevel: 'edit' }).access,
    })).session;
    expect(recipient.ownerMetadata).toBeUndefined();
    expect(recipient.agentState).toBeNull();
    expect(recipient.agentStateVersion).toBe(session.agentStateVersion);
    expect(JSON.parse(recipient.metadata)).not.toHaveProperty('profileId');
    expect(recipient.effectiveAccess?.level).toBe('edit');
    expect(() => createPlainSessionByIdResponseFixture({ ...session, encryptionMode: 'e2ee' })).toThrow();
});

it('keeps an owner without a read row quiet and derives unread only from an explicit viewer frontier', () => {
    const session = createSessionFixture({ seq: 4 });
    const quiet = createSessionOwnerViewerFixture(session);
    expect(quiet.readState).toEqual({ state: 'not_started' });
    expect(quiet.attention.needsAttention).toBe(false);
    const unread = createSessionOwnerViewerFixture({ ...session, lastViewedSessionSeq: 2, unreadSince: 3 });
    expect(unread.readState).toEqual({ state: 'tracking', lastViewedSessionSeq: 2, unreadSince: 3 });
    expect(unread.attention.reasons).toContain('unread');
    const page = SessionListQueryResponseV1Schema.parse({ sessions: [{
        ...createCompactSessionListRowFixture(createPlainSessionCurrentProjectionRecordFixture({ seq: session.seq })), viewer: unread,
    }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false });
    expect(page.sessions[0]?.viewer).toEqual(unread);
});

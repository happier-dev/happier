import type { Session } from '@/sync/domains/state/storageTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionDisplayV1 } from '@happier-dev/protocol/sessions';
import { createSessionDisplayCrypto } from '@/sync/encryption/sessionDisplayCrypto';
import { createCompactSessionListRowFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

/** Home HTTP row with the real owner-encrypted display producer, never a full-metadata fallback. */
export async function createVoiceHistoryListRowFixture(session: Session, account: Readonly<{
    mode?: 'plain' | 'e2ee'; credentials: AuthCredentials;
}>) {
    const owner = createSessionOwnerMetadataV1({ metadata: session.metadata ?? {} });
    if (!owner.ok) throw new Error('History fixture has unsupported owner metadata');
    const display = projectSessionDisplayV1({
        sharedMetadata: projectSessionSharedMetadataV1({ metadata: session.metadata }),
        ownerMetadata: owner.ownerMetadata,
    });
    if (!display.owner) throw new Error('History fixture needs owner display');
    const crypto = createSessionDisplayCrypto({ sessionMode: 'plain', accountMode: account.mode ?? 'plain', credentials: account.credentials });
    return createCompactSessionListRowFixture({
        ...createPlainSessionCurrentProjectionRecordFixture({ id: session.id, metadata: session.metadata,
            archivedAt: session.archivedAt, createdAt: session.createdAt, updatedAt: session.updatedAt,
            metadataVersion: session.metadataVersion }),
        viewer: createSessionOwnerViewerFixture(session),
        pendingCount: session.pendingCount, pendingBlockedCount: session.pendingBlockedCount,
        displayProjectionV1: { v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: session.metadataVersion,
            shared: await crypto.encodeSharedDisplay(display.shared), owner: crypto.encodeOwnerDisplay(display.owner) },
    });
}

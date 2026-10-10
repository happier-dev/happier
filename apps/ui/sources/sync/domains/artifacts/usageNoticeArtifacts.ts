import {
    readUsageNoticeArtifactV1,
    type UsageNoticeArtifactHeaderV1,
} from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { DecryptedArtifact } from './artifactTypes';

export type OpenUsageNoticeArtifact = Readonly<{
    artifact: DecryptedArtifact;
    header: UsageNoticeArtifactHeaderV1;
}>;

/** Header content never establishes Account ownership or the authenticated audience. */
export function readOpenUsageNoticeArtifactHeader(
    artifact: Readonly<{ isDecrypted: boolean; ownerAccountId?: string; access?: string;
        publicAudience?: string; draft?: boolean; header?: unknown; rawHeader?: unknown; body?: unknown }>,
    accountId: string | null | undefined,
): UsageNoticeArtifactHeaderV1 | null {
    if (!accountId || !artifact.isDecrypted || artifact.draft === true
        || artifact.ownerAccountId !== accountId || artifact.access !== 'owner'
        || artifact.publicAudience !== 'none') return null;
    const raw = artifact.rawHeader ?? artifact.header;
    const header = readUsageNoticeArtifactV1({ header: raw, body: artifact.body });
    return header?.status === 'open' ? header : null;
}

import {
    readOwnedNoticeArtifactAdmissionV1,
    normalizeAccountNoticeArtifactV1,
    projectOpenUsageNoticeHeaderV1,
    type UsageNoticeArtifactHeaderV1,
    type AccountNoticeArtifactHeaderV1,
    type OwnedNoticeArtifactAdmissionV1,
} from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { DecryptedArtifact } from './artifactTypes';
import type { InboxExpectedHealthOperationV1 } from '@happier-dev/protocol/actions/appShellActionFamily';

export type OpenUsageNoticeArtifact = Readonly<{
    artifact: DecryptedArtifact;
    header: UsageNoticeArtifactHeaderV1;
}>;

/** Readable operation navigation is transient presentation, never C1 identity or persisted expectation. */
export type ExpectedHealthOperation = InboxExpectedHealthOperationV1;
export type AccountNoticeArtifact = Readonly<{ artifact: DecryptedArtifact; header: AccountNoticeArtifactHeaderV1;
    expectedDuring?: ExpectedHealthOperation }>;

export function readAccountNoticeArtifactHeader(
    artifact: Parameters<typeof readOpenUsageNoticeArtifactHeader>[0],
    accountId: string | null | undefined,
): AccountNoticeArtifactHeaderV1 | null {
    const result = readAccountNoticeArtifactAdmission(artifact, accountId);
    return result.kind === 'presented' ? normalizeAccountNoticeArtifactV1(result.notice) : null;
}

export function readAccountNoticeArtifactAdmission(
    artifact: Parameters<typeof readOpenUsageNoticeArtifactHeader>[0], accountId: string | null | undefined,
): OwnedNoticeArtifactAdmissionV1 {
    if (!artifact.isDecrypted || artifact.draft === true) return { kind: 'unreadable' };
    return readOwnedNoticeArtifactAdmissionV1({ ...artifact, header: artifact.rawHeader ?? artifact.header }, accountId);
}

export function isOpenAccountNotice(header: AccountNoticeArtifactHeaderV1): boolean {
    return header.status === 'open' && !header.resolved;
}

export function isUnreadAccountNotice(header: AccountNoticeArtifactHeaderV1): boolean {
    return isOpenAccountNotice(header) && (header.type === 'decision' || header.type === 'approval'
        || header.type === 'blocked' || header.readAt === undefined);
}

/** Header content never establishes Account ownership or the authenticated audience. */
export function readOpenUsageNoticeArtifactHeader(
    artifact: Readonly<{ isDecrypted: boolean; ownerAccountId?: string; access?: string;
        publicAudience?: string; draft?: boolean; header?: unknown; rawHeader?: unknown; body?: unknown }>,
    accountId: string | null | undefined,
): UsageNoticeArtifactHeaderV1 | null {
    const header = readAccountNoticeArtifactHeader(artifact, accountId);
    return header ? projectOpenUsageNoticeHeaderV1(header) : null;
}

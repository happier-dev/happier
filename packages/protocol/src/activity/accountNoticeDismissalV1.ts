import { AccountNoticeDismissInputV1Schema } from './accountNoticeRecoveryV1.js';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, AccountNoticeArtifactBodyV1Schema, readOwnedNoticeArtifactV1,
  type AccountNoticeArtifactHeaderV1, type UsageNoticeArtifactHeaderV1 } from './usageNoticeArtifactV1.js';
import type { ArtifactRevisionV1 } from '../artifacts/artifactRevisionV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

type NoticeArtifact = Readonly<{
  artifactId: string; ownerAccountId?: string; access?: string; publicAudience?: string;
  header: Readonly<Record<string, unknown>>; body: unknown; revision: ArtifactRevisionV1;
}>;

/** The same owner serves mounted and headless Actions; the port is authenticated Artifact IO. */
export async function dismissAccountNoticeArtifactV1(input: unknown, port: Readonly<{
  accountId: string;
  assertCurrent(): void | Promise<void>;
  read(artifactId: string): Promise<NoticeArtifact | null>;
  write(input: Readonly<{ artifactId: string; expectedRevision: ArtifactRevisionV1;
    header: AccountNoticeArtifactHeaderV1 | UsageNoticeArtifactHeaderV1; body: string }>): Promise<unknown>;
}>) {
  const request = AccountNoticeDismissInputV1Schema.parse(input);
  await port.assertCurrent();
  const artifact = await port.read(request.artifactId);
  await port.assertCurrent();
  const notice = artifact && readOwnedNoticeArtifactV1(artifact, port.accountId);
  if (!artifact || artifact.artifactId !== request.artifactId || !notice || typeof artifact.body !== 'string') {
    return { ok: false as const, errorCode: 'usage_notice_unavailable', error: 'usage_notice_unavailable' };
  }
  if (request.expectedRevision && !sameStrictJsonValue(request.expectedRevision, artifact.revision)) {
    return { ok: false as const, errorCode: 'usage_notice_changed', error: 'usage_notice_changed' };
  }
  if (notice.status === 'dismissed') return { artifactId: request.artifactId, status: 'unchanged' as const };
  const settleRecovery = notice.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1 && notice.healthPhase === 'recovered';
  const result = await port.write({ artifactId: request.artifactId, expectedRevision: artifact.revision,
    header: { ...artifact.header, ...notice, status: 'dismissed', ...(settleRecovery ? { resolved: true } : {}) },
    body: settleRecovery
      ? JSON.stringify({ ...AccountNoticeArtifactBodyV1Schema.parse(JSON.parse(artifact.body)), resolved: true })
      : artifact.body });
  // Keep typed storage refusals and uncertain effects; a successful write is the only acknowledgement.
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return result;
  return { artifactId: request.artifactId, status: 'dismissed' as const };
}

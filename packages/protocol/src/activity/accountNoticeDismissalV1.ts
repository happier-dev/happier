import { AccountNoticeDismissInputV1Schema } from './accountNoticeRecoveryV1.js';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, AccountNoticeArtifactBodyV1Schema, canSetAccountNoticeReminderV1, readOwnedNoticeArtifactV1,
  type AccountNoticeArtifactHeaderV1, type UsageNoticeArtifactHeaderV1 } from './usageNoticeArtifactV1.js';
import type { ArtifactRevisionV1 } from '../artifacts/artifactRevisionV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { AttentionRemindAtV1Schema } from './attentionReminderV1.js';
import { INBOX_NOTICE_DISMISS_ACTION_ID_V1, INBOX_NOTICE_REMINDER_SET_ACTION_ID_V1 } from '../actions/appShellActionIdsV1.js';

type NoticeArtifact = Readonly<{
  artifactId: string; ownerAccountId?: string; access?: string; publicAudience?: string;
  header: Readonly<Record<string, unknown>>; body: unknown; revision: ArtifactRevisionV1;
}>;

export const AccountNoticeReminderSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...AccountNoticeDismissInputV1Schema.shape, remindAt: z.nullable(AttentionRemindAtV1Schema),
}));
export const AccountNoticeReminderSetResultV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: AccountNoticeDismissInputV1Schema.shape.artifactId, remindAt: z.nullable(AttentionRemindAtV1Schema),
}));

/** Mounted and headless Actions use the same recipient-private notice mutation. */
export async function mutateAccountNoticeArtifactV1(actionId: typeof INBOX_NOTICE_DISMISS_ACTION_ID_V1 | typeof INBOX_NOTICE_REMINDER_SET_ACTION_ID_V1, input: unknown, port: Readonly<{
  accountId: string;
  assertCurrent(): void | Promise<void>;
  read(artifactId: string): Promise<NoticeArtifact | null>;
  write(input: Readonly<{ artifactId: string; expectedRevision: ArtifactRevisionV1;
    header: AccountNoticeArtifactHeaderV1 | UsageNoticeArtifactHeaderV1; body: string }>): Promise<unknown>;
}>) {
  const reminderRequest = actionId === INBOX_NOTICE_REMINDER_SET_ACTION_ID_V1
    ? AccountNoticeReminderSetInputV1Schema.parse(input) : null;
  const request = reminderRequest ?? AccountNoticeDismissInputV1Schema.parse(input);
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
  if (reminderRequest !== null) {
    if (notice.kind !== ACCOUNT_NOTICE_ARTIFACT_KIND_V1 || !canSetAccountNoticeReminderV1(notice)) {
      return { ok: false as const, errorCode: 'usage_notice_unavailable', error: 'usage_notice_unavailable' };
    }
    const remindAt = reminderRequest.remindAt;
    if ((notice.remindAt ?? null) === remindAt) return { artifactId: request.artifactId, remindAt };
    const header = { ...artifact.header, ...notice };
    if (remindAt === null) delete header.remindAt;
    else header.remindAt = remindAt;
    const result = await port.write({ artifactId: request.artifactId, expectedRevision: artifact.revision,
      header, body: artifact.body });
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) return result;
    return { artifactId: request.artifactId, remindAt };
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

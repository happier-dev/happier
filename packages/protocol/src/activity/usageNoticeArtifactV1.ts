import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ConnectedServiceUsageNotificationV1Schema } from './webhookPayload.js';

export const USAGE_NOTICE_ARTIFACT_KIND_V1 = 'usage_notice.v1';
export const UsageNoticeArtifactHeaderV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), kind: z.literal(USAGE_NOTICE_ARTIFACT_KIND_V1), title: z.string().min(1),
  status: z.enum(['open', 'dismissed']), notice: ConnectedServiceUsageNotificationV1Schema,
  // The incumbent Artifact writer refreshes this body-derived encrypted preview.
  excerpt: z.string().optional(),
}).strict());
export const UsageNoticeArtifactBodyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), notice: ConnectedServiceUsageNotificationV1Schema,
}).strict());
export type UsageNoticeArtifactHeaderV1 = z.infer<typeof UsageNoticeArtifactHeaderV1Schema>;

/** Content validation is not audience admission; readers retain Artifact access/mode checks. */
export function readUsageNoticeArtifactHeaderV1(raw: unknown): UsageNoticeArtifactHeaderV1 | null {
  const parsed = UsageNoticeArtifactHeaderV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
export function readUsageNoticeArtifactV1(input: Readonly<{ header: unknown; body: unknown }>): UsageNoticeArtifactHeaderV1 | null {
  const header = readUsageNoticeArtifactHeaderV1(input.header);
  if (!header || typeof input.body !== 'string') return null;
  try {
    const body = UsageNoticeArtifactBodyV1Schema.safeParse(JSON.parse(input.body));
    return body.success && sameStrictJsonValue(body.data.notice, header.notice) ? header : null;
  } catch { return null; }
}

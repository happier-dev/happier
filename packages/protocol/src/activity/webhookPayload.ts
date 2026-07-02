import { z } from 'zod';

export const ActivityWebhookTopicSchema = z.enum([
  'ready',
  'permission_request',
  'user_action_request',
  'connected_service_account_switch',
  'connected_service_credential_health',
  'connected_service_quota_blocked',
  'connected_service_quota_recovered',
]);

export type ActivityWebhookTopic = z.infer<typeof ActivityWebhookTopicSchema>;

export const ActivityWebhookPayloadV1Schema = z.object({
  v: z.literal(1).default(1),
  channelId: z.string().trim().min(1),
  createdAt: z.number().int().nonnegative(),
  topic: ActivityWebhookTopicSchema,
  content: z.object({
    title: z.string(),
    body: z.string(),
  }),
  session: z.object({
    sessionId: z.string().trim().min(1),
    title: z.string().nullable().optional(),
  }).optional(),
  request: z.object({
    requestId: z.string().trim().min(1),
    kind: z.enum(['permission', 'user_action']),
    toolName: z.string().trim().min(1),
    toolDetails: z.string().nullable().optional(),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  navigation: z.object({
    sessionId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
  }),
});

export type ActivityWebhookPayloadV1 = z.infer<typeof ActivityWebhookPayloadV1Schema>;

export function buildActivityWebhookPayload(params: Readonly<{
  channelId: string;
  createdAt: number;
  topic: ActivityWebhookTopic;
  content: Readonly<{ title: string; body: string }>;
  session?: Readonly<{ sessionId: string; title?: string | null }> | null;
  request?: Readonly<{
    requestId: string;
    kind: 'permission' | 'user_action';
    toolName: string;
    toolDetails?: string | null;
  }> | null;
  metadata?: Readonly<Record<string, unknown>> | undefined;
}>): ActivityWebhookPayloadV1 {
  return ActivityWebhookPayloadV1Schema.parse({
    v: 1,
    channelId: params.channelId,
    createdAt: params.createdAt,
    topic: params.topic,
    content: {
      title: params.content.title,
      body: params.content.body,
    },
    session: params.session
      ? {
        sessionId: params.session.sessionId,
        title: params.session.title ?? null,
      }
      : undefined,
    request: params.request
      ? {
        requestId: params.request.requestId,
        kind: params.request.kind,
        toolName: params.request.toolName,
        toolDetails: params.request.toolDetails ?? null,
      }
      : undefined,
    metadata: params.metadata,
    navigation: {
      sessionId: params.session?.sessionId,
      requestId: params.request?.requestId,
    },
  });
}

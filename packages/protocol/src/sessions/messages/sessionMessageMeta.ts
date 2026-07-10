import { z } from 'zod';

import { createSentFromSchema } from '../../sentFrom.js';
import { createSessionPermissionModeSchema } from '../metadata/sessionPermissionModes.js';
import {
  SESSION_MEDIA_MESSAGE_META_KIND_V1,
  createSessionMediaMessageMetaV1Schema,
} from './sessionMediaV1.js';

export type SessionUserMessageDeliveryIntentV1 =
  | 'default'
  | 'explicit_pending'
  | 'explicit_immediate'
  | 'interrupt';

const SESSION_USER_MESSAGE_DELIVERY_INTENTS = new Set<SessionUserMessageDeliveryIntentV1>([
  'default',
  'explicit_pending',
  'explicit_immediate',
  'interrupt',
]);

export const SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY = 'happierDeliveryIntentV1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readSessionUserMessageDeliveryIntentMeta(
  meta: unknown,
): SessionUserMessageDeliveryIntentV1 | null {
  if (!isRecord(meta)) return null;
  const value = meta[SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY];
  return typeof value === 'string' && SESSION_USER_MESSAGE_DELIVERY_INTENTS.has(value as SessionUserMessageDeliveryIntentV1)
    ? value as SessionUserMessageDeliveryIntentV1
    : null;
}

export function withSessionUserMessageDeliveryIntentMeta(
  meta: Record<string, unknown> | null | undefined,
  intent: SessionUserMessageDeliveryIntentV1,
): Record<string, unknown> & { happierDeliveryIntentV1: SessionUserMessageDeliveryIntentV1 } {
  return {
    ...(meta ?? {}),
    [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: intent,
  };
}

/**
 * Message-level metadata (stored in encrypted message bodies).
 *
 * Forward compatibility is critical here: older clients must not fail to parse
 * messages when new fields or new enum values are introduced.
 */
export function createSessionMessageMetaSchema(zod: typeof z) {
  const sessionMediaMessageMetaV1Schema = createSessionMediaMessageMetaV1Schema(zod);
  return zod
    .object({
      sentFrom: createSentFromSchema(zod).optional(),
      /**
       * High-level origin of the message, used by agents to avoid treating
       * self-sent client traffic as a "new prompt" event.
       *
       * Forward-compatible: unknown strings are allowed.
       */
      source: zod.union([zod.enum(['ui', 'cli']), zod.string()]).optional(),
      permissionMode: createSessionPermissionModeSchema(zod).optional(),
      model: zod.string().nullable().optional(),
      fallbackModel: zod.string().nullable().optional(),
      customSystemPrompt: zod.string().nullable().optional(),
      appendSystemPrompt: zod.string().nullable().optional(),
      allowedTools: zod.array(zod.string()).nullable().optional(),
      disallowedTools: zod.array(zod.string()).nullable().optional(),
      displayText: zod.string().optional(),
      happier: zod
        .object({
          kind: zod.string(),
          payload: zod.unknown(),
        })
        .passthrough()
        .superRefine((value, ctx) => {
          if (value.kind !== SESSION_MEDIA_MESSAGE_META_KIND_V1) return;
          const parsed = sessionMediaMessageMetaV1Schema.safeParse(value);
          if (parsed.success) return;
          for (const issue of parsed.error.issues) {
            ctx.addIssue({
              code: 'custom',
              path: issue.path,
              message: issue.message,
            });
          }
        })
        .optional(),
      happierMedia: sessionMediaMessageMetaV1Schema.optional(),
    })
    .passthrough();
}

export const SessionMessageMetaSchema = createSessionMessageMetaSchema(z);
export type SessionMessageMeta = z.infer<typeof SessionMessageMetaSchema>;

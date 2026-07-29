import type { ZodSafeParseResult } from 'zod';

import {
  cursorGenerateImageNotificationSchema,
  cursorTaskNotificationSchema,
  type CursorGenerateImageNotification,
  type CursorTaskNotification,
} from './schemas.js';

export function parseCursorTaskRequest(
  value: unknown,
): ZodSafeParseResult<CursorTaskNotification> {
  return cursorTaskNotificationSchema.safeParse(value);
}

export function parseCursorGeneratedMedia(
  value: unknown,
): ZodSafeParseResult<CursorGenerateImageNotification> {
  return cursorGenerateImageNotificationSchema.safeParse(value);
}

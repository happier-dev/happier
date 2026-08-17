import { z } from 'zod';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import { SessionIdSchema } from './idsV1.js';
import {
  HappierManagedSessionRuntimeModeV1Schema,
  RuntimeModeSwitchReasonV1Schema,
  SessionRuntimeModeV1Schema,
} from './runtimeModeV1.js';

export const SessionRuntimeModeSetInputV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  to: HappierManagedSessionRuntimeModeV1Schema,
  reason: RuntimeModeSwitchReasonV1Schema,
}).passthrough();
export type SessionRuntimeModeSetInputV1 = z.infer<typeof SessionRuntimeModeSetInputV1Schema>;

export const SessionRuntimeModeSetResultV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    sessionId: asProtocolZod(SessionIdSchema),
    from: SessionRuntimeModeV1Schema,
    to: HappierManagedSessionRuntimeModeV1Schema,
    noop: z.boolean().optional(),
    resumeId: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'capability_unsupported',
      'transition_unsupported',
      'unsupported',
      'busy',
      'pending_messages',
      'not_ready',
      'aborted',
      'session_not_found',
      'concurrent_transition',
    ]),
    message: z.string().optional(),
  }).passthrough(),
]);
export type SessionRuntimeModeSetResultV1 = z.infer<typeof SessionRuntimeModeSetResultV1Schema>;

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { SessionViewerProjectionV1Schema } from '../personal/viewer.js';
import type { SessionReadStateActionIdV1 } from './actionIds.js';

const SessionIdZodSchema = asProtocolZod(SessionIdSchema);

/**
 * Strict Action input for `session.read_state.set` (Lane 09 E1).
 *
 * This is exactly today's domain route body plus the exact Session address.
 * The `sessionId` path parameter is lifted into the URL by the shared
 * `bindActionHttpRequest` helper; only `{ state }` travels as JSON body.
 */
export const SessionReadStateSetInputV1Schema = lazyZodSchema(() => z.object({
  sessionId: SessionIdZodSchema,
  state: z.enum(['read', 'unread']),
}).strict());
export type SessionReadStateSetInputV1 = z.infer<typeof SessionReadStateSetInputV1Schema>;

/**
 * Strict Action result for `session.read_state.set`.
 *
 * This is exactly today's domain route success payload minus the `success`
 * envelope flag. The optional `viewer` is the canonical Lane 09B projection,
 * not another read-state vocabulary: the UI uses it to replace its current
 * private viewer facts immediately while the ordinary Session-list refresh
 * converges every other projection.
 */
export const SessionReadStateSetResultV1Schema = lazyZodSchema(() => z.object({
  state: z.enum(['read', 'unread', 'empty']),
  lastViewedSessionSeq: z.number().int().min(0).nullable(),
  didChange: z.boolean(),
  viewer: SessionViewerProjectionV1Schema.optional(),
}).strict());
export type SessionReadStateSetResultV1 = z.infer<typeof SessionReadStateSetResultV1Schema>;

export const SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1 = Object.freeze({
  'session.read_state.set': SessionReadStateSetInputV1Schema,
} as const satisfies Readonly<Record<SessionReadStateActionIdV1, z.ZodTypeAny>>);

export const SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1 = Object.freeze({
  'session.read_state.set': SessionReadStateSetResultV1Schema,
} as const satisfies Readonly<Record<SessionReadStateActionIdV1, z.ZodTypeAny>>);

export type SessionReadStateActionInputV1 = {
  [K in SessionReadStateActionIdV1]: z.input<(typeof SESSION_READ_STATE_ACTION_INPUT_SCHEMAS_V1)[K]>;
};
export type SessionReadStateActionOutputV1 = {
  [K in SessionReadStateActionIdV1]: z.output<(typeof SESSION_READ_STATE_ACTION_OUTPUT_SCHEMAS_V1)[K]>;
};

export {
  SESSION_READ_STATE_ACTION_IDS_V1,
  isSessionReadStateActionIdV1,
} from './actionIds.js';
export type { SessionReadStateActionIdV1 } from './actionIds.js';

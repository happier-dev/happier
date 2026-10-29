import { SESSION_READ_STATE_ACTION_IDS_V1 } from './idsV1.js';
export { SESSION_READ_STATE_ACTION_IDS_V1 } from './idsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const SessionReadStateActionIdV1Schema = lazyZodSchema(() => z.enum(SESSION_READ_STATE_ACTION_IDS_V1));
export type SessionReadStateActionIdV1 = z.infer<typeof SessionReadStateActionIdV1Schema>;

const SESSION_READ_STATE_ACTION_ID_SET: ReadonlySet<string> = new Set(SESSION_READ_STATE_ACTION_IDS_V1);

export function isSessionReadStateActionIdV1(value: string): value is SessionReadStateActionIdV1 {
  return SESSION_READ_STATE_ACTION_ID_SET.has(value);
}

import { z } from 'zod';

import {
  SessionTurnIdentifierV1Schema,
  SessionTurnTimestampV1Schema,
  SessionTurnV1Schema,
  buildSessionTurnV1,
  type SessionTurnV1,
} from './sessionTurnV1.js';
import { lazySchema } from '../../lazySchema.js';

export const SessionTurnsProjectionV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    sessionId: SessionTurnIdentifierV1Schema,
    latestTurnId: SessionTurnIdentifierV1Schema.optional(),
    updatedAt: SessionTurnTimestampV1Schema,
    turns: z.array(SessionTurnV1Schema).readonly(),
  })
  .passthrough()
  .readonly());
export type SessionTurnsProjectionV1 = z.infer<typeof SessionTurnsProjectionV1Schema>;

export function buildSessionTurnsProjectionV1(params: Readonly<{
  sessionId: string;
  latestTurnId?: string;
  updatedAt: number;
  turns: readonly SessionTurnV1[];
} & Record<string, unknown>>): SessionTurnsProjectionV1 {
  const {
    sessionId,
    latestTurnId,
    updatedAt,
    turns,
    ...unknownFields
  } = params;
  return {
    ...unknownFields,
    v: 1,
    sessionId,
    ...(latestTurnId !== undefined ? { latestTurnId } : {}),
    updatedAt,
    turns: turns.map((turn) => buildSessionTurnV1(turn)),
  };
}

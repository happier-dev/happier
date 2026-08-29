import { z } from 'zod';

import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1.js';
import {
  SessionTurnLifecycleStatusV1Schema,
  SessionTurnRollbackStateV1Schema,
  SessionTurnProviderCheckpointV1Schema,
  SessionTurnTranscriptAnchorsV1Schema,
} from './sessionTurnMutationV1.js';
import { normalizeLegacySessionTurnAgentIdentity } from './compat/agentIdentity.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';

const SessionTurnIdentifierV1Schema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
const SessionTurnAgentIdV1Schema = AgentIdV1Schema;
const SessionTurnTimestampV1Schema = z.number().int().nonnegative();

export const SessionTurnRollbackV1Schema = z
  .object({
    state: SessionTurnRollbackStateV1Schema,
    reason: z.string().trim().min(1).optional(),
    agentRollbackOrdinal: z.number().int().nonnegative().optional(),
    providerCheckpoint: SessionTurnProviderCheckpointV1Schema.optional(),
    updatedAt: SessionTurnTimestampV1Schema,
  })
  .passthrough()
  .readonly();
export type SessionTurnRollbackV1 = z.infer<typeof SessionTurnRollbackV1Schema>;

export const SessionTurnV1Schema = z.preprocess(
  normalizeLegacySessionTurnAgentIdentity,
  z.object({
    turnId: SessionTurnIdentifierV1Schema,
    agentId: SessionTurnAgentIdV1Schema.optional(),
    agentTurnId: SessionTurnIdentifierV1Schema.optional(),
    status: SessionTurnLifecycleStatusV1Schema,
    startedAt: SessionTurnTimestampV1Schema,
    updatedAt: SessionTurnTimestampV1Schema,
    terminalAt: SessionTurnTimestampV1Schema.optional(),
    lastRuntimeIssue: SessionRuntimeIssueV1Schema.nullable().optional(),
    transcriptAnchors: SessionTurnTranscriptAnchorsV1Schema.optional(),
    rollback: SessionTurnRollbackV1Schema.optional(),
    lastMutationId: SessionTurnIdentifierV1Schema.optional(),
  }).passthrough().readonly(),
);
export type SessionTurnV1 = z.infer<typeof SessionTurnV1Schema>;

export const SessionTurnsProjectionV1Schema = z
  .object({
    v: z.literal(1),
    sessionId: SessionTurnIdentifierV1Schema,
    latestTurnId: SessionTurnIdentifierV1Schema.optional(),
    updatedAt: SessionTurnTimestampV1Schema,
    turns: z.array(SessionTurnV1Schema).readonly(),
  })
  .passthrough()
  .readonly();
export type SessionTurnsProjectionV1 = z.infer<typeof SessionTurnsProjectionV1Schema>;

export function buildSessionTurnV1(params: Readonly<SessionTurnV1 & Record<string, unknown>>): SessionTurnV1 {
  return {
    ...params,
    ...(params.transcriptAnchors
      ? {
          transcriptAnchors: {
            ...params.transcriptAnchors,
            ...(params.transcriptAnchors.userMessageSeqs
              ? { userMessageSeqs: [...params.transcriptAnchors.userMessageSeqs] }
              : {}),
          },
        }
      : {}),
    ...(params.rollback ? { rollback: { ...params.rollback } } : {}),
  };
}

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

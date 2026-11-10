import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1.js';
import {
  SessionTurnLifecycleStatusV1Schema,
  SessionTurnRollbackStateV1Schema,
  SessionTurnProviderCheckpointV1Schema,
  SessionTurnTranscriptAnchorsV1Schema,
  SessionTurnInitiatorV1Schema,
  SessionTurnWorkflowInvocationV1Schema,
} from './sessionTurnMutationV1.js';
import { normalizeLegacySessionTurnAgentIdentity } from './compat/agentIdentity.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import { SessionWorkDepthV1Schema } from '../creation/sessionCreateOriginV1.js';

const SessionTurnIdentifierV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1)));
const SessionTurnAgentIdV1Schema = AgentIdV1Schema;
const SessionTurnTimestampV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));

export const SessionTurnRollbackV1Schema = lazyZodSchema(() => z.readonly(z.looseObject({
    state: SessionTurnRollbackStateV1Schema,
    reason: z.optional(z.string().check(z.trim(), z.minLength(1))),
    agentRollbackOrdinal: z.optional(z.number().check(z.int(), z.nonnegative())),
    providerCheckpoint: z.optional(SessionTurnProviderCheckpointV1Schema),
    updatedAt: SessionTurnTimestampV1Schema,
  })));
export type SessionTurnRollbackV1 = z.infer<typeof SessionTurnRollbackV1Schema>;

export const SessionTurnV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeLegacySessionTurnAgentIdentity), z.readonly(z.looseObject({
    turnId: SessionTurnIdentifierV1Schema,
    agentId: z.optional(SessionTurnAgentIdV1Schema),
    agentTurnId: z.optional(SessionTurnIdentifierV1Schema),
    status: SessionTurnLifecycleStatusV1Schema,
    initiator: z.optional(SessionTurnInitiatorV1Schema),
    workDepth: z.optional(SessionWorkDepthV1Schema),
    workflowInvocation: z.optional(SessionTurnWorkflowInvocationV1Schema),
    startedAt: SessionTurnTimestampV1Schema,
    updatedAt: SessionTurnTimestampV1Schema,
    terminalAt: z.optional(SessionTurnTimestampV1Schema),
    lastRuntimeIssue: z.optional(z.nullable(SessionRuntimeIssueV1Schema)),
    transcriptAnchors: z.optional(SessionTurnTranscriptAnchorsV1Schema),
    rollback: z.optional(SessionTurnRollbackV1Schema),
    lastMutationId: z.optional(SessionTurnIdentifierV1Schema),
  }))));
export type SessionTurnV1 = z.infer<typeof SessionTurnV1Schema>;

export const SessionTurnsProjectionV1Schema = lazyZodSchema(() => z.readonly(z.looseObject({
    v: z.literal(1),
    sessionId: SessionTurnIdentifierV1Schema,
    latestTurnId: z.optional(SessionTurnIdentifierV1Schema),
    updatedAt: SessionTurnTimestampV1Schema,
    turns: z.readonly(z.array(SessionTurnV1Schema)),
  })));
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

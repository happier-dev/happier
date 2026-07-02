import { z } from 'zod';

export const SessionIndexedIdentifierMaxLengthV1 = 191;

export const SessionIdSchema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
export type SessionId = z.infer<typeof SessionIdSchema>;

export const SubagentIdSchema = z.string().trim().min(1);
export type SubagentId = z.infer<typeof SubagentIdSchema>;

export const SidechainIdSchema = z.string().trim().min(1);
export type SidechainId = z.infer<typeof SidechainIdSchema>;

export const ExecutionRunIdSchema = z.string().trim().min(1);
export type ExecutionRunId = z.infer<typeof ExecutionRunIdSchema>;

export const TurnIdSchema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
export type TurnId = z.infer<typeof TurnIdSchema>;

import { z } from 'zod';

import {
  defineProtocolString,
} from '../plugins/actions/jsonSchemaValidation.js';

export const SessionIndexedIdentifierMaxLengthV1 = 191;
const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;

export const SessionIdSchema = defineProtocolString({
  minLength: 1,
  maxLength: SessionIndexedIdentifierMaxLengthV1,
  pattern: NO_OUTER_WHITESPACE_PATTERN.source,
});
export type SessionId = ReturnType<typeof SessionIdSchema.parse>;

export const SubagentIdSchema = z.string().trim().min(1);
export type SubagentId = z.infer<typeof SubagentIdSchema>;

export const SidechainIdSchema = z.string().trim().min(1).max(SessionIndexedIdentifierMaxLengthV1);
export type SidechainId = z.infer<typeof SidechainIdSchema>;

export const ExecutionRunIdSchema = z.string().trim().min(1);
export type ExecutionRunId = z.infer<typeof ExecutionRunIdSchema>;

export const TurnIdSchema = z.string()
  .min(1)
  .max(SessionIndexedIdentifierMaxLengthV1)
  .regex(NO_OUTER_WHITESPACE_PATTERN);
export type TurnId = z.infer<typeof TurnIdSchema>;

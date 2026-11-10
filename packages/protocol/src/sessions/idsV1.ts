import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import {
  defineProtocolString,
} from '../plugins/actions/protocolComposableSchema.js';

export const SessionIndexedIdentifierMaxLengthV1 = 191;
const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;

export const SessionIdSchema = defineProtocolString({
  minLength: 1,
  maxLength: SessionIndexedIdentifierMaxLengthV1,
  pattern: NO_OUTER_WHITESPACE_PATTERN.source,
});
export type SessionId = ReturnType<typeof SessionIdSchema.parse>;

export const SubagentIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export type SubagentId = z.infer<typeof SubagentIdSchema>;

export const SidechainIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1)));
export type SidechainId = z.infer<typeof SidechainIdSchema>;

export const ExecutionRunIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1)));
export type ExecutionRunId = z.infer<typeof ExecutionRunIdSchema>;

export const DiscussionIdSchema = defineProtocolString({
  minLength: 1,
  maxLength: SessionIndexedIdentifierMaxLengthV1,
  pattern: NO_OUTER_WHITESPACE_PATTERN.source,
});
export type DiscussionId = ReturnType<typeof DiscussionIdSchema.parse>;

export const TurnIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1), z.regex(NO_OUTER_WHITESPACE_PATTERN)));
export type TurnId = z.infer<typeof TurnIdSchema>;

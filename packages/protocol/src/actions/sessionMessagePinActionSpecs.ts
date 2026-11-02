import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { readRecord } from '../inputs/inputRecords.js';

/** Strict Action ingress for session-core's existing persisted pin V1 shape. */
export const SessionMessagePinV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1), sessionId: z.string().check(z.trim(), z.minLength(1)),
  seq: z.number().check(z.int(), z.gte(0)),
  transcriptBlockIndex: z.nullable(z.number().check(z.int(), z.gte(0))),
  routeMessageId: z.nullable(z.string()), role: z.enum(['user', 'assistant', 'tool', 'system', 'unknown']),
  pinnedAtMs: z.number().check(z.gte(0)), label: z.nullable(z.string()),
}));
export const SessionMessagePinsInputSchema = lazyZodSchema(() => z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('read'), sessionId: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ op: z.enum(['pin', 'unpin']), sessionId: z.string().check(z.trim(), z.minLength(1)), pin: SessionMessagePinV1Schema }),
]).check(z.superRefine((input, ctx) => {
  if ('pin' in input && input.pin.sessionId !== input.sessionId) {
    ctx.addIssue({ code: 'custom', path: ['pin', 'sessionId'], message: 'Pin must belong to the addressed Session' });
  }
})));
export const SessionMessagePinsOutputSchema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), sessionId: z.string().check(z.minLength(1)), pins: z.array(SessionMessagePinV1Schema) }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.literal('noClient') }),
]));
export const SESSION_MESSAGE_PIN_ACTION_SPECS = [{
  id: 'session.messages.pins', approval: { result: 'required' },
  cli: { commands: [] },
  approvalPolicy: { uiConfirmation: 'direct' },
  title: 'Read or change message pins',
  description: 'Read, pin or unpin transcript messages in the answering device’s device-local Account and Session-scoped pin store. Acts on that device; pins do not sync across devices.',
  safety: 'danger', sideEffectClass: 'external', executionPlacement: 'client', placements: [],
  safetyForInput: (input) => readRecord(input).op === 'read' ? 'safe' : 'danger',
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  bindings: { mcpToolName: 'session_messages_pins' },
  inputSchema: SessionMessagePinsInputSchema, outputSchema: SessionMessagePinsOutputSchema,
}] as const satisfies readonly PreNormalizedActionSpec[];

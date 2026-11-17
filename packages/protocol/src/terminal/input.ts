import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

const TerminalIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(2000)));
const TerminalModifierSchema = lazyZodSchema(() => z.enum(['shift', 'ctrl', 'alt', 'meta']));

export const TerminalInputEventSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('text'),
    text: z.string().check(z.maxLength(100_000)),
  }),
  z.strictObject({
    t: z.literal('key'),
    key: z.string().check(z.minLength(1), z.maxLength(200)),
    modifiers: z._default(z.array(TerminalModifierSchema).check(z.maxLength(4)), []),
  }),
  z.strictObject({
    t: z.literal('paste'),
    text: z.string().check(z.maxLength(1_000_000)),
    bracketed: z.boolean(),
  }),
  z.strictObject({
    t: z.literal('ime'),
    phase: z.enum(['start', 'update', 'commit', 'cancel']),
    text: z.optional(z.string().check(z.maxLength(100_000))),
  }),
  z.strictObject({
    t: z.literal('mouse'),
    kind: z.enum(['down', 'up', 'move', 'wheel']),
    button: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(8))),
    x: z.number().check(z.int(), z.minimum(0), z.maximum(10_000)),
    y: z.number().check(z.int(), z.minimum(0), z.maximum(10_000)),
    modifiers: z._default(z.array(TerminalModifierSchema).check(z.maxLength(4)), []),
  }),
  z.strictObject({
    t: z.literal('resize'),
    cols: z.number().check(z.int(), z.minimum(2), z.maximum(500)),
    rows: z.number().check(z.int(), z.minimum(2), z.maximum(500)),
  }),
]));
export type TerminalInputEvent = z.infer<typeof TerminalInputEventSchema>;

export const TerminalStreamInputRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: TerminalIdSchema,
  event: TerminalInputEventSchema,
}));
export type TerminalStreamInputRequest = z.infer<typeof TerminalStreamInputRequestSchema>;

export const TerminalStreamInputResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.string().check(z.minLength(1), z.maxLength(200)),
    message: z.string().check(z.minLength(1), z.maxLength(2000)),
  }),
]));
export type TerminalStreamInputResponse = z.infer<typeof TerminalStreamInputResponseSchema>;

/**
 * `happier attach` on a Session's Agent terminal (the PTY terminal host): session RPCs served by
 * the process holding the Session's holder connection, addressed by the Session (never a client
 * connection to the holder). Reads use the terminal stream read shapes; resize is an input event.
 * The most recently active viewer sets the terminal size.
 */
const SessionAgentTerminalViewerIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(200)));
const SessionAgentTerminalRefusalSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  code: z.string().check(z.minLength(1), z.maxLength(200)),
  message: z.string().check(z.minLength(1), z.maxLength(2000)),
}));

export const SessionAgentTerminalOpenRequestSchema = lazyZodSchema(() => z.strictObject({
  viewerId: SessionAgentTerminalViewerIdSchema,
}));
export type SessionAgentTerminalOpenRequest = z.infer<typeof SessionAgentTerminalOpenRequestSchema>;

export const SessionAgentTerminalOpenResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    terminalId: TerminalIdSchema,
    /** The live end of the output: a viewer starts here, not at the retained history. */
    byteOffset: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
  }),
  SessionAgentTerminalRefusalSchema,
]));
export type SessionAgentTerminalOpenResponse = z.infer<typeof SessionAgentTerminalOpenResponseSchema>;

export const SessionAgentTerminalInputRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: TerminalIdSchema,
  viewerId: SessionAgentTerminalViewerIdSchema,
  event: TerminalInputEventSchema,
}));
export type SessionAgentTerminalInputRequest = z.infer<typeof SessionAgentTerminalInputRequestSchema>;

export const SessionAgentTerminalDetachRequestSchema = lazyZodSchema(() => z.strictObject({
  terminalId: TerminalIdSchema,
  viewerId: SessionAgentTerminalViewerIdSchema,
}));
export type SessionAgentTerminalDetachRequest = z.infer<typeof SessionAgentTerminalDetachRequestSchema>;

export const SessionAgentTerminalDetachResponseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true) }),
  SessionAgentTerminalRefusalSchema,
]));
export type SessionAgentTerminalDetachResponse = z.infer<typeof SessionAgentTerminalDetachResponseSchema>;

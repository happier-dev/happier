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

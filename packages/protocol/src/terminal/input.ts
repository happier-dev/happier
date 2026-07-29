import { z } from 'zod';

const TerminalIdSchema = z.string().min(1).max(2000);
const TerminalModifierSchema = z.enum(['shift', 'ctrl', 'alt', 'meta']);

export const TerminalInputEventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('text'),
    text: z.string().max(100_000),
  }),
  z.object({
    t: z.literal('key'),
    key: z.string().min(1).max(200),
    modifiers: z.array(TerminalModifierSchema).max(4).default([]),
  }),
  z.object({
    t: z.literal('paste'),
    text: z.string().max(1_000_000),
    bracketed: z.boolean(),
  }),
  z.object({
    t: z.literal('ime'),
    phase: z.enum(['start', 'update', 'commit', 'cancel']),
    text: z.string().max(100_000).optional(),
  }),
  z.object({
    t: z.literal('mouse'),
    kind: z.enum(['down', 'up', 'move', 'wheel']),
    button: z.number().int().min(0).max(8).optional(),
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
    modifiers: z.array(TerminalModifierSchema).max(4).default([]),
  }),
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(500),
  }),
]);
export type TerminalInputEvent = z.infer<typeof TerminalInputEventSchema>;

export const TerminalStreamInputRequestSchema = z.object({
  terminalId: TerminalIdSchema,
  event: TerminalInputEventSchema,
});
export type TerminalStreamInputRequest = z.infer<typeof TerminalStreamInputRequestSchema>;

export const TerminalStreamInputResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1).max(200),
    message: z.string().min(1).max(2000),
  }),
]);
export type TerminalStreamInputResponse = z.infer<typeof TerminalStreamInputResponseSchema>;

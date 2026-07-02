import { z } from 'zod';

export const BrowserInputTargetV1Schema = z.literal('page');
export type BrowserInputTargetV1 = z.infer<typeof BrowserInputTargetV1Schema>;

export const BrowserInputModifierV1Schema = z.enum(['alt', 'control', 'meta', 'shift']);
export type BrowserInputModifierV1 = z.infer<typeof BrowserInputModifierV1Schema>;

export const BrowserKeyInputEventV1Schema = z
  .object({
    kind: z.literal('key'),
    target: BrowserInputTargetV1Schema,
    key: z.string().trim().min(1).max(64),
    modifiers: z.array(BrowserInputModifierV1Schema).default([]),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

export const BrowserPointerInputEventV1Schema = z
  .object({
    kind: z.literal('pointer'),
    target: BrowserInputTargetV1Schema,
    action: z.enum(['down', 'move', 'up', 'cancel']),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

export const BrowserTextInputEventV1Schema = z
  .object({
    kind: z.literal('text'),
    target: BrowserInputTargetV1Schema,
    text: z.string().min(1).max(16 * 1024),
    sequence: z.number().int().nonnegative(),
  })
  .strict();

export const BrowserInputEventV1Schema = z.discriminatedUnion('kind', [
  BrowserKeyInputEventV1Schema,
  BrowserPointerInputEventV1Schema,
  BrowserTextInputEventV1Schema,
]);
export type BrowserInputEventV1 = z.infer<typeof BrowserInputEventV1Schema>;

import { z } from 'zod';

export const ContextSelectionV1Schema = z.object({
  machineId: z.string().nullable().optional(),
  workspacePath: z.string().nullable().optional(),
}).passthrough();
export type ContextSelectionV1 = z.infer<typeof ContextSelectionV1Schema>;

export const ContextSelectionsV1Schema = z
  .object({
    v: z.literal(1).default(1),
    selectionsByKey: z.record(z.string(), ContextSelectionV1Schema).default({}),
  })
  .passthrough()
  .catch({ v: 1, selectionsByKey: {} });
export type ContextSelectionsV1 = z.infer<typeof ContextSelectionsV1Schema>;

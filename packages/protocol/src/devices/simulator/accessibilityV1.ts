import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const IndexSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const FrameSchema = lazyZodSchema(() => z.strictObject({
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
}));

/** A native accessibility observation; identifiers are resolved afresh by the press Action. */
export const SimulatorAccessibilityNodeV1Schema = lazyZodSchema(() => z.strictObject({
  index: IndexSchema,
  parentIndex: z.optional(IndexSchema),
  type: z.string(),
  identifier: z.optional(z.string()),
  label: z.optional(z.string()),
  value: z.optional(z.union([z.string(), z.number()])),
  frame: z.optional(FrameSchema),
  enabled: z.optional(z.boolean()),
}));
export type SimulatorAccessibilityNodeV1 = z.infer<typeof SimulatorAccessibilityNodeV1Schema>;

export const SimulatorAccessibilitySnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  nodes: z.array(SimulatorAccessibilityNodeV1Schema),
  truncated: z.boolean(),
  viewport: z.optional(z.strictObject({ width: z.number(), height: z.number() })),
  appBundleId: z.optional(z.string()),
}));
export type SimulatorAccessibilitySnapshotV1 = z.infer<typeof SimulatorAccessibilitySnapshotV1Schema>;

import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** The value pointer may name authored keys; schema-side diagnostics name the contract. */
export const PluginJsonSchemaValueIssueSchema = lazyZodSchema(() => z.strictObject({
  pointer: z.string(), schemaPath: z.string(), keyword: z.string(), message: z.string(),
}));
export type PluginJsonSchemaValueIssue = Readonly<z.infer<typeof PluginJsonSchemaValueIssueSchema>>;

/** Earlier retained issues predate schema-side diagnostics; their absence stays explicit. */
export const StoredPluginJsonSchemaValueIssueSchema = lazyZodSchema(() => z.partial(
  PluginJsonSchemaValueIssueSchema, { schemaPath: true, keyword: true },
));

import { z } from 'zod';

/** A freshness hint, never executable authority. Both identity and fact are closed. */
export const DaemonPluginCatalogProjectionSchema = z.strictObject({
  runtimeId: z.string().min(1),
  contributionRegistryProjectionRevision: z.number().int().nonnegative().safe(),
});
export type DaemonPluginCatalogProjection = Readonly<z.infer<typeof DaemonPluginCatalogProjectionSchema>>;

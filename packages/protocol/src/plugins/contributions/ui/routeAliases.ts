import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';

/** Retained host paths owned by an app page. Braced subpath parameters are URI-encoded. */
export const PluginUiAppPageRouteAliasV1Schema = lazyZodSchema(() => z.strictObject({
  pathname: z.string().check(z.regex(/^\/[^?#]*$/)),
  /** A missing or empty parameter opens the page root instead of a selection. */
  subPath: z.optional(z.string()),
}));
export type PluginUiAppPageRouteAliasV1 = z.infer<typeof PluginUiAppPageRouteAliasV1Schema>;
export const PluginUiAppPageRouteAliasesV1Schema = lazyZodSchema(() => z.array(PluginUiAppPageRouteAliasV1Schema));

import { z } from 'zod';
import semver from 'semver';

import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../pluginId.js';

export const MAX_PLUGIN_RELEASE_VERSION_BYTES = 256;

export const PluginReleaseVersionV1Schema = z.string().trim().min(1).max(
  MAX_PLUGIN_RELEASE_VERSION_BYTES,
).refine(
  (value) => semver.valid(value) === value,
  'Plugin release versions must be canonical semver versions.',
);

export const PluginReleaseRefV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  version: PluginReleaseVersionV1Schema,
}).strict();
export type PluginReleaseRefV1 = z.infer<typeof PluginReleaseRefV1Schema>;

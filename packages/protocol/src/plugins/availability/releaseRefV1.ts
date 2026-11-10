import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import semver from 'semver';

import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../pluginId.js';

export const MAX_PLUGIN_RELEASE_VERSION_BYTES = 256;

export const PluginReleaseVersionV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_PLUGIN_RELEASE_VERSION_BYTES), z.refine((value) => semver.valid(value) === value, 'Plugin release versions must be canonical semver versions.')));

export const PluginReleaseRefV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  version: PluginReleaseVersionV1Schema,
}));
export type PluginReleaseRefV1 = z.infer<typeof PluginReleaseRefV1Schema>;

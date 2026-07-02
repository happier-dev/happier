import { z } from 'zod';

import { PluginReactNativeBundleContributionV1Schema } from '../contributions/ui/reactNativeBundles.js';
import { PluginUiExecutableArtifactManifestV1Schema } from './artifacts.js';

export const PluginReactNativeBundleManifestV1Schema = z.object({
  contribution: PluginReactNativeBundleContributionV1Schema,
  artifacts: z.array(PluginUiExecutableArtifactManifestV1Schema).min(1),
}).strict();
export type PluginReactNativeBundleManifestV1 =
  z.infer<typeof PluginReactNativeBundleManifestV1Schema>;

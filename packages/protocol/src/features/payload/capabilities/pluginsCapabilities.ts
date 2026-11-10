import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { PluginUiArtifactHostingCapabilityV1ReadSchema } from '../../../plugins/availability/v1.js';

export const PluginsCapabilitiesSchema = lazyZodSchema(() => z.object({
  uiArtifactHosting: PluginUiArtifactHostingCapabilityV1ReadSchema,
}));

export const DEFAULT_PLUGINS_CAPABILITIES = Object.freeze({
  uiArtifactHosting: { enabled: false as const },
});

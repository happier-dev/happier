import { z } from 'zod';

import { PluginUiArtifactHostingCapabilityV1Schema } from '../../../plugins/availability/v1.js';

export const PluginsCapabilitiesSchema = z.object({
  uiArtifactHosting: PluginUiArtifactHostingCapabilityV1Schema,
}).strict();

export const DEFAULT_PLUGINS_CAPABILITIES = Object.freeze({
  uiArtifactHosting: { enabled: false as const },
});

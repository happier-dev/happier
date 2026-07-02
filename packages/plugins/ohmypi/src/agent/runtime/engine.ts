import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { BundledBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { ohMyPiExternalSessionSurface } from '../surfaces/sessions/external/provider.js';

export function createOhMyPiBackendEngine(_ctx: PluginContextV1): BundledBackendEngineV1 {
  return {
    externalSessionSurface: ohMyPiExternalSessionSurface,
  };
}

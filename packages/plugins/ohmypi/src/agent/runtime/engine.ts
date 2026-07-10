import type { AgentRuntimeV1, PluginContextV1 } from '@happier-dev/plugin-sdk';

import { ohMyPiExternalSessionSurface } from '../surfaces/sessions/external/provider.js';
import { resolveOhMyPiTerminalRuntimeTranscriptBinding } from '../terminalRuntime/transcriptBinding.js';

export function createOhMyPiBackendEngine(_ctx: PluginContextV1): AgentRuntimeV1 {
  return {
    externalSessionSurface: ohMyPiExternalSessionSurface,
    terminalRuntimeSurface: {
      resolveTranscriptBinding: resolveOhMyPiTerminalRuntimeTranscriptBinding,
    },
  };
}

import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { RealtimeVoiceProviderRuntime } from '@happier-dev/plugin-sdk/voice/client';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { createXaiNativeWebSocketDriver } from './connection.native.js';
import { createXaiRealtimeProviderRuntime as createSharedXaiRealtimeProviderRuntime } from './runtime.js';

export function createXaiRealtimeProviderRuntime(): RealtimeVoiceProviderRuntime {
  return createSharedXaiRealtimeProviderRuntime({
    createConnectionDriver: createXaiNativeWebSocketDriver,
  });
}

/** Native uses the same public runtime with only the WebSocket constructor adapted. */
export function activate(api: Pick<PluginApi, 'voiceProviders'>): void {
  api.voiceProviders.register(
    PLUGIN_MANIFEST.contributes.voiceProviders[0].id,
    createXaiRealtimeProviderRuntime(),
  );
}

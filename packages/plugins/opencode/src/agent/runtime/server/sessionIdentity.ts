import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { OPEN_CODE_PROVIDER_SESSION_ID_METADATA_KEY } from '../../identity/session.js';

export async function publishOpenCodeProviderSessionId(params: Readonly<{
  ctx: PluginContextV1;
  providerSessionId: string;
  reason: string;
}>): Promise<void> {
  await params.ctx.sessions.writeStateField({
    fieldId: 'identity.providerSessionId',
    value: {
      metadataKey: OPEN_CODE_PROVIDER_SESSION_ID_METADATA_KEY,
      value: params.providerSessionId,
    },
    reason: params.reason,
  });
}

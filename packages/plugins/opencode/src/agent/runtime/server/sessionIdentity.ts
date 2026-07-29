import { OPEN_CODE_PROVIDER_SESSION_ID_METADATA_KEY } from '../../identity/session.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

export async function publishOpenCodeProviderSessionId(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
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

import { z } from 'zod';

import type { ConnectedServiceCredentialRefreshDiagnostic } from './refreshTypes';
import { isReauthRequiredFailure } from './refreshDiagnostics';
import { lazySchema } from '@happier-dev/protocol';

export const ConnectedServiceBridgeRefreshFailureResponseSchema = lazySchema(() => z.discriminatedUnion('errorCode', [
  z.object({
    ok: z.literal(false),
    errorCode: z.literal('connected_service_credential_reconnect_required'),
    credentialHealthStatus: z.literal('needs_reauth'),
  }),
  z.object({
    ok: z.literal(false),
    errorCode: z.literal('connected_service_credential_refresh_unavailable'),
    credentialHealthStatus: z.literal('refresh_failed_retryable'),
  }),
]));

export type ConnectedServiceBridgeRefreshFailureResponse = z.infer<
  typeof ConnectedServiceBridgeRefreshFailureResponseSchema
>;

export function buildConnectedServiceBridgeRefreshFailureResponse(
  diagnostic: ConnectedServiceCredentialRefreshDiagnostic,
): ConnectedServiceBridgeRefreshFailureResponse {
  const reconnectRequired = diagnostic.status === 'blocked_by_credential_health'
    || (diagnostic.category !== undefined && isReauthRequiredFailure(diagnostic.category));
  return reconnectRequired
    ? {
        ok: false,
        errorCode: 'connected_service_credential_reconnect_required',
        credentialHealthStatus: 'needs_reauth',
      }
    : {
        ok: false,
        errorCode: 'connected_service_credential_refresh_unavailable',
        credentialHealthStatus: 'refresh_failed_retryable',
      };
}

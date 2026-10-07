import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export function createLoopbackHomeIdentityProbe(params: Readonly<{
  serverUrl: string;
  expectedServerIdentityId?: string;
  signal?: AbortSignal;
}>): () => Promise<ReadinessProbeResult> {
  const serverUrl = resolveLoopbackHttpUrl(params.serverUrl).replace(/\/+$/, '');

  return async () => {
    try {
      params.signal?.throwIfAborted();
      const snapshot = await observeServerFeaturesSnapshot({
        serverUrl,
        projection: 'public',
        signal: params.signal,
      });
      params.signal?.throwIfAborted();

      if (
        snapshot.status === 'error'
        && snapshot.reason === 'response_status'
        && (snapshot.httpStatus ?? 0) >= 500
      ) {
        return {
          status: 'retry_later',
          errorMessage: `Home identity probe returned ${snapshot.httpStatus}`,
        };
      }
      if (snapshot.status !== 'ready') {
        return {
          status: 'server_unreachable',
          errorMessage: snapshot.status === 'error' && snapshot.httpStatus
            ? `Home identity probe returned ${snapshot.httpStatus}`
            : `Home identity probe failed: ${snapshot.reason}`,
        };
      }
      if (params.expectedServerIdentityId) {
        const observedIdentity = snapshot.features.capabilities.serverIdentity.serverIdentityId?.trim() ?? '';
        if (observedIdentity !== params.expectedServerIdentityId) {
          return {
            status: 'auth_failed',
            errorMessage: 'Home identity did not match the expected profile',
          };
        }
      }
      return { status: 'ready' };
    } catch (error) {
      return {
        status: 'server_unreachable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createLoopbackReadinessProbe(params: Readonly<{
  serverUrl: string;
  token: string;
  expectedServerIdentityId?: string;
  signal?: AbortSignal;
}>): () => Promise<ReadinessProbeResult> {
  const serverUrl = resolveLoopbackHttpUrl(params.serverUrl).replace(/\/+$/, '');

  return async () => {
    const identity = await createLoopbackHomeIdentityProbe(params)();
    if (identity.status !== 'ready') return identity;

    try {
      params.signal?.throwIfAborted();
      const authResponse = await axios.get(`${serverUrl}/v1/auth/ping`, {
        // The caller's signal owns cancellation; no phase-local cutoff that could
        // reject a healthy, loaded Home.
        signal: params.signal,
        validateStatus: () => true,
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${params.token}`,
        },
      });

      if (isAuthenticationStatus(authResponse.status)) {
        return {
          status: 'auth_failed',
          statusCode: authResponse.status,
          errorMessage: `Authenticated probe returned ${authResponse.status}`,
        };
      }

      if (authResponse.status >= 500) {
        return {
          status: 'retry_later',
          errorMessage: `Authenticated probe returned ${authResponse.status}`,
        };
      }

      if (authResponse.status >= 400) {
        return {
          status: 'server_unreachable',
          errorMessage: `Authenticated probe returned ${authResponse.status}`,
        };
      }

      return { status: 'ready' };
    } catch (error) {
      return {
        status: 'server_unreachable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

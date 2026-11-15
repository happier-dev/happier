import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { AxiosHeaders } from 'axios';
import { readRetryLaterHints, type ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readTerminalAuthHomeIdentity, TerminalAuthEnrollmentVerificationError } from '@/auth/terminalAuthEnrollmentClient';

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

      if (snapshot.status === 'unsupported') readTerminalAuthHomeIdentity(snapshot);

      if (
        snapshot.status === 'error'
        && snapshot.reason === 'response_status'
        && (snapshot.httpStatus ?? 0) >= 500
      ) {
        return {
          status: 'retry_later',
          ...snapshot.retryLater,
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
      if (error instanceof TerminalAuthEnrollmentVerificationError) {
        return {
          status: 'server_unreachable',
          errorMessage: error.message,
          failure: { code: error.code, retryable: false },
        };
      }
      return {
        status: 'server_unreachable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export function createLoopbackReadinessProbe(params: Readonly<{
  serverUrl?: string;
  token: string;
  expectedServerIdentityId?: string;
  signal?: AbortSignal;
}>): () => Promise<ReadinessProbeResult> {
  return async () => {
    const serverUrl = resolveLoopbackHttpUrl(params.serverUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
    const identity = await createLoopbackHomeIdentityProbe({ ...params, serverUrl })();
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
          ...readRetryLaterHints(AxiosHeaders.from(authResponse.headers as Parameters<typeof AxiosHeaders.from>[0])),
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

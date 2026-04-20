import axios from 'axios';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { isAuthenticationStatus } from '@/api/client/httpStatusError';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';

export function createLoopbackReadinessProbe(params: Readonly<{
  serverUrl: string;
  token: string;
}>): () => Promise<ReadinessProbeResult> {
  const serverUrl = resolveLoopbackHttpUrl(params.serverUrl).replace(/\/+$/, '');

  return async () => {
    try {
      const healthResponse = await axios.get(`${serverUrl}/health`, {
        timeout: 5_000,
        validateStatus: () => true,
      });

      if (healthResponse.status >= 500) {
        return {
          status: 'retry_later',
          errorMessage: `Health check returned ${healthResponse.status}`,
        };
      }
    } catch (error) {
      return {
        status: 'server_unreachable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const authResponse = await axios.get(`${serverUrl}/v1/features`, {
        timeout: 5_000,
        validateStatus: () => true,
        headers: {
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

      return { status: 'ready' };
    } catch (error) {
      return {
        status: 'server_unreachable',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

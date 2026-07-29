import axios from 'axios';

import {
  ConnectedServiceAuthGroupResponseV1Schema,
  type ConnectedServiceAuthGroupV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServicesServerApiTimeout';
import { createHttpStatusError } from './httpStatusError';
import { readAxiosResponseErrorCode } from './readAxiosResponseErrorCode';
import { logServerEndpointFailure } from './serverEndpointFailureLog';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export async function getConnectedServiceAuthGroup(params: Readonly<{
  token: string;
  serviceId: ConnectedServiceId;
  groupId: string;
}>): Promise<ConnectedServiceAuthGroupV1 | null> {
  const serverUrl = resolveServerHttpBaseUrl();
  const serviceId = encodeURIComponent(params.serviceId);
  const groupId = encodeURIComponent(params.groupId);

  try {
    const response = await axios.get(
      `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}`,
      {
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Invalid connected service auth group response');
    }
    return parsed.data.group;
  } catch (error: unknown) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const errorCode = readAxiosResponseErrorCode(error);
    if (status === 404 && errorCode === 'connect_group_not_found') return null;
    logServerEndpointFailure({
      logger,
      operation: 'Failed to get connected service auth group',
      error,
    });
    if (typeof status === 'number' && Number.isFinite(status)) {
      throw createHttpStatusError(
        status,
        `Failed to get connected service auth group (${status})`,
        errorCode ?? undefined,
      );
    }
    // Preserve the original error as `cause` so downstream classification can
    // recover transient network codes and keep usage-limit recovery retryable.
    throw new Error(
      `Failed to get connected service auth group: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error },
    );
  }
}

import axios from 'axios';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1, ProviderBrokerOpenRequestV1Schema, ProviderBrokerOpenResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerOpenRequestV1, ProviderBrokerOpenResponseV1 } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

/** Narrow typed HTTP boundary for opening one exact Provider broker authority. */
export async function openTeamCredentialProviderBroker(input: Readonly<{
  token: string;
  request: ProviderBrokerOpenRequestV1;
  serverBaseUrl?: string;
  signal?: AbortSignal;
}>): Promise<ProviderBrokerOpenResponseV1> {
  input.signal?.throwIfAborted();
  const serverBaseUrl = (input.serverBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const response = await axios.post(
    `${serverBaseUrl}${PROVIDER_BROKER_OPEN_HTTP_PATH_V1}`,
    ProviderBrokerOpenRequestV1Schema.parse(input.request),
    {
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  return ProviderBrokerOpenResponseV1Schema.parse(response.data);
}

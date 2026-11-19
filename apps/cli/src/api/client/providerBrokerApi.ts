import {
  ProviderBrokerWatcherOpenRequestV1Schema, ProviderBrokerWatcherOpenResponseV1Schema,
  type ProviderBrokerWatcherOpenRequestV1, type ProviderBrokerWatcherOpenResponseV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import axios from '@/api/client/credentialAxios';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1, ProviderBrokerOpenRequestV1Schema, ProviderBrokerOpenResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerOpenRequestV1, ProviderBrokerOpenResponseV1 } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

type BrokerOpenInput = Readonly<{ token: string; serverBaseUrl?: string; signal?: AbortSignal }>;

export function openTeamCredentialProviderBroker(input: BrokerOpenInput & Readonly<{ request: ProviderBrokerWatcherOpenRequestV1; requestHeaders: Readonly<Record<string, string>> }>): Promise<ProviderBrokerWatcherOpenResponseV1>;
export function openTeamCredentialProviderBroker(input: BrokerOpenInput & Readonly<{ request: ProviderBrokerOpenRequestV1 }>): Promise<ProviderBrokerOpenResponseV1>;

/** Narrow typed HTTP boundary for opening one exact Provider broker authority. */
export async function openTeamCredentialProviderBroker(input: Readonly<{
  token: string;
  requestHeaders?: Readonly<Record<string, string>>;
  request: ProviderBrokerOpenRequestV1 | ProviderBrokerWatcherOpenRequestV1;
  serverBaseUrl?: string;
  signal?: AbortSignal;
}>): Promise<ProviderBrokerOpenResponseV1 | ProviderBrokerWatcherOpenResponseV1> {
  input.signal?.throwIfAborted();
  const watcher = 'scope' in input.request;
  const publisherProof = watcher ? input.requestHeaders?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1] : undefined;
  if (watcher && !publisherProof) throw new Error('Signed Event watcher authority is required');
  const serverBaseUrl = (input.serverBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const body = watcher ? ProviderBrokerWatcherOpenRequestV1Schema.parse(input.request)
    : ProviderBrokerOpenRequestV1Schema.parse(input.request);
  const response = await axios.post(
    `${serverBaseUrl}${PROVIDER_BROKER_OPEN_HTTP_PATH_V1}`,
    body,
    {
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json',
        ...(publisherProof ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherProof } : {}) },
      ...(watcher ? { maxRedirects: 0 } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (watcher) return ProviderBrokerWatcherOpenResponseV1Schema.parse(response.data);
  return ProviderBrokerOpenResponseV1Schema.parse(response.data);
}

import {
  ProviderBrokerWatcherOpenRequestV1Schema, ProviderBrokerWatcherOpenResponseV1Schema,
  ProviderBrokerWatcherRefreshRequestV1Schema, ProviderBrokerWatcherRefreshResponseV1Schema,
  type ProviderBrokerWatcherOpenRequestV1, type ProviderBrokerWatcherOpenResponseV1,
  type ProviderBrokerWatcherRefreshRequestV1, type ProviderBrokerWatcherRefreshResponseV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import axios from '@/api/client/credentialAxios';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1, ProviderBrokerOpenRequestV1Schema, ProviderBrokerOpenResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerOpenRequestV1, ProviderBrokerOpenResponseV1 } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

type BrokerOpenInput = Readonly<{ token: string; serverBaseUrl?: string; signal?: AbortSignal }>;
type WatcherRequest = ProviderBrokerWatcherOpenRequestV1 | ProviderBrokerWatcherRefreshRequestV1;
type WatcherResponse = ProviderBrokerWatcherOpenResponseV1 | ProviderBrokerWatcherRefreshResponseV1;

export function openTeamCredentialProviderBroker(input: BrokerOpenInput & Readonly<{ request: WatcherRequest; requestHeaders: Readonly<Record<string, string>> }>): Promise<WatcherResponse>;
export function openTeamCredentialProviderBroker(input: BrokerOpenInput & Readonly<{ request: ProviderBrokerOpenRequestV1 }>): Promise<ProviderBrokerOpenResponseV1>;

/** Narrow typed HTTP boundary for opening one exact Provider broker authority. */
export async function openTeamCredentialProviderBroker(input: Readonly<{
  token: string;
  requestHeaders?: Readonly<Record<string, string>>;
  request: ProviderBrokerOpenRequestV1 | WatcherRequest;
  serverBaseUrl?: string;
  signal?: AbortSignal;
}>): Promise<ProviderBrokerOpenResponseV1 | WatcherResponse> {
  input.signal?.throwIfAborted();
  const watcher = 'scope' in input.request;
  const watcherRefresh = watcher && 'refreshAuthority' in input.request;
  const publisherProof = watcher ? input.requestHeaders?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1] : undefined;
  if (watcher && !publisherProof) throw new Error('Signed Event watcher authority is required');
  const serverBaseUrl = (input.serverBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '');
  const body = watcherRefresh ? ProviderBrokerWatcherRefreshRequestV1Schema.parse(input.request)
    : watcher ? ProviderBrokerWatcherOpenRequestV1Schema.parse(input.request)
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
  if (watcherRefresh) return ProviderBrokerWatcherRefreshResponseV1Schema.parse(response.data);
  if (watcher) return ProviderBrokerWatcherOpenResponseV1Schema.parse(response.data);
  return ProviderBrokerOpenResponseV1Schema.parse(response.data);
}

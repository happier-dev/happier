import axios from 'axios';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginPermissionGrantRequestActionInputV1Schema,
  PluginPermissionGrantRequestActionOutputV1Schema,
  type PluginPermissionGrantRequestActionInputV1,
  type PluginPermissionGrantRequestActionOutputV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const REQUEST_PATH = '/v1/plugins/permissions/grants/request';

export type PluginPermissionGrantRequester = Readonly<{
  request(
    input: PluginPermissionGrantRequestActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginPermissionGrantRequestActionOutputV1>;
}>;

export function createServerPluginPermissionGrantRequester(input: Readonly<{
  credentials: StoredCredentials;
}>): PluginPermissionGrantRequester {
  return Object.freeze({
    async request(rawInput, options = {}) {
      const body = PluginPermissionGrantRequestActionInputV1Schema.parse(rawInput);
      const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
        method: 'POST',
        path: REQUEST_PATH,
        body,
      });
      options.signal?.throwIfAborted();
      const response = await axios.post(
        `${resolveServerHttpBaseUrl()}${REQUEST_PATH}`,
        body,
        {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${input.credentials.token}`,
            ...(publisherHeader
              ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader }
              : {}),
          },
          timeout: configuration.sessionControlHttpTimeoutMs,
          validateStatus: (status) => status >= 200 && status < 300,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      return PluginPermissionGrantRequestActionOutputV1Schema.parse(response.data);
    },
  });
}

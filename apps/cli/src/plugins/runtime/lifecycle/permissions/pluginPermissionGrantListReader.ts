import axios from 'axios';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginPermissionGrantListActionInputV1Schema,
  PluginPermissionGrantListActionOutputV1Schema,
  type PluginPermissionGrantListActionInputV1,
  type PluginPermissionGrantListActionOutputV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const LIST_PATH = '/v1/plugins/permissions/grants/list';

export type PluginPermissionGrantListReader = Readonly<{
  list(
    input: PluginPermissionGrantListActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginPermissionGrantListActionOutputV1>;
}>;

export function createServerPluginPermissionGrantListReader(input: Readonly<{
  credentials: StoredCredentials;
}>): PluginPermissionGrantListReader {
  return Object.freeze({
    async list(rawInput, options = {}) {
      const body = PluginPermissionGrantListActionInputV1Schema.parse(rawInput);
      const publisherHeader = body.caller
        ? await createDefaultPluginInstallationPublisherHeader({
            method: 'POST',
            path: LIST_PATH,
            body,
          })
        : null;
      if (body.caller && !publisherHeader) {
        throw new Error('plugin_permission_grant_publisher_proof_unavailable');
      }
      options.signal?.throwIfAborted();
      const response = await axios.post(
        `${resolveServerHttpBaseUrl()}${LIST_PATH}`,
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
      return PluginPermissionGrantListActionOutputV1Schema.parse(response.data);
    },
  });
}

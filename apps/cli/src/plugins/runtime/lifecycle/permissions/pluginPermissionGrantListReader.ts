import axios from 'axios';

import {
  PluginPermissionGrantListActionInputV1Schema,
  PluginPermissionGrantListActionOutputV1Schema,
  type PluginPermissionGrantListActionInputV1,
  type PluginPermissionGrantListActionOutputV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
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
      const response = await axios.post(
        `${resolveServerHttpBaseUrl()}${LIST_PATH}`,
        body,
        {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${input.credentials.token}`,
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

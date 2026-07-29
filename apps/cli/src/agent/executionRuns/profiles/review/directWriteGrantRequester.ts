import axios from 'axios';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginPermissionGrantRequestActionInputV1Schema,
  PluginPermissionGrantRequestActionOutputV1Schema,
  type PluginPermissionGrantRequestActionInputV1,
  type PluginPermissionGrantRequestActionOutputV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { Credentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const REQUEST_PATH = '/v1/plugins/permissions/grants/request';

export async function requestReviewCommentDirectWriteGrant(params: Readonly<{
  credentials: Credentials;
  input: PluginPermissionGrantRequestActionInputV1;
}>): Promise<PluginPermissionGrantRequestActionOutputV1> {
  const body = PluginPermissionGrantRequestActionInputV1Schema.parse(params.input);
  const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
    method: 'POST',
    path: REQUEST_PATH,
    body,
  });
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}${REQUEST_PATH}`,
    body,
    {
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        ...(publisherHeader
          ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader }
          : {}),
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: (status) => status >= 200 && status < 300,
    },
  );
  return PluginPermissionGrantRequestActionOutputV1Schema.parse(response.data);
}

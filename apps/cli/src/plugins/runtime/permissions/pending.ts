import axios, { type AxiosRequestConfig } from 'axios';

import {
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    PluginPermissionGrantRequestActionInputV1Schema,
    PluginPermissionGrantRequestActionOutputV1Schema,
    type PluginPermissionGrantRequestActionInputV1,
    type PluginPermissionGrantRequestActionOutputV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import {
    createDefaultPluginInstallationPublisherHeader,
    type CreatePluginInstallationPublisherHeader,
} from '@/plugins/installations/publisherProof';
import type { Credentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export async function publishPluginPermissionGrantRequest(params: Readonly<{
    credentials: Credentials;
    input: PluginPermissionGrantRequestActionInputV1;
    createPublisherHeader?: CreatePluginInstallationPublisherHeader;
    signal?: AbortSignal;
}>): Promise<PluginPermissionGrantRequestActionOutputV1> {
    const input = PluginPermissionGrantRequestActionInputV1Schema.parse(params.input);
    const publisherHeader = await (params.createPublisherHeader ?? createDefaultPluginInstallationPublisherHeader)({
        method: 'POST',
        path: '/v1/plugins/permissions/grants/request',
        body: input,
    });
    const config: AxiosRequestConfig = {
        headers: {
            Authorization: `Bearer ${params.credentials.token}`,
            ...(publisherHeader ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader } : {}),
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: () => true,
        ...(params.signal ? { signal: params.signal } : {}),
    };
    const response = await axios.post(
        `${resolveServerHttpBaseUrl()}/v1/plugins/permissions/grants/request`,
        input,
        config,
    );
    if (response.status < 200 || response.status >= 300) {
        throw new Error('plugin_permission_grant_request_publish_failed');
    }
    return PluginPermissionGrantRequestActionOutputV1Schema.parse(response.data);
}

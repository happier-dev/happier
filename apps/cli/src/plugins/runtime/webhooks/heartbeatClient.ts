import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, stringifyPluginInstallationManifestCanonicalJsonV1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1, PluginWebhookEndpointEnsureInputV1Schema, PluginWebhookEndpointEnsureResultV1Schema, PluginWebhookHeartbeatReadInputV1Schema, PluginWebhookHeartbeatReadResultV1Schema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import type { PluginWebhookHeartbeatReadResultV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import type { StoredCredentials } from '@/persistence';

export type PluginWebhookHeartbeatEnrollRequest = Readonly<{
  caller: PluginMachineMaterializationRefV1;
  sourceInstanceId: string;
  checkId: string;
  heartbeatContributionId: string;
}>;
export type PluginWebhookHeartbeatReadRequest = Readonly<{
  caller: PluginMachineMaterializationRefV1;
  sourceInstanceId: string;
  checkId: string;
  webhookEndpointId: string;
}>;
export type PluginWebhookHeartbeatClient = Readonly<{
  enroll(request: PluginWebhookHeartbeatEnrollRequest, signal?: AbortSignal): Promise<Readonly<{ webhookEndpointId: string }>>;
  read(request: PluginWebhookHeartbeatReadRequest, signal?: AbortSignal): Promise<PluginWebhookHeartbeatReadResultV1>;
}>;
function endpointUnavailable(): PluginError {
  return new PluginError({ code: 'endpoint_unavailable', message: 'Heartbeat endpoint is unavailable' });
}

/** Finite daemon transport; the saved source retains only the returned endpoint identity. */
export function createPluginWebhookHeartbeatClient(params: Readonly<{
  readCredentials: () => Promise<StoredCredentials | null>;
  serverHttpBaseUrl: string;
}>): PluginWebhookHeartbeatClient {
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    let credentials: StoredCredentials | null;
    let publisherHeader: string | null;
    try {
      credentials = await params.readCredentials();
      if (!credentials) throw endpointUnavailable();
      publisherHeader = await createDefaultPluginInstallationPublisherHeader({ method: 'POST', path, body });
      if (!publisherHeader) throw endpointUnavailable();
    } catch {
      signal?.throwIfAborted();
      throw endpointUnavailable();
    }
    signal?.throwIfAborted();
    const response = await axios.post(`${params.serverHttpBaseUrl.replace(/\/+$/u, '')}${path}`, body, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${credentials.token}`,
        [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
      },
      timeout: configuration.sessionControlHttpTimeoutMs,
      validateStatus: status => status >= 200 && status < 300,
      ...(signal ? { signal } : {}),
    });
    return response.data;
  };
  return Object.freeze<PluginWebhookHeartbeatClient>({
    async enroll(request, signal) {
      signal?.throwIfAborted();
      try {
        // Canonical JSON keeps identity independent of property insertion order;
        // a fixed digest fits the ingress key contract for long check identities.
        const idempotencyKey = createHash('sha256')
          .update('happier.pluginWebhookHeartbeat.enroll.v1\u0000')
          .update(stringifyPluginInstallationManifestCanonicalJsonV1({
            caller: request.caller, sourceInstanceId: request.sourceInstanceId, checkId: request.checkId,
          }))
          .digest('hex');
        const input = PluginWebhookEndpointEnsureInputV1Schema.parse({
          webhookContribution: { pluginId: request.caller.pluginId, localId: request.heartbeatContributionId },
          targetMaterialization: request.caller,
          sourceInstanceId: request.sourceInstanceId,
          setup: { kind: 'capabilityUrlV1', checkId: request.checkId },
          idempotencyKey,
        });
        const result = PluginWebhookEndpointEnsureResultV1Schema.parse(await post(
          PLUGIN_WEBHOOK_HEARTBEAT_ENSURE_PATH_V1, { caller: request.caller, input }, signal,
        ));
        return { webhookEndpointId: result.webhookEndpointId };
      } catch {
        signal?.throwIfAborted();
        // Axios errors retain request credentials and the capability URL in their
        // response; only the existing closed error crosses the host service seam.
        throw endpointUnavailable();
      }
    },
    async read(request, signal) {
      signal?.throwIfAborted();
      try {
        const input = PluginWebhookHeartbeatReadInputV1Schema.parse({
          webhookEndpointId: request.webhookEndpointId,
          sourceInstanceId: request.sourceInstanceId,
          checkId: request.checkId,
        });
        return PluginWebhookHeartbeatReadResultV1Schema.parse(await post(
          PLUGIN_WEBHOOK_HEARTBEAT_READ_PATH_V1, { caller: request.caller, input }, signal,
        ));
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof PluginError) throw error;
        return { kind: 'unavailable', code: 'endpoint_unavailable' };
      }
    },
  });
}

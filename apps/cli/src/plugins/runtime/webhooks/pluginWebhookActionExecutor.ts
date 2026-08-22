import axios from 'axios';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginWebhookActionHttpPathsV1,
  PluginWebhookActionInputSchemasV1,
  PluginWebhookActionOutputSchemasV1,
  PluginMachineMaterializationRefV1Schema,
  type ActionExecutorDeps,
  type PluginWebhookActionIdV1,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { RevalidatePluginActionCallerMaterialization } from '@/plugins/runtime/invocation/services/actionCaller';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

type ExecutePluginWebhookAction = NonNullable<ActionExecutorDeps['pluginWebhookAction']>;

const CHECK_CORRESPONDENCE_PATH = '/v1/plugins/webhooks/endpoints/check-correspondence';

export type PluginWebhookActionTransport = Readonly<{
  execute(
    actionId: PluginWebhookActionIdV1,
    input: unknown,
    options?: Readonly<{
      signal?: AbortSignal;
      caller?: PluginMachineMaterializationRefV1;
    }>,
  ): Promise<unknown>;
}>;

function failure(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function createDefaultTransport(credentials: StoredCredentials): PluginWebhookActionTransport {
  return Object.freeze({
    async execute(actionId, rawInput, options = {}) {
      const input = PluginWebhookActionInputSchemasV1[actionId].parse(rawInput);
      const correspondence = actionId === 'plugin.webhook.endpoint.checkCorrespondence';
      const path = correspondence
        ? CHECK_CORRESPONDENCE_PATH
        : PluginWebhookActionHttpPathsV1[actionId as keyof typeof PluginWebhookActionHttpPathsV1];
      if (!path) throw new TypeError(`Unsupported plugin webhook Action transport: ${actionId}`);
      const body = correspondence
        ? { caller: options.caller, input }
        : input;
      const publisherHeader = correspondence
        ? await createDefaultPluginInstallationPublisherHeader({ method: 'POST', path, body })
        : null;
      if (correspondence && (!options.caller || !publisherHeader)) {
        return failure('plugin_webhook_publisher_proof_unavailable');
      }
      options.signal?.throwIfAborted();
      const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${credentials.token}`,
          ...(publisherHeader
            ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader }
            : {}),
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return PluginWebhookActionOutputSchemasV1[actionId].parse(response.data);
    },
  });
}

/**
 * CLI binding for the canonical webhook Action family. Caller surface and
 * plugin identity come from the host Action context, never Action input.
 */
export function createPluginWebhookActionExecutor(params: Readonly<{
  credentials: StoredCredentials;
  transport?: PluginWebhookActionTransport;
  revalidateCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
}>): ExecutePluginWebhookAction {
  const transport = params.transport ?? createDefaultTransport(params.credentials);
  const revalidateCallerMaterialization = params.revalidateCallerMaterialization;
  return async (args) => {
    const correspondence = args.actionId === 'plugin.webhook.endpoint.checkCorrespondence';
    if ((correspondence && args.caller.kind !== 'plugin') || (!correspondence && args.caller.kind !== 'host')) {
      return failure('plugin_webhook_caller_surface_mismatch');
    }
    let caller: PluginMachineMaterializationRefV1 | undefined;
    if (correspondence) {
      // The surface guard above narrows the caller to the plugin branch.
      if (args.caller.kind !== 'plugin') {
        return failure('plugin_webhook_caller_surface_mismatch');
      }
      const materialization = PluginMachineMaterializationRefV1Schema.safeParse(
        args.caller.materialization,
      );
      if (!materialization.success || materialization.data.pluginId !== args.caller.pluginId) {
        return failure('plugin_webhook_caller_materialization_unavailable');
      }
      if (!revalidateCallerMaterialization) {
        return failure('plugin_webhook_caller_materialization_unavailable');
      }
      let current = false;
      try {
        current = await revalidateCallerMaterialization(materialization.data);
      } catch {
        current = false;
      }
      if (!current) return failure('plugin_webhook_caller_materialization_unavailable');
      caller = materialization.data;
    }
    return await transport.execute(
      args.actionId,
      args.input,
      {
        ...(args.signal ? { signal: args.signal } : {}),
        ...(caller
          ? { caller }
          : {}),
      },
    );
  };
}

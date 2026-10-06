import axios from 'axios';

import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { PluginWebhookActionInputSchemasV1, PluginWebhookActionOutputSchemasV1, isPluginWebhookPluginSurfaceActionIdV1 } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import type { ActionExecutorDeps, PluginWebhookActionIdV1, PluginMachineMaterializationRefV1 } from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { RevalidatePluginActionCallerMaterialization } from '@/plugins/runtime/invocation/services/actionCaller';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

type ExecutePluginWebhookAction = NonNullable<ActionExecutorDeps['pluginWebhookAction']>;

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
      // Every plugin-surface endpoint operation carries the host-stamped caller
      // materialization under signed publisher proof; every present-user one
      // carries only the Account bearer. The Protocol family list is the single
      // owner of that split, so a new plugin-surface operation cannot be routed
      // through the present-user body shape by omission.
      const pluginSurface = isPluginWebhookPluginSurfaceActionIdV1(actionId);
      const transport = getActionSpec(actionId).serverTransport;
      if (!transport) throw new TypeError(`Unsupported plugin webhook Action transport: ${actionId}`);
      const { path, method } = transport;
      if (method !== 'GET' && method !== 'POST') {
        throw new TypeError(`Unsupported plugin webhook publisher-proof method: ${method}`);
      }
      const body = pluginSurface
        ? { caller: options.caller, input }
        : input;
      const publisherHeader = pluginSurface
        ? await createDefaultPluginInstallationPublisherHeader({ method, path, body })
        : null;
      if (pluginSurface && (!options.caller || !publisherHeader)) {
        return failure('plugin_webhook_publisher_proof_unavailable');
      }
      options.signal?.throwIfAborted();
      const response = await axios.request({
        url: `${resolveServerHttpBaseUrl()}${path}`,
        method,
        data: body,
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
    const pluginSurface = isPluginWebhookPluginSurfaceActionIdV1(args.actionId);
    if ((pluginSurface && args.caller.kind !== 'plugin') || (!pluginSurface && args.caller.kind !== 'host')) {
      return failure('plugin_webhook_caller_surface_mismatch');
    }
    let caller: PluginMachineMaterializationRefV1 | undefined;
    if (pluginSurface) {
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

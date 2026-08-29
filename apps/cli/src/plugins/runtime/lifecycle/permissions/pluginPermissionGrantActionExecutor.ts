import axios from 'axios';

import {
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginMachineMaterializationRefV1Schema,
  PluginPermissionGrantActionInputSchemasV1,
  PluginPermissionGrantActionOutputSchemasV1,
  type ActionExecutorDeps,
  type PluginMachineMaterializationRefV1,
  type PluginPermissionGrantListActionInputV1,
  type PluginPermissionGrantListActionOutputV1,
  type PluginPermissionGrantRequestActionInputV1,
  type PluginPermissionGrantRequestActionOutputV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { RevalidatePluginActionCallerMaterialization } from '@/plugins/runtime/invocation/services/actionCaller';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

import { createServerPluginPermissionGrantListReader } from './pluginPermissionGrantListReader';
import { createServerPluginPermissionGrantRequester } from './pluginPermissionGrantRequester';

type ExecutePluginPermissionGrantAction = NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']>;
type ExecutePluginPermissionGrantActionArgs = Parameters<ExecutePluginPermissionGrantAction>[0];

export type PluginPermissionGrantActionTransport = Readonly<{
  list(
    input: PluginPermissionGrantListActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginPermissionGrantListActionOutputV1>;
  request(
    input: PluginPermissionGrantRequestActionInputV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<PluginPermissionGrantRequestActionOutputV1>;
  mutate(
    actionId: 'plugins.permissions.grants.grant' | 'plugins.permissions.grants.revoke' | 'plugins.permissions.grants.dismissRequest',
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}>;

const MUTATION_PATHS = Object.freeze({
  'plugins.permissions.grants.grant': '/v1/plugins/permissions/grants/grant',
  'plugins.permissions.grants.revoke': '/v1/plugins/permissions/grants/revoke',
  'plugins.permissions.grants.dismissRequest': '/v1/plugins/permissions/grants/dismissRequest',
} as const);

function createDefaultTransport(credentials: StoredCredentials): PluginPermissionGrantActionTransport {
  const list = createServerPluginPermissionGrantListReader({ credentials });
  const requester = createServerPluginPermissionGrantRequester({ credentials });
  // A caller-provenance request is only authoritative together with the
  // signed installation publisher proof over the exact same body; without the
  // machine key there is no proven caller and the call fails closed.
  const signCallerProvenance = async (
    path: string,
    body: unknown,
  ): Promise<Record<string, string>> => {
    const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
      method: 'POST',
      path,
      body,
    });
    if (!publisherHeader) throw new Error('plugin_permission_grant_publisher_proof_unavailable');
    return { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader };
  };
  return Object.freeze({
    list: list.list,
    request: requester.request,
    async mutate(actionId, input, options = {}) {
      const body = PluginPermissionGrantActionInputSchemasV1[actionId].parse(input);
      const path = MUTATION_PATHS[actionId];
      const proofHeaders = 'caller' in body && body.caller
        ? await signCallerProvenance(path, body)
        : {};
      const response = await axios.post(
        `${resolveServerHttpBaseUrl()}${path}`,
        body,
        {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${credentials.token}`,
            ...proofHeaders,
          },
          timeout: configuration.sessionControlHttpTimeoutMs,
          validateStatus: (status) => status >= 200 && status < 300,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      return PluginPermissionGrantActionOutputSchemasV1[actionId].parse(response.data);
    },
  });
}

function failure(errorCode: string): Readonly<{
  ok: false;
  errorCode: string;
  error: string;
}> {
  return { ok: false, errorCode, error: errorCode };
}

/**
 * Resolves the host-stamped exact materialization for a plugin caller. Grant
 * decisions are enforced server-side against this provenance; the caller
 * string alone never carries it.
 */
async function resolveExactCallerMaterialization(params: Readonly<{
  caller: ExecutePluginPermissionGrantActionArgs['caller'] | undefined;
  revalidateCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
}>): Promise<PluginMachineMaterializationRefV1 | null> {
  const caller = params.caller;
  if (!caller || caller.kind !== 'plugin') return null;
  const materialization = PluginMachineMaterializationRefV1Schema.safeParse(caller.materialization);
  if (!materialization.success || materialization.data.pluginId !== caller.pluginId) {
    return null;
  }
  if (!params.revalidateCallerMaterialization) return null;
  let current = false;
  try {
    current = await params.revalidateCallerMaterialization(materialization.data);
  } catch {
    current = false;
  }
  return current ? materialization.data : null;
}

export function createPluginPermissionGrantActionExecutor(params: Readonly<{
  credentials: StoredCredentials;
  transport?: PluginPermissionGrantActionTransport;
  revalidateCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
}>): ExecutePluginPermissionGrantAction {
  const transport = params.transport ?? createDefaultTransport(params.credentials);
  return async (args) => {
    const options = args.signal ? { signal: args.signal } : {};
    if (args.caller.kind === 'plugin') {
      const callerRef = await resolveExactCallerMaterialization({
        caller: args.caller,
        revalidateCallerMaterialization: params.revalidateCallerMaterialization,
      });
      if (!callerRef) {
        return failure('plugin_permission_grant_caller_materialization_unavailable');
      }
      if (args.actionId === 'plugins.permissions.grants.list') {
        if (
          args.input.pluginId !== undefined
          && args.input.pluginId !== args.caller.pluginId
        ) {
          return failure('plugin_permission_grant_caller_mismatch');
        }
        return await transport.list({ ...args.input, caller: callerRef }, options);
      }
      if (args.actionId === 'plugins.permissions.grants.request') {
        if (
          args.input.pluginId !== args.caller.pluginId
          || args.input.requester.kind !== 'plugin'
          || args.input.requester.pluginId !== args.caller.pluginId
        ) {
          return failure('plugin_permission_grant_caller_mismatch');
        }
        return await transport.request({ ...args.input, caller: callerRef }, options);
      }
      if (args.actionId === 'plugins.permissions.grants.revoke') {
        // Grant ownership is enforced atomically server-side against the
        // proven exact caller; no client-side ownership pre-read is trusted.
        return await transport.mutate(
          args.actionId,
          { ...args.input, caller: callerRef },
          options,
        );
      }
      return await transport.mutate(args.actionId, args.input, options);
    }
    if (args.actionId === 'plugins.permissions.grants.list') {
      return await transport.list(args.input, options);
    }
    if (args.actionId === 'plugins.permissions.grants.request') {
      return failure('plugin_permission_grant_publisher_proof_required');
    }
    return await transport.mutate(args.actionId, args.input, options);
  };
}

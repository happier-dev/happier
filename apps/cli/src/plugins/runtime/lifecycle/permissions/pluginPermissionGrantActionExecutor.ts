import axios from 'axios';

import type {
  ActionExecutorDeps,
  PluginPermissionGrantListActionInputV1,
  PluginPermissionGrantListActionOutputV1,
  PluginPermissionGrantRequestActionInputV1,
  PluginPermissionGrantRequestActionOutputV1,
} from '@happier-dev/protocol';
import {
  PluginPermissionGrantActionInputSchemasV1,
  PluginPermissionGrantActionOutputSchemasV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

import { createServerPluginPermissionGrantListReader } from './pluginPermissionGrantListReader';
import { createServerPluginPermissionGrantRequester } from './pluginPermissionGrantRequester';

type ExecutePluginPermissionGrantAction = NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']>;

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
  return Object.freeze({
    list: list.list,
    request: requester.request,
    async mutate(actionId, input, options = {}) {
      const body = PluginPermissionGrantActionInputSchemasV1[actionId].parse(input);
      const response = await axios.post(
        `${resolveServerHttpBaseUrl()}${MUTATION_PATHS[actionId]}`,
        body,
        {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            Authorization: `Bearer ${credentials.token}`,
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

export function createPluginPermissionGrantActionExecutor(params: Readonly<{
  credentials: StoredCredentials;
  transport?: PluginPermissionGrantActionTransport;
}>): ExecutePluginPermissionGrantAction {
  const transport = params.transport ?? createDefaultTransport(params.credentials);
  return async (args) => {
    const options = args.signal ? { signal: args.signal } : {};
    if (args.actionId === 'plugins.permissions.grants.list') {
      if (
        args.caller.kind === 'plugin'
        && args.input.pluginId !== args.caller.pluginId
      ) {
        return failure('plugin_permission_grant_caller_mismatch');
      }
      return await transport.list(args.input, options);
    }
    if (args.actionId === 'plugins.permissions.grants.request') {
      if (
        args.caller.kind === 'plugin'
        && (
          args.input.pluginId !== args.caller.pluginId
          || args.input.requester.kind !== 'plugin'
          || args.input.requester.pluginId !== args.caller.pluginId
        )
      ) {
        return failure('plugin_permission_grant_caller_mismatch');
      }
      return await transport.request(args.input, options);
    }
    if (args.actionId === 'plugins.permissions.grants.revoke' && args.caller.kind === 'plugin') {
      const owned = await transport.list({
        pluginId: args.caller.pluginId,
        grantId: args.input.grantId,
        includeRevoked: true,
        includeResolvedRequests: false,
        limit: 1,
      }, options);
      if (!owned.grants.some((grant) => grant.id === args.input.grantId)) {
        return failure('plugin_permission_grant_not_owned');
      }
    }
    return await transport.mutate(args.actionId, args.input, options);
  };
}

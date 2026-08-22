import axios from 'axios';

import {
  AutomationConversationActionHttpPathsV1,
  AutomationConversationActionHttpRequestSchemasV1,
  AutomationConversationActionInputSchemasV1,
  AutomationConversationActionOutputSchemasV1,
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  PluginMachineMaterializationRefV1Schema,
  type ActionExecutorDeps,
  type AutomationConversationActionIdV1,
  type PluginMachineMaterializationRefV1,
} from '@happier-dev/protocol';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { configuration } from '@/configuration';
import { createDefaultPluginInstallationPublisherHeader } from '@/plugins/installations/publisherProof';
import type { StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

type ExecuteAutomationConversationAction = NonNullable<ActionExecutorDeps['automationConversationAction']>;

type AutomationConversationActionCallerFrame = Readonly<{
  pluginId: string;
  contributionLocalId: string;
  materialization: PluginMachineMaterializationRefV1;
}>;

export type AutomationConversationActionTransport = Readonly<{
  execute(
    actionId: AutomationConversationActionIdV1,
    input: unknown,
    options: Readonly<{
      caller: AutomationConversationActionCallerFrame;
      signal?: AbortSignal;
    }>,
  ): Promise<unknown>;
}>;

function failure(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function createDefaultTransport(credentials: StoredCredentials): AutomationConversationActionTransport {
  return Object.freeze({
    async execute(actionId, rawInput, options) {
      options.signal?.throwIfAborted();
      const input = AutomationConversationActionInputSchemasV1[actionId].parse(rawInput);
      const path = AutomationConversationActionHttpPathsV1[actionId];
      const body = AutomationConversationActionHttpRequestSchemasV1[actionId].parse({
        v: 1,
        caller: options.caller,
        input,
      });
      const publisherHeader = await createDefaultPluginInstallationPublisherHeader({
        method: 'POST',
        path,
        body,
      });
      if (!publisherHeader) {
        return failure('automation_conversation_publisher_proof_unavailable');
      }
      options.signal?.throwIfAborted();
      const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${credentials.token}`,
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
        },
        timeout: configuration.sessionControlHttpTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return AutomationConversationActionOutputSchemasV1[actionId].parse(response.data);
    },
  });
}

/**
 * CLI binding for the Automation conversation Action. The host stamps its
 * current plugin contribution and materialization; the payload cannot
 * select the delivery target or impersonate that caller frame.
 */
export function createAutomationConversationActionExecutor(params: Readonly<{
  credentials: StoredCredentials;
  transport?: AutomationConversationActionTransport;
}>): ExecuteAutomationConversationAction {
  const transport = params.transport ?? createDefaultTransport(params.credentials);

  return async (args) => {
    const contributionLocalId = args.caller.contributionLocalId;
    if (typeof contributionLocalId !== 'string' || contributionLocalId.trim().length === 0) {
      return failure('automation_conversation_caller_contribution_unavailable');
    }
    const materialization = PluginMachineMaterializationRefV1Schema.safeParse(
      args.caller.materialization,
    );
    if (!materialization.success || materialization.data.pluginId !== args.caller.pluginId) {
      return failure('automation_conversation_caller_materialization_unavailable');
    }
    return await transport.execute(args.actionId, args.input, {
      caller: {
        pluginId: args.caller.pluginId,
        contributionLocalId,
        materialization: materialization.data,
      },
      ...(args.signal ? { signal: args.signal } : {}),
    });
  };
}

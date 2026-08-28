import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionMediaService } from '@happier-dev/plugin-sdk/sessions';
import type {
  AgentAcpRuntimeOptions,
  AgentRuntimeContext,
  AgentSessionHostServices,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { McpServerConfig } from '@/agent/core/AgentTypes';
import type { AcpReplayHistorySessionClient } from '@/agent/acp/sessionClient';
import type { HostCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import {
  resolvePluginExecManagedDependencyForHost,
  resolvePluginExecSystemToolForHost,
} from '@/plugins/runtime/invocation/services/exec';

import {
  createPublicAcpSession,
  type PublicAcpManagedDependencies,
  type PublicAcpSystemTools,
} from './createPublicAcpSession';

function createPublicAcpSystemTools(
  services: PluginServices,
  pluginId: string,
): PublicAcpSystemTools {
  return Object.freeze({
    async resolve(request) {
      const resolved = await resolvePluginExecSystemToolForHost(services.exec, request);
      const executable = resolved.executable;
      const localId = executable.kind === 'systemTool'
        ? typeof executable.id === 'string'
          ? executable.id
          : executable.id.pluginId === pluginId
            ? executable.id.localId
            : null
        : null;
      if (executable.kind !== 'systemTool' || localId !== request.toolId) {
        throw new PluginError({
          code: 'plugin_exec_system_tool_resolution_invalid',
          message: `ACP system tool '${request.toolId}' did not resolve to its exact declared executable`,
        });
      }
      return Object.freeze({
        toolId: request.toolId,
        launch: Object.freeze({
          kind: 'binary',
          executablePath: resolved.command,
          ...(resolved.args ? { args: resolved.args } : {}),
          ...(resolved.env ? { env: resolved.env } : {}),
        }),
      });
    },
  });
}

function createPublicAcpManagedDependencies(
  services: PluginServices,
  pluginId: string,
): PublicAcpManagedDependencies {
  return Object.freeze({
    async resolve(request) {
      if (request.pluginId !== pluginId) {
        throw new PluginError({
          code: 'plugin_exec_managed_dependency_denied',
          message: 'ACP managed-dependency resolution cannot cross plugin identity',
        });
      }
      return await resolvePluginExecManagedDependencyForHost(
        services.exec,
        request.dependencyId,
        { signal: request.signal },
      );
    },
  });
}

function createPublicInteractionsAdapter(
  services: PluginServices,
): HostCurrentSessionInteractionsService {
  return Object.freeze({
    request: (async (request, options) => {
      const cancellation = options?.signal ? { signal: options.signal } : undefined;
      if (request.kind === 'approval') {
        return await services.interactions.requestApproval(request, cancellation);
      }
      if (request.kind === 'questions') {
        return await services.interactions.askQuestions(request, cancellation);
      }
      return await services.interactions.confirm(request, cancellation);
    }) as HostCurrentSessionInteractionsService['request'],
  });
}

function createUnavailableMedia(): SessionMediaService {
  return Object.freeze({
    async registerSourceRoot(): Promise<never> {
      throw new PluginError({
        code: 'agent_acp_media_unavailable',
        message: 'ACP generated-media publication requires a bound host Session',
      });
    },
  });
}

// Execution Runs have no interactive Session model publication target. The ACP
// runtime still owns its provider model state; this only declines that projection.
const UNBOUND_MODELS: AgentSessionHostServices['models'] = Object.freeze({
  bind: () => Object.freeze({ dispose() {} }),
});

export function createPublicAcpRuntimeProtocols(params: Readonly<{
  pluginId: string;
  agentId: string;
  signal: AbortSignal;
  isCurrent(): boolean;
  services: PluginServices;
  interactions?: HostCurrentSessionInteractionsService;
  media?: SessionMediaService;
  models?: AgentSessionHostServices['models'];
  resumeHistorySession?: AcpReplayHistorySessionClient;
  mcpServers?: Record<string, McpServerConfig>;
  transformAgentChildLaunchEnvironment?: (
    environment: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>;
  transformAgentRequest?: (
    payload: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal: AbortSignal }>,
  ) => Promise<Readonly<Record<string, unknown>>>;
}>): AgentRuntimeContext['protocols'] {
  return Object.freeze({
    acp: Object.freeze({
      async open(request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) {
        return await createPublicAcpSession(request, options, {
          pluginId: params.pluginId,
          agentId: params.agentId,
          signal: params.signal,
          isCurrent: params.isCurrent,
          systemTools: createPublicAcpSystemTools(params.services, params.pluginId),
          managedDependencies: createPublicAcpManagedDependencies(params.services, params.pluginId),
          interactions: params.interactions ?? createPublicInteractionsAdapter(params.services),
          media: params.media ?? params.services.sessions.current?.media ?? createUnavailableMedia(),
          models: params.models ?? UNBOUND_MODELS,
          ...(params.resumeHistorySession ? { resumeHistorySession: params.resumeHistorySession } : {}),
          ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
          ...(params.transformAgentChildLaunchEnvironment
            ? { transformAgentChildLaunchEnvironment: params.transformAgentChildLaunchEnvironment }
            : {}),
          ...(params.transformAgentRequest ? { transformAgentRequest: params.transformAgentRequest } : {}),
        });
      },
    }),
  });
}

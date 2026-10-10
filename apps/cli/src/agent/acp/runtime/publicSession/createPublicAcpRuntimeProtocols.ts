import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionMediaService } from '@happier-dev/plugin-sdk/sessions';
import type {
  AgentAcpRuntimeOptions,
  AgentAcpRuntimeDefinition,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeContext,
  AgentSessionHostServices,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { AcpReplayHistorySessionClient, AcpReplaySidechainSessionClient } from '@/agent/acp/sessionClient';
import type { HostCurrentSessionInteractionsService } from '@/agent/runtime/state/currentSessionUiTypes';
import {
  createPublicAcpManagedDependencies,
  createPublicAcpSystemTools,
} from '@/agent/acp/runtime/launch/acpTransportLaunch';

import {
  createPublicAcpExecutionRun,
  createPublicAcpSession,
  type PublicAcpComposerDependencies,
  type PublicAcpHostLaunchResolver,
} from './createPublicAcpSession';

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

// Execution Runs have no interactive Session catalog publication target. The ACP
// runtime still owns its provider model and mode state; these decline that projection.
const UNBOUND_MODELS: AgentSessionHostServices['models'] = Object.freeze({
  bind: () => Object.freeze({ dispose() {} }),
});

const UNBOUND_MODES: AgentSessionHostServices['modes'] = Object.freeze({
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
  modes?: AgentSessionHostServices['modes'];
  resumeHistorySession?: AcpReplayHistorySessionClient;
  sidechainSession?: AcpReplaySidechainSessionClient;
  mcpServers?: AgentSessionOpenRequest['mcpServers'];
  transformAgentChildLaunchEnvironment?: (
    environment: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>;
  transformAgentRequest?: (
    payload: Readonly<Record<string, unknown>>,
    options: Readonly<{ signal: AbortSignal }>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  /** Host-only executable custody for Account-configured ACP. */
  resolveHostLaunch?: PublicAcpHostLaunchResolver;
  /** Definition-local behavior admitted by the canonical Account catalog. */
  runtimeDefinition?: AgentAcpRuntimeDefinition;
}>): AgentRuntimeContext['protocols'] {
  const createDependencies = (scope: 'session' | 'execution_run'): PublicAcpComposerDependencies => ({
    pluginId: params.pluginId,
    agentId: params.agentId,
    signal: params.signal,
    isCurrent: params.isCurrent,
    systemTools: createPublicAcpSystemTools(params.services.exec, params.pluginId),
    managedDependencies: createPublicAcpManagedDependencies(params.services.exec, params.pluginId),
    interactions: params.interactions ?? createPublicInteractionsAdapter(params.services),
    media: scope === 'session'
      ? params.media ?? params.services.sessions.current?.media ?? createUnavailableMedia()
      : createUnavailableMedia(),
    models: scope === 'session' ? params.models ?? UNBOUND_MODELS : UNBOUND_MODELS,
    modes: scope === 'session' ? params.modes ?? UNBOUND_MODES : UNBOUND_MODES,
    ...(scope === 'session' && params.sidechainSession ? { sidechainSession: params.sidechainSession } : {}),
    ...(scope === 'session' && params.resumeHistorySession
      ? { resumeHistorySession: params.resumeHistorySession }
      : {}),
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.transformAgentChildLaunchEnvironment
      ? { transformAgentChildLaunchEnvironment: params.transformAgentChildLaunchEnvironment }
      : {}),
    ...(params.transformAgentRequest ? { transformAgentRequest: params.transformAgentRequest } : {}),
    ...(params.resolveHostLaunch ? { resolveHostLaunch: params.resolveHostLaunch } : {}),
  });
  return Object.freeze({
    acp: Object.freeze({
      async open(request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) {
        return await createPublicAcpSession(request,
          params.runtimeDefinition ? { ...options, definition: params.runtimeDefinition } : options,
          createDependencies('session'));
      },
      async openExecutionRunV1(
        request: AgentExecutionRunOpenRequest,
        options: AgentAcpRuntimeOptions,
      ): Promise<AgentExecutionRunRuntime> {
        return await createPublicAcpExecutionRun(request,
          params.runtimeDefinition ? { ...options, definition: params.runtimeDefinition } : options,
          createDependencies('execution_run'));
      },
    }),
  });
}

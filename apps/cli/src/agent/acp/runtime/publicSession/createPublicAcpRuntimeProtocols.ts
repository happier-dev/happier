import { PluginError, type PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionMediaService } from '@happier-dev/plugin-sdk/sessions';
import type {
  AgentAcpRuntimeOptions,
  AgentAcpRuntimeDefinition,
  AgentExecutionRunConversationRuntimeV1,
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

import type {
  PublicAcpComposerDependencies,
  PublicAcpHostLaunchResolver,
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
  /** Reports the selected concrete transport before the Session handshake. */
  onSessionOpening?: () => void;
  services: PluginServices;
  nativeLaunch?: PublicAcpComposerDependencies['nativeLaunch'];
  interactions?: HostCurrentSessionInteractionsService;
  media?: SessionMediaService;
  models?: AgentSessionHostServices['models'];
  modes?: AgentSessionHostServices['modes'];
  transcripts?: PublicAcpComposerDependencies['transcripts'];
  planWorkState?: () => NonNullable<PublicAcpComposerDependencies['planWorkState']>;
  titleSession?: PublicAcpComposerDependencies['titleSession'];
  resumeHistorySession?: AcpReplayHistorySessionClient;
  sidechainSession?: AcpReplaySidechainSessionClient;
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
  /** Saved native selections apply only when creating a Session without an override. */
  configurationDefaults?: Readonly<{ mode?: string; model?: string }>;
}>): AgentRuntimeContext['protocols'] {
  const createDependencies = (scope: 'session' | 'execution_run'): PublicAcpComposerDependencies => ({
    pluginId: params.pluginId,
    agentId: params.agentId,
    signal: params.signal,
    isCurrent: params.isCurrent,
    exec: params.services.exec,
    ...(params.nativeLaunch ? { nativeLaunch: params.nativeLaunch } : {}),
    systemTools: createPublicAcpSystemTools(params.services.exec, params.pluginId),
    managedDependencies: createPublicAcpManagedDependencies(params.services.exec, params.pluginId),
    interactions: params.interactions ?? createPublicInteractionsAdapter(params.services),
    media: scope === 'session'
      ? params.media ?? params.services.sessions.current?.media ?? createUnavailableMedia()
      : createUnavailableMedia(),
    models: scope === 'session' ? params.models ?? UNBOUND_MODELS : UNBOUND_MODELS,
    modes: scope === 'session' ? params.modes ?? UNBOUND_MODES : UNBOUND_MODES,
    ...(scope === 'session' && params.transcripts ? { transcripts: params.transcripts } : {}),
    ...(scope === 'session' && params.planWorkState ? { planWorkState: params.planWorkState() } : {}),
    ...(scope === 'session' && params.titleSession ? { titleSession: params.titleSession } : {}),
    ...(scope === 'session' && params.sidechainSession ? { sidechainSession: params.sidechainSession } : {}),
    ...(scope === 'session' && params.resumeHistorySession
      ? { resumeHistorySession: params.resumeHistorySession }
      : {}),
    ...(params.transformAgentChildLaunchEnvironment
      ? { transformAgentChildLaunchEnvironment: params.transformAgentChildLaunchEnvironment }
      : {}),
    ...(params.transformAgentRequest ? { transformAgentRequest: params.transformAgentRequest } : {}),
    ...(params.resolveHostLaunch ? { resolveHostLaunch: params.resolveHostLaunch } : {}),
  });
  return Object.freeze({
    acp: Object.freeze({
      async open(request: AgentSessionOpenRequest, options: AgentAcpRuntimeOptions) {
        params.onSessionOpening?.();
        const defaults = params.configurationDefaults;
        const configuration = request.configuration;
        const openRequest = request.kind === 'create' && defaults
          ? { ...request, configuration: {
            ...configuration,
            mode: configuration?.mode?.value == null && defaults.mode
              ? { value: defaults.mode, updatedAtMs: 0 }
              : configuration?.mode ?? { value: null, updatedAtMs: 0 },
            model: configuration?.model?.value == null && defaults.model
              ? { value: defaults.model, updatedAtMs: 0 }
              : configuration?.model ?? { value: null, updatedAtMs: 0 },
            permissionIntent: configuration?.permissionIntent ?? { value: null, updatedAtMs: 0 },
            options: configuration?.options ?? {},
          } }
          : request;
        const { createPublicAcpSession } = await import('./createPublicAcpSession');
        return await createPublicAcpSession(openRequest,
          params.runtimeDefinition ? { ...options, definition: params.runtimeDefinition } : options,
          createDependencies('session'));
      },
      async openExecutionRunV1(
        request: AgentExecutionRunOpenRequest,
        options: AgentAcpRuntimeOptions,
      ): Promise<AgentExecutionRunRuntime> {
        params.onSessionOpening?.();
        const { createPublicAcpExecutionRun } = await import('./createPublicAcpSession');
        return await createPublicAcpExecutionRun(request,
          params.runtimeDefinition ? { ...options, definition: params.runtimeDefinition } : options,
          createDependencies('execution_run'));
      },
      async openExecutionRunConversationV1(
        request: AgentExecutionRunOpenRequest,
        options: AgentAcpRuntimeOptions,
      ): Promise<AgentExecutionRunConversationRuntimeV1> {
        params.onSessionOpening?.();
        const { createPublicAcpExecutionRunConversation } = await import('./createPublicAcpSession');
        return await createPublicAcpExecutionRunConversation(request,
          params.runtimeDefinition ? { ...options, definition: params.runtimeDefinition } : options,
          createDependencies('execution_run'));
      },
    }),
  });
}

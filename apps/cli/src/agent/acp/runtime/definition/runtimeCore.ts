import React from 'react';

import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createCatalogProviderExecutionRunBackend } from '@/agent/executionRuns/runtime/backends/catalogProvider';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type {
  CliEngineAdapter,
  CliRuntimeBindings,
} from '@/agent/runtime/registry/engineRegistryTypes';
import { BuiltInAcpTerminalDisplay } from '@/agent/acp/catalog/builtIn/ui/TerminalDisplay';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/sessionLoop/catalogPlan';
import type {
  HostSessionRuntimeConfig,
  HostSessionRuntimeRunOptions,
} from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { createCatalogProviderSessionIdentityRuntime } from '@/agent/acp/runtime/createProviderSessionIdentityRuntime';
import type { AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';
import type {
  AgentMessageHandler,
  McpServerConfig,
  SessionId,
} from '@/agent/core';

import type {
  AcpRuntimeDefinitionInitV1,
  AcpRuntimeDefinitionV1,
} from './_types';
import { mergeDefinedStringEnv, resolveAcpRuntimeLaunch } from './launch';
import { createProviderMessageMetaEnricher } from './messageMeta';
import { createAcpTransportHandlerFromDefinition } from './transport';

export {
  resolveAcpRuntimeLaunch,
} from './launch';
export {
  assertAcpRuntimeDefinitionSupported,
} from './support';
export {
  createAcpTransportHandlerFromDefinition,
} from './transport';

export function createAcpRuntimeDefinition(
  init: AcpRuntimeDefinitionInitV1,
): AcpRuntimeDefinitionV1 {
  return Object.freeze({
    backendId: init.backendId,
    source: Object.freeze(init.source),
    identity: Object.freeze({
      ...(init.identity?.agentId ? { agentId: init.identity.agentId } : {}),
      backendId: init.identity?.backendId ?? init.backendId,
    }),
    engine: Object.freeze({
      kind: 'acp' as const,
    }),
    ux: Object.freeze(init.ux),
    transport: init.transport,
    launchEnv: Object.freeze({ ...(init.launchEnv ?? {}) }),
    capabilities: Object.freeze({ ...(init.capabilities ?? {}) }),
    ...(init.timeouts ? { timeouts: Object.freeze({ ...init.timeouts }) } : {}),
    ...(init.auth ? { auth: init.auth } : {}),
    ...(typeof init.fsEnabled === 'boolean' ? { fsEnabled: init.fsEnabled } : {}),
    ...(init.transportLifecycle ? { transportLifecycle: init.transportLifecycle } : {}),
    ...(init.permissionModeArgv ? { permissionModeArgv: init.permissionModeArgv } : {}),
    ...(init.sessionIdHeaderName ? { sessionIdHeaderName: init.sessionIdHeaderName } : {}),
    ...(init.bootstrap ? { bootstrap: init.bootstrap } : {}),
    ...(init.messageMeta ? { messageMeta: init.messageMeta } : {}),
    mcp: Object.freeze(init.mcp ?? {
      policy: 'pass_through',
    }),
    callbacks: Object.freeze({ ...(init.callbacks ?? {}) }),
  });
}

function adaptAcpBackendToRuntimeBackend(
  backend: ReturnType<typeof createAcpBackend>,
): AcpRuntimeBackend {
  const adapted: AcpRuntimeBackend = {
    startSession: (initialPrompt?: string) => backend.startSession(initialPrompt),
    loadSession: (sessionId: SessionId) => backend.loadSession(sessionId),
    loadSessionWithReplayCapture: (sessionId: SessionId) => backend.loadSessionWithReplayCapture(sessionId),
    sendPrompt: (sessionId: SessionId, prompt: string) => backend.sendPrompt(sessionId, prompt),
    sendSteerPrompt: (sessionId: SessionId, prompt: string) => backend.sendSteerPrompt(sessionId, prompt),
    cancel: (sessionId: SessionId) => backend.cancel(sessionId),
    onMessage: (handler: AgentMessageHandler) => backend.onMessage(handler),
    offMessage: (handler: AgentMessageHandler) => backend.offMessage(handler),
    waitForResponseComplete: (timeoutMs?: number | null) => backend.waitForResponseComplete(timeoutMs),
    dispose: () => backend.dispose(),
    setSessionMode: (sessionId: string, modeId: string) => backend.setSessionMode(sessionId, modeId),
    setSessionModel: (sessionId: string, modelId: string) => backend.setSessionModel(sessionId, modelId),
    setSessionConfigOption: (sessionId: string, configId: string, value: string | number | boolean | null) => {
      if (value === null) {
        return Promise.resolve(undefined);
      }
      return backend.setSessionConfigOption(sessionId, configId, String(value));
    },
  };
  return Object.freeze(adapted);
}

function createBackendFromDefinition(params: Readonly<{
  definition: AcpRuntimeDefinitionV1;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
}>): AcpRuntimeBackend {
  const launch = resolveAcpRuntimeLaunch({
    definition: params.definition,
    cwd: params.cwd,
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.env ? { env: params.env } : {}),
  });
  const mcpServers = params.definition.mcp.policy === 'drop'
    ? undefined
    : params.mcpServers;

  const backend = createAcpBackend({
    agentName: params.definition.backendId,
    cwd: params.cwd,
    command: launch.command,
    args: [...launch.args],
    env: mergeDefinedStringEnv(params.env, launch.env),
    ...(mcpServers ? { mcpServers } : {}),
    ...(params.permissionHandler ? { permissionHandler: params.permissionHandler } : {}),
    ...(typeof params.definition.fsEnabled === 'boolean' ? { fsEnabled: params.definition.fsEnabled } : {}),
    transportHandler: createAcpTransportHandlerFromDefinition(params.definition),
  });
  return adaptAcpBackendToRuntimeBackend(backend);
}

function createSessionRuntimePlan(
  definition: AcpRuntimeDefinitionV1,
  sessionParams: unknown,
) {
  const opts = sessionParams as HostSessionRuntimeRunOptions;
  const TerminalDisplay: HostSessionRuntimeConfig['terminalDisplay'] = (props) =>
    React.createElement(BuiltInAcpTerminalDisplay, {
      ...props,
      title: definition.ux.title,
    });

  return createCatalogHostSessionRuntimePlan({
    providerId: definition.backendId,
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: definition.backendId,
      config: {
        flavor: definition.backendId,
        policyAgentId: definition.identity.agentId ?? definition.backendId,
        displayName: definition.ux.title,
        terminalDisplay: TerminalDisplay,
        createNativeRuntime: ({
          directory,
          machineId,
          session,
          transcriptSession,
          messageBuffer,
          mcpServers,
          permissionHandler,
          setThinking,
          getPermissionMode,
          memoryRecallGuidanceEnabled,
        }) => createCatalogProviderSessionIdentityRuntime({
          provider: definition.backendId,
          loggerLabel: `${definition.ux.title}ACP`,
          directory,
          machineId,
          session,
          transcriptSession,
          messageBuffer,
          mcpServers,
          permissionHandler,
          onThinkingChange: setThinking,
          memoryRecallGuidanceEnabled,
          getPermissionMode,
          createBackend: () => createBackendFromDefinition({
            definition,
            cwd: directory,
            mcpServers,
            permissionHandler,
            permissionMode: getPermissionMode(),
          }),
        }),
        attachMetadataLogLabel: definition.backendId,
        formatPromptErrorMessage: formatProviderPromptErrorMessage,
      },
    }),
  });
}

export function createAcpRuntimeCoreFromDefinition(
  definition: AcpRuntimeDefinitionV1,
): CliEngineAdapter {
  const messageMeta = createProviderMessageMetaEnricher({
    backendId: definition.backendId,
    messageMeta: definition.messageMeta,
  });
  const bindings: CliRuntimeBindings = Object.freeze({
    async createSessionRuntime(sessionParams: unknown) {
      return createSessionRuntimePlan(definition, sessionParams);
    },
    createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams) {
      return createCatalogProviderExecutionRunBackend({
        providerId: definition.backendId,
        createRuntime: (runtimeOptions) => createBackendFromDefinition({
          definition,
          cwd: runtimeOptions.cwd,
          permissionMode: runtimeOptions.permissionMode,
          ...(runtimeOptions.env ? { env: runtimeOptions.env } : {}),
          ...(runtimeOptions.permissionHandler ? { permissionHandler: runtimeOptions.permissionHandler } : {}),
        }),
        buildRuntimeDescriptor: () => ({
          backendId: definition.backendId,
          runtimeKind: 'acp',
          source: definition.source.kind,
        }),
      }, opts);
    },
  });

  return Object.freeze({
    bindings,
    ...(messageMeta ? { messageMeta } : {}),
  });
}

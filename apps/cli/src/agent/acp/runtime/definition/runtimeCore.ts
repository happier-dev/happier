import React from 'react';
import type { ExecRuntimeServiceV1 } from '@/plugins/runtime/exec/privateContract';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';

import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { createCatalogProviderExecutionRunBackend } from '@/agent/runtime/bridges/executionRun/runtime/catalog';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type {
  CliEngineAdapter,
  CliRuntimeCore,
} from '@/agent/runtime/registry/engineRegistryTypes';
import { BuiltInAcpTerminalDisplay } from '@/agent/acp/catalog/builtIn/ui/TerminalDisplay';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type {
  HostSessionRuntimeConfig,
  HostSessionRuntimeRunOptions,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  buildPluginHostSessionRuntimeOptions,
  buildPluginSessionBindingInput,
} from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createCatalogProviderSessionIdentityRuntime } from '@/agent/acp/runtime/createProviderSessionIdentityRuntime';
import type { AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';
import type {
  AgentMessageHandler,
  SessionId,
} from '@/agent/core/AgentMessage';
import type { McpServerConfig } from '@/agent/core/AgentTypes';

import type {
  AcpRuntimeDefinitionInit,
  AcpRuntimeDefinition,
} from './_types';
import { createAcpRuntimeDefinition } from './create';
import { resolveAcpRuntimeLaunch } from './launch';
import { createAcpBackendFromDefinition } from './backend';
import { createProviderMessageMetaEnricher } from './messageMeta';
import { createAcpTransportHandlerFromDefinition } from './transport';

export {
  createAcpRuntimeDefinition,
} from './create';
export {
  resolveAcpRuntimeLaunch,
} from './launch';
export {
  assertAcpRuntimeDefinitionSupported,
} from './support';
export {
  createAcpTransportHandlerFromDefinition,
} from './transport';

function adaptAcpBackendToRuntimeBackend(
  backend: Awaited<ReturnType<typeof createAcpBackendFromDefinition>>,
): AcpRuntimeBackend {
  const adapted: AcpRuntimeBackend = {
    startSession: () => backend.startSession(),
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

async function createRuntimeBackendFromDefinition(params: Readonly<{
  definition: AcpRuntimeDefinition;
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  unsetEnvKeys?: readonly string[];
  permissionMode?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  exec?: Pick<ExecRuntimeServiceV1, 'systemTools'>;
}>): Promise<AcpRuntimeBackend> {
  return adaptAcpBackendToRuntimeBackend(await createAcpBackendFromDefinition(params));
}

function resolveConfiguredAcpBackendIdFromSessionParams(
  definition: AcpRuntimeDefinition,
  opts: HostSessionRuntimeRunOptions,
): string | null {
  if (opts.backendTarget) {
    try {
      const target = readBackendTargetRefV2(opts.backendTarget);
      if (target.sourceKind === 'configured') {
        const configuredBackendId = (target.configuredBackendId ?? target.backendId).trim();
        if (configuredBackendId) return configuredBackendId;
      }
    } catch {
      return null;
    }
  }

  return definition.source.kind === 'account_configured'
    ? definition.backendId
    : null;
}

function createSessionRuntimePlan(
  definition: AcpRuntimeDefinition,
  sessionParams: unknown,
  options: Readonly<{
    exec?: Pick<ExecRuntimeServiceV1, 'systemTools'>;
  }>,
) {
  const opts: HostSessionRuntimeRunOptions = buildPluginHostSessionRuntimeOptions(
    buildPluginSessionBindingInput(sessionParams),
  );
  const configuredBackendId = resolveConfiguredAcpBackendIdFromSessionParams(definition, opts);
  const sessionFlavor = configuredBackendId ? `acp:${configuredBackendId}` : definition.backendId;
  const TerminalDisplay: HostSessionRuntimeConfig['terminalDisplay'] = (props) =>
    React.createElement(BuiltInAcpTerminalDisplay, {
      ...props,
      title: definition.ux.title,
    });

  return createCatalogHostSessionRuntimePlan({
    agentId: definition.backendId,
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      agentId: definition.backendId,
      config: {
        flavor: sessionFlavor,
        agentMessageType: sessionFlavor,
        policyAgentId: definition.identity.agentId ?? definition.backendId,
        displayName: definition.ux.title,
        terminalDisplay: TerminalDisplay,
        ...(configuredBackendId
          ? {
              augmentSessionMetadata: (metadata) => ({
                ...metadata,
                flavor: sessionFlavor,
                ...buildConfiguredAcpBackendSessionMetadata({
                  backendId: configuredBackendId,
                  title: definition.ux.title,
                }),
              }),
            }
          : {}),
        createNativeRuntime: async ({
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
        }) => {
          const runtime = createCatalogProviderSessionIdentityRuntime({
            provider: definition.backendId,
            transcriptProvider: sessionFlavor,
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
            sessionOpenIntent: typeof opts.resume === 'string' && opts.resume.trim().length > 0
              ? {
                  kind: 'resume',
                  providerSessionId: opts.resume.trim(),
                  importHistory: false,
                }
              : { kind: 'create' },
            createBackend: () => createRuntimeBackendFromDefinition({
              definition,
              cwd: directory,
              ...(opts.environmentVariables ? { env: opts.environmentVariables } : {}),
              ...(opts.unsetEnvironmentVariables ? { unsetEnvKeys: opts.unsetEnvironmentVariables } : {}),
              mcpServers,
              permissionHandler,
              permissionMode: getPermissionMode(),
              ...(options.exec ? { exec: options.exec } : {}),
            }),
          });
          return runtime;
        },
        attachMetadataLogLabel: definition.backendId,
        formatPromptErrorMessage: formatProviderPromptErrorMessage,
      },
    }),
  });
}

export function createAcpRuntimeCoreFromDefinition(
  definition: AcpRuntimeDefinition,
  options: Readonly<{
    exec?: Pick<ExecRuntimeServiceV1, 'systemTools'>;
  }> = {},
): CliEngineAdapter {
  const messageMeta = createProviderMessageMetaEnricher({
    backendId: definition.backendId,
    messageMeta: definition.messageMeta,
  });
  const runtimeCore: CliRuntimeCore = Object.freeze({
    async createSessionRuntime(sessionParams: unknown) {
      return createSessionRuntimePlan(definition, sessionParams, options);
    },
	    createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams) {
	      return createCatalogProviderExecutionRunBackend({
	        agentId: definition.backendId,
	        createRuntime: (runtimeOptions) => createAcpBackendFromDefinition({
          definition,
          cwd: runtimeOptions.cwd,
          permissionMode: runtimeOptions.permissionMode,
          ...(runtimeOptions.env ? { env: runtimeOptions.env } : {}),
          ...(runtimeOptions.unsetEnvKeys ? { unsetEnvKeys: runtimeOptions.unsetEnvKeys } : {}),
          ...(runtimeOptions.permissionHandler ? { permissionHandler: runtimeOptions.permissionHandler } : {}),
          ...(options.exec ? { exec: options.exec } : {}),
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
    runtimeCore,
    ...(messageMeta ? { messageMeta } : {}),
  });
}

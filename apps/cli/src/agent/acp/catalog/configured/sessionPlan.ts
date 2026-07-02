import React from 'react';

import { configuration } from '@/configuration';
import type { AcpRuntimeBackend } from '@/agent/acp/runtime/createAcpRuntime';
import { createCatalogProviderSessionIdentityRuntime } from '@/agent/acp/runtime/createProviderSessionIdentityRuntime';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { BuiltInAcpTerminalDisplay } from '../builtIn/ui/TerminalDisplay';
import { buildConfiguredAcpBackendSessionMetadata } from './sessionMetadata';
import { resolveConfiguredAcpBackendStartupOverrides } from './startupOverrides';
import { resolveConfiguredAcpRuntimeOwner } from './configuredAcpRuntimeOwner';

export type ConfiguredAcpSessionRuntimePlanOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
  backendTarget: { kind: 'configuredAcpBackend'; backendId: string };
  happyHomeDir?: string;
};

export async function createConfiguredAcpSessionRuntimePlan(
  opts: ConfiguredAcpSessionRuntimePlanOptions,
) {
  const accountSettings = opts.accountSettingsContext?.settings as Readonly<Record<string, unknown>> | null | undefined;
  if (!accountSettings) {
    throw new Error('Configured ACP backends require account settings to be loaded');
  }
  const configuredAcpBackendId = opts.backendTarget.backendId.trim();
  if (configuredAcpBackendId.length === 0) {
    throw new Error('Configured ACP backends require a configured backend target');
  }

  const runtimeOwner = await resolveConfiguredAcpRuntimeOwner({
    credentials: opts.credentials,
    accountSettings,
    backendId: configuredAcpBackendId,
    happyHomeDir: opts.happyHomeDir ?? configuration.happyHomeDir,
  });
  const TerminalDisplay = (props: Readonly<{
    messageBuffer: MessageBuffer;
    logPath?: string;
    onExit?: () => void | Promise<void>;
  }>) => React.createElement(BuiltInAcpTerminalDisplay, {
    ...props,
    title: runtimeOwner.backend.title,
  });

  return createCatalogHostSessionRuntimePlan({
    providerId: runtimeOwner.providerId,
    opts: {
      ...opts,
      backendTarget: { kind: 'configuredAcpBackend', backendId: runtimeOwner.backend.backendId },
      ...resolveConfiguredAcpBackendStartupOverrides(opts, runtimeOwner.backend),
    },
    config: createCatalogHostSessionRuntimeConfig({
      providerId: runtimeOwner.providerId,
      config: {
        flavor: runtimeOwner.providerId,
        policyAgentId: runtimeOwner.providerId,
        displayName: runtimeOwner.backend.title,
        agentMessageType: runtimeOwner.providerId,
        terminalDisplay: TerminalDisplay,
        beforeInitializeSession: ({ metadata }) => {
          Object.assign(metadata, buildConfiguredAcpBackendSessionMetadata({
            backendId: runtimeOwner.backend.backendId,
            title: runtimeOwner.backend.title,
          }));
        },
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
          accountSettings,
          pendingQueueDrainMaxPopPerWake,
        }) => createCatalogProviderSessionIdentityRuntime({
          provider: runtimeOwner.providerId,
          loggerLabel: runtimeOwner.loggerLabel,
          directory,
          machineId,
          session,
          transcriptSession,
          messageBuffer,
          mcpServers,
          permissionHandler,
          onThinkingChange: setThinking,
          getPermissionMode,
          memoryRecallGuidanceEnabled,
          accountSettings,
          pendingQueueDrainMaxPopPerWake,
          createBackend: ({ permissionMode }) => runtimeOwner.createBackend({
            cwd: directory,
            mcpServers,
            permissionHandler,
            ...(permissionMode ? { permissionMode } : {}),
          }) as AcpRuntimeBackend,
        }),
        attachMetadataLogLabel: runtimeOwner.providerId,
        formatPromptErrorMessage: formatProviderPromptErrorMessage,
      },
    }),
  });
}

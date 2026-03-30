import React from 'react';

import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { CatalogDefinedAcpTerminalDisplay } from '../ui/CatalogDefinedAcpTerminalDisplay';
import { materializeConfiguredAcpEnvironment } from './materializeConfiguredAcpEnvironment';
import { resolveConfiguredAcpBackendFromAccountSettings } from './resolveConfiguredAcpBackendFromAccountSettings';
import { resolveConfiguredAcpBackendStartupOverrides } from './resolveConfiguredAcpBackendStartupOverrides';
import { createConfiguredAcpRuntime } from './createConfiguredAcpRuntime';
import { buildConfiguredAcpBackendSessionMetadata } from './buildConfiguredAcpBackendSessionMetadata';

export async function runConfiguredAcpBackend(
  opts: StandardAcpProviderRunOptions & {
    credentials: Credentials;
    permissionMode?: PermissionMode;
    configuredAcpBackendId: string;
  },
): Promise<void> {
  const accountSettings = opts.accountSettingsContext?.settings as Readonly<Record<string, unknown>> | null | undefined;
  if (!accountSettings) {
    throw new Error('Configured ACP backends require account settings to be loaded');
  }

  const backend = resolveConfiguredAcpBackendFromAccountSettings(accountSettings, opts.configuredAcpBackendId);
  if (!backend) {
    throw new Error(`Configured ACP backend not found: ${opts.configuredAcpBackendId}`);
  }

  const launchEnv = materializeConfiguredAcpEnvironment({
    backend,
    accountSettings,
    credentials: opts.credentials,
  });

  const TerminalDisplay = (props: Readonly<{
    messageBuffer: MessageBuffer;
    logPath?: string;
    onExit?: () => void | Promise<void>;
  }>) => React.createElement(CatalogDefinedAcpTerminalDisplay, { ...props, title: backend.title });

  await runStandardAcpProvider({
    ...opts,
    backendTarget: { kind: 'configuredAcpBackend', backendId: backend.backendId },
    ...resolveConfiguredAcpBackendStartupOverrides(opts, backend),
  }, {
    flavor: `acp:${backend.backendId}`,
    backendDisplayName: backend.title,
    uiLogPrefix: `[${backend.title}]`,
    providerName: backend.title,
    waitingForCommandLabel: backend.title,
    agentMessageType: `acp:${backend.backendId}`,
    machineMetadata: initialMachineMetadata,
    terminalDisplay: TerminalDisplay,
    beforeInitializeSession: ({ metadata }) => {
      Object.assign(metadata, buildConfiguredAcpBackendSessionMetadata({
        backendId: backend.backendId,
        title: backend.title,
      }));
    },
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled }) =>
      createConfiguredAcpRuntime({
        backend,
        loggerLabel: `${backend.title}ACP`,
        directory,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        launchEnv,
        onThinkingChange: setThinking,
        getPermissionMode,
        memoryRecallGuidance: {
          enabled: memoryRecallGuidanceEnabled,
          machineId,
        },
      }),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        `[acp:${backend.backendId}] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)`,
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}

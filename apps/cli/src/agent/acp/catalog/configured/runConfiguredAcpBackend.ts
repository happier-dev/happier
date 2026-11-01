import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';

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
    loadTerminalDisplay: async () => {
      const [{ default: React }, { CatalogDefinedAcpTerminalDisplay }] = await Promise.all([
        import('react'),
        import('../ui/CatalogDefinedAcpTerminalDisplay'),
      ]);
      return (props) => React.createElement(CatalogDefinedAcpTerminalDisplay, { ...props, title: backend.title });
    },
    // Same configured-backend declaration the ACP protocol owner enforces against the
    // negotiated handshake, so a backend that promises resume never silently starts fresh.
    declaredSessionLoadSupport: backend.capabilities.supportsLoadSession,
    beforeInitializeSession: ({ metadata }) => {
      Object.assign(metadata, buildConfiguredAcpBackendSessionMetadata({
        backendId: backend.backendId,
        title: backend.title,
      }));
    },
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled, processEnv, pendingQueueDrainMaxPopPerWake, providerInputConsumer }) =>
      createConfiguredAcpRuntime({
        backend,
        loggerLabel: `${backend.title}ACP`,
        directory,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        launchEnv,
        processEnv,
        onThinkingChange: setThinking,
        getPermissionMode,
        memoryRecallGuidance: {
          enabled: memoryRecallGuidanceEnabled,
          machineId,
        },
        pendingQueueDrainMaxPopPerWake,
        providerInputConsumer,
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

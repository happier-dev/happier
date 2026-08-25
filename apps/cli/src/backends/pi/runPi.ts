import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { createPiAcpRuntime } from '@/backends/pi/acp/runtime';
import { buildPiToolsForPermissionMode } from '@/backends/pi/acp/backend';
import { PiTerminalDisplay } from '@/backends/pi/ui/PiTerminalDisplay';
import { resolvePiToolsDeliveryAvailability } from '@/backends/pi/shellBridge/resolvePiShellBridgeAvailability';

export async function runPi(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
}): Promise<void> {
  await runStandardAcpProvider(opts, {
    flavor: 'pi',
    backendDisplayName: 'Pi',
    uiLogPrefix: '[Pi]',
    providerName: 'Pi',
    waitingForCommandLabel: 'Pi',
    agentMessageType: 'pi',
    supportsMcpServers: false,
    resolveToolsDeliveryAvailability: resolvePiToolsDeliveryAvailability,
    deliversSystemPromptAtSpawn: true,
    machineMetadata: initialMachineMetadata,
    terminalDisplay: PiTerminalDisplay,
    resolvePermissionModeQueueKey: (permissionMode) => buildPiToolsForPermissionMode(permissionMode)?.join(',') ?? 'native',
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, getAbortSignal, memoryRecallGuidanceEnabled, toolDelivery, pendingQueueDrainMaxPopPerWake, providerInputConsumer }) =>
      createPiAcpRuntime({
        directory,
        machineId,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        onThinkingChange: setThinking,
        getSessionOpenAbortSignal: getAbortSignal,
        memoryRecallGuidanceEnabled,
        fallbackToolDelivery: toolDelivery,
        getPermissionMode,
        pendingQueueDrainMaxPopPerWake,
        providerInputConsumer,
        credentials: opts.credentials,
        accountSettings: opts.accountSettingsContext?.settings ?? null,
      }),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[pi] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}

import type { PermissionMode } from '@/api/types';
import type { Credentials } from '@/persistence';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/sessionLoop/catalogPlan';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { runHostSessionRuntimePlan, type HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import { createPiAcpRuntime } from '@/backends/pi/acp/runtime';
import { buildPiToolsForPermissionMode } from '@/backends/pi/permissionMode';
import { PiTerminalDisplay } from '@/backends/pi/ui/PiTerminalDisplay';

export type PiSessionRuntimeOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
};

export function createPiSessionRuntimePlan(opts: PiSessionRuntimeOptions): HostSessionRuntimePlan {
  return createCatalogHostSessionRuntimePlan({
    providerId: 'pi',
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: 'pi',
      config: {
        flavor: 'pi',
        policyAgentId: 'pi',
        displayName: 'Pi',
        supportsMcpServers: false,
        terminalDisplay: PiTerminalDisplay,
        resolvePermissionModeQueueKey: (permissionMode) => buildPiToolsForPermissionMode(permissionMode).join(','),
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
        }) => createPiAcpRuntime({
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
        }),
        attachMetadataLogLabel: 'pi',
        formatPromptErrorMessage: formatProviderPromptErrorMessage,
      },
    }),
  });
}

export async function runPiSessionRuntime(opts: PiSessionRuntimeOptions): Promise<void> {
  await runHostSessionRuntimePlan(createPiSessionRuntimePlan(opts));
}

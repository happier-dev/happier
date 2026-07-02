import type { PermissionMode } from '@/api/types';
import type { Credentials } from '@/persistence';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { runHostSessionRuntimePlan, type HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { createPiAcpRuntime } from '@/backends/pi/acp/runtime';
import { PiTerminalDisplay } from '@/backends/pi/ui/PiTerminalDisplay';
import { buildPiToolsForPermissionMode } from '@happier-dev/plugins-pi/agent/runtime/rpc/permissions';

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
          accountSettings,
          pendingQueueDrainMaxPopPerWake,
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
          accountSettings,
          pendingQueueDrainMaxPopPerWake,
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

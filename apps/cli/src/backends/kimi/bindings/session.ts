/**
 * Kimi CLI Entry Point
 *
 * Runs the Kimi agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import type { Credentials } from '@/persistence';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/sessionLoop/catalogPlan';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { runHostSessionRuntimePlan, type HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

import { KimiTerminalDisplay } from '@/backends/kimi/ui/KimiTerminalDisplay';
import { createKimiAcpRuntime } from '../acp/runtime';

const KIMI_AUTH_HINT = 'Kimi appears not configured. Ensure the API key is set for the user running the daemon (e.g. `kimi config set --key api_key --value "..."`).';

export type KimiSessionRuntimeOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
};

export function createKimiSessionRuntimePlan(opts: KimiSessionRuntimeOptions): HostSessionRuntimePlan {
  return createCatalogHostSessionRuntimePlan({
    providerId: 'kimi',
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: 'kimi',
      config: {
        flavor: 'kimi',
        policyAgentId: 'kimi',
        displayName: 'Kimi',
        supportsMcpServers: false,
        terminalDisplay: KimiTerminalDisplay,
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
        }) => createKimiAcpRuntime({
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
        attachMetadataLogLabel: 'kimi',
        formatPromptErrorMessage: (error) => formatProviderPromptErrorMessage(error, { authHint: KIMI_AUTH_HINT }),
      },
    }),
  });
}

export async function runKimiSessionRuntime(opts: KimiSessionRuntimeOptions): Promise<void> {
  await runHostSessionRuntimePlan(createKimiSessionRuntimePlan(opts));
}

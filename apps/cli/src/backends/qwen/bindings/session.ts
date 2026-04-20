/**
 * Qwen Code CLI Entry Point
 *
 * Runs the Qwen Code agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import type { Credentials } from '@/persistence';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/sessionLoop/catalogPlan';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { runHostSessionRuntimePlan, type HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

import { QwenTerminalDisplay } from '@/backends/qwen/ui/QwenTerminalDisplay';

import { createQwenAcpRuntime } from '../acp/runtime';

export type QwenSessionRuntimeOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
};

export function createQwenSessionRuntimePlan(opts: QwenSessionRuntimeOptions): HostSessionRuntimePlan {
  return createCatalogHostSessionRuntimePlan({
    providerId: 'qwen',
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: 'qwen',
      config: {
        flavor: 'qwen',
        policyAgentId: 'qwen',
        displayName: 'Qwen Code',
        uiLogPrefix: '[Qwen]',
        terminalDisplay: QwenTerminalDisplay,
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
        }) => createQwenAcpRuntime({
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
        attachMetadataLogLabel: 'qwen',
        formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    }),
  });
}

export async function runQwenSessionRuntime(opts: QwenSessionRuntimeOptions): Promise<void> {
  await runHostSessionRuntimePlan(createQwenSessionRuntimePlan(opts));
}

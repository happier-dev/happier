/**
 * Auggie CLI Entry Point
 *
 * Runs the Auggie agent through Happier CLI using ACP.
 */

import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/sessionLoop/catalogPlan';
import { runHostSessionRuntimePlan, type HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

import { createAuggieAcpRuntime } from '@/backends/auggie/acp/runtime';
import { readAuggieAllowIndexingFromEnv } from '@/backends/auggie/utils/env';
import { AuggieTerminalDisplay } from '@/backends/auggie/ui/AuggieTerminalDisplay';

const AUGGIE_AUTH_HINT = 'Auggie appears not authenticated. Run `auggie login` on this machine (the same user running the daemon) and try again.';

export type AuggieSessionRuntimeOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
};

export function createAuggieSessionRuntimePlan(opts: AuggieSessionRuntimeOptions): HostSessionRuntimePlan {
  const allowIndexingFromEnv = readAuggieAllowIndexingFromEnv();

  return createCatalogHostSessionRuntimePlan({
    providerId: 'auggie',
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: 'auggie',
      config: {
        flavor: 'auggie',
        policyAgentId: 'auggie',
        displayName: 'Auggie',
        terminalDisplay: AuggieTerminalDisplay,
        beforeInitializeSession: ({ metadata }) => {
          metadata.auggieAllowIndexing = allowIndexingFromEnv;
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
        }) => {
          const metadataSnapshot = session.getMetadataSnapshot?.() ?? null;
          const allowIndexing = allowIndexingFromEnv || metadataSnapshot?.auggieAllowIndexing === true;
          return createAuggieAcpRuntime({
            directory,
            machineId,
            session,
            transcriptSession,
            messageBuffer,
            mcpServers,
            permissionHandler,
            onThinkingChange: setThinking,
            memoryRecallGuidanceEnabled,
            allowIndexing,
            getPermissionMode,
          });
        },
        attachMetadataLogLabel: 'auggie',
        formatPromptErrorMessage: (error) => {
          logger.debug('[Auggie] Error during prompt:', error);
          return formatProviderPromptErrorMessage(error, { authHint: AUGGIE_AUTH_HINT });
        },
      },
    }),
  });
}

export async function runAuggieSessionRuntime(opts: AuggieSessionRuntimeOptions): Promise<void> {
  await runHostSessionRuntimePlan(createAuggieSessionRuntimePlan(opts));
}

import React from 'react';

import {
  getAgentResumeConfig,
  getAgentCliRuntimeSpec,
  isAgentId,
  legacyCustomAcpCompat,
} from '@happier-dev/agents';
import type { CatalogAgentLookupId } from '@/backends/types';

import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import {
  createCatalogHostSessionRuntimeConfig,
  createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { createCatalogProviderSessionIdentityRuntime } from '@/agent/acp/runtime/createProviderSessionIdentityRuntime';
import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { BuiltInAcpTerminalDisplay } from './ui/TerminalDisplay';

function resolveAgentCliRuntimeSpecForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getAgentCliRuntimeSpec(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCliRuntimeSpec();
  }
  throw new Error(`Unsupported built-in session provider lookup id '${agentId}'`);
}

function resolveAgentResumeConfigForLookupId(agentId: CatalogAgentLookupId) {
  if (isAgentId(agentId)) {
    return getAgentResumeConfig(agentId);
  }
  if (legacyCustomAcpCompat.isLegacyCustomAcpAgentId(agentId)) {
    return legacyCustomAcpCompat.getLegacyCustomAcpAgentCore().resume;
  }
  throw new Error(`Unsupported built-in session resume lookup id '${agentId}'`);
}

function normalizeDisplayTitle(agentId: CatalogAgentLookupId): string {
  const title = resolveAgentCliRuntimeSpecForLookupId(agentId).title.trim();
  return title.endsWith(' CLI') ? title.slice(0, -4) : title;
}

export type BuiltInAcpSessionPlanOptions = HostSessionRuntimeRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
};

export function createBuiltInSessionPlan(
  agentId: CatalogAgentLookupId,
  opts: BuiltInAcpSessionPlanOptions,
) {
  const displayTitle = normalizeDisplayTitle(agentId);
  const resumeConfig = resolveAgentResumeConfigForLookupId(agentId);
  const vendorResumeIdField = 'vendorResumeIdField' in resumeConfig ? resumeConfig.vendorResumeIdField ?? null : null;
  const TerminalDisplay = (props: Readonly<{
    messageBuffer: MessageBuffer;
    logPath?: string;
    onExit?: () => void | Promise<void>;
  }>) => React.createElement(BuiltInAcpTerminalDisplay, { ...props, title: displayTitle });

  return createCatalogHostSessionRuntimePlan({
    providerId: agentId,
    opts,
    config: createCatalogHostSessionRuntimeConfig({
      providerId: agentId,
      config: {
        flavor: agentId,
        policyAgentId: agentId,
        displayName: displayTitle,
        terminalDisplay: TerminalDisplay,
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
          const runtimeParams = {
            provider: agentId,
            loggerLabel: `${displayTitle}ACP`,
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
          };

          if (vendorResumeIdField && isAgentId(agentId)) {
            return createCatalogProviderSessionIdentityRuntime({
              ...runtimeParams,
              agentId,
              vendorResumeIdField,
            });
          }

          return createCatalogProviderSessionIdentityRuntime(runtimeParams);
        },
        attachMetadataLogLabel: agentId,
        formatPromptErrorMessage: formatProviderPromptErrorMessage,
      },
    }),
  });
}

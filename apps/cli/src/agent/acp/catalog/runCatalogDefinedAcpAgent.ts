import React from 'react';

import type { AgentId, VendorResumeSupportLevel } from '@happier-dev/agents';
import { AGENTS_CORE, getProviderCliRuntimeSpec } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import { requireCatalogEntry } from '@/backends/catalog';

import { CatalogDefinedAcpTerminalDisplay } from './ui/CatalogDefinedAcpTerminalDisplay';

function normalizeDisplayTitle(agentId: AgentId): string {
  const title = getProviderCliRuntimeSpec(agentId).title.trim();
  return title.endsWith(' CLI') ? title.slice(0, -4) : title;
}

export async function runCatalogDefinedAcpAgent(
  agentId: AgentId,
  opts: StandardAcpProviderRunOptions & {
    credentials: Credentials;
    permissionMode?: PermissionMode;
  },
): Promise<void> {
  const displayTitle = normalizeDisplayTitle(agentId);
  const backendOptionsResolver = await requireCatalogEntry(agentId)
    .getAcpRuntimeBackendOptionsResolver?.();
  const TerminalDisplay = (props: Readonly<{
    messageBuffer: MessageBuffer;
    logPath?: string;
    onExit?: () => void | Promise<void>;
  }>) => React.createElement(CatalogDefinedAcpTerminalDisplay, { ...props, title: displayTitle });

  await runStandardAcpProvider(opts, {
    flavor: agentId,
    backendDisplayName: displayTitle,
    uiLogPrefix: `[${displayTitle}]`,
    providerName: displayTitle,
    waitingForCommandLabel: displayTitle,
    agentMessageType: agentId,
    machineMetadata: initialMachineMetadata,
    terminalDisplay: TerminalDisplay,
    createRuntime: ({
      directory,
      machineId,
      session,
      messageBuffer,
      mcpServers,
      permissionHandler,
      setThinking,
      getPermissionMode,
      memoryRecallGuidanceEnabled,
      pendingQueueDrainMaxPopPerWake,
      providerInputConsumer,
    }) => {
      const backendOptions = backendOptionsResolver?.({ session });
      return createCatalogProviderAcpRuntime<Record<string, unknown>>({
        provider: agentId,
        loggerLabel: `${displayTitle}ACP`,
        directory,
        session,
        messageBuffer,
        mcpServers,
        permissionHandler,
        sessionIdentity: (AGENTS_CORE[agentId].resume.vendorResume as VendorResumeSupportLevel) === 'unsupported'
          ? { kind: 'runtime-only', reason: 'vendor-resume-unsupported' }
          : { kind: 'manifest-metadata' },
        onThinkingChange: setThinking,
        getPermissionMode,
        memoryRecallGuidance: {
          enabled: memoryRecallGuidanceEnabled,
          machineId,
        },
        pendingQueueDrainMaxPopPerWake,
        providerInputConsumer,
        ...(backendOptions ? { backendOptions } : {}),
      });
    },
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        `[${agentId}] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)`,
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}

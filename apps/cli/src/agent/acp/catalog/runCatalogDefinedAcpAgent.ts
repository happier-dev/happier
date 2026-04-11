import React from 'react';

import type { AgentId } from '@happier-dev/agents';
import { AGENTS_CORE, getProviderCliRuntimeSpec } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { listSessionMarkers, writeSessionMarker } from '@/daemon/sessionRegistry';
import { logger } from '@/ui/logger';
import { initialMachineMetadata } from '@/daemon/startDaemon';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';

import { CatalogDefinedAcpTerminalDisplay } from './ui/CatalogDefinedAcpTerminalDisplay';

function normalizeDisplayTitle(agentId: AgentId): string {
  const title = getProviderCliRuntimeSpec(agentId).title.trim();
  return title.endsWith(' CLI') ? title.slice(0, -4) : title;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readHostPid(metadata: unknown): number | null {
  if (!isRecord(metadata)) return null;
  const pid = metadata.hostPid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function refreshTrackedSessionMarkerProviderSessionId(params: Readonly<{
  agentId: AgentId;
  session: SessionClientPort;
  providerSessionId: string;
  vendorResumeIdField: string;
}>): Promise<void> {
  const pid = readHostPid(params.session.getMetadataSnapshot());
  if (!pid) return;

  const markers = await listSessionMarkers().catch(() => []);
  const currentMarker = markers
    .filter((marker) => marker.pid === pid)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  const snapshot = params.session.getMetadataSnapshot();
  const metadata = isRecord(snapshot) ? snapshot : {};
  const nextMetadata: Record<string, unknown> = {
    ...(isRecord(currentMarker?.metadata) ? currentMarker.metadata : {}),
    ...metadata,
    flavor: params.agentId,
    [params.vendorResumeIdField]: params.providerSessionId,
  };

  await writeSessionMarker({
    pid,
    happySessionId: params.session.sessionId,
    flavor: params.agentId,
    startedBy: currentMarker?.startedBy,
    cwd: currentMarker?.cwd ?? (typeof nextMetadata.path === 'string' ? nextMetadata.path : undefined),
    processCommandHash: currentMarker?.processCommandHash,
    processCommand: currentMarker?.processCommand,
    metadata: nextMetadata,
    ...(currentMarker?.respawn ? { respawn: currentMarker.respawn } : {}),
  });
}

function publishCatalogProviderSessionId(params: Readonly<{
  agentId: AgentId;
  providerSessionId: string | null;
  session: SessionClientPort;
  vendorResumeIdField: string;
  lastPublished: { value: string | null };
}>): void {
  const next = typeof params.providerSessionId === 'string' ? params.providerSessionId.trim() : '';
  if (!next) return;
  if (params.lastPublished.value === next) return;

  const previous = params.lastPublished.value;
  params.lastPublished.value = next;

  try {
    const result = params.session.updateMetadata((metadata) => ({
      ...metadata,
      [params.vendorResumeIdField]: next,
    }));

    void Promise.resolve(result)
      .then(() => refreshTrackedSessionMarkerProviderSessionId({
        agentId: params.agentId,
        session: params.session,
        providerSessionId: next,
        vendorResumeIdField: params.vendorResumeIdField,
      }))
      .catch(() => {
        if (params.lastPublished.value === next) {
          params.lastPublished.value = previous;
        }
      });
  } catch {
    if (params.lastPublished.value === next) {
      params.lastPublished.value = previous;
    }
  }
}

export async function runCatalogDefinedAcpAgent(
  agentId: AgentId,
  opts: StandardAcpProviderRunOptions & {
    credentials: Credentials;
    permissionMode?: PermissionMode;
  },
): Promise<void> {
  const displayTitle = normalizeDisplayTitle(agentId);
  const resumeConfig = AGENTS_CORE[agentId].resume;
  const vendorResumeIdField = 'vendorResumeIdField' in resumeConfig ? resumeConfig.vendorResumeIdField ?? null : null;
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
      transcriptSession,
      messageBuffer,
      mcpServers,
      permissionHandler,
      setThinking,
      getPermissionMode,
      memoryRecallGuidanceEnabled,
    }) => {
      const lastPublishedProviderSessionId = { value: null as string | null };
      return (
      createCatalogProviderAcpRuntime({
        provider: agentId,
        loggerLabel: `${displayTitle}ACP`,
        directory,
        session,
        transcriptSession,
        messageBuffer,
        mcpServers,
        permissionHandler,
        onThinkingChange: setThinking,
        getPermissionMode,
        memoryRecallGuidance: {
          enabled: memoryRecallGuidanceEnabled,
          machineId,
        },
        ...(vendorResumeIdField
          ? {
              onSessionIdChange: (nextSessionId: string | null) => {
                publishCatalogProviderSessionId({
                  agentId,
                  providerSessionId: nextSessionId,
                  session,
                  vendorResumeIdField,
                  lastPublished: lastPublishedProviderSessionId,
                });
              },
            }
          : {}),
      })
      );
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

import type { AgentId } from '@happier-dev/agents';
import { AGENTS_CORE, getBuiltInAcpConfig, getProviderCliRuntimeSpec } from '@happier-dev/agents';

import type { Credentials } from '@/persistence';
import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import { requireCatalogEntry } from '@/backends/catalog';

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
  const catalogEntry = requireCatalogEntry(agentId);
  const backendOptionsResolver = await catalogEntry.getAcpRuntimeBackendOptionsResolver?.();
  const sessionModelAdapter = await catalogEntry.getAcpRuntimeSessionModelAdapter?.();
  const turnHooks = await catalogEntry.getAcpRuntimeTurnHooks?.();
  await runStandardAcpProvider(opts, {
    flavor: agentId,
    backendDisplayName: displayTitle,
    uiLogPrefix: `[${displayTitle}]`,
    providerName: displayTitle,
    waitingForCommandLabel: displayTitle,
    agentMessageType: agentId,
    machineMetadata: initialMachineMetadata,
    loadTerminalDisplay: async () => {
      const [{ default: React }, { CatalogDefinedAcpTerminalDisplay }] = await Promise.all([
        import('react'),
        import('./ui/CatalogDefinedAcpTerminalDisplay'),
      ]);
      return (props) => React.createElement(CatalogDefinedAcpTerminalDisplay, { ...props, title: displayTitle });
    },
    // Same catalog declaration the ACP protocol owner enforces against the negotiated handshake.
    declaredSessionLoadSupport: getBuiltInAcpConfig(agentId)?.supportsLoadSession === true,
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
      processEnv,
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
        sessionIdentity: AGENTS_CORE[agentId].resume.vendorResume === 'unsupported'
          ? { kind: 'runtime-only', reason: 'vendor-resume-unsupported' }
          : { kind: 'manifest-metadata' },
        onThinkingChange: setThinking,
        getPermissionMode,
        memoryRecallGuidance: {
          enabled: memoryRecallGuidanceEnabled,
          machineId,
        },
        processEnv,
        pendingQueueDrainMaxPopPerWake,
        providerInputConsumer,
        ...(sessionModelAdapter ?? {}),
        ...(turnHooks ? { hooks: turnHooks } : {}),
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

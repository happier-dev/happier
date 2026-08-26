import { createCursorAcpRuntime } from '@/backends/cursor/acp/runtime';
import { CursorTerminalDisplay } from '@/backends/cursor/ui/CursorTerminalDisplay';
import type { PermissionMode } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/machine/metadata';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { runStandardAcpProvider, type StandardAcpProviderRunOptions } from '@/agent/runtime/runStandardAcpProvider';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';

function buildCursorRuntimeEnv(params: Readonly<{
  cursorBinaryPath?: string;
  cursorAgentFallbackEnabled?: boolean;
  cursorApiEndpoint?: string;
}>): NodeJS.ProcessEnv | undefined {
  const env: NodeJS.ProcessEnv = {};
  const cursorBinaryPath = typeof params.cursorBinaryPath === 'string' ? params.cursorBinaryPath.trim() : '';
  if (cursorBinaryPath) {
    env.HAPPIER_CURSOR_PATH = cursorBinaryPath;
  }
  if (params.cursorAgentFallbackEnabled === false) {
    env.HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED = '0';
  }
  const cursorApiEndpoint = typeof params.cursorApiEndpoint === 'string' ? params.cursorApiEndpoint.trim() : '';
  if (cursorApiEndpoint) {
    env.HAPPIER_CURSOR_API_ENDPOINT = cursorApiEndpoint;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export async function runCursor(opts: StandardAcpProviderRunOptions & {
  credentials: Credentials;
  permissionMode?: PermissionMode;
  cursorBinaryPath?: string;
  cursorAgentFallbackEnabled?: boolean;
  cursorApiEndpoint?: string;
}): Promise<void> {
  const runtimeEnv = buildCursorRuntimeEnv(opts);

  await runStandardAcpProvider(opts, {
    flavor: 'cursor',
    backendDisplayName: 'Cursor',
    uiLogPrefix: '[Cursor]',
    providerName: 'Cursor',
    waitingForCommandLabel: 'Cursor',
    agentMessageType: 'cursor',
    failClosedOnResumeFailure: true,
    machineMetadata: initialMachineMetadata,
    terminalDisplay: CursorTerminalDisplay,
    resolveRuntimeDirectory: ({ session, metadata }) => session.getMetadataSnapshot()?.path ?? metadata.path,
    createRuntime: ({ directory, machineId, session, messageBuffer, mcpServers, permissionHandler, setThinking, getPermissionMode, memoryRecallGuidanceEnabled, processEnv, startupOverrides, pendingQueueDrainMaxPopPerWake, providerInputConsumer }) => createCursorAcpRuntime({
      directory,
      machineId,
      session,
      messageBuffer,
      mcpServers,
      permissionHandler,
      onThinkingChange: setThinking,
      memoryRecallGuidanceEnabled,
      getPermissionMode,
      env: { ...processEnv, ...runtimeEnv },
      startupOverrides,
      pendingQueueDrainMaxPopPerWake,
      providerInputConsumer,
    }),
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        '[cursor] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)',
        error ?? undefined,
      );
    },
    formatPromptErrorMessage: formatProviderPromptErrorMessage,
  });
}

import type { McpServerConfig } from '@/agent';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import { createCatalogProviderAcpRuntime } from '@/agent/acp/runtime/createCatalogProviderAcpRuntime';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { CursorBackendOptions } from '@/backends/cursor/acp/backend';
import {
  buildCursorSessionModelsFromConfigOptions,
  resolveCursorSessionConfigOptionUpdate,
  resolveCursorSessionModelConfigUpdate,
} from '@/backends/cursor/acp/cursorModelConfig';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { SessionProviderInputConsumer } from '@/agent/runtime/sessionInput/types';

import { resolveCursorGeneratedMediaRoot } from './resolveCursorGeneratedMediaRoot';

export function createCursorAcpRuntime(params: {
  directory: string;
  machineId: string;
  session: ApiSessionClient;
  messageBuffer: MessageBuffer;
  mcpServers: Record<string, McpServerConfig>;
  permissionHandler: AcpPermissionHandler;
  onThinkingChange: (thinking: boolean) => void;
  memoryRecallGuidanceEnabled?: boolean;
  getPermissionMode?: () => PermissionMode | null | undefined;
  env?: NodeJS.ProcessEnv;
  startupOverrides?: Parameters<typeof createCatalogProviderAcpRuntime>[0]['startupOverrides'];
  pendingQueueDrainMaxPopPerWake?: number;
  providerInputConsumer: SessionProviderInputConsumer<unknown, unknown>;
}) {
  return createCatalogProviderAcpRuntime<CursorBackendOptions>({
    provider: 'cursor',
    loggerLabel: 'CursorACP',
    directory: params.directory,
    session: params.session,
    messageBuffer: params.messageBuffer,
    mcpServers: params.mcpServers,
    permissionHandler: params.permissionHandler,
    sessionIdentity: { kind: 'manifest-metadata' },
    processEnv: params.env,
    onThinkingChange: params.onThinkingChange,
    memoryRecallGuidance: {
      enabled: params.memoryRecallGuidanceEnabled === true,
      machineId: params.machineId,
    },
    startupOverrides: params.startupOverrides,
    getPermissionMode: params.getPermissionMode,
    pendingQueueDrainMaxPopPerWake: params.pendingQueueDrainMaxPopPerWake,
    providerInputConsumer: params.providerInputConsumer,
    resolveSessionModelConfigUpdate: resolveCursorSessionModelConfigUpdate,
    deriveSessionModelsFromConfigOptions: buildCursorSessionModelsFromConfigOptions,
    resolveSessionConfigOptionUpdate: resolveCursorSessionConfigOptionUpdate,
    sessionMediaProviderRoots: [resolveCursorGeneratedMediaRoot({
      directory: params.directory,
      env: params.env,
    })],
  });
}

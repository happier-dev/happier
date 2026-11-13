import { join } from 'node:path';

import type { AgentSessionMcpLaunchConfig, AgentSessionNativeToolBridgeConfig, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { createSecureTempDirectorySync, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';

import { buildPiToolsForPermissionMode } from '../runtime/rpc/permissions.js';
import { buildPiHappierToolsExtensionSource } from './extensionSource.js';

export type PreparedPiHappierToolsExtension = Readonly<{
  extensionPath: string;
  configPath: string;
  toolNames: readonly string[];
  nativeToolSelection: readonly string[] | null;
  dispose(): Promise<void>;
}>;

export async function preparePiHappierToolsExtension(params: Readonly<{
  permissionMode?: string;
  mcpServers?: Readonly<Record<string, AgentSessionMcpLaunchConfig>>;
  mcpServersStrictMode?: AgentSessionOpenRequest['mcpServersStrictMode'];
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
}> & (Readonly<{ config: AgentSessionNativeToolBridgeConfig; directory?: never }>
  | Readonly<{ config?: never; directory: string }>)): Promise<PreparedPiHappierToolsExtension> {
  const config = params.config ?? { v: 1, directory: params.directory, systemPrompt: '', tools: [] };
  const nativeToolSelection = buildPiToolsForPermissionMode(params.permissionMode);
  const directory = createSecureTempDirectorySync({ prefix: 'happier-pi-tools' });
  const extensionPath = join(directory.path, 'happier-pi-tools-bridge.mjs');
  const configPath = join(directory.path, 'config.json');
  try {
    await writeAtomicTextFile({
      path: extensionPath,
      contents: buildPiHappierToolsExtensionSource(),
      mode: 0o600,
    });
    await writeAtomicTextFile({
      path: configPath,
      mode: 0o600,
      contents: `${JSON.stringify({ ...config, nativeTools: nativeToolSelection, mcpServers: params.mcpServers ?? {},
        ...(params.mcpServersStrictMode !== undefined ? { mcpServersStrictMode: params.mcpServersStrictMode } : {}),
        ...(params.mcpToolPolicy ? { mcpToolPolicy: params.mcpToolPolicy } : {}) })}\n`,
    });
    return Object.freeze({
      extensionPath,
      configPath,
      toolNames: Object.freeze(config.tools.map((tool) => tool.name)),
      nativeToolSelection,
      async dispose() {
        directory.cleanup();
      },
    });
  } catch (error) {
    directory.cleanup();
    throw error;
  }
}

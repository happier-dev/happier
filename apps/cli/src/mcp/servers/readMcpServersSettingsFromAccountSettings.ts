/**
 * MCP settings access (account settings)
 *
 * Reads the server-synced MCP servers settings blob from the account settings object.
 * Invalid payloads are treated as empty settings (fail-closed on config).
 */

import { McpServersSettingsV1Schema, type McpServersSettingsV1 } from '@happier-dev/protocol';

function emptySettings(): McpServersSettingsV1 {
  return { v: 1, strictMode: false, servers: [], bindings: [] };
}

export function readMcpServersSettingsFromAccountSettings(settingsLike: unknown): McpServersSettingsV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  const raw = rec?.mcpServersSettingsV1;
  if (!raw) return emptySettings();
  const parsed = McpServersSettingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : emptySettings();
}

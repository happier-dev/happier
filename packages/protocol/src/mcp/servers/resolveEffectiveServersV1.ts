import type {
  McpServerCatalogEntryV1,
  McpServersSettingsV1,
} from './settingsV1.js';
import { resolveApplicableServerBindingV1 } from './resolveServerBindingV1.js';

export type ResolvedMcpServerV1 = Readonly<{
  serverId: string;
  name: string;
  bindingId: string | null;
  enabled: boolean;
  config: McpServerCatalogEntryV1;
}>;

export type ResolveEffectiveServersV1Result = Readonly<{
  directory: string;
  strictMode: boolean;
  serversByName: Readonly<Record<string, ResolvedMcpServerV1>>;
}>;

export function resolveEffectiveServersV1(
  settings: McpServersSettingsV1,
  params: Readonly<{
    machineId: string;
    directory: string;
    normalizePath?: (value: string) => string;
  }>,
): ResolveEffectiveServersV1Result {
  const serversByName: Record<string, ResolvedMcpServerV1> = {};

  for (const server of settings.servers) {
    const resolved = resolveApplicableServerBindingV1({
      server,
      bindings: settings.bindings,
      machineId: params.machineId,
      directory: params.directory,
      normalizePath: params.normalizePath,
    });

    serversByName[server.name] = {
      serverId: server.id,
      name: server.name,
      bindingId: resolved.bindingId,
      enabled: resolved.enabled,
      config: resolved.config,
    };
  }

  return { directory: params.directory, strictMode: settings.strictMode, serversByName };
}

import { normalizeMcpServerWireKeyV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { UsageMcpBindingIdentity } from '@happier-dev/protocol/usage/coach/usageMcpBindingUsage';
import type { DetectedMcpServerV1 } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';

export function readLoadedMcpNativeServerNames(input: Readonly<{ servers: readonly DetectedMcpServerV1[]; agentId?: string | null }>): string[] {
  return input.servers.filter(server => server.provider === input.agentId && server.loadedInHappierSessions === true
    && server.enabled !== false).map(server => server.name);
}

export type McpServerIdentity = ResolvedMcpToolIdentityV1['item'] & Readonly<{ serverTitle: string; usage?: UsageMcpBindingIdentity }>;
export type McpWireNameItem = McpServerIdentity & Readonly<{ name: string }>;
export function assignMcpWireNames(input: Readonly<{ items: readonly McpWireNameItem[]; nativeServerNames?: readonly string[] }>): Readonly<{
  wireNamesByServerId: Readonly<Record<string, string>>; mcpServerIdentities: Readonly<Record<string, McpServerIdentity>>;
}> {
  const used = new Set(['happier', ...(input.nativeServerNames ?? []).flatMap(name => [name, normalizeMcpServerWireKeyV1(name)])]);
  const items = [...input.items].sort((a, b) => Number(Boolean(a.plugin)) - Number(Boolean(b.plugin)) || a.serverId.localeCompare(b.serverId));
  const wireNamesByServerId: Record<string, string> = Object.create(null);
  const mcpServerIdentities: Record<string, McpServerIdentity> = Object.create(null);
  for (const { name, ...identity } of items) {
    const baseName = normalizeMcpServerWireKeyV1(name);
    let wireName = baseName;
    for (let suffix = 2; used.has(wireName); suffix++) wireName = `${baseName}_${suffix}`;
    used.add(wireName);
    wireNamesByServerId[identity.serverId] = wireName;
    mcpServerIdentities[wireName] = identity;
  }
  return { wireNamesByServerId, mcpServerIdentities };
}

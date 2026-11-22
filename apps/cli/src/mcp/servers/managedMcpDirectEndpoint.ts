import { inferMcpServerAuthModeV1, type McpServerCatalogEntryV1 } from '@happier-dev/protocol';

// Keep the in-process delivery hint out of provider-owned JSON config.
export const managedMcpDirectEndpoint = Symbol('managedMcpDirectEndpoint');

export type ManagedMcpDirectEndpoint = Readonly<{ transport: 'http' | 'sse'; url: string }>;

export function resolveManagedMcpDirectEndpoint(server: McpServerCatalogEntryV1): ManagedMcpDirectEndpoint | undefined {
  if (server.transport === 'stdio' || !server.remote || inferMcpServerAuthModeV1(server) !== 'none') {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(server.remote.url);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  return { transport: server.transport, url: server.remote.url };
}

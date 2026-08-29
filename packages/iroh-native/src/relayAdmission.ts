/** Header name emitted by the upstream iroh-relay admission callback. */
export const IROH_NODE_ID_HEADER = 'x-iroh-nodeid' as const;

/** Reads the actual upstream node-id header without accepting documentation aliases. */
export function readIrohNodeIdHeader(headers: Readonly<Record<string, unknown>>): string | null {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === IROH_NODE_ID_HEADER)?.[1];
  if (typeof value !== 'string') return null;
  const nodeId = value.trim();
  return /^[0-9a-fA-F]{64}$/.test(nodeId) ? nodeId.toLowerCase() : null;
}

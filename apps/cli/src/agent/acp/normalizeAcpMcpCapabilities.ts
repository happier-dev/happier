export type AcpMcpCapabilities = Readonly<{ http: boolean; sse: boolean }>;

export function normalizeAcpMcpCapabilities(raw: unknown): AcpMcpCapabilities {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { http: value.http === true, sse: value.sse === true };
}

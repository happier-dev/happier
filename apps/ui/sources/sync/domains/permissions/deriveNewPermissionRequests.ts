export type NewPermissionRequest = Readonly<{
  requestId: string;
  toolName: string;
  toolArgs: unknown;
}>;

type RequestsMap = Record<string, any>;

function toRequestsMap(value: unknown): RequestsMap {
  if (!value || typeof value !== 'object') return {};
  return value as RequestsMap;
}

function compareNewRequests(a: NewPermissionRequest, b: NewPermissionRequest, nextRaw: RequestsMap): number {
  const aRaw = nextRaw[a.requestId];
  const bRaw = nextRaw[b.requestId];
  const aCreatedAt = typeof aRaw?.createdAt === 'number' && Number.isFinite(aRaw.createdAt) ? aRaw.createdAt : null;
  const bCreatedAt = typeof bRaw?.createdAt === 'number' && Number.isFinite(bRaw.createdAt) ? bRaw.createdAt : null;

  if (aCreatedAt != null && bCreatedAt != null && aCreatedAt !== bCreatedAt) {
    return aCreatedAt - bCreatedAt;
  }
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

export function deriveNewPermissionRequests(prevRequests: unknown, nextRequests: unknown): NewPermissionRequest[] {
  const prev = toRequestsMap(prevRequests);
  const next = toRequestsMap(nextRequests);
  const results: NewPermissionRequest[] = [];

  for (const [requestId, raw] of Object.entries(next)) {
    if (Object.prototype.hasOwnProperty.call(prev, requestId)) continue;
    const toolName = typeof raw?.tool === 'string' ? raw.tool.trim() : '';
    if (!toolName) continue;
    results.push({
      requestId,
      toolName,
      toolArgs: raw?.arguments,
    });
  }

  results.sort((a, b) => compareNewRequests(a, b, next));
  return results;
}


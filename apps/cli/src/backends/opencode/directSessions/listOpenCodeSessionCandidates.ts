import { buildOpenCodeAgentRuntimeDescriptor } from '@happier-dev/agents';
import type { DirectSessionCandidateV1, DirectSessionsSource } from '@happier-dev/protocol';

import { deriveDirectSessionActivityFromTimestamp } from '@/api/directSessions/activity/deriveDirectSessionActivityFromTimestamp';

import { createOpenCodeDirectClient } from './createOpenCodeDirectClient';
import { isOpenCodeSessionBusy } from './isOpenCodeSessionBusy';
import { parseOpenCodeSessionCandidate } from './parseOpenCodeSessionCandidate';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as any;
    if (!parsed || typeof parsed !== 'object') return 0;
    if (parsed.v !== 1 || parsed.kind !== 'index') return 0;
    const offset = typeof parsed.offset === 'number' && Number.isFinite(parsed.offset) ? Math.trunc(parsed.offset) : 0;
    return Math.max(0, offset);
  } catch {
    return 0;
  }
}

export async function listOpenCodeSessionCandidates(params: Readonly<{
  source: DirectSessionsSource;
  cursor?: string;
  limit: number;
  searchTerm?: string;
}>): Promise<Readonly<{ candidates: DirectSessionCandidateV1[]; nextCursor: string | null }>> {
  const client = await createOpenCodeDirectClient(params.source);

  try {
    const rawSessions = await client.sessionList();
    const rawStatuses = await client.sessionStatusList().catch(() => ({}));
    const statuses = rawStatuses && typeof rawStatuses === 'object' && !Array.isArray(rawStatuses)
      ? rawStatuses as Record<string, unknown>
      : {};
    const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';

    const candidates: DirectSessionCandidateV1[] = [];
    for (const raw of rawSessions) {
      const parsed = parseOpenCodeSessionCandidate(raw);
      if (!parsed) continue;
      if (searchTerm) {
        const haystack = `${parsed.remoteSessionId} ${parsed.title ?? ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) continue;
      }
      const activity = isOpenCodeSessionBusy(statuses[parsed.remoteSessionId])
        ? 'running'
        : deriveDirectSessionActivityFromTimestamp({ updatedAtMs: parsed.updatedAtMs });
      const serverBaseUrl = params.source.kind === 'opencodeServer' && typeof params.source.baseUrl === 'string' && params.source.baseUrl.trim().length > 0
        ? params.source.baseUrl.trim()
        : null;
      candidates.push({
        ...parsed,
        activity,
        details: {
          ...(parsed.details ?? {}),
          agentRuntimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptor({
            backendMode: 'server',
            vendorSessionId: parsed.remoteSessionId,
            ...(serverBaseUrl ? { serverBaseUrl } : {}),
            ...(serverBaseUrl ? { serverBaseUrlExplicit: true } : {}),
          }),
        },
      });
    }

    candidates.sort((a, b) => b.updatedAtMs - a.updatedAtMs || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)));

    const limit = Math.max(1, Math.trunc(params.limit));
    const offset = decodeIndexCursor(params.cursor);
    const page = candidates.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < candidates.length ? encodeIndexCursor(nextOffset) : null;
    return { candidates: page, nextCursor };
  } finally {
    await client.dispose().catch(() => {});
  }
}

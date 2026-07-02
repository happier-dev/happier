import {
  type ExternalSessionActivityV1,
  type ExternalSessionCandidateV1,
  type ExternalSessionsSource,
} from '@happier-dev/protocol';

import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';
import { createOpenCodeExternalSessionClient } from './client.js';

type IndexCursorV1 = Readonly<{ v: 1; kind: 'index'; offset: number }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getString(value: unknown, key: string): string {
  const record = asRecord(value);
  const raw = record ? record[key] : null;
  return typeof raw === 'string' ? raw : '';
}

function getNumber(value: unknown, key: string): number | null {
  const record = asRecord(value);
  const raw = record ? record[key] : null;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : null;
}

function encodeIndexCursor(offset: number): string {
  const cursor: IndexCursorV1 = { v: 1, kind: 'index', offset: Math.max(0, Math.trunc(offset)) };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeIndexCursor(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    const record = asRecord(parsed);
    if (!record || record.v !== 1 || record.kind !== 'index') return 0;
    const offset = typeof record.offset === 'number' && Number.isFinite(record.offset) ? Math.trunc(record.offset) : 0;
    return Math.max(0, offset);
  } catch {
    return 0;
  }
}

function resolveRecentActivityWindowMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15_000;
  return Math.max(1000, Math.min(60 * 60 * 1000, configured));
}

function deriveActivityFromTimestamp(params: Readonly<{
  updatedAtMs: number | null | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
}>): ExternalSessionActivityV1 {
  const updatedAtMs = typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs)
    ? Math.trunc(params.updatedAtMs)
    : null;
  if (updatedAtMs === null || updatedAtMs < 0) return 'unknown';

  const nowMs = params.nowMs ?? Date.now();
  const ageMs = nowMs - updatedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';

  return ageMs <= resolveRecentActivityWindowMs(params.env ?? process.env) ? 'active_recently' : 'idle';
}

export function isOpenCodeSessionBusy(record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const type = (record as Record<string, unknown>).type;
  return String(type ?? '').toLowerCase() === 'busy';
}

export function parseOpenCodeSessionCandidate(raw: unknown): ExternalSessionCandidateV1 | null {
  const record = asRecord(raw);
  if (!record) return null;
  const remoteSessionId = getString(record, 'id').trim();
  if (!remoteSessionId) return null;

  const title = getString(record, 'title').trim();
  const updatedAtMs = getNumber(record, 'updatedAtMs') ?? getNumber(record, 'updatedAt') ?? null;

  return {
    kindVersion: 1,
    remoteSessionId,
    ...(title ? { title } : {}),
    updatedAtMs: updatedAtMs ?? Date.now(),
    activity: 'unknown',
    details: {},
  };
}

export async function listOpenCodeSessionCandidates(params: Readonly<{
  source: ExternalSessionsSource;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<Readonly<{ candidates: ExternalSessionCandidateV1[]; nextCursor: string | null }>> {
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    env: params.env,
  });

  try {
    const rawSessions = await client.sessionList();
    const rawStatuses = await client.sessionStatusList().catch(() => ({}));
    const statuses = rawStatuses && typeof rawStatuses === 'object' && !Array.isArray(rawStatuses)
      ? rawStatuses as Record<string, unknown>
      : {};
    const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
    const serverBaseUrl = params.source.kind === 'opencodeServer'
      && typeof params.source.baseUrl === 'string'
      && params.source.baseUrl.trim().length > 0
      ? params.source.baseUrl.trim()
      : null;

    const candidates: ExternalSessionCandidateV1[] = [];
    for (const raw of rawSessions) {
      const parsed = parseOpenCodeSessionCandidate(raw);
      if (!parsed) continue;
      if (searchTerm) {
        const haystack = `${parsed.remoteSessionId} ${parsed.title ?? ''}`.toLowerCase();
        if (!haystack.includes(searchTerm)) continue;
      }
      const activity = isOpenCodeSessionBusy(statuses[parsed.remoteSessionId])
        ? 'running'
        : deriveActivityFromTimestamp({ updatedAtMs: parsed.updatedAtMs, env: params.env });
      candidates.push({
        ...parsed,
        activity,
        details: {
          ...(parsed.details ?? {}),
          runtimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptorV1({
            backendMode: 'server',
            providerSessionId: parsed.remoteSessionId,
            ...(serverBaseUrl ? { serverBaseUrl } : {}),
            ...(serverBaseUrl ? { serverBaseUrlExplicit: true } : {}),
          }),
        },
      });
    }

    candidates.sort(
      (a, b) =>
        b.updatedAtMs - a.updatedAtMs
        || String(a.remoteSessionId).localeCompare(String(b.remoteSessionId)),
    );

    const limit = Math.max(1, Math.trunc(params.limit));
    const offset = decodeIndexCursor(params.cursor);
    const page = candidates.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      candidates: page,
      nextCursor: nextOffset < candidates.length ? encodeIndexCursor(nextOffset) : null,
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}

export async function getOpenCodeExternalSessionActivity(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
}>): Promise<Readonly<{ isRunning: boolean; lastActivityAtMs: number | null }>> {
  const client = await createOpenCodeExternalSessionClient({ source: params.source });
  try {
    const statuses = await client.sessionStatusList().catch(() => ({}));
    const record = statuses && typeof statuses === 'object' && !Array.isArray(statuses)
      ? (statuses as Record<string, unknown>)[params.providerSessionId]
      : null;
    const isRunning = isOpenCodeSessionBusy(record);

    const sessions = await client.sessionList().catch(() => []);
    let lastActivityAtMs: number | null = null;
    for (const raw of sessions) {
      const candidate = parseOpenCodeSessionCandidate(raw);
      if (!candidate || candidate.remoteSessionId !== params.providerSessionId) continue;
      lastActivityAtMs = candidate.updatedAtMs > 0 ? Math.trunc(candidate.updatedAtMs) : null;
      break;
    }
    return { isRunning, lastActivityAtMs };
  } finally {
    await client.dispose().catch(() => {});
  }
}

export async function getOpenCodeExternalSessionVerifiedWorkingDirectory(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
}>): Promise<string | null> {
  const client = await createOpenCodeExternalSessionClient({ source: params.source });
  try {
    const session = await client.sessionGet({ sessionId: params.providerSessionId });
    const directory =
      session && typeof session === 'object' && !Array.isArray(session)
      && typeof (session as Record<string, unknown>).directory === 'string'
        ? String((session as Record<string, unknown>).directory).trim()
        : '';
    return directory || null;
  } catch {
    return null;
  } finally {
    await client.dispose().catch(() => {});
  }
}

export async function getOpenCodeExternalSessionWorkingDirectory(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
}>): Promise<string | null> {
  const verified = await getOpenCodeExternalSessionVerifiedWorkingDirectory(params);
  if (verified) return verified;

  if (params.source.kind === 'opencodeServer') {
    const fromSource = typeof params.source.directory === 'string' ? params.source.directory.trim() : '';
    if (fromSource.length > 0) return fromSource;
  }
  return null;
}

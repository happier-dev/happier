import {
  deriveExternalSessionActivity,
  type ExternalSessionCandidateV1,
  type ExternalSessionsSource,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import { buildOpenCodeAgentRuntimeDescriptorV1 } from '../../../identity/runtimeDescriptor.js';
import {
  asRecord,
  normalizeString,
} from '../../../runtime/server/openCodeParsing.js';
import { createOpenCodeExternalSessionClient } from './client.js';

function getString(value: unknown, key: string): string {
  const record = asRecord(value);
  return normalizeString(record?.[key]);
}

function getNumber(value: unknown, key: string): number | null {
  const record = asRecord(value);
  const raw = record ? record[key] : null;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : null;
}

function getNestedNumber(value: unknown, parentKey: string, key: string): number | null {
  const record = asRecord(value);
  return getNumber(record?.[parentKey], key);
}

export function isOpenCodeSessionBusy(record: unknown): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const type = (record as Record<string, unknown>).type;
  return String(type ?? '').toLowerCase() === 'busy';
}

export function parseOpenCodeSessionCandidate(raw: unknown): ExternalSessionCandidateV1 | null {
  const record = asRecord(raw);
  if (!record) return null;
  const remoteSessionId = getString(record, 'id');
  if (!remoteSessionId) return null;

  const title = getString(record, 'title');
  const updatedAtMs = getNumber(record, 'updatedAtMs')
    ?? getNumber(record, 'updatedAt')
    ?? getNestedNumber(record, 'time', 'updated')
    ?? null;

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
  searchMode?: 'fast' | 'full';
  includeActivity?: boolean;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
}>): Promise<Readonly<{
  candidates: ExternalSessionCandidateV1[];
  nextCursor: null;
  searchIncomplete?: boolean;
}>> {
  if (params.cursor) {
    throw new Error('OpenCode session listing does not expose an official continuation cursor.');
  }
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    env: params.env,
  });

  try {
    const limit = Math.max(1, Math.trunc(params.limit));
    const searchTerm = typeof params.searchTerm === 'string' ? params.searchTerm.trim() : '';
    const rawSessions = await client.sessionList({
      limit: limit + 1,
      ...(searchTerm ? { search: searchTerm } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const rawStatuses = params.includeActivity === false
      ? {}
      : await client.sessionStatusList(
        params.signal ? { signal: params.signal } : undefined,
      ).catch(() => ({}));
    const statuses = rawStatuses && typeof rawStatuses === 'object' && !Array.isArray(rawStatuses)
      ? rawStatuses as Record<string, unknown>
      : {};
    const serverBaseUrl = params.source.kind === 'opencodeServer'
      && typeof params.source.baseUrl === 'string'
      && params.source.baseUrl.trim().length > 0
      ? params.source.baseUrl.trim()
      : null;

    const candidates: ExternalSessionCandidateV1[] = [];
    for (const raw of rawSessions) {
      const parsed = parseOpenCodeSessionCandidate(raw);
      if (!parsed) continue;
      const activity = isOpenCodeSessionBusy(statuses[parsed.remoteSessionId])
        ? 'running'
        : deriveExternalSessionActivity({ updatedAtMs: parsed.updatedAtMs, env: params.env });
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

    const hasOverflow = candidates.length > limit;
    return {
      candidates: candidates.slice(0, limit),
      nextCursor: null,
      ...((hasOverflow || (searchTerm && params.searchMode === 'fast'))
        ? { searchIncomplete: true }
        : {}),
    };
  } finally {
    await client.dispose().catch(() => {});
  }
}

export async function getOpenCodeExternalSessionVerifiedWorkingDirectory(params: Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  baseUrlAuthority?: 'configured' | 'canonical';
}>): Promise<string | null> {
  const client = await createOpenCodeExternalSessionClient({
    source: params.source,
    env: params.env,
    ...(params.baseUrlAuthority
      ? { baseUrlAuthority: params.baseUrlAuthority }
      : {}),
  });
  try {
    const session = await client.sessionGet({
      sessionId: params.providerSessionId,
      ...(params.signal ? { signal: params.signal } : {}),
    });
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
